import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readJevRouterDefaults, writeJevRouterDefaults } from '../scripts/advisor-runtime/agent-router-control.mjs';
import {
  readRouterView, setRouterView, routerLaunchGuard, routerStatusText, routerViewDetail,
  ROUTER_STATUS_EVENT, ROUTER_STATUS_KEY, type RouterView,
} from './advisor-core/router-control.ts';

/** The host owns the switch; this extension only presents acknowledged state. */
export default function jevRouterExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let epoch = 0;
  let view: RouterView | undefined;
  let commands = Promise.resolve();

  function show(next: RouterView) {
    if (!context) return;
    if (view?.kind === 'ready' && next.kind === 'ready' && next.status.generation < view.status.generation) return;
    view = next;
    const color = next.kind === 'ready' && !next.status.error ? next.status.enabled ? 'success' : 'dim' : 'warning';
    // A native footer-area widget stays visible even when a custom footer truncates statuses.
    context.ui.setWidget(ROUTER_STATUS_KEY, [context.ui.theme.fg(color, routerStatusText(next))], { placement: 'belowEditor' });
  }
  const unsubscribe = pi.events.on(ROUTER_STATUS_EVENT, (event: unknown) => {
    const update = event as { sessionId: string; view: RouterView };
    if (context && sessionId === update.sessionId && context.sessionManager.getSessionId() === sessionId) show(update.view);
  });

  pi.on('session_start', async (_event, ctx) => {
    epoch += 1; commands = Promise.resolve(); context = ctx; sessionId = ctx.sessionManager.getSessionId(); view = undefined;
    ctx.ui.setWidget(ROUTER_STATUS_KEY, [ctx.ui.theme.fg('dim', 'Jev router: checking')], { placement: 'belowEditor' });
    await readRouterView(pi, ctx);
  });
  pi.on('session_shutdown', () => {
    epoch += 1; commands = Promise.resolve(); context?.ui.setWidget(ROUTER_STATUS_KEY, undefined);
    context = undefined; sessionId = undefined; view = undefined;
    unsubscribe();
  });
  pi.on('before_agent_start', async (_event, ctx) => { await readRouterView(pi, ctx); });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bg_agent') return;
    const reason = await routerLaunchGuard(pi, ctx, event.input);
    if (reason) return { block: true, reason };
  });

  async function command(args: string, ctx: ExtensionCommandContext, own: number, id: string) {
    const current = () => epoch === own && sessionId === id && ctx.sessionManager.getSessionId() === id;
    if (!current()) return;
    const action = args.trim().toLowerCase();
    if (!['', 'status', 'on', 'off', 'config'].includes(action)) {
      ctx.ui.notify('Usage: /jev-router on|off|config|status', 'warning'); return;
    }
    if (action === 'config') {
      if (!ctx.hasUI) { ctx.ui.notify('/jev-router config requires Pi interactive or RPC UI.', 'warning'); return; }
      const { AGENT_ROUTER_CONFIG: override, ...defaultsEnv } = process.env;
      const defaults = readJevRouterDefaults(defaultsEnv);
      const selected = await ctx.ui.select(`Jev router — default for NEW sessions (${defaults.enabled ? 'ON' : 'OFF'} now)`, [
        'ON — automatic model / effort selection', 'OFF — manual model / effort selection',
      ]);
      if (!current() || selected === undefined) return;
      if (!selected.startsWith('ON —') && !selected.startsWith('OFF —')) return;
      const saved = writeJevRouterDefaults({ ...defaults, enabled: selected.startsWith('ON —') }, defaultsEnv);
      ctx.ui.notify(`Default saved: ${saved.enabled ? 'ON' : 'OFF'} for new sessions. This session and existing workers are unchanged.${override ? ' Explicit AGENT_ROUTER_CONFIG still takes precedence in sessions launched with that override.' : ''}`, 'info');
      return;
    }
    if (action === 'on' || action === 'off') {
      if (!ctx.isIdle()) ctx.ui.notify('Router switch queued until this turn finishes; existing work is unchanged.', 'info');
      await ctx.waitForIdle();
      if (!current()) return;
      const before = await readRouterView(pi, ctx);
      if (!current()) return;
      if (before.kind !== 'ready') { ctx.ui.notify(routerViewDetail(before), 'warning'); return; }
      const after = await setRouterView(pi, ctx, action === 'on', before.status);
      if (!current()) return;
      ctx.ui.notify(routerViewDetail(after), after.kind === 'ready' && !after.status.error ? 'info' : 'warning');
      return;
    }
    const actual = await readRouterView(pi, ctx);
    if (current()) ctx.ui.notify(`${routerViewDetail(actual)}\n/jev-router on|off · /jev-router config (future defaults)`, actual.kind === 'ready' && !actual.status.error ? 'info' : 'warning');
  }

  pi.registerCommand('jev-router', {
    description: 'Session routing on/off, status, or a future-defaults dialog',
    getArgumentCompletions(prefix) {
      return ['on', 'off', 'config', 'status'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    handler(args, ctx) {
      const own = epoch; const id = ctx.sessionManager.getSessionId();
      const next = commands.then(() => command(args, ctx, own, id)).catch(error => {
        if (epoch === own && sessionId === id && ctx.sessionManager.getSessionId() === id) ctx.ui.notify(`Jev router: ${error instanceof Error ? error.message : 'configuration unavailable'}`, 'error');
      });
      commands = next;
      return next;
    },
  });
}
