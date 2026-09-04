const $ = (selector) => document.querySelector(selector);

const elements = {
  page: $("#page"),
  refreshState: $("#refresh-state"),
  generatedAt: $("#generated-at"),
  caseFilter: $("#case-filter"),
  runList: $("#run-list"),
  before: $("#before-select"),
  after: $("#after-select"),
  verdict: $("#verdict"),
  empty: $("#comparison-empty"),
  content: $("#comparison-content"),
  ruler: $("#trajectory-ruler"),
  checks: $("#checks-table"),
  evidenceEmpty: $("#evidence-empty"),
  evidenceList: $("#evidence-list"),
  dialog: $("#search-dialog"),
  searchInput: $("#search-input"),
  searchResults: $("#search-results"),
};

let snapshot = { cases: [], runs: [], baselines: [] };
let selectedArtifactKey = "";
let searchItems = [];
let searchIndex = 0;

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function artifacts() {
  return [...snapshot.baselines, ...snapshot.runs];
}

function artifactByKey(key) {
  return artifacts().find((artifact) => artifact.key === key);
}

function artifactTitle(artifact) {
  const label = artifact.manifest?.candidate?.label;
  if (artifact.kind === "baseline") return `${artifact.id} · baseline`;
  return `${label && label !== "working-tree" ? `${label} · ` : ""}${artifact.id}`;
}

function short(value, length = 12) {
  if (!value) return "—";
  return String(value).length > length ? `${String(value).slice(0, length)}…` : String(value);
}

function workingTreeLabel(dirty) {
  if (dirty === undefined) return "—";
  return dirty ? "dirty" : "clean";
}

function duration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

function renderSummary() {
  $("#summary-cases").textContent = snapshot.cases.length;
  $("#summary-runs").textContent = snapshot.runs.length;
  $("#summary-baselines").textContent = snapshot.baselines.length;
  const complete = snapshot.runs.filter((run) => run.result);
  const passed = complete.filter((run) => run.result.status === "passed").length;
  $("#summary-pass-rate").textContent = complete.length ? `${Math.round((passed / complete.length) * 100)}%` : "—";
}

function optionFor(artifact) {
  const incomplete = !artifact.result;
  return node(
    "option",
    { value: artifact.key, disabled: incomplete || undefined },
    `${artifact.manifest?.case?.id ?? "unknown"} · ${artifactTitle(artifact)}${incomplete ? " · running" : ""}`,
  );
}

function renderSelectors() {
  const previousBefore = elements.before.value;
  const previousAfter = elements.after.value;
  elements.before.replaceChildren(node("option", { value: "" }, "Choose baseline or run"));
  elements.after.replaceChildren(node("option", { value: "" }, "Choose newer run"));
  const baselineGroup = node("optgroup", { label: "Promoted baselines" });
  for (const artifact of snapshot.baselines) baselineGroup.append(optionFor(artifact));
  elements.before.append(baselineGroup);
  const runBeforeGroup = node("optgroup", { label: "Stored runs" });
  const runAfterGroup = node("optgroup", { label: "Stored runs" });
  for (const artifact of snapshot.runs.filter((run) => run.result)) {
    runBeforeGroup.append(optionFor(artifact));
    runAfterGroup.append(optionFor(artifact));
  }
  elements.before.append(runBeforeGroup);
  elements.after.append(runAfterGroup);
  const incomplete = snapshot.runs.filter((run) => !run.result);
  if (incomplete.length) {
    const incompleteGroup = node("optgroup", { label: "Running — not comparable" });
    for (const artifact of incomplete) incompleteGroup.append(optionFor(artifact));
    elements.before.append(incompleteGroup);
  }
  if (artifactByKey(previousBefore)?.result) elements.before.value = previousBefore;
  else if (snapshot.baselines[0]) elements.before.value = snapshot.baselines[0].key;
  if (artifactByKey(previousAfter)?.result) elements.after.value = previousAfter;
}

function dimensionSummary(result, dimension) {
  const summary = result?.dimensions?.[dimension];
  if (!summary || !summary.total) return "—";
  return `${summary.passed}/${summary.total} passed`;
}

