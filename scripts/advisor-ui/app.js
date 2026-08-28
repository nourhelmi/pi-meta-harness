const $ = (selector) => document.querySelector(selector);

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const RECENT_WINDOW_MS = 30 * 60 * 1000;
const POLL_MS = 3000;
const RUN_PREVIEW_COUNT = 8;
const NODE_HISTORY_KEY = "advisor-ui-node-history-v1";

let state = null;
let cy = null;
let selectedProjectKey = null;
let selectedGraphId = null;
let selectedMessageTarget = null;
let showAllRuns = false;
let renderedGraphKey = null;
let nodeHistory = loadNodeHistory();
let graphLibraryCollapsed = window.matchMedia("(max-width: 760px)").matches;

function loadNodeHistory() {
  try {
    return JSON.parse(localStorage.getItem(NODE_HISTORY_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveNodeHistory() {
  localStorage.setItem(NODE_HISTORY_KEY, JSON.stringify(nodeHistory));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function ageMs(session) {
  return Math.max(0, (state?.now ?? Date.now()) - (session.lastActivity ?? 0));
}

function activityTier(session) {
  const status = String(session.status || "idle").toLowerCase();
  if (status !== "idle" || ageMs(session) <= ACTIVE_WINDOW_MS) return "active";
  if (ageMs(session) <= RECENT_WINDOW_MS) return "recent";
  return "dormant";
}

function statusKind(status) {
  const value = String(status || "idle").toLowerCase();
  if (value.includes("tool") || value.includes("work")) return "working";
  if (value.includes("think") || value.includes("stream") || value.includes("respond")) return "thinking";
  return "idle";
}

function statusColor(status) {
  const kind = statusKind(status);
  if (kind === "working") return "#f5c86c";
  if (kind === "thinking") return "#79b8ff";
  return "#5dd6b3";
}

function humanAge(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function shortModel(model) {
  return String(model || "unknown").split("/").pop();
}

function projectName(path) {
  return String(path || "").split("/").filter(Boolean).pop() || "unknown";
}

function agentSessions() {
  if (!state) return [];
  return state.sessions.filter((session) => session.id !== state.broker.sessionId && session.model !== "dashboard");
}

function graphProjects() {
  return (state?.projects ?? []).filter((project) => project.graphs.length > 0);
}

function pathsRelated(a, b) {
  if (!a || !b) return true;
  const left = a.replace(/\/+$/, "") + "/";
  const right = b.replace(/\/+$/, "") + "/";
  return left.startsWith(right) || right.startsWith(left);
}

function matchNodeSession(node) {
  const sessions = agentSessions();
  const nodeId = node.id.toLowerCase();
  return sessions.find((session) =>
    session.name && session.name.toLowerCase().includes(nodeId) && pathsRelated(node.worktree, session.cwd)) || null;
}

function currentProject() {
  const projects = graphProjects();
  return projects.find((project) => project.key === selectedProjectKey) || projects[0] || null;
}

function currentGraph() {
  const project = currentProject();
  if (!project) return null;
  return project.graphs.find((graph) => graph.graphId === selectedGraphId) || project.graphs[0] || null;
}

function normalizedSessionName(session) {
  return String(session.name || "").toLowerCase().replace(/^advisor-/, "");
}

function findGraphForSession(session) {
  const sessionName = normalizedSessionName(session);
  let best = null;
  for (const project of graphProjects()) {
    for (const graph of project.graphs) {
      let score = 0;
      let nodeId = null;
      if (graph.advisorSessionId === session.id) score += 1000;
      if (graph.workstream && graph.workstream.toLowerCase() === sessionName) score += 900;
      if (graph.workstream && sessionName.includes(graph.workstream.toLowerCase())) score += 700;
      const matchedNode = graph.nodes.find((node) => matchNodeSession(node)?.id === session.id);
      if (matchedNode) {
        score += 850;
        nodeId = matchedNode.id;
      }
      if (!score) continue;
      score += Math.min(100, (graph.mtime || 0) / 1e12);
      if (!best || score > best.score) best = { project, graph, nodeId, score };
    }
  }
  return best;
}

function focusGraphForSession(session) {
  const match = findGraphForSession(session);
  if (!match) return false;
  closeDrawers();
  selectGraph(match.project.key, match.graph.graphId);
  document.querySelector(".workspace-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  requestAnimationFrame(() => {
    cy?.fit(undefined, 58);
    if (match.nodeId) cy?.getElementById(match.nodeId).select();
  });
  return true;
}

function renderConnection() {
  const badge = $("#brokerState");
  const connected = state?.broker?.connected === true;
  badge.className = `connection-pill ${connected ? "connected" : "disconnected"}`;
  badge.textContent = connected ? "Intercom online" : "Intercom offline";
}

function renderActiveSessions() {
  const sessions = agentSessions()
    .filter((session) => activityTier(session) === "active")
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  $("#activeSummary").textContent = sessions.length ? `${sessions.length} connected` : "No agents working";
  if (!sessions.length) {
    $("#activeSessions").replaceChildren(el("span", { class: "no-active" }, "Nothing is running right now."));
    return;
  }
  const cards = sessions.map((session) => {
    const kind = statusKind(session.status);
    const graphMatch = findGraphForSession(session);
    return el("button", { class: "active-agent", type: "button", onclick: () => {
      if (!focusGraphForSession(session)) openSessionDetail(session);
    } },
      el("span", { class: `agent-dot ${kind}` }),
      el("span", { class: "active-agent-copy" },
        el("span", { class: "active-agent-name" }, session.name || session.id.slice(0, 8)),
        el("span", { class: "active-agent-meta" }, graphMatch
          ? `${graphMatch.graph.graphId} · ${session.status || "idle"}`
          : `${session.status || "idle"} · ${projectName(session.cwd)}`)),
      el("span", { class: "active-agent-age" }, humanAge(ageMs(session))));
  });
  $("#activeSessions").replaceChildren(...cards);
}

function syncSelectors() {
  const projects = graphProjects();
  if (!projects.length) {
    selectedProjectKey = null;
    selectedGraphId = null;
    $("#projectSelect").replaceChildren();
    $("#graphSelect").replaceChildren();
    return;
  }
  if (!projects.some((project) => project.key === selectedProjectKey)) selectedProjectKey = projects[0].key;
  const project = currentProject();
  if (!project.graphs.some((graph) => graph.graphId === selectedGraphId)) selectedGraphId = project.graphs[0].graphId;

  const previousProject = $("#projectSelect").value;
  $("#projectSelect").replaceChildren(...projects.map((item) => new Option(item.key, item.key)));
  $("#projectSelect").value = selectedProjectKey || previousProject;

  const previousGraph = $("#graphSelect").value;
  $("#graphSelect").replaceChildren(...project.graphs.map((graph) => new Option(graph.graphId, graph.graphId)));
  $("#graphSelect").value = selectedGraphId || previousGraph;
}

function setGraphLibraryCollapsed(collapsed) {
  graphLibraryCollapsed = collapsed;
  const card = document.querySelector(".workspace-card");
  const changed = card?.classList.contains("library-collapsed") !== collapsed;
  card?.classList.toggle("library-collapsed", collapsed);
  $("#collapseGraphLibrary").textContent = collapsed ? "›" : "‹";
  if (!changed) return;
  setTimeout(() => {
    cy?.resize();
    cy?.fit(undefined, 58);
  }, 190);
}

function selectGraph(projectKey, graphId) {
  selectedProjectKey = projectKey;
  selectedGraphId = graphId;
  showAllRuns = false;
  syncSelectors();
  renderGraphLibrary();
  renderGraphHeading();
  renderGraphCanvas();
  renderRuns();
  if (window.matchMedia("(max-width: 760px)").matches) setGraphLibraryCollapsed(true);
}

function renderGraphLibrary() {
  const query = $("#graphSearch").value.trim().toLowerCase();
  const groups = graphProjects().map((project) => {
    const graphs = project.graphs.filter((graph) => `${project.key} ${graph.graphId} ${graph.workstream || ""}`.toLowerCase().includes(query));
    if (!graphs.length) return null;
    return el("section", { class: "graph-project" },
      el("div", { class: "graph-project-name", title: project.key }, project.key),
      graphs.map((graph) => {
        const statuses = computeNodeStatuses(project, graph);
        const running = [...statuses.values()].filter((status) => status === "running").length;
        const complete = [...statuses.values()].filter((status) => status === "complete").length;
        const agentCount = graph.nodes.reduce((count, node) => count + agentRecordsForNode(project, graph, node).length, 0);
        let graphState = "planned";
        if (running) graphState = "running";
        else if (complete === graph.nodes.length) graphState = "complete";
        return el("button", {
          class: `graph-nav-item${project.key === selectedProjectKey && graph.graphId === selectedGraphId ? " selected" : ""}`,
          type: "button",
          onclick: () => selectGraph(project.key, graph.graphId),
        },
        el("span", { class: "graph-nav-title" }, graph.graphId),
        el("span", { class: "graph-nav-meta" }, `${agentCount} agents · ${graph.waves?.length || 1} ${(graph.waves?.length || 1) === 1 ? "wave" : "waves"}`),
        el("span", { class: `graph-nav-state ${graphState}`, title: graphState }));
      }));
  }).filter(Boolean);
  $("#graphLibraryList").replaceChildren(...groups);
  setGraphLibraryCollapsed(graphLibraryCollapsed);
}

function nodeHistoryKey(project, graph, node) {
  return `${project.key}:${graph.graphId}:${node.id}`;
}

const MATCH_STOPWORDS = new Set(["about", "after", "against", "anchor", "before", "builder", "checker", "current", "execute", "fresh", "graph", "node", "packet", "review", "should", "task", "using", "verify", "with"]);

function matchWords(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g)?.filter((word) => !MATCH_STOPWORDS.has(word)) || []);
}

function assignRunsToNodes(project, graph) {
  const graphStart = Date.parse(graph.createdAt || "") || 0;
  const nextGraphStart = project.graphs
    .map((item) => Date.parse(item.createdAt || "") || 0)
    .filter((timestamp) => timestamp > graphStart)
    .sort((a, b) => a - b)[0] || Infinity;
  const candidateRuns = project.runs.filter((run) =>
    run.resultExcerpt && run.mtime >= graphStart - 10 * 60 * 1000 && run.mtime < nextGraphStart);
  const pairs = [];
  for (const run of candidateRuns) {
    const excerpt = run.resultExcerpt.toLowerCase();
    const heading = excerpt.slice(0, 180);
    const headingWords = matchWords(heading);
    const excerptWords = matchWords(excerpt);
    for (const node of graph.nodes) {
      const nodeId = node.id.toLowerCase();
      const idWords = matchWords(nodeId.replaceAll("-", " "));
      const taskWords = matchWords(node.task);
      let score = heading.includes(nodeId) ? 120 : 0;
      for (const word of idWords) if (headingWords.has(word)) score += 24;
      let taskMatches = 0;
      for (const word of taskWords) if (excerptWords.has(word)) taskMatches += 1;
      score += Math.min(taskMatches, 24);
      if (run.role && node.role) score += run.role === node.role ? 80 : -100;
      pairs.push({ run, node, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const assignments = new Map();
  const usedRuns = new Set();
  for (const pair of pairs) {
    if (pair.score < 10 || usedRuns.has(pair.run.runId)) continue;
    const nodeRuns = assignments.get(pair.node.id) || [];
    nodeRuns.push(pair.run);
    nodeRuns.sort((a, b) => b.mtime - a.mtime);
    assignments.set(pair.node.id, nodeRuns);
    usedRuns.add(pair.run.runId);
  }
  return assignments;
}

function agentRecordsForNode(project, graph, node) {
  const records = [];
  const seen = new Set();
  const session = matchNodeSession(node);
  if (session) {
    records.push({
      id: session.id,
      kind: "live",
      name: session.name || `${node.role || "worker"}-${node.id}`,
      role: node.role || "worker",
      model: shortModel(session.model),
      status: activityTier(session) === "active" ? "running" : "incomplete",
      age: humanAge(ageMs(session)),
    });
    seen.add(session.id);
  }

  const key = nodeHistoryKey(project, graph, node);
  const rememberedSessionId = nodeHistory[key]?.sessionId;
  const exactRun = rememberedSessionId && project.runs.find((run) => run.sessionId === rememberedSessionId);
  const assignedRuns = assignRunsToNodes(project, graph).get(node.id) || [];
  const runs = exactRun ? [exactRun, ...assignedRuns] : assignedRuns;
  for (const run of runs.sort((a, b) => b.mtime - a.mtime)) {
    if (seen.has(run.sessionId)) continue;
    seen.add(run.sessionId);
    records.push({
      id: run.sessionId,
      kind: "history",
      name: `${run.role || node.role || "worker"} · ${run.sessionId.slice(0, 8)}`,
      role: run.role || node.role || "worker",
      model: shortModel(run.model),
      status: run.resultState === "complete" ? "complete" : run.resultState === "running" ? "running" : "incomplete",
      age: humanAge(Math.max(0, (state?.now ?? Date.now()) - run.mtime)),
    });
  }

  if (rememberedSessionId && !seen.has(rememberedSessionId)) {
    records.push({
      id: rememberedSessionId,
      kind: "history",
      name: nodeHistory[key]?.sessionName || `${node.role || "worker"} · ${rememberedSessionId.slice(0, 8)}`,
      role: node.role || "worker",
      model: "unknown model",
      status: "incomplete",
      age: "history",
    });
  }

  if (!records.length) {
    records.push({
      id: `planned:${node.id}`,
      kind: "planned",
      name: `${node.role || "worker"} agent`,
      role: node.role || "worker",
      model: "assigned at launch",
      status: "planned",
      age: "future",
    });
  }
  return records;
}

function visibleAgentRecordsForNode(project, graph, node, nodeStatus) {
  return agentRecordsForNode(project, graph, node).map((record) =>
    record.kind === "planned" && nodeStatus === "complete"
      ? { ...record, kind: "history", name: `${record.role} · inferred prior agent`, model: "unknown model", status: "complete", age: "history" }
      : record);
}

function taskNodeLabel(node, nodeStatus) {
  return `${node.id}\n${node.role || "worker"} · ${statusLabel(nodeStatus)}`;
}

function agentRecordLabel(record) {
  return `${record.name}\n${record.role} · ${record.model}\n${statusLabel(record.status)} · ${record.age}`;
}

function agentElementId(taskNodeId, record, index = 0) {
  return `__agent::${taskNodeId || record.relation || "standalone"}::${record.kind}::${record.id}::${index}`;
}
function standaloneLiveAgents(project, graph) {
  const attachedIds = new Set(graph.nodes.flatMap((node) =>
    agentRecordsForNode(project, graph, node).filter((record) => record.kind === "live").map((record) => record.id)));
  return agentSessions()
    .filter((session) => activityTier(session) === "active" && !attachedIds.has(session.id))
    .map((session) => {
      const match = findGraphForSession(session);
      const belongsToGraph = match?.project.key === project.key && match?.graph.graphId === graph.graphId;
      return {
        id: session.id,
        kind: "live",
        relation: belongsToGraph ? "advisor" : "unassigned",
        name: session.name || session.id.slice(0, 8),
        role: belongsToGraph ? "advisor" : "unassigned",
        model: shortModel(session.model),
        status: "running",
        age: humanAge(ageMs(session)),
      };
    });
}

function topologySignature(project, graph) {
  const attached = graph.nodes.flatMap((node) =>
    agentRecordsForNode(project, graph, node).map((record) => `${node.id}:${record.id}:${record.status}`));
  const standalone = standaloneLiveAgents(project, graph).map((record) => `${record.id}:${record.relation}:${record.status}`);
  return [...attached, ...standalone].sort().join("|");
}


function computeNodeStatuses(project, graph) {
  const statuses = new Map(graph.nodes.map((node) => [node.id, "planned"]));
  const assignedRuns = assignRunsToNodes(project, graph);
  let historyChanged = false;

  for (const node of graph.nodes) {
    const session = matchNodeSession(node);
    const key = nodeHistoryKey(project, graph, node);
    if (session && nodeHistory[key]?.sessionId !== session.id) {
      nodeHistory[key] = { sessionId: session.id, sessionName: session.name || "", lastSeen: Date.now() };
      historyChanged = true;
    }
    const rememberedSessionId = nodeHistory[key]?.sessionId;
    const exactRun = rememberedSessionId && project.runs.find((run) => run.sessionId === rememberedSessionId);
    const associatedRuns = [...(assignedRuns.get(node.id) || [])];
    if (exactRun && !associatedRuns.some((run) => run.runId === exactRun.runId)) associatedRuns.unshift(exactRun);
    associatedRuns.sort((a, b) => b.mtime - a.mtime);
    const latestRun = associatedRuns[0];
    if (session && activityTier(session) === "active") statuses.set(node.id, "running");
    else if (latestRun?.resultState === "running") statuses.set(node.id, "running");
    else if (latestRun?.resultState === "complete") statuses.set(node.id, "complete");
    else if (latestRun || rememberedSessionId) statuses.set(node.id, "incomplete");
  }

  const markDependenciesComplete = (nodeId, seen = new Set()) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = graph.nodes.find((item) => item.id === nodeId);
    for (const dependency of node?.dependsOn || []) {
      if (statuses.get(dependency) !== "running") statuses.set(dependency, "complete");
      markDependenciesComplete(dependency, seen);
    }
  };
  for (const [nodeId, status] of statuses) {
    if (status === "running" || status === "complete") markDependenciesComplete(nodeId);
  }

  if (historyChanged) saveNodeHistory();
  return statuses;
}

function statusLabel(status) {
  if (status === "complete") return "Complete";
  if (status === "running") return "Running";
  if (status === "incomplete") return "Incomplete";
  return "Planned";
}

function renderGraphLegend() {
  $("#graphLegend").replaceChildren(
    el("span", { class: "legend-item" }, el("span", { class: "legend-shape agent" }), "Agent"),
    el("span", { class: "legend-item" }, el("span", { class: "legend-shape slot" }), "Task"),
    el("span", { class: "legend-item" }, el("span", { class: "legend-dot running" }), "Running"),
    el("span", { class: "legend-item" }, el("span", { class: "legend-dot complete" }), "Complete"),
    el("span", { class: "legend-item" }, el("span", { class: "legend-dot incomplete" }), "Incomplete"),
    el("span", { class: "legend-item" }, el("span", { class: "legend-dot planned" }), "Planned"));
}

function renderGraphHeading() {
  const project = currentProject();
  const graph = currentGraph();
  if (!project || !graph) {
    $("#graphTitle").textContent = "No saved graph";
    $("#graphGoal").textContent = "Graph plans appear here after an advisor saves one.";
    $("#graphStats").replaceChildren();
    $("#graphEmpty").hidden = false;
    return;
  }
  $("#graphEmpty").hidden = true;
  const workstream = project.workstreams.find((item) => item.name === graph.workstream);
  $("#workstreamStatus").textContent = workstream
    ? `${workstream.name} · ${workstream.status || "unknown"}`
    : graph.workstream || "Work graph";
  $("#graphTitle").textContent = graph.graphId;
  $("#graphGoal").textContent = graph.goal || "No graph goal recorded.";

  const statuses = computeNodeStatuses(project, graph);
  const attachedAgentCount = graph.nodes.reduce((count, node) => count + agentRecordsForNode(project, graph, node).length, 0);
  const standaloneAgents = standaloneLiveAgents(project, graph);
  const standaloneAgentCount = standaloneAgents.length;
  const agentCount = attachedAgentCount + standaloneAgentCount;
  const complete = [...statuses.values()].filter((status) => status === "complete").length;
  const running = [...statuses.values()].filter((status) => status === "running").length;
  const incomplete = [...statuses.values()].filter((status) => status === "incomplete").length;
  const planned = graph.nodes.length - complete - running - incomplete;
  const dependencyConnections = graph.nodes.reduce((count, node) => count + (node.dependsOn?.length || 0), 0);
  const rootCount = graph.nodes.filter((node) => !(node.dependsOn || []).length).length;
  const advisorConnections = standaloneAgents.filter((record) => record.relation === "advisor").length * rootCount;
  const connections = dependencyConnections + attachedAgentCount + advisorConnections;
  const stats = [
    el("span", { class: "stat" }, `${agentCount} agents shown`),
    el("span", { class: "stat" }, `${graph.nodes.length} nodes`),
    el("span", { class: "stat" }, `${graph.waves?.length || 1} ${(graph.waves?.length || 1) === 1 ? "wave" : "waves"}`),
    el("span", { class: "stat" }, `${connections} connections`),
    el("span", { class: `stat${running ? " live" : ""}` }, `${running} running`),
    el("span", { class: "stat" }, `${complete} complete`),
    el("span", { class: "stat" }, `${incomplete} incomplete`),
    el("span", { class: "stat" }, `${planned} planned`),
  ];
  $("#graphStats").replaceChildren(...stats);
  renderGraphLegend();
}

function cytoscapeElements(project, graph, statuses) {
  const waves = graph.waves?.length ? graph.waves : [graph.nodes.map((node) => node.id)];
  const recordsByNode = new Map(graph.nodes.map((node) => {
    const nodeStatus = statuses.get(node.id) || "planned";
    return [node.id, visibleAgentRecordsForNode(project, graph, node, nodeStatus)];
  }));
  const groupHeight = (nodeId) => 72 + (recordsByNode.get(nodeId)?.length || 1) * 78;
  const waveHeight = (wave) => wave.reduce((height, nodeId) => height + groupHeight(nodeId), 0)
    + Math.max(0, wave.length - 1) * 34;
  const maxWaveHeight = Math.max(...waves.map(waveHeight), 150);
  const positions = new Map();
  const waveLabels = [];
  const taskNodes = [];
  const agentNodes = [];
  const assignmentEdges = [];

  waves.forEach((wave, waveIndex) => {
    const x = waveIndex * 370;
    let cursorY = 104 + (maxWaveHeight - waveHeight(wave)) / 2;
    waveLabels.push({
      data: { id: `__wave_${waveIndex}`, kind: "wave", label: `Wave ${waveIndex + 1}` },
      position: { x, y: 22 },
      selectable: false,
      grabbable: false,
    });
    wave.forEach((nodeId) => {
      const node = graph.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      const nodeStatus = statuses.get(node.id) || "planned";
      positions.set(node.id, { x, y: cursorY + 25 });
      taskNodes.push({
        data: {
          id: node.id,
          kind: "slot",
          label: taskNodeLabel(node, nodeStatus),
          state: nodeStatus,
          statusColor: nodeStatus === "running" ? "#f5c86c" : "#566174",
        },
        position: positions.get(node.id),
      });
      (recordsByNode.get(node.id) || []).forEach((record, index) => {
        const id = agentElementId(node.id, record, index);
        const liveSession = record.kind === "live" ? agentSessions().find((session) => session.id === record.id) : null;
        agentNodes.push({
          data: {
            id,
            kind: "agent",
            recordKind: record.kind,
            agentId: record.id,
            taskNodeId: node.id,
            liveSessionId: liveSession?.id || "",
            label: agentRecordLabel(record),
            state: record.status,
            statusColor: liveSession ? statusColor(liveSession.status) : "#f5c86c",
          },
          position: { x: x + 28, y: cursorY + 92 + index * 78 },
        });
        assignmentEdges.push({
          data: {
            id: `__assignment::${node.id}::${id}`,
            kind: "assignment",
            source: node.id,
            target: id,
            state: record.status,
          },
        });
      });
      cursorY += groupHeight(node.id) + 34;
    });
  });

  const standalone = standaloneLiveAgents(project, graph);
  const laneNodes = [];
  const standaloneNodes = [];
  const oversightEdges = [];
  const roots = graph.nodes.filter((node) => !(node.dependsOn || []).length);
  let laneY = 22;
  for (const relation of ["advisor", "unassigned"]) {
    const records = standalone.filter((record) => record.relation === relation);
    if (!records.length) continue;
    laneNodes.push({
      data: {
        id: `__lane_${relation}`,
        kind: "lane",
        label: relation === "advisor" ? "Graph advisor" : "Unassigned live agents",
      },
      position: { x: -390, y: laneY },
      selectable: false,
      grabbable: false,
    });
    laneY += 74;
    records.forEach((record, index) => {
      const id = agentElementId("", record, index);
      const session = agentSessions().find((item) => item.id === record.id);
      standaloneNodes.push({
        data: {
          id,
          kind: "agent",
          recordKind: "live",
          relation,
          agentId: record.id,
          taskNodeId: "",
          liveSessionId: record.id,
          label: agentRecordLabel(record),
          state: "running",
          statusColor: session ? statusColor(session.status) : "#f5c86c",
        },
        position: { x: -390, y: laneY + index * 82 },
      });
      if (relation === "advisor") {
        roots.forEach((root) => oversightEdges.push({
          data: {
            id: `__oversight::${id}::${root.id}`,
            kind: "oversight",
            source: id,
            target: root.id,
            state: "running",
          },
        }));
      }
    });
    laneY += records.length * 82 + 54;
  }

  const dependencyEdges = graph.nodes.flatMap((node) => (node.dependsOn || []).map((dependency) => ({
    data: {
      id: `${dependency}->${node.id}`,
      kind: "dependency",
      source: dependency,
      target: node.id,
      state: statuses.get(node.id) || "planned",
    },
  })));
  return [
    ...waveLabels,
    ...laneNodes,
    ...taskNodes,
    ...agentNodes,
    ...standaloneNodes,
    ...dependencyEdges,
    ...assignmentEdges,
    ...oversightEdges,
  ];
}

function updateGraphActivity(graph) {
  if (!cy) return;
  const project = currentProject();
  if (!project) return;
  const statuses = computeNodeStatuses(project, graph);
  cy.batch(() => {
    for (const node of graph.nodes) {
      const nodeStatus = statuses.get(node.id) || "planned";
      cy.getElementById(node.id).data({ label: taskNodeLabel(node, nodeStatus), state: nodeStatus });
      visibleAgentRecordsForNode(project, graph, node, nodeStatus).forEach((record, index) => {
        const element = cy.getElementById(agentElementId(node.id, record, index));
        if (element.length) element.data({ label: agentRecordLabel(record), state: record.status });
      });
    }
    for (const edge of cy.edges('[kind = "dependency"]')) {
      edge.data("state", statuses.get(edge.target().id()) || "planned");
    }
  });
}

function renderGraphCanvas() {
  const graph = currentGraph();
  if (!graph || typeof window.cytoscape !== "function") {
    cy?.destroy();
    cy = null;
    renderedGraphKey = null;
    return;
  }
  const project = currentProject();
  const statuses = computeNodeStatuses(project, graph);
  const statusSignature = graph.nodes.map((node) => `${node.id}:${statuses.get(node.id) || "planned"}`).join("|");
  const graphKey = `${project?.key || ""}:${graph.graphId}:${graph.mtime || graph.createdAt || ""}:${graph.nodes.map((node) => node.id).join(",")}:${statusSignature}:${topologySignature(project, graph)}`;
  if (cy && renderedGraphKey === graphKey) {
    updateGraphActivity(graph);
    return;
  }
  cy?.destroy();
  renderedGraphKey = graphKey;
  cy = window.cytoscape({
    container: $("#graphCanvas"),
    elements: cytoscapeElements(project, graph, statuses),
    minZoom: 0.2,
    maxZoom: 2.4,
    boxSelectionEnabled: false,
    style: [
      {
        selector: 'node[kind = "slot"]',
        style: {
          shape: "round-rectangle",
          width: 218,
          height: 50,
          "background-color": "#111822",
          "border-color": "#465263",
          "border-width": 1,
          "border-style": "dashed",
          label: "data(label)",
          color: "#b8c3d0",
          "font-family": "Inter, -apple-system, sans-serif",
          "font-size": 9,
          "font-weight": 600,
          "line-height": 1.45,
          "text-wrap": "wrap",
          "text-valign": "center",
          "text-halign": "center",
          "text-transform": "none",
          "overlay-opacity": 0,
          "transition-property": "border-color, opacity, background-color",
          "transition-duration": "140ms",
        },
      },
      {
        selector: 'node[kind = "agent"]',
        style: {
          shape: "round-rectangle",
          width: 240,
          height: 68,
          "background-color": "#1a2431",
          "border-color": "#465468",
          "border-width": 1.5,
          label: "data(label)",
          color: "#e5edf5",
          "font-family": "Inter, -apple-system, sans-serif",
          "font-size": 10,
          "font-weight": 600,
          "line-height": 1.4,
          "text-wrap": "wrap",
          "text-max-width": 218,
          "text-valign": "center",
          "text-halign": "center",
          "overlay-opacity": 0,
          "transition-property": "border-color, opacity, background-color",
          "transition-duration": "140ms",
        },
      },
      {
        selector: 'node[kind = "agent"][relation = "advisor"]',
        style: {
          "background-color": "#20243a",
          "border-color": "#9da8ff",
          "border-width": 2,
        },
      },
      {
        selector: 'node[kind = "agent"][relation = "unassigned"]',
        style: { "border-style": "dashed", "background-color": "#171e28" },
      },
      {
        selector: 'node[state = "running"]',
        style: {
          "border-color": "data(statusColor)",
          "border-width": 2,
          "background-color": "#1c2633",
        },
      },
      {
        selector: 'node[state = "complete"]',
        style: {
          "border-color": "#5dd6b3",
          "border-width": 2,
          "background-color": "#17272a",
        },
      },
      { selector: 'node[state = "incomplete"]', style: { "border-color": "#a96468", opacity: 0.86 } },
      { selector: 'node[state = "planned"]', style: { opacity: 0.72 } },
      { selector: "node:selected", style: { "border-color": "#9da8ff", "border-width": 2, opacity: 1 } },
      {
        selector: 'node[kind = "wave"]',
        style: {
          width: 120,
          height: 24,
          "background-opacity": 0,
          "border-width": 0,
          label: "data(label)",
          color: "#91a0b3",
          "font-family": "Inter, -apple-system, sans-serif",
          "font-size": 11,
          "font-weight": 700,
          "text-transform": "uppercase",
          "text-valign": "center",
          "text-halign": "center",
          "events": "no",
        },
      },
      {
        selector: 'node[kind = "lane"]',
        style: {
          width: 230,
          height: 24,
          "background-opacity": 0,
          "border-width": 0,
          label: "data(label)",
          color: "#aeb7ff",
          "font-family": "Inter, -apple-system, sans-serif",
          "font-size": 11,
          "font-weight": 700,
          "text-transform": "uppercase",
          "text-valign": "center",
          "text-halign": "center",
          "events": "no",
        },
      },
      {
        selector: 'edge[kind = "dependency"]',
        style: {
          width: 1.5,
          "line-color": "#354151",
          "target-arrow-color": "#354151",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.7,
          "curve-style": "bezier",
          "control-point-step-size": 58,
          opacity: 0.72,
        },
      },
      {
        selector: 'edge[kind = "assignment"]',
        style: {
          width: 1,
          "line-color": "#465468",
          "line-style": "dotted",
          "target-arrow-shape": "none",
          "curve-style": "bezier",
          opacity: 0.62,
        },
      },
      {
        selector: 'edge[kind = "oversight"]',
        style: {
          width: 1.5,
          "line-color": "#727dc9",
          "line-style": "dashed",
          "target-arrow-color": "#727dc9",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.65,
          "curve-style": "unbundled-bezier",
          "control-point-distances": 70,
          "control-point-weights": 0.45,
          opacity: 0.72,
        },
      },
      {
        selector: 'edge[kind = "dependency"][state = "running"]',
        style: {
          width: 2,
          "line-color": "#7c8ce8",
          "target-arrow-color": "#7c8ce8",
          opacity: 0.95,
        },
      },
      {
        selector: 'edge[kind = "dependency"][state = "complete"]',
        style: {
          "line-color": "#4e9f8a",
          "target-arrow-color": "#4e9f8a",
          opacity: 0.85,
        },
      },
    ],
    layout: {
      name: "preset",
      padding: 64,
      animate: false,
      fit: true,
    },
  });
  cy.on("tap", "node", (event) => {
    const element = event.target;
    const kind = element.data("kind");
    if (kind === "slot") {
      const node = graph.nodes.find((item) => item.id === element.id());
      if (node) openNodeDetail(node);
      return;
    }
    if (kind !== "agent") return;
    const liveSessionId = element.data("liveSessionId");
    const session = liveSessionId ? agentSessions().find((item) => item.id === liveSessionId) : null;
    if (session) {
      openSessionDetail(session);
      return;
    }
    const taskNodeId = element.data("taskNodeId");
    const node = taskNodeId ? graph.nodes.find((item) => item.id === taskNodeId) : null;
    if (node) openNodeDetail(node);
  });
  requestAnimationFrame(() => cy?.fit(undefined, 52));
}

function renderRuns() {
  const project = currentProject();
  const runs = project?.runs ?? [];
  const visible = showAllRuns ? runs : runs.slice(0, RUN_PREVIEW_COUNT);
  $("#toggleRuns").hidden = runs.length <= RUN_PREVIEW_COUNT;
  $("#toggleRuns").textContent = showAllRuns ? "Show less" : `Show all ${runs.length}`;
  if (!visible.length) {
    $("#recentRuns").replaceChildren(el("div", { class: "empty-state" }, "No worker runs recorded for this project."));
    return;
  }
  const cards = visible.map((run) => {
    const session = agentSessions().find((item) => item.id === run.sessionId);
    let runStatus = "pending";
    if (session && activityTier(session) === "active") runStatus = "live";
    else if (run.resultState === "complete") runStatus = "done";
    else if (run.resultState === "running") runStatus = "running";
    return el("article", { class: "run-card" },
      el("div", { class: "run-top" },
        el("span", { class: "run-role" }, run.role || "worker"),
        el("span", { class: `run-status ${runStatus}` }, runStatus)),
      el("div", { class: "run-meta" }, `${shortModel(run.model)} · ${humanAge(Math.max(0, (state?.now ?? Date.now()) - run.mtime))}`));
  });
  $("#recentRuns").replaceChildren(...cards);
}

function sessionRow(session) {
  const kind = statusKind(session.status);
  return el("button", { class: "session-row", type: "button", onclick: () => openSessionDetail(session) },
    el("span", { class: `agent-dot ${kind}` }),
    el("span", { class: "session-row-copy" },
      el("span", { class: "session-row-name" }, session.name || session.id.slice(0, 8)),
      el("span", { class: "session-row-meta" }, `${projectName(session.cwd)} · ${shortModel(session.model)} · ${session.status || "idle"}`)),
    el("span", { class: "session-row-age" }, humanAge(ageMs(session))));
}

function renderSessionGroups() {
  const query = $("#sessionSearch").value.trim().toLowerCase();
  const filtered = agentSessions().filter((session) => {
    const haystack = `${session.name || ""} ${session.cwd || ""} ${session.model || ""}`.toLowerCase();
    return haystack.includes(query);
  });
  const definitions = [
    ["active", "Active now", "Working or active in the last 2 minutes"],
    ["recent", "Recent", "Idle for 2–30 minutes"],
    ["dormant", "Dormant", "Idle for more than 30 minutes"],
  ];
  const groups = definitions.map(([tier, title, note]) => {
    const sessions = filtered
      .filter((session) => activityTier(session) === tier)
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    if (!sessions.length) return null;
    return el("section", { class: "session-group" },
      el("div", { class: "session-group-head" }, el("h3", {}, title), el("span", {}, `${sessions.length} · ${note}`)),
      el("div", { class: "session-list" }, sessions.map(sessionRow)));
  }).filter(Boolean);
  $("#sessionGroups").replaceChildren(...groups);
}

function openDrawer(drawer) {
  $("#sessionDrawer").classList.remove("open");
  $("#detailDrawer").classList.remove("open");
  $("#sessionDrawer").setAttribute("aria-hidden", "true");
  $("#detailDrawer").setAttribute("aria-hidden", "true");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
}

function closeDrawers() {
  $("#sessionDrawer").classList.remove("open");
  $("#detailDrawer").classList.remove("open");
  $("#sessionDrawer").setAttribute("aria-hidden", "true");
  $("#detailDrawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
  selectedMessageTarget = null;
}

function detailSection(title, content) {
  return el("section", { class: "detail-section" }, el("h3", {}, title), content);
}

function agentRecordCard(record) {
  return el("article", { class: "agent-record" },
    el("span", { class: `legend-dot ${record.status}` }),
    el("span", { class: "agent-record-copy" },
      el("strong", {}, record.name),
      el("span", {}, `${record.model} · ${statusLabel(record.status)}`)),
    el("span", { class: "agent-record-age" }, record.age));
}

function openNodeDetail(node) {
  const session = matchNodeSession(node);
  const project = currentProject();
  const graph = currentGraph();
  const nodeStatus = project && graph ? computeNodeStatuses(project, graph).get(node.id) || "planned" : "planned";
  const agents = project && graph ? visibleAgentRecordsForNode(project, graph, node, nodeStatus) : [];
  $("#detailEyebrow").textContent = node.role || "Graph node";
  $("#detailTitle").textContent = node.id;
  const body = [
    el("span", { class: "detail-chip" }, session
      ? `${statusLabel(nodeStatus)} · ${session.status || "idle"} · ${shortModel(session.model)}`
      : statusLabel(nodeStatus)),
    detailSection("Agents", el("div", { class: "agent-records" }, agents.map(agentRecordCard))),
    detailSection("Task", el("p", {}, node.task || "No task text recorded.")),
    detailSection("Completion anchor", el("p", {}, node.anchor || "No anchor recorded.")),
  ];
  if (node.dependsOn?.length) {
    body.push(detailSection("Depends on", el("div", { class: "detail-deps" }, node.dependsOn.map((item) => el("span", {}, item)))));
  }
  $("#detailBody").replaceChildren(...body);
  configureMessaging(session || null);
  openDrawer($("#detailDrawer"));
}

function openSessionDetail(session) {
  const graphMatch = findGraphForSession(session);
  $("#detailEyebrow").textContent = activityTier(session) === "active" ? "Active session" : "Session";
  $("#detailTitle").textContent = session.name || session.id.slice(0, 12);
  $("#detailBody").replaceChildren(
    el("span", { class: "detail-chip" }, `${session.status || "idle"} · ${humanAge(ageMs(session))}`),
    graphMatch
      ? el("button", { class: "primary-button", type: "button", style: "margin-top:16px", onclick: () => focusGraphForSession(session) },
          `View full graph · ${graphMatch.graph.graphId}`)
      : null,
    detailSection("Project", el("p", {}, session.cwd || "Unknown directory")),
    detailSection("Model", el("p", {}, shortModel(session.model))),
    session.contextPct != null
      ? detailSection("Context", el("p", {}, `${session.contextPct}% · ${(session.contextTokens || 0).toLocaleString()} tokens`))
      : null);
  configureMessaging(session);
  openDrawer($("#detailDrawer"));
}

function configureMessaging(session) {
  selectedMessageTarget = session;
  $("#messageForm").hidden = !session;
  $("#messageText").value = "";
  $("#expectsReply").checked = false;
  $("#messageStatus").textContent = "";
  $("#messageStatus").className = "message-status";
  renderEvents(session);
}

function renderEvents(session) {
  if (!session) {
    $("#eventLog").replaceChildren();
    return;
  }
  const events = (state?.events ?? []).filter((event) =>
    event.to === session.id || event.from?.id === session.id || event.session?.id === session.id).slice(-8).reverse();
  if (!events.length) {
    $("#eventLog").replaceChildren();
    return;
  }
  $("#eventLog").replaceChildren(...events.map((event) => {
    const direction = event.kind === "message" ? "Received" : event.kind === "sent" ? "Sent" : event.kind;
    const text = event.text ? ` · ${event.text}` : event.status ? ` · ${event.status}` : "";
    return el("div", { class: "event-row" }, `${direction}${text}`);
  }));
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $("#messageText").value.trim();
  if (!selectedMessageTarget || !text) return;
  const status = $("#messageStatus");
  $("#sendMessage").disabled = true;
  status.className = "message-status";
  status.textContent = "Sending…";
  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: selectedMessageTarget.id,
        text,
        expectsReply: $("#expectsReply").checked,
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.reason || `Request failed (${response.status})`);
    $("#messageText").value = "";
    status.className = "message-status success";
    status.textContent = "Delivered";
  } catch (error) {
    status.className = "message-status error";
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    $("#sendMessage").disabled = false;
  }
}

function render() {
  renderConnection();
  renderActiveSessions();
  syncSelectors();
  renderGraphLibrary();
  renderGraphHeading();
  renderGraphCanvas();
  renderRuns();
  if ($("#sessionDrawer").classList.contains("open")) renderSessionGroups();
}

async function poll() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`State request failed (${response.status})`);
    state = await response.json();
    render();
  } catch (error) {
    if (!state) {
      state = { now: Date.now(), broker: { connected: false }, sessions: [], projects: [], events: [] };
    } else {
      state.broker.connected = false;
    }
    renderConnection();
  }
}

$("#graphSearch").addEventListener("input", renderGraphLibrary);
$("#collapseGraphLibrary").addEventListener("click", () => setGraphLibraryCollapsed(true));
$("#openGraphLibrary").addEventListener("click", () => setGraphLibraryCollapsed(false));
$("#projectSelect").addEventListener("change", (event) => {
  selectedProjectKey = event.target.value;
  selectedGraphId = null;
  showAllRuns = false;
  syncSelectors();
  renderGraphHeading();
  renderGraphCanvas();
  renderRuns();
});
$("#graphSelect").addEventListener("change", (event) => {
  selectedGraphId = event.target.value;
  renderGraphHeading();
  renderGraphCanvas();
});
$("#zoomIn").addEventListener("click", () => cy?.zoom({ level: Math.min(cy.zoom() * 1.2, 2.4), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));
$("#zoomOut").addEventListener("click", () => cy?.zoom({ level: Math.max(cy.zoom() / 1.2, 0.2), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));
$("#fitGraph").addEventListener("click", () => cy?.fit(undefined, 52));
$("#toggleRuns").addEventListener("click", () => { showAllRuns = !showAllRuns; renderRuns(); });
$("#openSessions").addEventListener("click", () => { renderSessionGroups(); openDrawer($("#sessionDrawer")); });
$("#sessionSearch").addEventListener("input", renderSessionGroups);
$("#scrim").addEventListener("click", closeDrawers);
$(".close-drawer").addEventListener("click", closeDrawers);
$(".close-detail").addEventListener("click", closeDrawers);
$("#messageForm").addEventListener("submit", sendMessage);
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawers(); });
window.addEventListener("resize", () => cy?.resize());

poll();
setInterval(poll, POLL_MS);
