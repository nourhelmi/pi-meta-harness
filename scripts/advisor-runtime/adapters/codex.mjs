import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { demand, privateDirectory, RuntimeError } from '../security.mjs';
import { NativeSession, environment, nativeId, digest, ROOT_DOCTRINE, MAKER_DOCTRINE } from './common.mjs';
import { permissionConfig, configArgs, READ_PROFILE, WRITE_PROFILE, providerEnvironment, assertPermissionConfig } from '../native-boundary.mjs';

export const CODEX_VERSION = '0.153.4';
export function codexIsolatedConfig(home, cwd, { ownedEntryProject = false } = {}) {
  const absent = path => { try { lstatSync(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
  demand(absent(join(home, 'config.toml')), 'CODEX_CONFIG_NOT_ISOLATED');
  for (let path = cwd; ; path = dirname(path)) {
    if (path !== cwd || !ownedEntryProject) demand(absent(join(path, '.codex')), 'CODEX_CONFIG_NOT_ISOLATED');
    if (dirname(path) === path) break;
  }
}
export function codexVersion(env = environment()) {
  const probe = spawnSync('codex', ['--version'], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  demand(probe.status === 0 && probe.stdout.trim() === `codex-cli ${CODEX_VERSION}`, 'CODEX_VERSION_UNSUPPORTED');
  return CODEX_VERSION;
}
export function codexThreadOptions(s, mcp) {
  return { model: s.requested.model, allowProviderModelFallback: false, cwd: s.input.context.cwd,
    runtimeWorkspaceRoots: [s.input.context.cwd], approvalPolicy: 'untrusted', approvalsReviewer: 'user', permissions: s.writer ? WRITE_PROFILE : READ_PROFILE,
    config: { ...permissionConfig(s.input.context.cwd, s.controls ?? []), mcp_servers: mcp ?? {} },
    environments: [], experimentalRawEvents: false, developerInstructions: s.root ? ROOT_DOCTRINE : MAKER_DOCTRINE };
}
export function codexTurnOptions(s, text) {
  return { threadId: s.thread, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: s.input.effect.commandId,
    approvalPolicy: 'untrusted', approvalsReviewer: 'user', model: s.requested.model, effort: s.requested.thinking,
    permissions: s.writer ? WRITE_PROFILE : READ_PROFILE, runtimeWorkspaceRoots: [s.input.context.cwd], environments: [] };
}

/** Bounded NDJSON transport. A response ID must belong to this client; errors never echo host content. */
export class CodexWire {
  constructor(child, session) {
    this.child = child; this.s = session; this.pending = new Map(); this.serial = 0; this.buffer = Buffer.alloc(0); this.stderr = 0;
    child.stdout.on('data', chunk => session.guarded(() => {
      session.count(chunk.toString('utf8')); this.buffer = Buffer.concat([this.buffer, chunk]);
      demand(this.buffer.length <= session.limits.bytes, 'NATIVE_OUTPUT_BOUND');
      let end;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        let message; try { message = JSON.parse(line.toString('utf8')); } catch { throw new RuntimeError('NATIVE_JSON'); }
        if (Object.hasOwn(message, 'id') && !message.method) {
          const request = this.pending.get(message.id); demand(request, 'UNKNOWN_RESPONSE'); this.pending.delete(message.id); clearTimeout(request.timer);
          if (message.error || !Object.hasOwn(message, 'result')) request.reject(new RuntimeError('NATIVE_RPC_ERROR')); else request.resolve(message.result);
        } else this.onMessage(message);
      }
    }));
    child.stderr.on('data', chunk => { this.stderr += chunk.length; if (this.stderr > session.limits.stderr) session.fail('NATIVE_STDERR_BOUND'); });
    child.on('error', () => session.fail('NATIVE_PROCESS_ERROR'));
    child.on('exit', code => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new RuntimeError('NATIVE_EXIT')); } this.pending.clear();
      session.guarded(() => { demand(this.buffer.length === 0, 'TRUNCATED_NATIVE_FRAME'); session.exited(code); });
    });
    child.stdin.on('error', () => session.fail('NATIVE_STDIN_ERROR'));
  }
  send(value) { demand(!this.s.failed, 'RECOVERY_REQUIRED'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params) {
    demand(this.pending.size < 16, 'NATIVE_RPC_BOUND'); const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RuntimeError('NATIVE_RPC_TIMEOUT')); this.s.fail('NATIVE_RPC_TIMEOUT'); }, this.s.limits.rpcMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
}
const ITEMS = new Set(['userMessage', 'agentMessage', 'plan', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'contextCompaction']);
const PROGRESS = new Set(['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated', 'item/mcpToolCall/progress']);
const INFO = new Set(['thread/tokenUsage/updated', 'turn/diff/updated', 'turn/plan/updated']);
function item(s, value) {
  nativeId(value?.id); demand(ITEMS.has(value.type), 'UNKNOWN_OR_NESTED_ITEM');
  if (value.status !== undefined) demand(['inProgress', 'completed', 'failed', 'declined'].includes(value.status), 'UNKNOWN_ITEM_STATUS');
  if (value.type === 'mcpToolCall') demand(s.root && value.server === 'advisor_runtime' && value.tool.startsWith('advisor_'), 'FOREIGN_MCP');
}
function correlate(s, p, withItem = false) {
  demand(p?.threadId === s.thread && p.turnId === s.turn && s.active, 'NATIVE_CORRELATION');
  if (withItem) { nativeId(p.itemId); demand(s.items.has(p.itemId), 'UNKNOWN_ITEM'); }
}
export function decodeCodex(s, message) {
  const { method, params: p } = message; demand(typeof method === 'string' && p, 'NATIVE_MESSAGE');
  if (Object.hasOwn(message, 'id')) { approval(s, message); return; }
  if (method === 'remoteControl/status/changed') { demand(p.status === 'disabled', 'REMOTE_CONTROL_FORBIDDEN'); return; }
  if (method === 'turn/completed' && s.completedTurns?.has(p.turn?.id)) { demand(s.completedTurns.get(p.turn.id) === digest(p), 'EVENT_REUSE'); return; }
  if (method === 'thread/started') { nativeId(p.thread?.id); demand(!s.thread || s.thread === p.thread.id, 'FOREIGN_THREAD'); s.thread = p.thread.id; return; }
  if (method === 'thread/status/changed') {
    demand(p.threadId === s.thread && ['notLoaded', 'idle', 'active', 'systemError'].includes(p.status?.type), 'UNKNOWN_THREAD_STATUS');
    demand(p.status.type !== 'systemError', 'NATIVE_SYSTEM_ERROR');
    if (p.status.type === 'active') demand(Array.isArray(p.status.activeFlags) && p.status.activeFlags.every(f => ['waitingOnApproval', 'waitingOnUserInput'].includes(f)), 'UNKNOWN_ACTIVE_FLAG');
    return;
  }
  if (method === 'turn/started') {
    demand(p.threadId === s.thread && s.active && (s.starting || s.turn === p.turn.id) && (!s.turn || s.turn === p.turn.id) && p.turn.status === 'inProgress', 'FOREIGN_TURN');
    nativeId(p.turn.id); s.turn = p.turn.id; return;
  }
  if (method === 'serverRequest/resolved') {
    demand(p.threadId === s.thread, 'FOREIGN_THREAD');
    const record = s.requests.get(JSON.stringify(p.requestId)); demand(record?.answered, 'UNANSWERED_REQUEST_RESOLVED'); return;
  }
  correlate(s, method === 'turn/completed' ? { ...p, turnId: p.turn?.id } : p, method.startsWith('item/') && !['item/started', 'item/completed'].includes(method));
  if (method === 'item/started' || method === 'item/completed') {
    item(s, p.item); const key = `${method}/${p.item.id}`; const prior = s.events.get(key); const fingerprint = digest(p.item);
    if (prior) { demand(prior === fingerprint, 'EVENT_REUSE'); return; }
    if (method === 'item/started') demand(!s.items.has(p.item.id), 'DUPLICATE_ITEM'); else demand(s.items.has(p.item.id), 'ITEM_OUT_OF_ORDER');
    s.events.set(key, fingerprint); s.items.add(p.item.id);
    if (method === 'item/completed' && p.item.type === 'agentMessage') { demand(typeof p.item.text === 'string', 'NATIVE_TEXT'); s.answer = p.item.text; }
    return;
  }
  if (method === 'item/agentMessage/delta') { demand(typeof p.delta === 'string', 'NATIVE_DELTA'); s.progress(p.delta); return; }
  if (PROGRESS.has(method)) { s.progress(`Native progress: ${method}`); return; }
  if (INFO.has(method)) return;
  if (method === 'turn/completed') {
    demand(p.turn?.id === s.turn && ['completed', 'interrupted', 'failed'].includes(p.turn.status), 'UNKNOWN_TURN_STATUS');
    demand(Array.isArray(p.turn.items), 'NATIVE_ITEMS'); p.turn.items.forEach(value => item(s, value));
    s.completedTurns ??= new Map(); s.completedTurns.set(p.turn.id, digest(p));
    s.finish(p.turn.status === 'completed' ? 'done' : p.turn.status === 'interrupted' && s.cancelled ? 'cancelled' : 'failed', p.turn.status === 'completed' ? s.answer : `Native turn ${p.turn.status}.`); return;
  }
  throw new RuntimeError('UNKNOWN_NATIVE_EVENT');
}
function approval(s, { id, method, params: p }) {
  demand(typeof id === 'string' || Number.isSafeInteger(id), 'NATIVE_REQUEST_ID'); correlate(s, p, true);
  const key = JSON.stringify(id); let kind = 'permission'; let text; let response;
  if (method === 'item/tool/requestUserInput') {
    demand(p.isBlocking === true && (p.autoResolutionMs === null || p.autoResolutionMs === undefined), 'ASYNC_QUESTION_UNSUPPORTED');
    demand(Array.isArray(p.questions) && p.questions.length > 0 && p.questions.length <= 4, 'NATIVE_QUESTIONS');
    const seen = new Set(); for (const q of p.questions) { nativeId(q.id); demand(!seen.has(q.id) && q.isSecret === false && typeof q.question === 'string', 'SECRET_OR_DUPLICATE_QUESTION'); seen.add(q.id); }
    kind = 'question'; text = JSON.stringify({ questions: p.questions.map(q => ({ id: q.id, question: q.question, options: q.options })) });
    response = answer => {
      let answers; try { answers = JSON.parse(answer); } catch { throw new RuntimeError('ANSWER_JSON_REQUIRED'); }
      demand(answers && Object.keys(answers).length === seen.size && Object.keys(answers).every(k => seen.has(k)), 'QUESTION_ID_MISMATCH');
      for (const list of Object.values(answers)) demand(Array.isArray(list) && list.length > 0 && list.every(v => typeof v === 'string' && v.length <= 2048), 'INVALID_ANSWER');
      return { answers: Object.fromEntries(Object.entries(answers).map(([k, answers]) => [k, { answers }])) };
    };
  } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    demand(Number.isSafeInteger(p.startedAtMs), 'NATIVE_APPROVAL');
    if (p.cwd !== undefined) demand(p.cwd === s.input.context.cwd, 'APPROVAL_CWD');
    text = JSON.stringify({ method, itemId: p.itemId, decision: 'decline or cancel (grant unsupported by this bounded adapter)' });
    response = answer => { demand(['decline', 'cancel'].includes(answer), 'APPROVAL_GRANT_UNSUPPORTED'); return { decision: answer }; };
  } else if (method === 'item/permissions/requestApproval') {
    demand(p.permissions && p.cwd === s.input.context.cwd, 'NATIVE_PERMISSIONS');
    text = JSON.stringify({ method, itemId: p.itemId, decision: 'deny only; no expanded filesystem/network grants' });
    response = answer => { demand(answer === 'deny', 'APPROVAL_GRANT_UNSUPPORTED'); return { permissions: {}, scope: 'turn', strictAutoReview: true }; };
  } else throw new RuntimeError('UNKNOWN_NATIVE_REQUEST');
  s.block(key, kind, text, answer => s.wire.send({ id, result: response(answer) }));
}

