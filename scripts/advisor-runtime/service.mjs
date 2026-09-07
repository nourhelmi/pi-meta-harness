import { createConnection, createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LIMITS, fields } from './contract.mjs';
import { RuntimeError, demand, privateDirectory, safeFile, within } from './security.mjs';

function decode(text) { try { return JSON.parse(text); } catch { throw new RuntimeError('INVALID_JSON'); } }
const failure = error => ({ ok: false, error: error instanceof RuntimeError ? error.code : 'TRANSPORT_ERROR' });
function encode(value) { const text = JSON.stringify(value); demand(Buffer.byteLength(text) <= LIMITS.reply, 'RESPONSE_TOO_LARGE'); return text + '\n'; }

/** Foreground service host. Caller already owns the runtime's exclusive service lock. */
export async function startService(runtime, { keepAlive = true } = {}) {
  const socketPath = join(runtime.stateRoot, 'runtime.sock');
  demand(Buffer.byteLength(socketPath) <= 100, 'SOCKET_PATH_TOO_LONG');
  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath); demand(stat.isSocket() && stat.uid === process.getuid(), 'UNSAFE_SOCKET'); unlinkSync(socketPath);
  }
  const connections = new Set();
  const server = createServer(socket => {
    if (connections.size >= LIMITS.connections) { socket.destroy(); return; }
    const deadline = setTimeout(() => socket.destroy(), LIMITS.waitMs + 2000);
    connections.add(socket); socket.on('close', () => { clearTimeout(deadline); connections.delete(socket); }); socket.on('error', () => {});
    socket.setTimeout(LIMITS.waitMs + 2000, () => socket.destroy());
    let bytes = Buffer.alloc(0); let submitted = false;
    socket.on('data', async chunk => {
      if (submitted) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > LIMITS.envelope + 256) { socket.end(encode({ ok: false, error: 'ENVELOPE_TOO_LARGE' })); submitted = true; return; }
      const newline = bytes.indexOf(10); if (newline < 0) return;
      submitted = true; // Exactly one request per connection. Reconnect is not cancellation.
      try {
        demand(newline === bytes.length - 1, 'REQUEST_COUNT');
        const request = decode(bytes.subarray(0, newline).toString('utf8')); fields(request, ['v', 'token', 'command', 'audience']); demand(request.v === 1, 'UNSUPPORTED_VERSION');
        demand(['operator', 'model'].includes(request.audience), 'INVALID_AUDIENCE');
        if (request.command?.op === 'capabilities') {
          fields(request.command, ['v', 'op']); demand(request.command.v === 1, 'UNSUPPORTED_VERSION');
          socket.end(encode({ ok: true, value: runtime.describe(request.token, request.audience) })); return;
        }
        const resultPromise = request.command?.op === "pi.detach" ? runtime.piDetachRequest(request.token, request.command, request.audience) : runtime.request(request.token, request.command, request.audience);
        // Execute has synchronously committed before dispatch. Do not await native effects.
        void runtime.dispatch().catch(() => {});
        const result = await resultPromise;
        void runtime.dispatch().catch(() => {});
        socket.end(encode(result));
      } catch (error) { socket.end(encode(failure(error))); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); }); });
  // Embedded/test hosts may own their own lifetime. This does not cancel work or release runtime ownership.
  if (!keepAlive) server.unref();
  return {
    socketPath,
    async close() {
      // Runtime typed refusal occurs before dropping any client or accepting shutdown.
      runtime.close();
      for (const socket of connections) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

/** Trusted bootstrap writes credentials privately. Never return this object to a model/UI. */
export function writeCredential(path, { socketPath, token }, runtime) {
  demand(!within(join(dirname(resolve(socketPath)), 'runs'), resolve(path)), 'CREDENTIAL_IN_ARTIFACT_SCOPE');
  demand(runtime && socketPath === join(runtime.stateRoot, 'runtime.sock') && typeof runtime.protectControlPath === 'function', 'CONTROL_OWNER_REQUIRED');
  runtime.protectControlPath(resolve(path));
  privateDirectory(dirname(resolve(path)));
  writeFileSync(path, JSON.stringify({ v: 1, socketPath, token }), { flag: 'wx', mode: 0o600 });
}
/** Private descriptor validation before listen: does not require an already-live socket. */
export function readStoredCredential(path) {
  safeFile(path); demand(lstatSync(path).size <= 4096, 'INVALID_CREDENTIAL');
  const value = decode(readFileSync(path, 'utf8')); fields(value, ['v', 'socketPath', 'token']);
  demand(value.v === 1 && typeof value.socketPath === 'string' && typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token), 'INVALID_CREDENTIAL');
  return value;
}
export function readCredential(path) {
  const value = readStoredCredential(path);
  privateDirectory(dirname(resolve(value.socketPath)));
  const stat = lstatSync(value.socketPath); demand(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, 'UNSAFE_SOCKET');
  return value;
}
export async function callSocket(credential, command, audience = 'operator') {
  demand(typeof credential.socketPath === 'string' && credential.socketPath.startsWith('/'), 'UNIX_SOCKET_REQUIRED');
  const wire = JSON.stringify({ v: 1, token: credential.token, command, audience }); demand(Buffer.byteLength(wire) <= LIMITS.envelope + 256, 'ENVELOPE_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: credential.socketPath }); let bytes = Buffer.alloc(0); let finished = false;
    const fail = error => { if (!finished) { finished = true; socket.destroy(); reject(error); } };
    socket.setTimeout(LIMITS.waitMs + 3000, () => fail(new RuntimeError('TRANSPORT_TIMEOUT')));
    socket.on('error', () => fail(new RuntimeError('TRANSPORT_ERROR')));
    socket.on('connect', () => socket.write(wire + '\n'));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > LIMITS.reply) { fail(new RuntimeError('RESPONSE_TOO_LARGE')); return; }
      const newline = bytes.indexOf(10); if (newline < 0) return;
      try { const value = decode(bytes.subarray(0, newline).toString('utf8')); finished = true; socket.destroy(); resolve(value); } catch (error) { fail(error); }
    });
    socket.on('end', () => { if (!finished) fail(new RuntimeError('TRUNCATED_RESPONSE')); });
  });
}