function selectEvidence(key) {
  selectedArtifactKey = key;
  const artifact = artifactByKey(key);
  for (const row of elements.runList.querySelectorAll(".run-row")) row.dataset.selected = String(row.dataset.key === key);
  if (!artifact) {
    elements.evidenceEmpty.hidden = false;
    elements.evidenceList.hidden = true;
    return;
  }
  const candidate = artifact.manifest?.candidate ?? {};
  const diagnostics = artifact.diagnostics ?? {};
  const fields = [
    ["Kind", artifact.kind],
    ["Case", artifact.manifest?.case?.id],
    ["Setup name", candidate.label ?? "unlabelled"],
    ["Revision", short(candidate.revision, 16)],
    ["Working tree", workingTreeLabel(candidate.dirty)],
    ["Fingerprint", short(candidate.fingerprint?.value, 18)],
    ["Profile", candidate.profile],
    ["Model", candidate.model],
    ["Thinking", candidate.thinking],
    ["Status", artifact.result?.status ?? "incomplete"],
    ["Reward", artifact.result?.reward],
    ["Functional outcome", dimensionSummary(artifact.result, "workspace")],
    ["Orchestration", dimensionSummary(artifact.result, "orchestration")],
    ["Measurement/control", dimensionSummary(artifact.result, "measurement")],
    ["Events", diagnostics.events],
    ["Wall time", duration(diagnostics.elapsed?.wallElapsedMs)],
    ["Active time", duration(diagnostics.elapsed?.activeElapsedMs)],
    ["Blocked on user", diagnostics.elapsed?.blockedOnUserMs ? duration(diagnostics.elapsed.blockedOnUserMs) : "—"],
    ["Role launches", Object.entries(diagnostics.roleLaunches ?? {}).map(([role, count]) => `${role} ${count}`).join(" · ") || "—"],
    ["Useful width", artifact.result?.parallelism ? `${artifact.result.parallelism.observedUsefulWidth}/${artifact.result.parallelism.expectedMaxUsefulWidth} · ${artifact.result.parallelism.status}` : "—"],
  ];
  elements.evidenceList.replaceChildren(...fields.flatMap(([term, detail]) => [node("dt", {}, term), node("dd", {}, detail ?? "—")]));
  elements.evidenceEmpty.hidden = true;
  elements.evidenceList.hidden = false;
}

function renderRunList() {
  const caseId = elements.caseFilter.value;
  const visible = artifacts().filter((artifact) => !caseId || artifact.manifest?.case?.id === caseId);
  if (!visible.length) {
    elements.runList.replaceChildren(node("p", { className: "evidence-empty" }, "No artifacts match this case."));
    return;
  }
  elements.runList.replaceChildren(...visible.map((artifact) => node("button", {
    className: "run-row",
    type: "button",
    dataset: {
      key: artifact.key,
      status: artifact.result?.status ?? "incomplete",
      selected: String(artifact.key === selectedArtifactKey),
    },
    onClick: () => selectEvidence(artifact.key),
  },
  node("span", { className: "run-row__status", "aria-hidden": "true" }),
  node("span", { className: "run-row__copy" },
    node("span", { className: "run-row__title" }, artifactTitle(artifact)),
    node(
      "span",
      { className: "run-row__meta" },
      `${artifact.manifest?.case?.id ?? "unknown"} · outcome ${dimensionSummary(artifact.result, "workspace")} · orchestration ${dimensionSummary(artifact.result, "orchestration")} · measurement ${dimensionSummary(artifact.result, "measurement")}`,
    ),
  ))));
}

function renderCaseFilter() {
  const previous = elements.caseFilter.value;
  elements.caseFilter.replaceChildren(node("option", { value: "" }, "All cases"));
  for (const prospectiveCase of snapshot.cases) elements.caseFilter.append(node("option", { value: prospectiveCase.id }, prospectiveCase.title));
  elements.caseFilter.value = snapshot.cases.some((prospectiveCase) => prospectiveCase.id === previous) ? previous : "";
}

function metricTone(metric, before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return "neutral";
  if (metric === "Reward") return after > before ? "better" : "worse";
  return "neutral";
}