/** Factories inject only trusted test seams; client payloads cannot supply executables/configuration. */
export function createCodexAdapter({ spawnProcess = spawn, probe = codexVersion, env = environment(), mcpFor = () => null, limits } = {}) {
  const sessions = new Map();
  return {
    capabilities: Object.fromEntries(['node.launch', 'node.reply', 'node.cancel', 'root.create', 'root.message', 'root.reply', 'root.cancel', 'root.stop'].map(op => [op, true])),
    async execute(input) {
      const create = ['node.launch', 'root.create'].includes(input.effect.op); let s;
      try {
        if (create) {
          demand(!input.handle, 'SESSION_ALREADY_EXISTS'); probe(env);
          const boundary = providerEnvironment('codex', env, input.context.cwd, input.context.artifactDirectory, input.context.controlPaths ?? []);
          codexIsolatedConfig(boundary.env.CODEX_HOME, input.context.cwd);
          s = new NativeSession(input, 'codex', limits); s.controls = boundary.controls;
          demand(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(s.requested.thinking), 'CODEX_EFFORT_UNSUPPORTED');
          const mcp = s.root ? await mcpFor(input.effect.scope) : null; demand(!s.root || mcp, 'ROOT_MCP_REQUIRED');
          const config = { ...permissionConfig(input.context.cwd, s.controls), mcp_servers: mcp ?? {} };
          const child = spawnProcess('codex', ['app-server', '--stdio', '--strict-config', ...configArgs(config)], { cwd: input.context.cwd, env: boundary.env, stdio: ['pipe', 'pipe', 'pipe'] });
          s.stop = () => { child.stdin.end(); child.kill('SIGTERM'); };
          s.wire = new CodexWire(child, s); s.wire.onMessage = message => decodeCodex(s, message);
          const init = await s.wire.request('initialize', { clientInfo: { name: 'portable-advisor', title: null, version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
          demand(typeof init.userAgent === 'string' && init.userAgent.includes(CODEX_VERSION), 'CODEX_HANDSHAKE_VERSION'); s.wire.send({ method: 'initialized' });
          const checked = await s.wire.request('config/read', { includeLayers: false, cwd: input.context.cwd });
          assertPermissionConfig(checked.config, config);
          const opened = await s.wire.request('thread/start', codexThreadOptions(s, mcp));
          nativeId(opened.thread?.id); demand(!s.thread || s.thread === opened.thread.id, 'FOREIGN_THREAD'); s.thread = opened.thread.id;
          demand(opened.approvalPolicy === 'untrusted' && opened.approvalsReviewer === 'user', 'CODEX_PERMISSION_DRIFT');
          demand(opened.cwd === input.context.cwd && opened.runtimeWorkspaceRoots?.length === 1 && opened.runtimeWorkspaceRoots[0] === input.context.cwd, 'CODEX_WORKSPACE_DRIFT');
          demand(opened.thread.parentThreadId === null && opened.thread.agentRole === null && opened.thread.canAcceptDirectInput === true && ['appServer', 'cli'].includes(opened.thread.source), 'NESTED_OR_UNOWNED_THREAD');
          demand(opened.activePermissionProfile?.id === (s.writer ? WRITE_PROFILE : READ_PROFILE) && opened.activePermissionProfile.extends === null, 'CODEX_PERMISSION_PROFILE_DRIFT');
          s.observed = { host: 'codex', version: CODEX_VERSION, model: opened.model ?? null, thinking: opened.reasoningEffort ?? null, session: s.thread };
          input.recordHandle({ id: s.id, session: s.thread, pid: child.pid }); s.identity(); sessions.set(s.id, s);
        } else { s = sessions.get(input.handle?.id); demand(s, 'SESSION_NOT_OWNED'); s.bind(input); }
        const op = input.effect.op;
        if (create || op === 'root.message') {
          s.startTurn(); s.items = new Set(); s.events = new Map(); s.turn = null; s.starting = true;
          const text = create && !s.root ? `${MAKER_DOCTRINE}\nPacket: ${JSON.stringify(input.effect.payload.packet)}` : input.effect.payload.text;
          const started = await s.wire.request('turn/start', codexTurnOptions(s, text));
          nativeId(started.turn?.id); demand(!s.turn || s.turn === started.turn.id, 'FOREIGN_TURN'); s.turn = started.turn.id; s.starting = false;
        } else if (op.endsWith('.reply')) await s.reply(input.effect.payload.text, input.effect.payload.requestId);
        else if (op.endsWith('.cancel')) {
          demand(s.active, 'NO_ACTIVE_TURN'); s.cancelled = true;
          if (s.pending) { s.pending.answered = true; s.pending = null; }
          await s.wire.request('turn/interrupt', { threadId: s.thread, turnId: s.turn });
        } else if (op === 'root.stop') { demand(!s.active, 'ROOT_NOT_IDLE'); clearTimeout(s.timer); s.stop(); }
        else throw new RuntimeError('UNSUPPORTED_CAPABILITY');
        demand(!s.failed, 'RECOVERY_REQUIRED'); return { accepted: true };
      } catch { s?.fail('NATIVE_PROTOCOL'); throw new RuntimeError('CODEX_ADAPTER_REJECTED'); }
    },
  };
}
