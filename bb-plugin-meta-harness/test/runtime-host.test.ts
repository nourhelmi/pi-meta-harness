import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../src/host.js";
import plugin from "../src/server.js";
import { traceHostContract } from "../src/contracts.js";
import { type Mutation, type RuntimeCommand, type RuntimeResponse } from "../src/runtime-contract.js";

let prefix: string;
let native: string;
beforeAll(() => {
  prefix = mkdtempSync(join(realpathSync(tmpdir()), "bb-native-installed-"));
  const artifacts = join(prefix, "artifacts with spaces");
  const packed = JSON.parse(execFileSync(process.execPath, [resolve("../scripts/pack-advisor-native.mjs"), artifacts], { encoding: "utf8" }));
  const install = join(prefix, "native prefix with spaces");
  execFileSync("npm", ["install", "--prefix", install, "--ignore-scripts", "--omit=optional", "--offline", "--package-lock=false", packed.tarball], { encoding: "utf8", timeout: 60000 });
  native = dirname(createRequire(join(install, "package.json")).resolve("@nourhelmi/advisor-native/package.json"));
  expect(JSON.parse(readFileSync(join(native, "package.json"), "utf8")).name).toBe("@nourhelmi/advisor-native");
  const proof = {
    package: "@nourhelmi/advisor-native@0.1.0", node: process.version,
    prefixContainsSpaces: native.includes(" "),
    tarballSha256: createHash("sha256").update(readFileSync(packed.tarball)).digest("hex"),
    integrity: packed.integrity,
    runtimeSha256: createHash("sha256").update(readFileSync(join(native, "scripts/advisor-runtime/runtime.mjs"))).digest("hex"),
    contractSha256: createHash("sha256").update(readFileSync(join(native, "scripts/advisor-runtime/contract.mjs"))).digest("hex"),
  };
  if (process.env.BB_TEST_EVIDENCE_DIR) writeFileSync(join(process.env.BB_TEST_EVIDENCE_DIR, "installed-native-proof.json"), JSON.stringify(proof, null, 2));
}, 90000);
afterAll(() => { if (prefix) rmSync(prefix, { recursive: true, force: true }); });

