import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { atomicWrite, demand, privateDirectory, safeFile, within } from '../security.mjs';

export const NATIVE_LIMITS = Object.freeze({ turns: 6, timeMs: 180000, bytes: 1048576, stderr: 65536, requests: 32, rpcMs: 8000 });
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const nativeId = value => demand(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value), 'NATIVE_ID');
export function environment(source = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].filter(k => typeof source[k] === 'string').map(k => [k, source[k]]));
}
/** One-shot file-tool authorization never follows symlinks or leaves the assigned workspace. */
export function workspaceFile(cwd, value) {
  demand(typeof value === 'string' && value.length > 0, 'TOOL_PATH_FORBIDDEN');
  const path = resolve(cwd, value); demand(within(cwd, path) && path !== cwd, 'TOOL_PATH_FORBIDDEN');
  let current = path;
  while (within(cwd, current)) {
    try { const stat = lstatSync(current); demand(!stat.isSymbolicLink() && (current !== path || (stat.isFile() && stat.nlink === 1)), 'TOOL_PATH_FORBIDDEN'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === cwd) break; current = dirname(current);
  }
  demand(realpathSync(cwd) === cwd, 'TOOL_PATH_FORBIDDEN'); return path;
}
export const ROOT_DOCTRINE = 'You are the advisor. Choose strategy directly, not via a hidden strategy agent. Use only scoped advisor_runtime tools for delegation. Prefer one direct maker (packet.admit then node.launch) for cohesive work; graphs only for real dependencies. Inspect durable wait deliveries, acknowledge only after processing, and synthesize evidence. Never use native Agent/spawn tools. Readiness is not live certification. Do not read credentials or service state files.';
export const MAKER_DOCTRINE = 'You are the sole maker for this packet. Never launch an agent, graph, orchestrator, routine, or inter-session message. Work only in the assigned workspace. Prove every acceptance criterion and inspect your own diff. Return a final bounded result with Status, Claims, Evidence, Files, Decisions, Remaining Risk. The host persists your final answer as result.md; do not write outside the workspace. Ask through the supported question tool if blocked. Never read credential or service state files. Model prose is not trusted verification.';

/** Local lifecycle bookkeeping only. All authority, requests and deliveries commit in AdvisorRuntime. */
export class NativeSession {
  constructor(input, provider, limits = NATIVE_LIMITS) {
    this.input = input; this.provider = provider; this.limits = { ...NATIVE_LIMITS, ...limits };
    for (const key of Object.keys(NATIVE_LIMITS)) demand(Number.isSafeInteger(this.limits[key]) && this.limits[key] > 0 && this.limits[key] <= NATIVE_LIMITS[key], 'INVALID_NATIVE_BOUND');
    demand(input.context.nestedDelegation === false, 'NESTED_AGENT_FORBIDDEN');
    const { cwd, artifactDirectory } = input.context;
    demand(realpathSync(cwd) === cwd && !within(cwd, artifactDirectory), 'STATE_IN_WORKSPACE');
    privateDirectory(artifactDirectory);
    this.root = input.effect.scope.node === 'root'; this.id = randomUUID(); this.sequence = 0; this.bytes = 0; this.turns = 0; this.pending = null; this.requests = new Map(); this.failed = false; this.active = false; this.cancelled = false;
    this.writer = !this.root && ['builder', 'foreman'].includes(input.effect.payload.packet.role);
    this.requested = this.root ? { model: input.effect.payload.model, thinking: input.effect.payload.thinking } : { model: input.effect.payload.packet.model, thinking: input.effect.payload.packet.thinking };
    this.observed = { host: provider, version: null, model: null, thinking: null, session: null };
    this.timer = setTimeout(() => this.fail('NATIVE_TIME_BOUND'), this.limits.timeMs);
  }
  bind(input) {
    demand(!this.failed && input.handle?.id === this.id && digest(input.effect.scope) === digest(this.input.effect.scope), 'SESSION_OWNERSHIP');
    this.input = input;
  }
  emit(kind, data) {
    demand(!this.failed, 'RECOVERY_REQUIRED');
    return this.input.emit({ id: `native-${this.id}-${++this.sequence}`, kind, attempt: this.input.effect.attempt, data });
  }
  write(name, content) {
    demand(Buffer.byteLength(content) <= 65536, 'ARTIFACT_BOUND');
    const path = join(this.input.context.artifactDirectory, name); privateDirectory(this.input.context.artifactDirectory); safeFile(path); atomicWrite(path, content);
  }
  identity() { this.write('native.json', JSON.stringify({ requested: this.requested, observed: this.observed, limits: this.limits, certification: 'not-live-certified' }, null, 2)); }
  count(value) { this.bytes += Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)); demand(this.bytes <= this.limits.bytes, 'NATIVE_OUTPUT_BOUND'); }
  startTurn() { demand(!this.active && ++this.turns <= this.limits.turns, 'NATIVE_TURN_BOUND'); this.active = true; this.cancelled = false; this.answer = ''; }
  progress(text) {
    demand(this.active, 'OUT_OF_ORDER');
    // Already-buffered output can arrive after a permission/cancel was committed.
    // It cannot change blocked/cancel state or be used as completion evidence.
    if (this.pending || this.cancelled) return;
    if (!text?.trim()) return;
    demand(Buffer.byteLength(text) <= 16384, 'NATIVE_TEXT_BOUND');
    this.emit('progress', this.root ? { text } : { note: text });
  }
  block(key, kind, text, respond) {
    nativeId(key); demand(this.active, 'OUT_OF_ORDER');
    const id = `request-${digest([this.id, key])}`;
    if (this.requests.has(key)) { demand(this.requests.get(key).fingerprint === digest([kind, text]), 'REQUEST_REUSE'); return this.requests.get(key); }
    demand(!this.pending && this.requests.size < this.limits.requests, 'REQUEST_BOUND_OR_CONCURRENT');
    const record = { id, key, kind, text, respond, fingerprint: digest([kind, text]), answered: false };
    this.requests.set(key, record); this.pending = record;
    this.write('request.json', JSON.stringify({ id, kind, text, attempt: this.input.effect.attempt }));
    if (!this.root) this.write('result.md', `# Status\nBLOCKED\n${text}\n`);
    this.emit('blocked', { requestId: id, kind, text }); return record;
  }
  async reply(text, requestId) {
    const request = this.pending; demand(request && !request.answered && request.id === requestId, 'REQUEST_MISMATCH');
    // Clear before native response: callbacks may arrive synchronously.
    request.answered = true; this.pending = null;
    await request.respond(text);
    this.write('request.json', JSON.stringify({ id: request.id, answered: true }));
  }
  finish(status, text) {
    demand(this.active && !this.pending, 'OUT_OF_ORDER');
    demand(['done', 'failed', 'cancelled'].includes(status), 'NATIVE_STATUS');
    if (status === 'cancelled') demand(this.cancelled, 'CANCEL_NOT_ACCEPTED');
    // A successful native turn without evidence must stay blank so result-v2 stalls it.
    const output = text?.trim() || (status === 'done' ? '' : `Native turn ${status}.`);
    demand(Buffer.byteLength(output) <= 16384, 'NATIVE_TEXT_BOUND');
    if (this.root) this.emit('completed', { text: output || 'Native turn completed without text.' });
    else { this.write('result.md', output); this.emit('settled', { status, reason: `native-${status}`, verified: false }); }
    this.active = false; this.identity();
    if (!this.root) { clearTimeout(this.timer); this.stop?.(); }
  }
  exited(code) {
    clearTimeout(this.timer);
    if (this.failed) return;
    if (this.active) { this.fail('NATIVE_EXIT_BEFORE_TERMINAL'); return; }
    this.emit('process-exited', { code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1 });
  }
  fail(code) {
    if (this.failed) return;
    this.failed = true; clearTimeout(this.timer);
    // Never persist a native exception, stderr, request secret, or raw error object.
    try { this.write('diagnostic.json', JSON.stringify({ code: /^[A-Z_]+$/.test(code) ? code : 'NATIVE_PROTOCOL', recoveryRequired: true })); } catch {}
    try { this.input.context.recoveryRequired(); } finally { this.stop?.(); }
  }
  guarded(fn) { try { return fn(); } catch { this.fail('NATIVE_PROTOCOL'); return undefined; } }
}
