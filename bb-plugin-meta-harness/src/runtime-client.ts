// Version-1 bounded Unix transport only. Admission, persistence and effects remain
// in @nourhelmi/advisor-native. This client needs no repository-relative imports.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { commandSchema, responseSchema, type RuntimeCommand, type RuntimeResponse } from "./runtime-contract.js";

async function credential(path: string): Promise<{ socketPath: string; token: string }> {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new Error("descriptor");
  const before = await lstat(path);
  if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > 4096) throw new Error("descriptor");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("descriptor");
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error("descriptor");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("descriptor");
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!value || typeof value !== "object") throw new Error("descriptor");
    const data = value as Record<string, unknown>;
    if (Object.keys(data).sort().join() !== "socketPath,token,v" || data.v !== 1 || typeof data.token !== "string" || !/^[0-9a-f]{64}$/u.test(data.token) || typeof data.socketPath !== "string" || !isAbsolute(data.socketPath) || Buffer.byteLength(data.socketPath) > 100) throw new Error("descriptor");
    const directory = dirname(data.socketPath);
    if (await realpath(directory) !== resolve(directory)) throw new Error("socket");
    const [parent, socket] = await Promise.all([lstat(directory), lstat(data.socketPath)]);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700 || !socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) throw new Error("socket");
    return { socketPath: data.socketPath, token: data.token };
  } finally { await file.close(); }
}

export async function runtimeCall(descriptorPath: string, input: RuntimeCommand, signal?: AbortSignal): Promise<RuntimeResponse> {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_COMMAND" };
  let secret: { socketPath: string; token: string };
  try { secret = await credential(descriptorPath); }
  catch { return { ok: false, error: "RUNTIME_CONFIGURATION" }; }
  if (signal?.aborted) return { ok: false, error: "TRANSPORT_UNCERTAIN" };
  return new Promise(resolveResponse => {
    const socket = createConnection({ path: secret.socketPath });
    let bytes = Buffer.alloc(0);
    let finished = false;
    const finish = (value: RuntimeResponse) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolveResponse(value);
    };
    const abort = () => finish({ ok: false, error: "TRANSPORT_UNCERTAIN" });
    const deadline = setTimeout(abort, 13000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", abort);
    socket.on("end", abort);
    socket.on("connect", () => socket.write(JSON.stringify({ v: 1, token: secret.token, command: parsed.data, audience: "operator" }) + "\n"));
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1048576) { abort(); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const result = responseSchema.safeParse(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
        finish(result.success ? result.data : { ok: false, error: "TRANSPORT_UNCERTAIN" });
      } catch { abort(); }
    });
  });
}
