import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import jevRouterExtension from '../extensions/jev-router.ts';

test('global defaults dialog ignores the active session environment override and explains precedence', async t => {
  const root = realpathSync(mkdtempSync('/tmp/jev-default-ui-')); const agent = join(root, 'agent'); mkdirSync(agent, {mode: 0o700});
  const defaults = join(agent, 'jev-router.json'); const override = join(root, 'override.json');
  writeFileSync(defaults, JSON.stringify({version: 1, enabled: false, configPath: null}), {mode: 0o600});
  writeFileSync(override, JSON.stringify({version: 1, enabled: true}), {mode: 0o600});
  const env = {PI_CODING_AGENT_DIR: agent, AGENT_ROUTER_CONFIG: override, PI_DETACH_BACKEND: 'legacy'};
  const prior = Object.keys(env).map(key => process.env[key]); Object.assign(process.env, env);
  const bus = new EventEmitter(); const hooks: Record<string, Function> = {}; let command: any;
  const notices: string[] = []; const titles: string[] = [];
  jevRouterExtension({
    on(name: string, handler: Function) { hooks[name] = handler; },
    events: {on(name: string, handler: (...args: any[]) => void) {bus.on(name, handler); return () => bus.off(name, handler);}, emit: (name: string, data: unknown) => bus.emit(name, data)},
    registerCommand(_name: string, value: any) { command = value; },
  } as unknown as ExtensionAPI);
  const ctx = {cwd: root, hasUI: true, sessionManager: {getSessionId: () => 'session'},
    ui: {setWidget() {}, theme: {fg: (_key: string, text: string) => text}, notify: (text: string) => notices.push(text),
      select: async (title: string) => {titles.push(title); return 'OFF — manual model / effort selection';}},
  } as unknown as ExtensionCommandContext;
  t.after(() => {hooks.session_shutdown(); Object.keys(env).forEach((key, i) => {if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i];}); rmSync(root, {recursive: true, force: true});});
  await hooks.session_start({}, ctx); await command.handler('config', ctx);
  assert.match(titles[0]!, /\(OFF now\)/, 'dialog shows global default, not override ON');
  assert.match(notices.at(-1)!, /Explicit AGENT_ROUTER_CONFIG still takes precedence/);
  assert.equal(JSON.parse(readFileSync(defaults, 'utf8')).enabled, false);
  assert.equal(JSON.parse(readFileSync(override, 'utf8')).enabled, true);
});
