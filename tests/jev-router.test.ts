import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import jevRouterExtension from '../extensions/jev-router.ts';
import { readRouterView, routerLaunchGuard, routerPromptState, routerStatusText, setRouterView, type RouterControlStatus } from '../extensions/advisor-core/router-control.ts';
import { readJevRouterDefaults } from '../scripts/advisor-runtime/agent-router-control.mjs';

type Handler = (...args: any[]) => any;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'jev-router-ui-')));
  const agentDir = join(dir, 'agent'); await mkdir(agentDir, { mode: 0o700 });
  const defaultsPath = join(agentDir, 'jev-router.json');
  await writeFile(defaultsPath, JSON.stringify({version: 1, enabled: true, configPath: null}), {mode: 0o600});
  const env = { PI_CODING_AGENT_DIR: agentDir, PI_DETACH_RUNTIME_BRIDGE: '/fixture/not-imported.mjs', PI_DETACH_BACKEND: undefined, AGENT_ROUTER_CONFIG: undefined };
  const before = Object.keys(env).map(key => process.env[key]);
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const hooks: Record<string, Handler> = {}; const commands: Record<string, any> = {}; const bus = new EventEmitter();
  const statuses = new Map<string, RouterControlStatus>();
  const calls: Array<{sessionId: string; action: string; payload: any}> = [];
  const notifications: string[] = []; const widgets: Array<{value: string[] | undefined; options: unknown}> = [];
  const selections: Array<{title: string; options: string[]}> = [];
  let id = 'A'; let selected: string | undefined | Promise<string | undefined>;
  let idle: Promise<void> = Promise.resolve(); let isIdle = true;
  let response: ((request: any) => unknown | Promise<unknown>) | undefined;
  const ctx = {
    cwd: dir, hasUI: true, isIdle: () => isIdle, waitForIdle: () => idle,
    sessionManager: {getSessionId: () => id},
    ui: {
      theme: {fg: (_color: string, text: string) => text},
      setWidget: (_key: string, value: string[] | undefined, options: unknown) => widgets.push({value, options}),
      notify: (text: string) => notifications.push(text),
      select: async (title: string, options: string[]) => { selections.push({title, options}); return selected; },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    events: {emit: (name: string, event: unknown) => bus.emit(name, event), on(name: string, handler: Handler) { bus.on(name, handler); return () => bus.off(name, handler); }},
    on: (name: string, handler: Handler) => { hooks[name] = handler; },
    registerCommand: (name: string, command: unknown) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const state = (sessionId = id) => {
    if (!statuses.has(sessionId)) statuses.set(sessionId, {version: 1, sessionId, enabled: readJevRouterDefaults().enabled, generation: 0, templatePath: '/fixture/router.json'});
    return statuses.get(sessionId)!;
  };
  bus.on('pi-detach:request', request => {
    calls.push({sessionId: request.sessionId, action: request.action, payload: request.payload});
    request.response = Promise.resolve().then(() => {
      if (response) return response(request);
      const current = state(request.sessionId);
      if (request.action === 'router.set') {
        assert.equal(request.payload.expectedGeneration, current.generation);
        current.enabled = request.payload.enabled; current.generation++;
      }
      return {...current};
    });
  });
  jevRouterExtension(pi);
  t.after(async () => {
    hooks.session_shutdown();
    Object.keys(env).forEach((key, index) => { const value = before[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    await rm(dir, {force: true, recursive: true});
  });
  const start = (sessionId = id, reason = 'startup') => { id = sessionId; return hooks.session_start({reason}, ctx); };
  const run = (args: string) => commands['jev-router'].handler(args, ctx);
  return { pi, ctx, hooks, commands, calls, notifications, widgets, selections, state, statuses, start, run, defaultsPath,
    select(value: typeof selected) { selected = value; },
    blockUntil(value: Promise<void>) { idle = value; isIdle = false; },
    respond(value: typeof response) { response = value; },
  };
}

test('session commands are acknowledged, preserve other sessions and keep a native footer-area row', async t => {
  const f = await fixture(t); await f.start(); f.state('B');
  assert.deepEqual(f.widgets.at(-1), {value: ['Jev router: ON'], options: {placement: 'belowEditor'}});
  await f.run('off');
  assert.equal(f.state().enabled, false); assert.equal(f.state('B').enabled, true);
  assert.equal(readJevRouterDefaults().enabled, true);
  assert.match(f.notifications.at(-1)!, /OFF for new launches in this session/);
  assert.match(f.notifications.at(-1)!, /Existing and already-preparing workers are unchanged/);
  await f.run('on'); assert.equal(f.state().enabled, true);
  assert.deepEqual(f.calls.filter(c => c.action === 'router.set').map(c => c.payload), [
    {enabled: false, expectedGeneration: 0}, {enabled: true, expectedGeneration: 1},
  ]);
  assert.deepEqual(f.commands['jev-router'].getArgumentCompletions('o').map((x: any) => x.value), ['on', 'off']);
  await f.run('wat'); assert.match(f.notifications.at(-1)!, /Usage:/);
});

test('config save/cancel only change future defaults; resume, reload and new/fork use host state', async t => {
  const f = await fixture(t); await f.start();
  const bytes = await readFile(f.defaultsPath, 'utf8');
  f.select(undefined); await f.run('config'); assert.equal(await readFile(f.defaultsPath, 'utf8'), bytes);
  f.select('OFF — manual model / effort selection'); await f.run('config');
  assert.equal(readJevRouterDefaults().enabled, false); assert.equal(f.state('A').enabled, true);
  assert.equal(f.calls.some(c => c.action === 'router.set'), false);
  assert.match(f.selections.at(-1)!.title, /NEW sessions/);
  for (const reason of ['resume', 'reload']) { await f.start('A', reason); assert.deepEqual(f.widgets.at(-1)!.value, ['Jev router: ON']); }
  for (const reason of ['new', 'fork']) { await f.start(reason, reason); assert.deepEqual(f.widgets.at(-1)!.value, ['Jev router: OFF']); }
});

test('old host and disconnected host are distinct, fenced, and never receive a guessed toggle', async t => {
  const f = await fixture(t);
  f.respond(() => { throw new Error('BRIDGE_OPERATION'); }); await f.start(); await f.run('on');
  assert.deepEqual(f.widgets.at(-1)!.value, ['Jev router: restart required']);
  assert.match(f.notifications.at(-1)!, /\/reload does not upgrade/);
  assert.equal(f.calls.some(c => c.action === 'router.set'), false);
  assert.match(await routerLaunchGuard(f.pi, f.ctx, {prompt: 'new'}) ?? '', /fenced/);
  const count = f.calls.length;
  assert.equal(await routerLaunchGuard(f.pi, f.ctx, {name: 'owned-worker', prompt: 'follow up'}), undefined);
  assert.equal(f.calls.length, count, 'followup never requires a new route');
  f.respond(() => { throw new Error('PI_DETACH_BRIDGE_UNAVAILABLE'); }); await f.run('status');
  assert.deepEqual(f.widgets.at(-1)!.value, ['Jev router: unknown']);
  f.select('OFF — manual model / effort selection'); await f.run('config');
  assert.equal(readJevRouterDefaults().enabled, false, 'defaults remain editable without a compatible host');
});

test('replacement status and toggle complete while an old idle wait remains unresolved', async t => {
  const f = await fixture(t); await f.start();
  const idle = deferred<void>(); f.blockUntil(idle.promise);
  const switching = f.run('off'); await Promise.resolve();
  assert.equal(f.calls.some(c => c.action === 'router.set'), false);
  await f.start('B', 'new'); f.blockUntil(Promise.resolve());
  let settled = false;
  const replacement = Promise.all([f.run('status'), f.run('off')]).then(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'B commands must not queue behind A idle wait');
    assert.equal(f.state('B').enabled, false);
    const calls = f.calls.length; const notifications = [...f.notifications]; const widgets = [...f.widgets];
    idle.resolve(); await switching;
    assert.equal(f.state('A').enabled, true);
    assert.equal(f.calls.length, calls, 'old command must not call the host after its wait');
    assert.deepEqual(f.notifications, notifications, 'old command must not notify B');
    assert.deepEqual(f.widgets, widgets, 'old command must not alter B widget');
  } finally { idle.resolve(); await Promise.all([switching, replacement]); }
});
test('same-session reload gets a fresh queue and fences the old command', async t => {
  const f = await fixture(t); await f.start();
  const idle = deferred<void>(); f.blockUntil(idle.promise);
  const switching = f.run('off'); await Promise.resolve();
  await f.start('A', 'reload'); f.blockUntil(Promise.resolve());
  let settled = false;
  const replacement = Promise.all([f.run('status'), f.run('on')]).then(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'reload must not inherit a pending command');
    assert.equal(f.state().generation, 1, 'same-mode host set advanced once');
    const calls = f.calls.length; const notifications = [...f.notifications];
    idle.resolve(); await switching;
    assert.equal(f.calls.length, calls);
    assert.deepEqual(f.notifications, notifications, 'pre-reload command must not notify');
  } finally { idle.resolve(); await Promise.all([switching, replacement]); }
});

test('replacement status and toggle complete while an old config dialog remains unresolved', async t => {
  const f = await fixture(t); await f.start();
  const choice = deferred<string | undefined>(); f.select(choice.promise);
  const configuring = f.run('config'); await Promise.resolve();
  assert.equal(f.selections.length, 1, 'old dialog must be open');
  await f.start('C', 'fork');
  let settled = false;
  const replacement = Promise.all([f.run('status'), f.run('off')]).then(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'C commands must not queue behind A dialog');
    assert.equal(f.state('C').enabled, false);
    const defaults = await readFile(f.defaultsPath, 'utf8');
    const calls = f.calls.length; const notifications = [...f.notifications]; const widgets = [...f.widgets];
    choice.resolve('OFF — manual model / effort selection'); await configuring;
    assert.equal(await readFile(f.defaultsPath, 'utf8'), defaults, 'old dialog must not save defaults');
    assert.equal(f.calls.length, calls);
    assert.deepEqual(f.notifications, notifications, 'old dialog must not notify C');
    assert.deepEqual(f.widgets, widgets, 'old dialog must not alter C widget');
  } finally { choice.resolve(undefined); await Promise.all([configuring, replacement]); }
});

test('lost or invalid ACK stays unknown without retry, rollback, or success notification', async t => {
  const f = await fixture(t); await f.start();
  f.respond(request => {
    if (request.action === 'router.set') { f.state().enabled = false; f.state().generation++; throw new Error('TRANSPORT_TIMEOUT'); }
    return {...f.state()};
  });
  await f.run('off');
  assert.equal(f.state().enabled, false); assert.deepEqual(f.widgets.at(-1)!.value, ['Jev router: unknown']);
  assert.equal(f.calls.filter(c => c.action === 'router.set').length, 1);
  assert.match(f.notifications.at(-1)!, /unconfirmed/);
  f.respond(undefined); await f.run('status'); assert.deepEqual(f.widgets.at(-1)!.value, ['Jev router: OFF']);
  const before = {...f.state()};
  f.respond(() => ({...before, enabled: true}));
  const invalid = await setRouterView(f.pi, f.ctx, true, before);
  assert.equal(invalid.kind, 'unavailable', 'a changed mode requires a newer acknowledged generation');
});

test('same-mode set requires one generation step; stale, jumped, malformed, wrong-mode and wrong-session ACKs fail', async t => {
  const f = await fixture(t); await f.start();
  for (const [label, ack, kind] of [
    ['stale', {generation: 0}, 'unavailable'],
    ['jumped', {generation: 2}, 'unavailable'],
    ['wrong mode', {generation: 1, enabled: false}, 'unavailable'],
    ['malformed', {generation: 1, version: 2}, 'unsupported'],
    ['wrong session', {generation: 1, sessionId: 'B'}, 'unsupported'],
  ] as const) {
    f.respond(request => request.action === 'router.set' ? {...f.state(), ...ack} : {...f.state()});
    const before = f.calls.filter(c => c.action === 'router.set').length;
    await f.run('on');
    assert.equal(f.calls.filter(c => c.action === 'router.set').length, before + 1, `${label}: no retry or rollback`);
    assert.equal(f.state().generation, 0, `${label}: host state unchanged`);
    assert.equal(f.widgets.at(-1)?.value?.[0], kind === 'unavailable' ? 'Jev router: unknown' : 'Jev router: restart required');
    assert.doesNotMatch(f.notifications.at(-1)!, /ON for new launches/, `${label}: no success notification`);
  }
  f.respond(undefined); await f.run('on');
  assert.equal(f.state().generation, 1, 'successful same-mode set increments once');
  assert.match(f.notifications.at(-1)!, /ON for new launches/);
});

test('session-bound status validation and guard honor enabled pins, manual mode and configuration errors', async t => {
  const f = await fixture(t); await f.start();
  assert.equal(await routerLaunchGuard(f.pi, f.ctx, {}, true), undefined);
  assert.equal(await routerLaunchGuard(f.pi, f.ctx, {model: 'provider/model'}, true), undefined);
  assert.match(await routerLaunchGuard(f.pi, f.ctx, {thinking: 'high'}, true) ?? '', /Thinking without model/);
  await f.run('off');
  assert.match(await routerLaunchGuard(f.pi, f.ctx, {}, true) ?? '', /explicit model and thinking/);
  assert.equal(await routerLaunchGuard(f.pi, f.ctx, {model: 'provider/model', thinking: 'high'}, true), undefined);
  for (const bad of [{sessionId: 'foreign'}, {version: 2}, {generation: -1}, {generation: 0.5}, {enabled: 'on'}, {templatePath: 'relative'}]) {
    f.respond(() => ({...f.state(), ...bad}));
    const view = await readRouterView(f.pi, f.ctx); assert.equal(view.kind, 'unsupported'); assert.equal(routerPromptState(view), 'invalid');
  }
  f.respond(() => ({...f.state(), enabled: true, error: 'AGENT_ROUTER_CONFIG_INVALID'}));
  const error = await readRouterView(f.pi, f.ctx);
  assert.equal(routerStatusText(error), 'Jev router: config error'); assert.equal(routerPromptState(error), 'invalid');
});
