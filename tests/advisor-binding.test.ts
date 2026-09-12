import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sessionExtension from "../extensions/advisor-session.ts";
import workerExtension from "../extensions/advisor-worker.ts";
import { hostPiDetach } from "../scripts/advisor-runtime/pi-detach-host.mjs";
import { createPiDetachClient } from "../scripts/advisor-runtime/pi-detach-client.mjs";

// Actual extension callers, bootstrap reconnect, SQLite, paired port and Herdr driver.
// Only Herdr observations are deterministic fixtures; no real provider is launched.
for (const [entry, harness] of [['tool', undefined], ['cos', 'native'], ['advisor-team', 'pi']] as const) test(`${entry}: real entry/bridge hosts child advisor in Pi with native specialists (${harness ?? 'omitted'} harness)`, { skip: !process.env.PI_DETACH_TEST_PACKAGE, timeout: 30000 }, async () => {
  const saved = { ...process.env };
  const base = realpathSync(mkdtempSync("/tmp/bind-")); const cwd = join(base, "work"); mkdirSync(cwd);
  const detach = process.env.PI_DETACH_TEST_PACKAGE!;
  const { createAgentExecutionPort } = await import(pathToFileURL(join(detach, "src/execution-port.ts")).href);
  const { createPaneManager } = await import(pathToFileURL(join(detach, "src/herdr/panes.ts")).href);
  const { detectHerdrContext } = await import(pathToFileURL(join(detach, "src/herdr/context.ts")).href);
  const { registerBridgeDelivery, resetBridgeClients } = await import(pathToFileURL(join(detach, "src/runtime-bridge.ts")).href);
  const { registerBgAgentTool } = await import(pathToFileURL(join(detach, "src/tools/bg-agent.ts")).href);
  const { bootstrapIdentity, ensurePiDetach, installedRevision } = await import(pathToFileURL(resolve("scripts/advisor-runtime/pi-detach-bootstrap.mjs")).href);
  writeFileSync(join(base, 'advisor-intelligence.json'), readFileSync('config/intelligence-profiles/codex-lean.json'));
  const profile = join(base, "profiles.json");
  writeFileSync(profile, JSON.stringify({ defaultAgent: "pi", profiles: {
    advisor: { agent: "pi", harness: "pi", skill: "advisor-role-advisor", cliArgs: ["--advisor-worker-role", "advisor", "--advisor-worker-allow-subagents"] },
    builder: { agent: "pi", skill: "advisor-role-builder" },
  } }));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: base, PI_DETACH_AGENT_PROFILES: profile, ADVISOR_STATE_DIR: join(base, "checkpoint"), HERDR_ENV: "1", HERDR_PANE_ID: "w1:p0" });
  for (const key of ["ADVISOR_WORKSTREAM", "PI_DETACH_WORKER_HARNESS", "ADVISOR_BRIDGE_CHILD_STATE", "ADVISOR_BRIDGE_WORKER_DIR", "ADVISOR_RUNTIME_CANONICAL_OWNER", "ADVISOR_RUNTIME_DESCRIPTOR", "PI_DETACH_RUNTIME_BRIDGE", "PI_DETACH_BACKEND"]) delete process.env[key];
  const config = { v: 1, backend: "runtime", node: process.execPath, client: resolve("scripts/advisor-runtime/pi-detach-bootstrap.mjs"), host: resolve("scripts/advisor-runtime/pi-detach-host.mjs"), stateBase: base };
  writeFileSync(join(base, "pi-detach-runtime.json"), JSON.stringify(config));
  let number = 0; const occupants = new Map<string, any>(); const waits: any[] = []; const calls: string[][] = [];
  const ok = (json: any = {}, stdout = "") => ({ ok: true, code: 0, json, stdout, stderr: "" });
  const cli = {
    async exec(args: string[]) {
      calls.push(args);
      if (args[1] === "split") return ok({ pane_id: `w1:p${++number}` });
      if (args[1] === "process-info") {
        const a = occupants.get(args[args.indexOf("--pane") + 1]);
        return ok({ result: { process_info: a?.agent === "codex" ? { pane_id: a.pane_id, shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ name: "codex", argv0: "codex", pid: a.pid }] } : { foreground_processes: [{ name: "zsh", argv0: "zsh" }] } } });
      }
      if (args[1] === "start") {
        const pane = args[args.indexOf("--pane") + 1], kind = args[args.indexOf("--kind") + 1];
        const a = { pane_id: pane, name: args[2], agent: kind, terminal_id: `terminal-${number}`, pid: number + 100, status: "idle", state_change_seq: 1, ...(kind === "codex" ? {} : { agent_session: { source: "fixture", agent: "pi", kind: "id", value: `session-${number}` } }) };
        occupants.set(pane, a); return ok({ result: { agent: a } });
      }
      if (args[1] === "get") return ok({ result: { agent: occupants.get(args[2]) } });
      if (args[1] === "prompt") { const a = occupants.get(args[2]); a.agent_session ??= { source: "herdr:codex", agent: "codex", kind: "id", value: `thread-${a.pid}` }; a.status = "working"; a.state_change_seq++; return ok(a); }
      if (args[1] === "read") return ok({}, "fixture output");
      return ok();
    },
    spawnWaiter(args: string[]) { let done: any; const promise = new Promise(resolve => { done = resolve; }); const w = { args, promise, resolve: done, kill() {} }; waits.push(w); if (occupants.get(args[2])?.status === args[4]) done(ok(occupants.get(args[2]))); return w; },
  };
  const hosts: any[] = [], sessions: any[] = [];
  async function start(sessionId: string, childState?: string) {
    const { identity, stateRoot } = bootstrapIdentity({ cwd, sessionId, detachPath: detach, config, herdr: detectHerdrContext(), childState });
    const port = createAgentExecutionPort({ cli, ctx: { paneId: "w1:p0" }, panes: createPaneManager(cli, { paneId: "w1:p0" }), env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: base, PI_DETACH_AGENT_PROFILES: profile } });
    const host = await hostPiDetach({ cwd, sessionId, stateRoot, credentialPath: join(stateRoot, "pi.json"), port, managedIdentity: identity, revision: installedRevision(detach, config.host), keepAlive: false }); hosts.push(host);
    writeFileSync(join(stateRoot, "startup.json"), JSON.stringify({ identity, roots: [cwd] }), { mode: 0o600 });
    const client = createPiDetachClient(join(stateRoot, "pi.json"));
    return { host, stateRoot, request: (action: string, payload: object = {}) => client.request(sessionId, action, payload) as Promise<any> };
  }
  function session(sessionId: string, child = false, branch: any[] = []) {
    const commands = new Map<string, any>(); const messages: string[] = [];
    const hooks = new Map<string, any[]>(), tools = new Map<string, any>(), notices: string[] = [], entries: any[] = [...branch];
    const pi: any = { events: new EventEmitter(), on(n: string, h: any) { hooks.set(n, [...(hooks.get(n) ?? []), h]); }, getFlag(n: string) { return child ? n === 'advisor-worker-role' ? 'advisor' : n === 'advisor-worker-allow-subagents' ? true : undefined : undefined; }, registerFlag() {}, registerTool(t: any) { tools.set(t.name, t); }, registerCommand(name: string, value: any) { commands.set(name, value); }, async exec() { return { code: 0, stdout: '', stderr: '' }; }, getActiveTools() { return ['bg_agent', 'edit']; }, setActiveTools() {}, setSessionName() {}, getSessionName() {}, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data }); }, sendMessage() {}, sendUserMessage(message: string) { messages.push(message); } };
    const ctx: any = { cwd, sessionManager: { getSessionId: () => sessionId, getBranch: () => entries, getEntries: () => entries }, ui: { notify(message: string) { notices.push(message); }, setStatus() {} }, isIdle: () => false };
    sessionExtension(pi); if (child) workerExtension(pi); registerBridgeDelivery(pi); registerBgAgentTool(pi, { list: () => [], start() { throw new Error("legacy path forbidden"); } });
    const result = { entries, notices, messages, command: (name: string, args = '') => commands.get(name).handler(args, ctx), emit: async (n: string, e: any = {}) => { const values = []; for (const h of hooks.get(n) ?? []) values.push(await h(e, ctx)); return values; }, invoke: (name: string, id: string, p: object) => tools.get(name).execute(id, p, undefined, undefined, ctx) };
    assert.equal(commands.get('cos').handler, commands.get('advisor-team').handler, 'literal aliases share one entry');
    sessions.push(result); return result;
  }
  async function finish(owner: any, node: any) {
    writeFileSync(join(node.packet.execution.sourceDirectory, "result.md"), "# Status\nPASS\n# Claims\nfixture");
    const pane = JSON.parse(node.handle.id)[0], a = occupants.get(pane); a.status = "done"; a.state_change_seq++;
    waits.findLast(w => w.args[2] === pane && w.args[4] === "done")?.resolve(ok(a));
    for (let i = 0; i < 200; i++) { if ((await owner.request("get", { runId: node.snapshot.scope.run })).snapshot.state === "terminal") return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail("observed terminal required");
  }
  try {
    // Eager bootstrap has no chosen advisor metadata yet. Reconnect through actual sibling hooks.
    const root = await start("root-session"), rootSession = session("root-session"); await rootSession.emit("session_start");
    const startup = readFileSync(join(root.stateRoot, "startup.json"));
    process.env.PI_DETACH_BACKEND = 'legacy';
    await assert.rejects(entry === 'tool'
      ? rootSession.invoke('advisor_session_init', 'no-legacy', { workstream: 'chosen-outcome', workerHarness: 'native', mode: 'cos' })
      : rootSession.command(entry, 'chosen-outcome native'), /CoS requires the paired managed bridge/);
    assert.equal(existsSync(join(base, 'checkpoint/workstreams/chosen-outcome.md')), false);
    delete process.env.PI_DETACH_BACKEND;
    if (entry === 'tool') await rootSession.invoke('advisor_session_init', 'init', { workstream: 'chosen-outcome', workerHarness: 'native' });
    else {
      await rootSession.command(entry, 'chosen-outcome native -- Own the accepted outcome');
      assert.match(rootSession.messages[0], /initialized.*do not initialize again/);
      await rootSession.command(entry === 'cos' ? 'advisor-team' : 'cos', '-- Continue the same outcome');
      assert.match(rootSession.messages.at(-1)!, /Continue the same outcome/);
      assert.equal(rootSession.entries.length, 1, 'alias restore does not duplicate initialization');
      const disk = readFileSync(join(base, 'checkpoint/workstreams/chosen-outcome.md'), 'utf8');
      assert.match(disk, /Advisor mode: `cos`/);
    }
    const advisorParams = { role: 'advisor', ...(harness ? { harness } : {}), prompt: 'Own outcome', anchor: 'prove', promoteAfterMs: 0, keepAlive: true };
    assert.ok((await rootSession.emit('tool_call', { toolName: 'bg_agent', input: advisorParams })).every(v => !v?.block));
    assert.ok((await rootSession.emit('tool_call', { toolName: 'bg_agent', input: { role: 'builder', harness: 'pi', prompt: 'Forbidden', anchor: 'prove' } })).some(v => v?.block));
    const a = await rootSession.invoke('bg_agent', 'advisor', advisorParams); await root.host.runtime.dispatch();
    const advisor = await root.request("get", { runId: a.details.runId }); assert.ok(advisor.handle, JSON.stringify(advisor));
    assert.equal(advisor.packet.execution.harness, "pi"); assert.equal(advisor.childService.family.workstream, "chosen-outcome"); assert.equal(advisor.childService.family.workerHarness, "native");
    if (entry !== 'tool') {
      await root.request('team.enlist', { toolCallId: 'enlist', runId: a.details.runId, name: 'outcome-owner' });
      const checkpoint = await rootSession.invoke('advisor_checkpoint', 'checkpoint-read', {});
      assert.match(JSON.stringify(checkpoint), /Team projection[\s\S]*outcome-owner[\s\S]*writeSurface/);
      await assert.rejects(rootSession.command('cos', 'foreign-workstream'), /cannot move/);
      await assert.rejects(rootSession.command('cos', 'chosen-outcome pi'), /preference is immutable/);
    }
    process.env.ADVISOR_BRIDGE_CHILD_STATE = advisor.childService.stateRoot; process.env.ADVISOR_BRIDGE_WORKER_DIR = advisor.packet.execution.sourceDirectory;
    const child = await start("child-session", advisor.childService.stateRoot), childSession = session("child-session", true); await childSession.emit("session_start");
    assert.equal(childSession.notices.some(n => /unavailable|Could not initialize/.test(n)), false, childSession.notices.join("\n"));
    const b = await childSession.invoke("bg_agent", "builder", { role: "builder", prompt: "Implement", model: "openai-codex/example", thinking: "high", anchor: "prove", keepAlive: true, promoteAfterMs: 0 }); await child.host.runtime.dispatch();
    const builder = await child.request("get", { runId: b.details.runId }); assert.ok(builder.handle, JSON.stringify(builder));
    assert.equal(builder.packet.execution.harness, "native"); assert.match(builder.packet.execution.command, /codex/); assert.equal(builder.packet.execution.environment.ADVISOR_BRIDGE_CHILD_STATE, "");
    assert.deepEqual(calls.filter(a => a[1] === "start").map(a => a[a.indexOf("--kind") + 1]), ["pi", "codex"]);
    await finish(child, builder); await finish(root, advisor);
    await childSession.emit("session_shutdown"); await rootSession.emit("session_shutdown"); resetBridgeClients();
    delete process.env.ADVISOR_BRIDGE_CHILD_STATE; delete process.env.ADVISOR_BRIDGE_WORKER_DIR;
    // Resume binds before publishing environment and reconnects the unchanged original startup marker.
    const resumed = session("root-session", false, rootSession.entries); await resumed.emit("session_start");
    assert.equal(process.env.PI_DETACH_WORKER_HARNESS, "native"); assert.equal(resumed.notices.some(n => /refused|unavailable/.test(n)), false, resumed.notices.join("\n"));
    await ensurePiDetach({ cwd, sessionId: "root-session", detachPath: detach, herdr: detectHerdrContext() });
    assert.deepEqual(readFileSync(join(root.stateRoot, 'startup.json')), startup);
    const prompt = await resumed.emit('before_agent_start', { systemPrompt: 'base' });
    assert.ok(prompt.some(v => /Profile: codex-lean/.test(v?.systemPrompt ?? '')));
    if (entry !== 'tool') assert.ok(prompt.some(v => /CoS team mode/.test(v?.systemPrompt ?? '')));
    else assert.ok(prompt.every(v => !/CoS team mode/.test(v?.systemPrompt ?? '')));
    assert.equal((await root.request("family.budget")).used, 2);
    await resumed.emit("session_shutdown"); resetBridgeClients();
    // A conflicting init publishes no session pointer, entry or selected environment, and fences workers.
    const foreign = await start("foreign-session"); await foreign.request("advisor.bind", { workstream: "established", workerHarness: "pi" });
    const failed = session("foreign-session"); await failed.emit("session_start");
    const before = { workstream: process.env.ADVISOR_WORKSTREAM, harness: process.env.PI_DETACH_WORKER_HARNESS };
    await assert.rejects(failed.invoke("advisor_session_init", "conflict", { workstream: "conflicting", workerHarness: "native" }), /FAMILY_BINDING_MISMATCH/);
    assert.deepEqual({ workstream: process.env.ADVISOR_WORKSTREAM, harness: process.env.PI_DETACH_WORKER_HARNESS }, before); assert.deepEqual(failed.entries, []);
    assert.equal(existsSync(join(base, "checkpoint", "sessions", "foreign-session.md")), false);
    assert.ok((await failed.emit("tool_call", { toolName: "bg_agent", input: {} })).some(v => v?.block));
    for (const owner of [root, child]) for (const row of await owner.request("list")) for (const d of await owner.request("wait", { runId: row.runId, timeoutMs: 0 })) await owner.request("ack", { runId: row.runId, deliveryId: d.id });
    if (entry !== 'tool') {
      await child.host.service.close();
      const retired = await root.request('team.retire', { toolCallId: 'retire', to: 'outcome-owner' });
      assert.equal(retired.status, 'retired', JSON.stringify(retired));
    }
    await root.host.service.close(); await foreign.host.service.close();
  } finally {
    for (const s of sessions) await s.emit("session_shutdown"); resetBridgeClients();
    for (const h of hosts.reverse()) try { await h.service.close(); } catch { /* Fixture refusal is not settlement proof. */ }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  }
});
