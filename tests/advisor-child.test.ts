import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorSessionExtension, { liveAdvisorDoctrine } from "../extensions/advisor-session.ts";
import advisorWorkerExtension from "../extensions/advisor-worker.ts";
import advisorGraphExtension from "../extensions/advisor-graph.ts";
import { hostPiDetach } from "../scripts/advisor-runtime/pi-detach-host.mjs";
import { createPiDetachClient } from "../scripts/advisor-runtime/pi-detach-client.mjs";
import { readChildScope } from "../scripts/advisor-runtime/pi-detach-bootstrap.mjs";

test("child advisors share doctrine, own checkpoints and link sibling graphs through validated runtime scopes", async () => {
  const base = await realpath(await mkdtemp("/tmp/adv-child-"));
  const cwd = join(base, "work"); await mkdir(cwd);
  const keys = ["ADVISOR_BRIDGE_CHILD_STATE", "ADVISOR_BRIDGE_WORKER_DIR", "ADVISOR_STATE_DIR", "ADVISOR_WORKSTREAM", "PI_DETACH_AGENT_PROFILES", "PI_CODING_AGENT_DIR", "PI_DETACH_WORKER_HARNESS"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const hosts: Awaited<ReturnType<typeof hostPiDetach>>[] = [];
  const profiles = join(base, "roles.json");
  await writeFile(profiles, JSON.stringify({ profiles: { advisor: { skill: "advisor-role-advisor", maxTurns: 6 }, builder: {}, checker: {} } }));
  const guide = { name: "child-test", models: { "test/model": { character: "shared guide", defaultThinking: "high" } } };
  await writeFile(join(base, "advisor-intelligence.json"), JSON.stringify(guide));
  const port = {
    version: 1,
    async prepare(params: any, sourceDirectory: string, scope: any) {
      return { v: 1, command: "fixture", prompt: params.prompt, role: "advisor", runtime: "pi", model: "fixture", thinking: "high", maxTurns: 6, requiredSkills: [], harness: "pi", keepAlive: true, label: "fixture", resultDiscovery: null, resultPolicy: "runtime-capture", sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: "", PI_DETACH_RUNTIME_BRIDGE: "", ADVISOR_RUNTIME_CANONICAL_OWNER: "1", ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_BRIDGE_CHILD_STATE: scope.childState } };
    },
    async launch({ hooks, intent }: any) { hooks.recordHandle({ id: intent.sourceDirectory, session: "fixture" }); return { async interrupt() {}, async readLive() { return "fixture"; } }; },
  };
  async function start(stateRoot: string, sessionId: string) {
    const credentialPath = join(stateRoot, "pi.json");
    const host = await hostPiDetach({ stateRoot, cwd, sessionId, credentialPath, port, maxLaunches: 8, keepAlive: false, managedIdentity: { workstream: "root-outcome", workerHarness: "native" } });
    hosts.push(host);
    await writeFile(join(stateRoot, "startup.json"), JSON.stringify({ identity: { sessionId } }), { mode: 0o600 });
    const client = createPiDetachClient(credentialPath);
    return { host, request: (action: string, payload: any = {}) => client.request(sessionId, action, payload) as Promise<any> };
  }
  try {
    process.env.PI_DETACH_AGENT_PROFILES = profiles;
    process.env.PI_CODING_AGENT_DIR = base;
    process.env.ADVISOR_STATE_DIR = join(base, "root-checkpoint");
    process.env.ADVISOR_WORKSTREAM = "untrusted-ambient-name";
    delete process.env.ADVISOR_BRIDGE_CHILD_STATE;
    const root = await start(join(base, "root"), "root-session");
    const paths: string[] = [];
    for (const id of ["one", "two"]) {
      const receipt = await root.request("call", { tool: "bg_agent", toolCallId: id, cwd, params: { role: "advisor", prompt: "Own a bounded outcome" } });
      await root.host.runtime.dispatch();
      const run = await root.request("get", { runId: receipt.runId });
      const stateRoot = run.childService.stateRoot;
      process.env.ADVISOR_BRIDGE_CHILD_STATE = stateRoot;
      const scope = await readChildScope({ cwd }); assert.ok(scope);
      const child = await start(stateRoot, `child-${id}`);
      const runDir = run.packet.execution.sourceDirectory;
      process.env.ADVISOR_BRIDGE_WORKER_DIR = runDir;
      await writeFile(join(runDir, "result.md"), `# Status\nIN PROGRESS\n# Decisions\ncheckpoint-${id}`);
      // Do not infer the specialist default from the child advisor's Pi transport or ambient env.
      process.env.PI_DETACH_WORKER_HARNESS = "pi";
      const hooks = new Map<string, Array<(...args: any[]) => any>>();
      const tools = new Map<string, any>();
      const entries: string[] = []; const notices: string[] = [];
      let active = ["bg_agent", "advisor_graph_plan", "advisor_graph_evidence", "advisor_session_init", "advisor_launch", "edit", "intercom", "RoutineCreate"];
      const pi = {
        getFlag: (name: string) => name === "advisor-worker-role" ? "advisor" : name === "advisor-worker-allow-subagents" ? true : undefined,
        registerFlag() {}, registerTool: (tool: any) => tools.set(tool.name, tool),
        on(name: string, hook: (...args: any[]) => any) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
        appendEntry: (kind: string) => entries.push(kind),
        getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
        events: { emit(_name: string, request: any) { request.response = child.request(request.action, request.payload); } },
      } as unknown as ExtensionAPI;
      advisorSessionExtension(pi); advisorWorkerExtension(pi); advisorGraphExtension(pi);
      const ctx = { cwd, model: { provider: "test", id: "model" }, thinkingLevel: "high", sessionManager: { getSessionId: () => `child-${id}`, getBranch: () => [] }, ui: { setStatus() {}, notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
      const emit = async (name: string, event: any) => Promise.all((hooks.get(name) ?? []).map(hook => hook(event, ctx)));
      await emit("session_start", {});
      assert.deepEqual(notices, []);
      assert.deepEqual(entries, ["advisor-worker"], "no root ownership claim or checkpoint restoration");
      assert.equal(process.env.PI_DETACH_WORKER_HARNESS, "native");
      assert.deepEqual(active, ["bg_agent", "advisor_graph_plan", "advisor_graph_evidence", "edit"]);
      const prompt = (await emit("before_agent_start", { systemPrompt: "base" })).find(value => value?.systemPrompt)?.systemPrompt;
      assert.ok(prompt.includes(await liveAdvisorDoctrine()), "identical installed advisor doctrine");
      assert.match(prompt, /shared guide/); assert.match(prompt, /Session mode: \*\*native\*\*/);
      assert.match(prompt, new RegExp(`checkpoint-${id}`));
      assert.ok(prompt.includes(JSON.stringify(scope))); assert.ok(prompt.includes(join(runDir, "result.md")));
      assert.doesNotMatch(prompt, /not an advisor or orchestrator|only depth-1 visible subagents/);
      const second = (await emit("before_agent_start", { systemPrompt: "base" })).find(value => value?.systemPrompt)?.systemPrompt;
      assert.doesNotMatch(second, /# Child Advisor Checkpoint/);
      await emit("session_compact", {});
      const compacted = (await emit("before_agent_start", { systemPrompt: "base" })).find(value => value?.systemPrompt)?.systemPrompt;
      assert.match(compacted, /# Child Advisor Checkpoint/);
      const guard = async (toolName: string, input = {}) => (await emit("tool_call", { toolName, input })).find(value => value?.block);
      assert.equal(await guard("bg_agent", { role: "advisor", harness: "pi", anchor: "prove it" }), undefined);
      assert.equal(await guard("bg_agent", { role: "builder", anchor: "prove it" }), undefined);
      assert.ok(await guard("bg_agent", { role: "builder", harness: "pi", anchor: "prove it" }));
      assert.ok(await guard("bg_agent", { role: "advisor" }));
      for (const name of ["advisor_session_init", "advisor_launch", "RoutineCreate", "intercom", "subagent"]) assert.ok(await guard(name));
      assert.equal(await guard("advisor_graph_evidence"), undefined, "child does not require the root checkpoint");
      const planned = await tools.get("advisor_graph_plan").execute("plan", { graphId: "same-id", goal: "Local outcome", nodes: [{ id: "make", role: "advisor", task: "Own nested work", anchor: "prove it" }, { id: "review", role: "checker", task: "Check it", anchor: "probe it", dependsOn: ["make"] }] }, undefined, undefined, ctx);
      assert.ok(planned.details.manifestPath, JSON.stringify(planned));
      assert.deepEqual(planned.details.warnings, []);
      paths.push(planned.details.manifestPath);
      assert.equal(paths.at(-1), join(stateRoot, "graphs", "same-id.json"));
      const manifest = JSON.parse(await readFile(planned.details.manifestPath, "utf8"));
      assert.deepEqual(manifest.parentOutcome, scope.parent); assert.equal(manifest.workstream, "root-outcome");
      const evidence = await tools.get("advisor_graph_evidence").execute("evidence", { graphId: "same-id", node: "make" }, undefined, undefined, ctx);
      assert.ok(JSON.stringify(evidence).includes(scope.parent.scope.run));
      manifest.parentOutcome.scope.run = "forged-run";
      await writeFile(planned.details.manifestPath, JSON.stringify(manifest));
      await assert.rejects(tools.get("advisor_graph_evidence").execute("forged", { graphId: "same-id", node: "make" }, undefined, undefined, ctx), /different parent outcome/);
    }
    assert.notEqual(paths[0], paths[1]);
    await assert.rejects(readFile(join(base, "root-checkpoint", "workstreams", "untrusted-ambient-name.md")), { code: "ENOENT" });
    const grantPath = join(process.env.ADVISOR_BRIDGE_CHILD_STATE!, "child-grant.json");
    const grant = JSON.parse(await readFile(grantPath, "utf8")); grant.family.workerHarness = "pi";
    await writeFile(grantPath, JSON.stringify(grant));
    await assert.rejects(readChildScope({ cwd }), /CHILD_GRANT_MISMATCH/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // Disposable transport fixtures have no real agents; release failed-test hosts too.
    for (const host of hosts.reverse()) {
      try { await host.service.close(); } catch { /* The unref'ed fixture service must not mask the assertion. */ }
    }
    await rm(base, { recursive: true, force: true });
  }
});