function renderRuler(comparison) {
  const dimension = (name, side) => {
    const value = comparison.dimensions?.[name]?.[side];
    if (!value?.total) return "—";
    const verdict = side === "after" ? comparison.dimensions?.[name]?.verdict : undefined;
    return `${value.passed}/${value.total}${verdict ? ` · ${verdict}` : ""}`;
  };
  const rows = [
    ["Status", comparison.before.status, comparison.after.status],
    ["Reward", comparison.before.reward, comparison.after.reward],
    ["Functional outcome", dimension("workspace", "before"), dimension("workspace", "after")],
    ["Orchestration", dimension("orchestration", "before"), dimension("orchestration", "after")],
    ["Measurement/control", dimension("measurement", "before"), dimension("measurement", "after")],
    ["Check contract", "before", comparison.comparability?.status ?? "same"],
    ["Events", comparison.process.events.before, comparison.process.events.after],
    ["Worker launches", comparison.process.launches.before, comparison.process.launches.after],
    ["Useful width", comparison.process.parallelism?.before ? `${comparison.process.parallelism.before.observedUsefulWidth}/${comparison.process.parallelism.before.expectedMaxUsefulWidth}` : "—", comparison.process.parallelism?.after ? `${comparison.process.parallelism.after.observedUsefulWidth}/${comparison.process.parallelism.after.expectedMaxUsefulWidth}` : "—"],
    ["Wall time", duration(comparison.process.wallElapsedMs.before), duration(comparison.process.wallElapsedMs.after)],
    ["Active time", duration(comparison.process.activeElapsedMs.before), duration(comparison.process.activeElapsedMs.after)],
    ["Blocked on user", duration(comparison.process.blockedOnUserMs?.before ?? 0), duration(comparison.process.blockedOnUserMs?.after ?? 0)],
  ];
  const grid = node("div", { className: "ruler-grid" },
    node("div", { className: "ruler-label" }, "Measure"),
    node("div", { className: "ruler-label" }, "Before"),
    node("div", { className: "ruler-label" }, "After"),
  );
  for (const [label, before, after] of rows) {
    grid.append(
      node("div", { className: "ruler-label" }, label),
      node("div", { className: "ruler-value" }, before ?? "—"),
      node("div", { className: "ruler-value", dataset: { tone: metricTone(label, before, after) } }, after ?? "—"),
    );
  }
  elements.ruler.replaceChildren(grid);
}

function checkMark(passed) {
  if (passed === undefined) return "NOT RECORDED";
  return passed ? "PASS" : "FAIL";
}

function renderChecks(comparison) {
  const cell = (passed, evidence) => node(
    "div",
    { className: "check-cell", dataset: { pass: passed === undefined ? "missing" : String(passed) } },
    node("span", { className: "check-mark", "aria-hidden": "true" }, checkMark(passed)),
    node("span", { className: "check-evidence" }, evidence ?? "No evidence recorded"),
  );
  elements.checks.replaceChildren(...comparison.checks.map((check) => node("div", { className: "check-row" },
    node("div", { className: "check-row__name" }, check.id),
    cell(check.before, check.beforeEvidence),
    cell(check.after, check.afterEvidence),
  )));
}

async function renderComparison() {
  const before = elements.before.value;
  const after = elements.after.value;
  if (!before || !after) {
    elements.verdict.textContent = "Select two runs";
    elements.verdict.dataset.verdict = "empty";
    elements.empty.hidden = false;
    elements.content.hidden = true;
    return;
  }
  elements.verdict.textContent = "Comparing…";
  elements.verdict.dataset.verdict = "empty";
  try {
    const response = await fetch(`/api/compare?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`);
    const comparison = await response.json();
    if (!response.ok) throw new Error(comparison.error ?? "Comparison failed");
    elements.verdict.textContent = `${comparison.verdict}${comparison.comparability?.status === "changed" ? " · check contract changed" : ""}`;
    elements.verdict.dataset.verdict = comparison.verdict;
    elements.empty.hidden = true;
    elements.content.hidden = false;
    renderRuler(comparison);
    renderChecks(comparison);
  } catch (error) {
    elements.verdict.textContent = "Cannot compare";
    elements.verdict.dataset.verdict = "regressed";
    elements.empty.replaceChildren(
      node("span", { className: "empty-state__glyph", "aria-hidden": "true" }, "×"),
      node("h3", {}, "Comparison unavailable"),
      node("p", {}, error instanceof Error ? error.message : String(error)),
    );
    elements.empty.hidden = false;
    elements.content.hidden = true;
  }
}

