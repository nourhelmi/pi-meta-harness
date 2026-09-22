import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isAbsolute } from 'node:path';
import { managedBridgeEnabled } from '../../scripts/advisor-runtime/pi-detach-bootstrap.mjs';

export type RouterControlStatus = ReturnType<typeof parseStatus>;
export type RouterView =
  | { kind: 'ready'; status: RouterControlStatus }
  | { kind: 'unmanaged' | 'unsupported' | 'unavailable'; detail: string };
export type RouterPromptState = 'enabled' | 'disabled' | 'invalid';
export const ROUTER_STATUS_EVENT = 'jev-router:status';
export const ROUTER_STATUS_KEY = 'jev-router';

function parseStatus(value: unknown, sessionId: string) {
  const s = value as Record<string, unknown> | null;
  if (!s || s.version !== 1 || s.sessionId !== sessionId || typeof s.enabled !== 'boolean'
    || typeof s.generation !== 'number' || !Number.isSafeInteger(s.generation) || s.generation < 0
    || !(s.templatePath === null || typeof s.templatePath === 'string' && isAbsolute(s.templatePath))
    || !(s.error === undefined || typeof s.error === 'string')) throw new Error('AGENT_ROUTER_CONTROL_UNSUPPORTED');
  return { version: 1 as const, sessionId, enabled: s.enabled, generation: s.generation,
    templatePath: s.templatePath, ...(s.error !== undefined ? { error: s.error } : {}) };
}

async function request(pi: ExtensionAPI, ctx: ExtensionContext, action: 'router.status' | 'router.set', payload: Record<string, unknown>): Promise<RouterControlStatus> {
  const sessionId = ctx.sessionManager.getSessionId();
  const event: { sessionId: string; action: string; payload: Record<string, unknown>; context: ExtensionContext; response?: Promise<unknown> } = {
    sessionId, action, payload, context: ctx,
  };
  pi.events?.emit('pi-detach:request', event);
  if (!event.response) throw new Error('AGENT_ROUTER_CONTROL_UNSUPPORTED');
  const status = parseStatus(await event.response, sessionId);
  if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error('AGENT_ROUTER_SESSION_CHANGED');
  return status;
}

function failure(error: unknown): RouterView {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'AGENT_ROUTER_UNAVAILABLE';
  return /UNSUPPORTED/.test(code) || code === 'BRIDGE_OPERATION'
    ? { kind: 'unsupported', detail: 'This host does not support session routing controls. Start a new Pi session; /reload does not upgrade a running host.' }
    : { kind: 'unavailable', detail: `Routing state is unconfirmed (${code}). Existing workers are unchanged.` };
}

function publish(pi: ExtensionAPI, sessionId: string, view: RouterView): RouterView {
  pi.events?.emit(ROUTER_STATUS_EVENT, { sessionId, view });
  return view;
}

export async function readRouterView(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RouterView> {
  const sessionId = ctx.sessionManager.getSessionId();
  let view: RouterView;
  if (process.env.PI_DETACH_BACKEND === 'legacy' || !managedBridgeEnabled() && !process.env.PI_DETACH_RUNTIME_BRIDGE) {
    view = { kind: 'unmanaged', detail: 'Session routing requires the managed Pi runtime.' };
  } else {
    try { view = { kind: 'ready', status: await request(pi, ctx, 'router.status', {}) }; }
    catch (error) { view = failure(error); }
  }
  return publish(pi, sessionId, view);
}

export async function setRouterView(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean, before: RouterControlStatus): Promise<RouterView> {
  const sessionId = ctx.sessionManager.getSessionId();
  let view: RouterView;
  try {
    const status = await request(pi, ctx, 'router.set', { enabled, expectedGeneration: before.generation });
    if (status.sessionId !== before.sessionId || status.enabled !== enabled || status.generation !== before.generation + 1) throw new Error('AGENT_ROUTER_ACK_INVALID');
    view = { kind: 'ready', status };
  } catch (error) { view = failure(error); }
  return publish(pi, sessionId, view);
}

export function routerPromptState(view: RouterView): RouterPromptState {
  if (view.kind === 'unmanaged') return 'disabled';
  if (view.kind !== 'ready' || view.status.error) return 'invalid';
  return view.status.enabled ? 'enabled' : 'disabled';
}

export function routerStatusText(view: RouterView): string {
  if (view.kind === 'ready') return view.status.error ? 'Jev router: config error' : `Jev router: ${view.status.enabled ? 'ON' : 'OFF'}`;
  if (view.kind === 'unsupported') return 'Jev router: restart required';
  if (view.kind === 'unmanaged') return 'Jev router: unmanaged';
  return 'Jev router: unknown';
}

export function routerViewDetail(view: RouterView): string {
  if (view.kind !== 'ready') return view.detail;
  if (view.status.error) return `Routing configuration error: ${view.status.error}. No bypass is enabled.`;
  return `${routerStatusText(view)} for new launches in this session. Existing and already-preparing workers are unchanged.\nConfiguration: ${view.status.templatePath ?? 'not configured'}`;
}

export async function routerLaunchGuard(pi: ExtensionAPI, ctx: ExtensionContext, input: unknown, requireManualIdentity = false): Promise<string | undefined> {
  if (!input || typeof input !== 'object' || (input as {name?: unknown}).name !== undefined) return;
  const view = await readRouterView(pi, ctx);
  const state = routerPromptState(view);
  if (state === 'invalid') return `${routerViewDetail(view)} Fresh bg_agent launches are fenced; existing-worker followups, output and cancellation remain available.`;
  const {model, thinking} = input as {model?: unknown; thinking?: unknown};
  if (state === 'enabled' && thinking !== undefined && model === undefined) return 'Thinking without model is invalid. Omit both for router selection, or supply an explicit model pin.';
  if (view.kind === 'ready' && state === 'disabled' && requireManualIdentity && (typeof model !== 'string' || typeof thinking !== 'string')) return 'Routing is OFF for this session. Select an explicit model and thinking level from the active intelligence guide.';
}