it("public server + actual host + installed package Unix service share SQLite admission, history and disconnect ownership", async () => {
  // These imports resolve from an actual npm-installed package, never sibling source.
  const installed = createRequire(join(native, "package.json"));
  const { AdvisorRuntime } = installed("@nourhelmi/advisor-native/scripts/advisor-runtime/runtime.mjs");
  const { startService, writeCredential } = installed("@nourhelmi/advisor-native/scripts/advisor-runtime/service.mjs");
  const { OPERATIONS } = installed("@nourhelmi/advisor-native/scripts/advisor-runtime/contract.mjs");
  const base = mkdtempSync(join(realpathSync(tmpdir()), "bb-sock-"));
  const state = join(base, "state"); const work = join(base, "work"); mkdirSync(work);
  const calls: string[] = [];
  let stream: ((text: string) => void) | undefined;
  const result = (status: string) => `# Status\n${status}\n# Claims\nDeterministic fixture.\n# Evidence\nNo model.\n# Files\nNone.\n# Decisions\nFixture.\n# Remaining Risk\nNot live.\n`;
  const adapter = {
    capabilities: Object.fromEntries(OPERATIONS.map((op: string) => [op, !op.endsWith("resume")])),
    execute({ effect, context, recordHandle, emit }: any) {
      calls.push(effect.op);
      let i = 0;
      const event = (kind: string, data: unknown) => emit({ id: `${effect.commandId}-${++i}`, kind, attempt: effect.attempt, data });
      if (effect.op === "root.create" || effect.op === "node.launch") recordHandle({ id: `${effect.scope.node}-owned` });
      if (effect.op === "root.create") {
        event("progress", { text: "streamed native fixture output" });
        event("blocked", { requestId: "root-question", kind: "question", text: "Which fixture?" });
      } else if (effect.op === "root.reply") event("completed", { text: "root synthesis after durable reply" });
      else if (effect.op === "root.message") { stream = text => event("progress", { text }); }
      else if (effect.op === "root.cancel") event("completed", { text: "cancel finalized" });
      else if (effect.op === "root.stop") event("process-exited", { code: 0 });
      else if (effect.op === "node.launch") {
        writeFileSync(context.resultPath, result("BLOCKED"));
        writeFileSync(join(context.artifactDirectory, "request.json"), JSON.stringify({ id: "maker-question", kind: "question", text: "Choose fixture" }));
        event("blocked", { requestId: "maker-question", kind: "question", text: "Choose fixture" });
      } else if (effect.op === "node.reply") event("progress", { note: "reply delivered on current attempt" });
      else if (effect.op === "node.cancel") {
        writeFileSync(context.resultPath, result("CANCELLED"));
        event("settled", { status: "cancelled", reason: "operator cancelled", verified: false });
        event("process-exited", { code: 0 });
      }
      return { accepted: true };
    },
  };
  let faultPoint: string | null = null;
  const runtime = new AdvisorRuntime({ stateRoot: state, allowedRoots: [work], adapters: { roots: { codex: adapter }, workers: { codex: adapter } }, fault(point: string) { if (point === faultPoint) { faultPoint = null; throw new Error("injected transaction fault"); } } });
  const root = { workstream: "work", run: "run", node: "root", ownerEpoch: 1 };
  const maker = { ...root, node: "maker" };
  const scope = ({ workstream, run, node }: typeof root) => ({ workstream, run, node });
  const token = runtime.registerPrincipal({ id: "operator", kind: "operator", scopes: [scope(root), scope(maker), { ...scope(root), run: "wrong" }], operations: OPERATIONS });
  const narrow = runtime.registerPrincipal({ id: "narrow", kind: "operator", scopes: [scope(maker)], operations: ["history"] });
  const service = await startService(runtime, { keepAlive: false });
  const descriptor = join(state, "operator.json"); writeCredential(descriptor, { socketPath: service.socketPath, token }, runtime);
  const restricted = join(state, "restricted.json"); writeCredential(restricted, { socketPath: service.socketPath, token: narrow }, runtime);
  let host = experimental_createHostEntryHarness(hostEntry);
  const { bb, harness } = createFakePluginHost({ pluginId: "meta-harness", settings: { hostId: "real-host", stateRoot: state, runtimeDescriptor: descriptor }, experimental_callHostRpc(call) {
    if (call.method !== "runtime") throw new Error("Unexpected host operation");
    return host.experimental_call("runtime", traceHostContract.runtime.input.parse(call.input));
  } });
  await plugin(bb);
  const rpc = (command: RuntimeCommand) => harness.callRpc("runtime", command) as Promise<any>;
  const read = (op: "progress" | "history" | "wait", target = root, payload: Record<string, unknown> = {}) => rpc({ v: 1, op, scope: target, payload });
  let counter = 0;
  const command = async (op: Mutation["op"], payload: Record<string, unknown>, target = root): Promise<Mutation> => {
    const current = await read("progress", target);
    return { v: 1, commandId: `bb-command-${++counter}`, expectedRevision: current.ok ? current.value.revision : 0, op, scope: target, payload };
  };
  const mutate = async (op: Mutation["op"], payload: Record<string, unknown>, target = root) => {
    const c = await command(op, payload, target); const response = await rpc(c); expect(response.ok, JSON.stringify(response)).toBe(true); await runtime.dispatch(); return c;
  };
  const historyPayload = { cursor: 0, limit: 128, maxBytes: 262144 };
  const observed: RuntimeResponse[] = [];
  try {
    expect((await rpc({ v: 1, op: "capabilities" })).value.operations).toContain("history");
    await expect(harness.callRpc("runtime", { v: 1, op: "capabilities", descriptorPath: "/caller-override", token: "caller" })).rejects.toThrow();
    await expect(harness.callRpc("runtime", { v: 1, op: "unknown", scope: root, payload: {} })).rejects.toThrow();
    await mutate("workstream.create", { cwd: work, host: "codex" });
    const create = await command("root.create", { adapter: "codex", model: "fixture-not-live", thinking: "high", text: "user first message" });
    faultPoint = "transaction.beforeCommit";
    expect(await rpc(create)).toEqual({ ok: false, error: "INTERNAL_ERROR" });
    expect((await read("history", root, historyPayload)).value.entries).toEqual([]);
    expect(calls).toEqual([]);
    expect((await rpc(create)).ok).toBe(true); await runtime.dispatch();
    expect(calls.filter(op => op === "root.create")).toHaveLength(1);
    const replay = await rpc(create); expect(replay.replayed).toBe(true);
    expect(await rpc({ ...create, payload: { ...create.payload, text: "changed" } })).toEqual({ ok: false, error: "COMMAND_ID_REUSE" });
    expect(await rpc({ ...create, commandId: "stale-create" })).toEqual({ ok: false, error: "STALE_REVISION" });
    expect(await read("history", { ...root, ownerEpoch: 2 }, historyPayload)).toEqual({ ok: false, error: "OWNER_EPOCH_MISMATCH" });
    expect(await read("history", { ...root, run: "wrong" }, historyPayload)).toEqual({ ok: false, error: "RUN_FORBIDDEN" });
    expect(await read("history", { ...root, workstream: "foreign" }, historyPayload)).toEqual({ ok: false, error: "SCOPE_FORBIDDEN" });
    expect(await read("history", root, { ...historyPayload, maxBytes: 1 })).toEqual({ ok: false, error: "INVALID_INTEGER" });
    expect(await rpc(await command("root.reply", { requestId: "wrong-question", text: "answer" }))).toEqual({ ok: false, error: "REQUEST_MISMATCH" });
    const reply = await command("root.reply", { requestId: "root-question", text: "accepted user answer" });
    faultPoint = "transaction.afterCommit";
    expect(await rpc(reply)).toEqual({ ok: false, error: "INTERNAL_ERROR" });
    expect((await rpc(reply)).replayed).toBe(true); await runtime.dispatch();
    await mutate("packet.admit", { node: "maker", packet: { role: "builder", task: "No-model fixture", acceptance: ["result"], riskTier: "high", cwd: work, adapter: "codex", model: "fixture", thinking: "high" } });
    await mutate("node.launch", { node: "maker" });
    expect((await read("progress", maker)).value.requestDetail).toEqual({ id: "maker-question", kind: "question", text: "Choose fixture" });
    const node = (await read("progress", maker)).value;
    await mutate("node.reply", { attempt: node.snapshot.attempt, requestId: "maker-question", text: "maker answer" }, maker);
    const current = (await read("progress", maker)).value;
    expect(current.snapshot.attempt).toBe(2);
    const artifact = await rpc({ v: 1, op: "artifact.read", scope: maker, payload: { path: "result.md", offset: 0, maxBytes: 65536 } }); expect(artifact.value.text).toContain("BLOCKED");
    for (const path of ["../root/result.md", descriptor]) expect((await rpc({ v: 1, op: "artifact.read", scope: maker, payload: { path, offset: 0, maxBytes: 65536 } })).ok).toBe(false);
    symlinkSync(descriptor, join(state, "runs/run/maker/escape"));
    expect((await rpc({ v: 1, op: "artifact.read", scope: maker, payload: { path: "escape", offset: 0, maxBytes: 65536 } })).ok).toBe(false);
    // Acked data remains in the same SQL delivery rows; pagination never skips or duplicates.
    const before = await read("history", root, historyPayload); observed.push(before);
    expect(before.value.entries.filter((e: any) => e.kind === "user.message").map((e: any) => e.text)).toEqual(["user first message", "accepted user answer", "maker answer"]);
    const first = before.value.entries[0].id;
    await mutate("delivery.ack", { deliveryId: first });
    const page1 = await read("history", root, { ...historyPayload, limit: 1 });
    expect(page1.value.entries[0]).toMatchObject({ id: first, acked: true }); expect(page1.value.hasMore).toBe(true);
    const page2 = await read("history", root, { ...historyPayload, cursor: page1.value.nextCursor });
    expect(page2.value.entries.some((e: any) => e.id === first)).toBe(false);
    expect((await read("wait", root, { timeoutMs: 0, limit: 128 })).value.some((e: any) => e.id === first)).toBe(false);
    await harness.setSettings({ runtimeDescriptor: restricted });
    expect(await read("history", root, historyPayload)).toEqual({ ok: false, error: "SCOPE_FORBIDDEN" });
    const narrowHistory = await read("history", maker, historyPayload);
    expect(narrowHistory.value.entries.every((e: any) => e.node === "maker")).toBe(true);
    expect(await read("progress", maker)).toEqual({ ok: false, error: "OPERATION_FORBIDDEN" });
    await harness.setSettings({ runtimeDescriptor: descriptor });
    // Raw socket loss after write must not cancel a committed root turn.
    const message = await command("root.message", { text: "user message before disconnect" });
    await new Promise<void>(done => { const socket = createConnection(service.socketPath); socket.on("connect", () => socket.end(JSON.stringify({ v: 1, audience: "operator", token, command: message }) + "\n")); socket.on("close", () => done()); socket.resume(); });
    await runtime.dispatch();
    await host.experimental_dispose(); host = experimental_createHostEntryHarness(hostEntry);
    stream?.("persisted while BB was disconnected");
    for (let i = 0; i < 12; i++) stream?.(`${i}: ${"🧪".repeat(4000)}`);
    const bounded = await read("history", root, { ...historyPayload, maxBytes: 131072 });
    expect(Buffer.byteLength(JSON.stringify(bounded.value))).toBeLessThanOrEqual(131072);
    expect(bounded.value.hasMore).toBe(true);
    const reconnected = await read("history", root, historyPayload); observed.push(reconnected);
    expect(reconnected.value.entries.some((e: any) => e.text === "persisted while BB was disconnected")).toBe(true);
    expect(reconnected.value.entries.find((e: any) => e.id === first).acked).toBe(true);
    expect((await rpc(message)).replayed).toBe(true);
    expect(calls.filter(op => op === "root.message")).toHaveLength(1);
    expect(calls).not.toContain("root.cancel"); expect(calls).not.toContain("node.cancel");
    const waiting = await read("wait", root, { timeoutMs: 0, limit: 128 });
    expect(await read("wait", root, { timeoutMs: 0, limit: 128 })).toEqual(waiting);
    const cancelled = await mutate("node.cancel", { attempt: 2, reason: "test" }, maker); expect((await rpc(cancelled)).replayed).toBe(true);
    await mutate("root.cancel", { reason: "test" });
    await mutate("root.stop", {});
    expect((await read("progress")).value.root.processExited).toBe(0);
    expect(await rpc(await command("root.resume", {}))).toEqual({ ok: false, error: "RESUME_UNSUPPORTED" });
    const sql = new DatabaseSync(join(state, "runtime.sqlite"), { readOnly: true });
    expect(sql.prepare("SELECT count(*) AS n FROM receipts WHERE id=?").get(create.commandId)?.n).toBe(1);
    expect(sql.prepare("SELECT count(*) AS n FROM deliveries WHERE json_extract(data,'$.kind')='user.message'").get()?.n).toBe(4);
    sql.close();
    const all = (await read("history", root, historyPayload)).value.entries;
    for (const entry of all) await mutate("delivery.ack", { deliveryId: entry.id });
    expect((await read("history", root, historyPayload)).value.entries.every((e: any) => e.acked)).toBe(true);
    expect(JSON.stringify([observed, harness.experimental_hostRpcCalls])).not.toContain(token);
    expect(JSON.stringify(observed)).not.toContain(service.socketPath);
    expect(harness.sdk.calls).toEqual([]);
    const trace = await host.experimental_call("readTrace", { stateRoot: state, fileName: "run.jsonl" });
    expect(trace.ok).toBe(true);
    if (trace.ok) expect(trace.trace.projection.nodes).toMatchObject([{ id: "maker", attempts: 2, settledStatus: "cancelled" }]);
    await service.close();
    // Actual SQLite reopened under a fresh owner still contains acknowledged history.
    const reopened = new AdvisorRuntime({ stateRoot: state, allowedRoots: [work], adapters: {} });
    expect(reopened.execute(token, { v: 1, op: "history", scope: root, payload: historyPayload }).value.entries).toHaveLength(all.length);
    expect(reopened.execute(token, create).replayed).toBe(true);
    reopened.close();
  } finally { await host.experimental_dispose(); rmSync(base, { recursive: true, force: true }); }
}, 30000);
