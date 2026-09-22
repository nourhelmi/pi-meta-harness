import { randomUUID } from 'node:crypto';
import { fields, integer, LIMITS, text } from './contract.mjs';
import { demand, id, RuntimeError } from './security.mjs';
import { callSocket, readCredential } from './service.mjs';

export const agentMessageSchema = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['list', 'send', 'reply', 'status', 'wait'] },
    to: { type: 'string', description: 'Exact peer ID or unique name from list; parent addresses your launching advisor.' },
    text: { type: 'string', description: 'Advice, a question, or a reply. Messages never grant assignment or write authority.' },
    replyTo: { type: 'string', description: 'Exact received message ID; reply resolves its sender automatically.' },
    messageId: { type: 'string', description: 'Send/reply idempotency key (generated when omitted); status/wait selects a returned message ID. Reuse the same key and input after uncertain submission.' },
    timeoutMs: { type: 'integer', minimum: 0, maximum: LIMITS.waitMs, description: 'Wait for a reply, up to 10000ms. Timeout does not cancel the message.' },
  },
};
export const agentMessageTool = {
  name: 'agent_message',
  description: 'Message managed Pi, Codex and Claude agents through one interface. List authorized peers, send advice/questions, reply by exact message ID, inspect status, or wait for replies. Accepted/queued is not read/done. No pane IDs, scope grants, automatic resends, or replacement sessions.',
  inputSchema: agentMessageSchema,
};

/** The same parser is used by the runtime, Pi, CLI and MCP. */
export function parseAgentMessage(input, { messageId } = {}) {
  fields(input, ['action'], ['to', 'text', 'replyTo', 'messageId', 'timeoutMs']);
  const value = { ...input };
  if (value.action === 'list') fields(value, ['action']);
  else if (value.action === 'send' || value.action === 'reply') {
    fields(value, ['action', 'text', value.action === 'send' ? 'to' : 'replyTo'], ['messageId', ...(value.action === 'send' ? ['replyTo'] : [])]);
    text(value.text);
    if (value.to !== undefined) text(value.to);
    if (value.replyTo !== undefined) id(value.replyTo);
    if (value.messageId === undefined) value.messageId = messageId ?? `msg-${randomUUID()}`;
    id(value.messageId);
  } else if (value.action === 'status' || value.action === 'wait') {
    fields(value, ['action', 'messageId'], value.action === 'wait' ? ['timeoutMs'] : []);
    id(value.messageId);
    if (value.action === 'wait') { if (value.timeoutMs === undefined) value.timeoutMs = LIMITS.waitMs; integer(value.timeoutMs, 0, LIMITS.waitMs); }
  } else throw new RuntimeError('MESSAGE_ACTION_INVALID');
  return value;
}

export function messageError(error, messageId) {
  let code = 'MESSAGE_UNAVAILABLE';
  if (error instanceof RuntimeError) code = error.code;
  else if (/^[A-Z][A-Z0-9_]*$/.test(error?.message ?? '')) code = error.message;
  const result = { ok: false, error: code };
  if (messageId) result.messageId = messageId;
  if (code === 'MESSAGE_TRANSPORT_UNCERTAIN') result.outcomeKnown = false;
  return result;
}

/** Host-supplied descriptor only. Never accept credentials or addresses in public arguments. */
export async function callAgentMessage(input, { descriptorPath = process.env.AGENT_MESSAGE_DESCRIPTOR } = {}) {
  const args = parseAgentMessage(input);
  demand(descriptorPath, 'MESSAGE_NOT_CONFIGURED');
  let credential;
  try { credential = readCredential(descriptorPath); }
  catch { throw Object.assign(new RuntimeError('MESSAGE_UNAVAILABLE'), { messageId: args.messageId }); }
  const uncertain = ['send', 'reply'].includes(args.action) ? 'MESSAGE_TRANSPORT_UNCERTAIN' : 'MESSAGE_UNAVAILABLE';
  let result;
  try { result = await callSocket(credential, { v: 1, op: 'agent.message', payload: args }, 'model'); }
  catch { throw Object.assign(new RuntimeError(uncertain), { messageId: args.messageId }); }
  return unwrapAgentMessage(args, result);
}

