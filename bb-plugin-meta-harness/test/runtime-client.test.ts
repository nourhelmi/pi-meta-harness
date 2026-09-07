import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runtimeCall } from "../src/runtime-client.js";
import plugin from "../src/server.js";

it("host-only transport bounds private descriptors, rejects symlinks/FIFO, sanitizes failures and aborts only its socket", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "bb-wire-")); chmodSync(dir, 0o700);
  const socketPath = join(dir, "test.sock"); const descriptor = join(dir, "operator.json");
  const token = "a".repeat(64);
  let response = JSON.stringify({ ok: true, value: { operations: [], scopes: [] } }) + "\n";
  let envelope: any;
  const server = createServer(socket => { socket.on("error", () => {}); socket.on("data", bytes => { envelope = JSON.parse(bytes.toString()); if (response) socket.end(response); }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  writeFileSync(descriptor, JSON.stringify({ v: 1, socketPath, token }), { mode: 0o600 });
  const command = { v: 1 as const, op: "capabilities" as const };
  try {
    expect(await runtimeCall(descriptor, command)).toEqual({ ok: true, value: { operations: [], scopes: [] } });
    expect(envelope).toEqual({ v: 1, audience: "operator", token, command });
    chmodSync(descriptor, 0o644); expect(await runtimeCall(descriptor, command)).toEqual({ ok: false, error: "RUNTIME_CONFIGURATION" }); chmodSync(descriptor, 0o600);
    const alias = join(dir, "alias"); symlinkSync(descriptor, alias); expect((await runtimeCall(alias, command)).ok).toBe(false);
    const fifo = join(dir, "fifo"); execFileSync("mkfifo", [fifo]); expect((await runtimeCall(fifo, command)).ok).toBe(false);
    const big = join(dir, "big"); writeFileSync(big, "x".repeat(4097), { mode: 0o600 }); expect((await runtimeCall(big, command)).ok).toBe(false);
    response = JSON.stringify({ ok: false, error: `private raw error ${token} ${descriptor}` }) + "\n";
    expect(await runtimeCall(descriptor, command)).toEqual({ ok: false, error: "TRANSPORT_UNCERTAIN" });
    response = "x".repeat(1048577); expect(await runtimeCall(descriptor, command)).toEqual({ ok: false, error: "TRANSPORT_UNCERTAIN" });
    response = ""; const abort = new AbortController(); const pending = runtimeCall(descriptor, command, abort.signal); abort.abort();
    expect(await pending).toEqual({ ok: false, error: "TRANSPORT_UNCERTAIN" });
    expect(envelope.command).toEqual(command); // No cancel command is synthesized.
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

it("server uses fresh trusted settings, blocks payload routing overrides and never forwards raw host failures", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "meta-harness", settings: { hostId: "host-a", runtimeDescriptor: "/private/operator.json", stateRoot: "/private/state" }, experimental_callHostRpc: () => { throw new Error("sensitive descriptor and bearer contents"); } });
  await plugin(bb);
  expect(await harness.callRpc("runtime", { v: 1, op: "capabilities" })).toEqual({ ok: false, error: "TRANSPORT_UNCERTAIN" });
  expect(harness.experimental_hostRpcCalls[0]).toMatchObject({ method: "runtime", hostId: "host-a", input: { descriptorPath: "/private/operator.json", command: { v: 1, op: "capabilities" } } });
  await expect(harness.callRpc("runtime", { v: 1, op: "capabilities", descriptorPath: "/untrusted" })).rejects.toThrow();
  await harness.setSettings({ hostId: "host-b", runtimeDescriptor: "/private/second.json" });
  await harness.callRpc("runtime", { v: 1, op: "capabilities" });
  expect(harness.experimental_hostRpcCalls[1]).toMatchObject({ hostId: "host-b", input: { descriptorPath: "/private/second.json" } });
  expect(harness.sdk.calls).toEqual([]);
});
