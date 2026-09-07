import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { demand, RuntimeError, within } from '../security.mjs';
import { OPERATIONS } from '../contract.mjs';
import { NativeSession, environment, nativeId, digest, workspaceFile, ROOT_DOCTRINE, MAKER_DOCTRINE } from './common.mjs';
import { guardTool, preToolGuard, providerEnvironment } from '../native-boundary.mjs';

export const CLAUDE_SDK_VERSION = '0.3.263';
export const CLAUDE_CLI_VERSION = '2.1.263';
export async function loadClaude() {
  try {
    const url = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(url)), 'package.json'), 'utf8'));
    demand(pkg.version === CLAUDE_SDK_VERSION && pkg.claudeCodeVersion === CLAUDE_CLI_VERSION, 'CLAUDE_VERSION_UNSUPPORTED');
    const sdk = await import(url); return { query: sdk.query, version: pkg.version, cliVersion: pkg.claudeCodeVersion };
  } catch { throw new RuntimeError('CLAUDE_SDK_MISSING_OR_UNSUPPORTED'); }
}
class InputQueue {
  constructor() { this.values = []; this.waiter = null; this.closed = false; }
  push(value) { demand(!this.closed && this.values.length < 1, 'CLAUDE_INPUT_BOUND'); if (this.waiter) { this.waiter({ value, done: false }); this.waiter = null; } else this.values.push(value); }
  close() { this.closed = true; this.waiter?.({ done: true }); this.waiter = null; }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(resolve => { this.waiter = resolve; }); }
}
export function claudeOptions(s, mcp, env, spawnProcess) {
  return { cwd: s.input.context.cwd, sessionId: s.id, model: s.requested.model, effort: s.requested.thinking,
    maxTurns: s.limits.turns, includePartialMessages: true, persistSession: true, settingSources: [], settings: {}, plugins: [], skills: [], agents: {},
    tools: s.writer ? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion'] : ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
    disallowedTools: ['Agent', 'Bash', 'Task', 'WebFetch', 'WebSearch'], permissionMode: 'default', permissionPrompts: 'host',
    env, mcpServers: mcp ?? {}, strictMcpConfig: true, systemPrompt: { type: 'preset', preset: 'claude_code', append: s.root ? ROOT_DOCTRINE : MAKER_DOCTRINE },
    hooks: { PreToolUse: [{ hooks: [async (input, _toolUseId, options) => {
      if (!s.initialized || !s.active || input.session_id !== s.id || options.signal.aborted) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Stale or unowned tool invocation.' } };
      return preToolGuard({ cwd: s.input.context.cwd, writer: s.writer, root: s.root }, input);
    }] }] },
    canUseTool: (name, input, options) => claudePermission(s, name, input, options),
    supportedDialogKinds: [], onUserDialog: async () => ({ behavior: 'cancelled' }),
    stderr: chunk => { s.stderrBytes = (s.stderrBytes ?? 0) + Buffer.byteLength(chunk); if (s.stderrBytes > s.limits.stderr) s.fail('NATIVE_STDERR_BOUND'); },
    spawnClaudeCodeProcess: options => {
      const child = spawnProcess(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
      s.process = child;
      child.stdout.on('data', chunk => s.guarded(() => s.count(chunk.toString('utf8'))));
      child.stderr.on('data', chunk => { s.stderrBytes = (s.stderrBytes ?? 0) + chunk.length; if (s.stderrBytes > s.limits.stderr) s.fail('NATIVE_STDERR_BOUND'); });
      child.on('exit', code => s.guarded(() => s.exited(code)));
      child.on('error', () => s.fail('NATIVE_PROCESS_ERROR'));
      return child;
    },
  };
}
const MCP_TOOLS = new Set(OPERATIONS.map(op => `mcp__advisor_runtime__advisor_${op.replaceAll('.', '_')}`));
const DENY = { behavior: 'deny', message: 'Denied by bounded advisor host policy.' };
export function claudePermission(s, name, input, options) {
  try {
    demand(s.initialized && s.active && !options.agentID && !options.signal.aborted, 'STALE_OR_NESTED_PERMISSION');
    nativeId(options.requestId); nativeId(options.toolUseID);
    guardTool({ cwd: s.input.context.cwd, writer: s.writer, root: s.root }, name, input);
    const key = options.requestId;
    if (s.permissionPromises.has(key)) { demand(s.permissionFingerprints.get(key) === digest([name, input, options.toolUseID]), 'REQUEST_REUSE'); return s.permissionPromises.get(key); }
    if (s.root && MCP_TOOLS.has(name)) return Promise.resolve({ behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID });
    let respond; let text; let kind = 'permission';
    if (name === 'AskUserQuestion') {
      demand(Array.isArray(input.questions) && input.questions.length >= 1 && input.questions.length <= 4, 'CLAUDE_QUESTIONS');
      const seen = new Set();
      for (const q of input.questions) {
        demand(typeof q.question === 'string' && !seen.has(q.question) && typeof q.multiSelect === 'boolean' && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4, 'CLAUDE_QUESTION_SHAPE'); seen.add(q.question);
      }
      text = JSON.stringify({ questions: input.questions }); kind = 'question';
      respond = answer => {
        let answers; try { answers = JSON.parse(answer); } catch { throw new RuntimeError('ANSWER_JSON_REQUIRED'); }
        demand(Object.keys(answers).length === seen.size && Object.keys(answers).every(k => seen.has(k)) && Object.values(answers).every(v => typeof v === 'string' && v.length <= 2048), 'QUESTION_ID_MISMATCH');
        return { behavior: 'allow', updatedInput: { ...input, answers }, toolUseID: options.toolUseID };
      };
    } else if ((s.writer ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'] : ['Read', 'Glob', 'Grep']).includes(name)) {
      const path = input.file_path ?? input.path ?? s.input.context.cwd;
      demand(typeof path === 'string' && within(s.input.context.cwd, resolve(s.input.context.cwd, path)), 'TOOL_PATH_FORBIDDEN');
      demand(!options.blockedPath || within(s.input.context.cwd, resolve(options.blockedPath)), 'TOOL_PATH_FORBIDDEN');
      const fileEdit = s.writer && ['Edit', 'Write'].includes(name);
      if (fileEdit) workspaceFile(s.input.context.cwd, path);
      text = JSON.stringify({ tool: name, toolUseID: options.toolUseID, path, inputSha256: digest(input), decision: fileEdit ? 'allow or deny this exact file input only; no permission updates' : 'deny only; expanded tool permissions unsupported' });
      respond = answer => {
        if (answer === 'deny') return { ...DENY, toolUseID: options.toolUseID };
        demand(fileEdit && answer === 'allow', 'APPROVAL_GRANT_UNSUPPORTED'); workspaceFile(s.input.context.cwd, path);
        return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID };
      };
    } else { s.fail('UNKNOWN_OR_NESTED_TOOL'); return Promise.resolve(DENY); }
    const promise = new Promise(resolve => {
      const record = s.block(key, kind, text, answer => resolve(respond(answer)));
      record.abort = () => resolve({ ...DENY, interrupt: true });
      options.signal.addEventListener('abort', () => { record.abort(); if (!record.answered && !s.cancelled) s.fail('STALE_PERMISSION'); }, { once: true });
    });
    s.permissionPromises.set(key, promise); s.permissionFingerprints.set(key, digest([name, input, options.toolUseID])); return promise;
  } catch { s.fail('NATIVE_PERMISSION_PROTOCOL'); return Promise.resolve(DENY); }
}
const RESULT_ERRORS = new Set(['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);
export function decodeClaude(s, message) {
  s.count(message); demand(message.session_id === s.id, 'FOREIGN_SESSION');
  if (message.uuid) {
    nativeId(message.uuid); const prior = s.messages.get(message.uuid); const fingerprint = digest(message);
    if (prior) { demand(prior === fingerprint, 'MESSAGE_REUSE'); return; } s.messages.set(message.uuid, fingerprint);
  }
  demand(!message.parent_tool_use_id, 'NESTED_AGENT_FORBIDDEN');
  if (message.type === 'system' && message.subtype === 'init') {
    demand(!s.initialized && message.claude_code_version === CLAUDE_CLI_VERSION && message.permissionMode === 'default' && message.cwd === s.input.context.cwd, 'CLAUDE_INIT_DRIFT');
    const visible = s.writer ? ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion'] : ['Read', 'Glob', 'Grep', 'AskUserQuestion'];
    demand(Array.isArray(message.tools) && message.tools.every(tool => visible.includes(tool) || (s.root && MCP_TOOLS.has(tool))), 'CLAUDE_TOOL_DRIFT');
    demand(!message.agents?.length && Array.isArray(message.mcp_servers) && message.mcp_servers.every(server => s.root && server.name === 'advisor_runtime' && server.status === 'connected'), 'CLAUDE_MCP_DRIFT');
    demand(!s.root || message.mcp_servers.some(server => server.name === 'advisor_runtime'), 'ROOT_MCP_REQUIRED');
    s.initialized = true; s.capabilities = message.capabilities ?? [];
    s.observed = { host: 'claude-code', sdk: CLAUDE_SDK_VERSION, version: message.claude_code_version, session: message.session_id, model: message.model ?? null, thinking: message.effort ?? null }; s.identity(); return;
  }
  demand(s.initialized, 'INIT_REQUIRED');
  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    demand(['idle', 'running', 'requires_action'].includes(message.state), 'UNKNOWN_SESSION_STATUS');
    if (message.state === 'idle' && s.result) { const result = s.result; s.result = null; s.finish(result.status, result.text); }
    return;
  }
  demand(s.active, 'OUT_OF_ORDER');
  if (message.type === 'stream_event') {
    const event = message.event;
    demand(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(event?.type), 'UNKNOWN_STREAM_EVENT');
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') demand(event.content_block.name !== 'Agent' && event.content_block.name !== 'Task', 'NESTED_AGENT_FORBIDDEN');
    if (event.type === 'content_block_delta') {
      demand(['text_delta', 'thinking_delta', 'signature_delta', 'input_json_delta'].includes(event.delta?.type), 'UNKNOWN_DELTA');
      if (event.delta.type === 'text_delta') s.progress(event.delta.text);
    }
    return;
  }
  if (message.type === 'assistant') {
    demand(Array.isArray(message.message?.content), 'CLAUDE_CONTENT');
    for (const block of message.message.content) {
      demand(['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type), 'UNKNOWN_CONTENT');
      if (block.type === 'tool_use') demand(block.name !== 'Agent' && block.name !== 'Task', 'NESTED_AGENT_FORBIDDEN');
    }
    return;
  }
  if (message.type === 'user') return;
  if (message.type === 'result') {
    demand(!s.result && (message.subtype === 'success' || RESULT_ERRORS.has(message.subtype)) && typeof message.is_error === 'boolean', 'UNKNOWN_RESULT');
    nativeId(s.inputUuid); demand(message.user_message_uuid === s.inputUuid && (!message.user_message_uuids || (message.user_message_uuids.length === 1 && message.user_message_uuids[0] === s.inputUuid)), 'RESULT_TURN_MISMATCH');
    demand(Number.isSafeInteger(message.num_turns) && message.num_turns <= s.limits.turns && !message.queued_turn_count, 'CLAUDE_TURN_BOUND');
    const status = s.cancelled ? 'cancelled' : message.subtype === 'success' && !message.is_error ? 'done' : 'failed';
    // Result receipt is distinct from the authoritative idle/turn-over event.
    s.result = { status, text: status === 'done' ? message.result : `Native turn ${status}.` }; return;
  }
  throw new RuntimeError('UNKNOWN_OR_NESTED_EVENT');
}
export function createClaudeAdapter({ load = loadClaude, env = environment(), mcpFor = () => null, spawnProcess = spawn, limits } = {}) {
  const sessions = new Map();
  return {
    capabilities: Object.fromEntries(['node.launch', 'node.reply', 'node.cancel', 'root.create', 'root.message', 'root.reply', 'root.cancel', 'root.stop'].map(op => [op, true])),
    async execute(input) {
      const create = ['node.launch', 'root.create'].includes(input.effect.op); let s;
      try {
        if (create) {
          demand(!input.handle, 'SESSION_ALREADY_EXISTS'); const sdk = await load();
          demand(sdk.version === CLAUDE_SDK_VERSION && sdk.cliVersion === CLAUDE_CLI_VERSION, 'CLAUDE_VERSION_UNSUPPORTED');
          const boundary = providerEnvironment('claude-code', env, input.context.cwd, input.context.artifactDirectory, input.context.controlPaths ?? []);
          s = new NativeSession(input, 'claude-code', limits); demand(['low', 'medium', 'high', 'xhigh', 'max'].includes(s.requested.thinking), 'CLAUDE_EFFORT_UNSUPPORTED');
          s.messages = new Map(); s.permissionPromises = new Map(); s.permissionFingerprints = new Map(); s.queue = new InputQueue();
          const mcp = s.root ? await mcpFor(input.effect.scope) : null; demand(!s.root || mcp, 'ROOT_MCP_REQUIRED');
          // Session UUID is preselected using the pinned SDK sessionId option; no input is sent before durable handle.
          input.recordHandle({ id: s.id, session: s.id, requiresExit: true }); s.identity(); sessions.set(s.id, s);
          s.query = sdk.query({ prompt: s.queue, options: claudeOptions(s, mcp, boundary.env, spawnProcess) });
          s.stop = () => { s.pending?.abort?.(); s.queue.close(); s.query.close(); };
          // The pinned public initialization receipt confirms all-invocation hook
          // registration before the first lower-trust prompt is submitted.
          let initTimer;
          try {
            const initialized = await Promise.race([s.query.initializationResult(), new Promise((_, reject) => { initTimer = setTimeout(() => reject(new RuntimeError('CLAUDE_INITIALIZE_TIMEOUT')), s.limits.rpcMs); })]);
            demand(initialized.hooks_applied === true, 'CLAUDE_HOOK_REGISTRATION_REQUIRED');
          } finally { clearTimeout(initTimer); }
          void (async () => {
            try { for await (const message of s.query) { if (s.failed) break; decodeClaude(s, message); } if (s.active && !s.failed) s.fail('NATIVE_EOF_BEFORE_TERMINAL'); }
            catch { s.fail('NATIVE_PROTOCOL'); }
          })();
        } else { s = sessions.get(input.handle?.id); demand(s, 'SESSION_NOT_OWNED'); s.bind(input); }
        const op = input.effect.op;
        if (create || op === 'root.message') {
          s.startTurn();
          const uuidHash = digest([s.id, input.effect.commandId]);
          s.inputUuid = `${uuidHash.slice(0, 8)}-${uuidHash.slice(8, 12)}-4${uuidHash.slice(13, 16)}-a${uuidHash.slice(17, 20)}-${uuidHash.slice(20, 32)}`;
          s.write('input.json', JSON.stringify({ commandId: input.effect.commandId, uuid: s.inputUuid, attempt: input.effect.attempt }));
          s.queue.push({ type: 'user', message: { role: 'user', content: create && !s.root ? `${MAKER_DOCTRINE}\nPacket: ${JSON.stringify(input.effect.payload.packet)}` : input.effect.payload.text }, parent_tool_use_id: null, uuid: s.inputUuid });
        } else if (op.endsWith('.reply')) await s.reply(input.effect.payload.text, input.effect.payload.requestId);
        else if (op.endsWith('.cancel')) {
          demand(s.active && s.capabilities.includes('interrupt_receipt_v1'), 'INTERRUPT_CAPABILITY_REQUIRED'); s.cancelled = true;
          if (s.pending) { s.pending.answered = true; s.pending.abort?.(); s.pending = null; }
          const receipt = await s.query.interrupt(); demand(Array.isArray(receipt?.still_queued) && receipt.still_queued.length === 0, 'QUEUED_INPUT_AMBIGUOUS');
        } else if (op === 'root.stop') { demand(!s.active, 'ROOT_NOT_IDLE'); clearTimeout(s.timer); s.stop(); }
        else throw new RuntimeError('UNSUPPORTED_CAPABILITY');
        demand(!s.failed, 'RECOVERY_REQUIRED'); return { accepted: true };
      } catch { s?.fail('NATIVE_PROTOCOL'); throw new RuntimeError('CLAUDE_ADAPTER_REJECTED'); }
    },
  };
}