/** Shared success/error validation for direct and session-bound Pi transports. */
export function unwrapAgentMessage(args, result) {
  const uncertain = ['send', 'reply'].includes(args.action) ? 'MESSAGE_TRANSPORT_UNCERTAIN' : 'MESSAGE_UNAVAILABLE';
  if (result?.ok === false && typeof result.error === 'string' && /^[A-Z][A-Z0-9_]*$/.test(result.error)) {
    throw Object.assign(new RuntimeError(result.error), { messageId: args.messageId });
  }
  try {
    demand(result?.ok === true, 'MESSAGE_INVALID_RESPONSE');
    const value = result.value;
    demand(value && typeof value === 'object' && !Array.isArray(value), 'MESSAGE_INVALID_RESPONSE');
    if (args.action === 'list') {
      id(value.self?.id); text(value.self?.name);
      demand(value.parent === null || typeof value.parent === 'string', 'MESSAGE_INVALID_RESPONSE');
      demand(Array.isArray(value.peers), 'MESSAGE_INVALID_RESPONSE');
      for (const peer of value.peers) {
        id(peer.id); for (const key of ['name', 'role', 'harness', 'state']) text(peer[key]);
        demand(typeof peer.available === 'boolean', 'MESSAGE_INVALID_RESPONSE');
      }
    } else {
      validateMessage(value);
      demand(value.messageId === args.messageId, 'MESSAGE_INVALID_RESPONSE');
    }
    return value;
  } catch { throw Object.assign(new RuntimeError(uncertain), { messageId: args.messageId }); }
}

function validateMessage(value) {
  demand(value && typeof value === 'object' && !Array.isArray(value), 'MESSAGE_INVALID_RESPONSE');
  id(value.messageId); id(value.from); id(value.to); text(value.fromName); text(value.text);
  if (value.replyTo !== null) id(value.replyTo);
  demand(['accepted', 'queued', 'rejected', 'unknown'].includes(value.status)
    && value.read === null && value.done === null && Array.isArray(value.replies), 'MESSAGE_INVALID_RESPONSE');
  for (const reply of value.replies) {
    validateMessage(reply);
    demand(reply.replyTo === value.messageId && reply.from === value.to && reply.to === value.from, 'MESSAGE_INVALID_RESPONSE');
  }
}

/** A child advisor sees its parent neighborhood and its own children, not a global roster. */
const pendingRoutes = new Map();
export async function routeAgentMessage(input, channels, options) {
  const args = parseAgentMessage(input, options);
  demand(channels.length > 0, 'MESSAGE_NOT_CONFIGURED');
  if (channels.length === 1) return channels[0].request(args);
  const views = await Promise.all(channels.map(async channel => ({ channel, view: await channel.request({ action: 'list' }) })));
  const self = views[0].view.self;
  demand(views.every(({ view }) => view.self.id === self.id), 'MESSAGE_IDENTITY_MISMATCH');
  if (!['send', 'reply'].includes(args.action)) return routeNeighborhood(args, channels, views);
  // Serialize same-ID calls in this Pi client; runtime ledgers remain the durable authority.
  const key = `${self.id}\0${args.messageId}`;
  const pending = (pendingRoutes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => routeNeighborhood(args, channels, views));
  pendingRoutes.set(key, pending);
  try { return await pending; }
  finally { if (pendingRoutes.get(key) === pending) pendingRoutes.delete(key); }
}

async function routeNeighborhood(args, channels, views) {
  const self = views[0].view.self;
  // Reject a changed-target retry before dispatching it to a different runtime ledger.
  const existing = [];
  if (['send', 'reply'].includes(args.action)) for (const { channel } of views) {
    try {
      const message = await channel.request({ action: 'status', messageId: args.messageId });
      if (message.from === self.id) existing.push(channel);
    } catch (error) { if (!['MESSAGE_NOT_FOUND', 'MESSAGE_FORBIDDEN'].includes(error?.code ?? error?.message)) throw error; }
  }
  if (['status', 'wait', 'reply'].includes(args.action) || args.replyTo) {
    const reference = args.replyTo ?? args.messageId;
    const matches = [];
    for (const channel of channels) {
      try { await channel.request({ action: 'status', messageId: reference }); matches.push(channel); }
      catch (error) { if (!['MESSAGE_NOT_FOUND', 'MESSAGE_FORBIDDEN'].includes(error?.code ?? error?.message)) throw error; }
    }
    demand(matches.length === 1, matches.length ? 'MESSAGE_AMBIGUOUS' : 'MESSAGE_NOT_FOUND');
    demand(existing.every(channel => channel === matches[0]), 'MESSAGE_ID_REUSE');
    return matches[0].request(args);
  }
  const parent = views.find(({ channel }) => channel.parent)?.view.parent ?? null;
  if (args.action === 'list') return { self, parent, peers: [...new Map(views.flatMap(({ view }) => view.peers).filter(peer => peer.id !== self.id).map(peer => [peer.id, peer])).values()] };
  const target = ['parent', 'root', 'advisor'].includes(args.to) && parent ? parent : args.to;
  const matches = views.flatMap(({ channel, view }) => view.peers.filter(peer => peer.id === target || peer.name === target).map(peer => ({ channel, peer })));
  const exact = matches.filter(({ peer }) => peer.id === target);
  const candidates = exact.length ? exact : matches;
  demand(candidates.length === 1, candidates.length ? 'MESSAGE_TARGET_AMBIGUOUS' : 'MESSAGE_TARGET_NOT_FOUND');
  demand(existing.every(channel => channel === candidates[0].channel), 'MESSAGE_ID_REUSE');
  return candidates[0].channel.request({ ...args, to: candidates[0].peer.id });
}
