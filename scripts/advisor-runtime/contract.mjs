import { createHash } from 'node:crypto';
import { canonicalJson, isCommandId } from '../advisor-core/command-contract.mjs';
import { demand, id } from './security.mjs';

export const READS = ['workstream.open', 'progress', 'wait', 'history', 'artifact.read', 'log.read', 'team.status'];
export const MUTATIONS = ['workstream.create', 'packet.admit', 'graph.admit', 'wave.launch', 'node.launch', 'root.create', 'root.message', 'root.reply', 'root.cancel', 'root.stop', 'root.resume', 'node.reply', 'node.task', 'node.cancel', 'node.resume', 'team.enlist', 'team.rename', 'team.context', 'team.assign', 'team.message', 'team.retire', 'delivery.ack'];
export const OPERATIONS = [...READS, ...MUTATIONS];
export const WORKER_OPERATIONS = ['progress', 'wait', 'history', 'artifact.read', 'log.read', 'delivery.ack'];
export const LIMITS = Object.freeze({ envelope: 32768, text: 16384, reply: 1048576, connections: 32, requests: 128, waitMs: 10000, events: 128, artifact: 65536 });
export function fields(value, required, optional = []) {
  demand(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_SHAPE');
  demand(Object.keys(value).every(key => [...required, ...optional].includes(key)), 'EXTRA_FIELD');
  demand(required.every(key => Object.hasOwn(value, key)), 'MISSING_FIELD');
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) { demand(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INTEGER'); }
export function text(value, max = LIMITS.text) { demand(typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= max, 'INVALID_TEXT'); }
export function scope(value) { fields(value, ['workstream', 'run', 'node', 'ownerEpoch']); ['workstream', 'run', 'node'].forEach(key => id(value[key])); integer(value.ownerEpoch, 1); }
export function parseEnvelope(input) {
  const encoded = canonicalJson(input, LIMITS.envelope);
  let command;
  try { command = JSON.parse(encoded); } catch { demand(false, 'NON_JSON'); }
  const mutation = MUTATIONS.includes(command.op);
  fields(command, ['v', 'op', 'scope', 'payload', ...(mutation ? ['commandId', 'expectedRevision'] : [])]);
  demand(command.v === 1, 'UNSUPPORTED_VERSION');
  demand(OPERATIONS.includes(command.op), 'UNSUPPORTED_OPERATION');
  scope(command.scope);
  if (mutation) { id(command.commandId); integer(command.expectedRevision); }
  const p = command.payload;
  switch (command.op) {
    case 'workstream.create': fields(p, ['cwd', 'host']); text(p.cwd, 4096); demand(['codex', 'claude-code', 'pi'].includes(p.host), 'UNSUPPORTED_HOST'); break;
    case 'workstream.open': case 'progress': case 'root.stop': case 'root.resume': case 'node.resume': case 'team.status': fields(p, []); break;
    case 'node.launch': fields(p, ['node']); id(p.node); demand(p.node !== 'root', 'ROOT_SCOPE'); break;
    case 'packet.admit': fields(p, ['node', 'packet']); id(p.node); validatePacket(p.packet); demand(p.node !== 'root', 'ROOT_SCOPE'); break;
    case 'graph.admit': validateGraph(p); break;
    case 'wave.launch': fields(p, ['wave']); integer(p.wave, 1, 24); break;
    case 'root.create': fields(p, ['adapter', 'model', 'thinking', 'text']); id(p.adapter); text(p.model, 256); text(p.thinking, 128); text(p.text); break;
    case 'root.message': fields(p, ['text']); text(p.text); break;
    case 'root.reply': fields(p, ['requestId', 'text']); id(p.requestId); text(p.text); break;
    case 'root.cancel': fields(p, ['reason']); text(p.reason, 1024); break;
    case 'node.task': fields(p, ['attempt', 'handleId', 'generation', 'text']); integer(p.attempt, 1); text(p.handleId, 1024); integer(p.generation, 1); text(p.text); break;
    case 'node.reply': fields(p, ['attempt', 'requestId', 'text']); integer(p.attempt, 1); id(p.requestId); text(p.text); break;
    case 'node.cancel': fields(p, ['attempt', 'reason']); integer(p.attempt, 1); text(p.reason, 1024); break;
    case 'team.enlist': case 'team.rename': fields(p, ['name']); id(p.name); break;
    case 'team.context': fields(p, ['text']); text(p.text); break;
    case 'team.assign':
      fields(p, ['attempt', 'handleId', 'generation', 'assignmentId', 'task', 'acceptance', 'riskTier']);
      integer(p.attempt, 1); text(p.handleId, 1024); integer(p.generation, 1); id(p.assignmentId); text(p.task);
      demand(Array.isArray(p.acceptance) && p.acceptance.length > 0 && p.acceptance.length <= 12, 'INVALID_ACCEPTANCE');
      p.acceptance.forEach(item => text(item, 2048)); demand(['low', 'standard', 'high'].includes(p.riskTier), 'INVALID_RISK'); break;
    case 'team.message':
      fields(p, ['to', 'target', 'text']); id(p.to); text(p.text);
      if (p.to === 'root') { fields(p.target, ['rootSession']); text(p.target.rootSession, 256); }
      else { fields(p.target, ['memberId', 'assignmentId', 'session', 'handleId', 'generation']); id(p.target.memberId); id(p.target.assignmentId); text(p.target.session, 1024); text(p.target.handleId, 1024); integer(p.target.generation, 1); }
      break;
    case 'team.retire': fields(p, ['attempt', 'handleId', 'generation']); integer(p.attempt, 1); text(p.handleId, 1024); integer(p.generation, 1); break;
    case 'wait': fields(p, ['timeoutMs', 'limit']); integer(p.timeoutMs, 0, LIMITS.waitMs); integer(p.limit, 1, LIMITS.events); break;
    case 'history': fields(p, ['cursor', 'limit', 'maxBytes']); integer(p.cursor); integer(p.limit, 1, LIMITS.events); integer(p.maxBytes, 131072, 524288); break;
    case 'delivery.ack': fields(p, ['deliveryId']); integer(p.deliveryId, 1); break;
    case 'artifact.read': case 'log.read': fields(p, ['path', 'offset', 'maxBytes']); text(p.path, 4096); integer(p.offset, 0, 1048576); integer(p.maxBytes, 1, LIMITS.artifact); break;
  }
  return { command, mutation, digest: createHash('sha256').update(encoded).digest('hex') };
}
export function validatePacket(p) {
  fields(p, ['role', 'task', 'acceptance', 'riskTier', 'cwd', 'adapter', 'model', 'thinking'], ['execution']);
  if (p.execution !== undefined) {
    demand(p.adapter === 'pi-detach', 'EXECUTION_ADAPTER');
    const e = p.execution;
    fields(e, ['v', 'command', 'prompt', 'role', 'runtime', 'model', 'thinking', 'maxTurns', 'requiredSkills', 'harness', 'keepAlive', 'label', 'resultDiscovery', 'resultPolicy', 'sourceDirectory', 'environment']);
    fields(e.environment, ['ADVISOR_RUNTIME_DESCRIPTOR', 'PI_DETACH_RUNTIME_BRIDGE', 'ADVISOR_BRIDGE_WORKER_DIR', 'ADVISOR_RUNTIME_CANONICAL_OWNER'], ['ADVISOR_BRIDGE_CHILD_STATE', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_DETACH_AGENT_PROFILES', 'CODEX_HOME', 'ADVISOR_WORKSTREAM', 'PI_DETACH_WORKER_HARNESS', 'ADVISOR_TEAM_MODE']);
    demand(e.environment.ADVISOR_RUNTIME_DESCRIPTOR === '' && e.environment.PI_DETACH_RUNTIME_BRIDGE === '' && e.environment.ADVISOR_RUNTIME_CANONICAL_OWNER === '1' && e.environment.ADVISOR_BRIDGE_WORKER_DIR === e.sourceDirectory, 'EXECUTION_ENVIRONMENT');
    for (const value of Object.values(e.environment)) demand(typeof value === 'string' && Buffer.byteLength(value) <= 4096, 'EXECUTION_ENVIRONMENT');
    demand(e.v === 1 && e.resultPolicy === 'runtime-capture' && typeof e.keepAlive === 'boolean', 'EXECUTION_VERSION');
    for (const key of ['command', 'prompt', 'role', 'runtime', 'model', 'thinking', 'harness', 'label', 'sourceDirectory']) text(e[key]);
    demand(e.maxTurns === null || Number.isSafeInteger(e.maxTurns) && e.maxTurns > 0, 'EXECUTION_TURNS');
    demand(Array.isArray(e.requiredSkills) && e.requiredSkills.length <= 12, 'EXECUTION_SKILLS'); e.requiredSkills.forEach(skill => text(skill, 128));
    demand(e.resultDiscovery === null || typeof e.resultDiscovery === 'string', 'EXECUTION_DISCOVERY');
    demand(e.role === p.role && e.prompt === p.task && e.model === p.model && e.thinking === p.thinking, 'EXECUTION_MISMATCH');
  }
  ['role', 'adapter'].forEach(key => id(p[key])); ['task', 'cwd', 'model', 'thinking'].forEach(key => text(p[key]));
  demand(['low', 'standard', 'high'].includes(p.riskTier), 'INVALID_RISK');
  demand(Array.isArray(p.acceptance) && p.acceptance.length > 0 && p.acceptance.length <= 12, 'INVALID_ACCEPTANCE');
  p.acceptance.forEach(item => text(item, 2048));
}
export function validateGraph(p) {
  fields(p, ['graph', 'waves', 'dependencies', 'maxParallel', 'maxRepairLoops', 'topology']); id(p.graph);
  demand(p.topology === 'flat-root', 'UNSUPPORTED_TOPOLOGY'); integer(p.maxParallel, 1, 6); integer(p.maxRepairLoops, 0, 3);
  demand(Array.isArray(p.waves) && p.waves.length > 0 && p.waves.length <= 24, 'INVALID_GRAPH');
  const seen = new Map();
  p.waves.forEach((wave, i) => {
    demand(Array.isArray(wave) && wave.length > 0 && wave.length <= p.maxParallel, 'INVALID_WAVE');
    wave.forEach(node => { id(node); demand(node !== 'root' && !seen.has(node), 'INVALID_GRAPH'); seen.set(node, i); });
  });
  demand(seen.size <= 24, 'GRAPH_TOO_LARGE');
  fields(p.dependencies, [...seen.keys()]);
  for (const [node, deps] of Object.entries(p.dependencies)) {
    demand(Array.isArray(deps) && deps.length <= 12 && new Set(deps).size === deps.length, 'INVALID_DEPENDENCIES');
    demand(deps.every(dep => isCommandId(dep) && seen.has(dep) && seen.get(dep) < seen.get(node)), 'GRAPH_CYCLE_OR_ORDER');
  }
}