function searchableItems() {
  const caseItems = snapshot.cases.map((prospectiveCase) => ({ kind: "case", key: prospectiveCase.id, title: prospectiveCase.title, meta: prospectiveCase.id }));
  const artifactItems = artifacts().map((artifact) => ({ kind: "artifact", key: artifact.key, title: artifactTitle(artifact), meta: `${artifact.manifest?.case?.id ?? "unknown"} · ${artifact.result?.status ?? "incomplete"}` }));
  return [...artifactItems, ...caseItems];
}

function renderSearch() {
  const query = elements.searchInput.value.trim().toLowerCase();
  searchItems = searchableItems().filter((item) => !query || `${item.title} ${item.meta}`.toLowerCase().includes(query)).slice(0, 24);
  searchIndex = Math.min(searchIndex, Math.max(0, searchItems.length - 1));
  if (!searchItems.length) {
    elements.searchResults.replaceChildren(node("div", { className: "command-empty" }, "No matching runs or cases."));
    return;
  }
  elements.searchResults.replaceChildren(...searchItems.map((item, index) => node("button", {
    className: "command-item",
    type: "button",
    role: "option",
    dataset: { active: String(index === searchIndex) },
    "aria-selected": String(index === searchIndex),
    onClick: () => activateSearchItem(item),
  }, node("span", {}, item.title), node("span", {}, item.meta))));
}

function activateSearchItem(item) {
  elements.dialog.close();
  elements.page.inert = false;
  if (item.kind === "case") {
    elements.caseFilter.value = item.key;
    renderRunList();
    return;
  }
  selectEvidence(item.key);
}

function openSearch() {
  searchIndex = 0;
  elements.searchInput.value = "";
  renderSearch();
  elements.page.inert = true;
  elements.dialog.showModal();
  elements.searchInput.focus();
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refreshState.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`State request exited ${response.status}`);
    snapshot = await response.json();
    renderSummary();
    renderCaseFilter();
    renderSelectors();
    renderRunList();
    if (selectedArtifactKey) selectEvidence(selectedArtifactKey);
    elements.generatedAt.textContent = `Scanned ${new Date(snapshot.generatedAt).toLocaleString()}`;
    elements.refreshState.textContent = `${snapshot.runs.length} runs · ${snapshot.baselines.length} baselines`;
    elements.page.inert = false;
    await renderComparison();
  } catch (error) {
    elements.refreshState.textContent = "Run inventory unavailable";
    elements.page.inert = false;
    elements.runList.replaceChildren(node("p", { className: "evidence-empty" }, error instanceof Error ? error.message : String(error)));
  } finally {
    refreshing = false;
  }
}

$("#open-search").addEventListener("click", openSearch);
$("#refresh").addEventListener("click", refresh);
elements.caseFilter.addEventListener("change", renderRunList);
elements.before.addEventListener("change", () => {
  selectEvidence(elements.before.value);
  renderComparison();
});
elements.after.addEventListener("change", () => {
  selectEvidence(elements.after.value);
  renderComparison();
});
elements.searchInput.addEventListener("input", () => {
  searchIndex = 0;
  renderSearch();
});
elements.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    searchIndex = Math.min(searchItems.length - 1, searchIndex + 1);
    renderSearch();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    searchIndex = Math.max(0, searchIndex - 1);
    renderSearch();
  } else if (event.key === "Enter" && searchItems[searchIndex]) {
    event.preventDefault();
    activateSearchItem(searchItems[searchIndex]);
  }
});
elements.dialog.addEventListener("close", () => { elements.page.inert = false; });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (elements.dialog.open) elements.dialog.close();
    else openSearch();
  }
});

refresh();
setInterval(() => {
  if (!document.hidden && !elements.dialog.open) void refresh();
}, 15_000);
