import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager, type ModelRegistry } from '@earendil-works/pi-coding-agent';

// Actual public Pi resource loader/runner; only Engram HTTP is a fake transport. No model/auth/GUI.
test('public Pi loader and hook chaining preserve managed checkpoint and ordinary automatic capture', async t => {
  const root = await mkdtemp('/tmp/checker-memory-host-');
  const previous = { state: process.env.ADVISOR_STATE_DIR, url: process.env.ENGRAM_URL, fetch: globalThis.fetch };
  process.env.ADVISOR_STATE_DIR = join(root, 'state'); process.env.ENGRAM_URL = 'http://engram.invalid';
  const requests: string[] = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ project: 'fixture', status: 'ok', id: 'fixture' }), { status: 200 }); };
  t.after(async () => { globalThis.fetch = previous.fetch; for (const [key, value] of [['ADVISOR_STATE_DIR', previous.state], ['ENGRAM_URL', previous.url]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } await rm(root, { recursive: true, force: true }); });
  const installed = join(root, 'installed');
  const install = spawnSync(process.execPath, [resolve('scripts/meta-harness.mjs'), 'install', '--target', installed], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  await symlink(resolve('node_modules'), join(installed, 'node_modules'));
  const sessionModule = await import(pathToFileURL(join(installed, 'extensions/advisor-session.ts')).href);
  const installSession = sessionModule.default.default ?? sessionModule.default;
  await mkdir(join(root, 'state/workstreams'), { recursive: true });
  const sm = SessionManager.inMemory(root); const owner = sm.getSessionId();
  const path = join(root, 'state/workstreams/check.md');
  const content = `# Workstream: check\n- Owner session: \`${owner}\`\n## Current state\nAccepted outcome and evidence.\n`;
  const start = async (paths = [join(installed, 'extensions/advisor-memory.ts')]) => {
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: paths });
    await loader.reload(); const loaded = loader.getExtensions();
    if (paths.length === 1) assert.deepEqual(loaded.errors, []);
    else { assert.ok(loaded.errors.length > 0); assert.ok(loaded.errors.every(error => /Tool "mem_.*conflicts with/.test(error.error))); }
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sm, {} as ModelRegistry);
    const errors: unknown[] = []; runner.onError(error => errors.push(error));
    return { runner, errors, prompt: (text = 'Continue') => runner.emitBeforeAgentStart(text, undefined, 'BASE', { cwd: root }) };
  };
  const host = await start();
  assert.ok(host.runner.getToolDefinition('mem_save')); assert.ok(host.runner.getToolDefinition('mem_search'));
  await host.runner.emitInput('/skill:advisor-pi', undefined, 'interactive');
  assert.doesNotMatch((await host.prompt('/skill:advisor-pi'))!.systemPrompt!, /WHEN TO SAVE/);
  assert.match((await host.prompt('Initialization was cancelled'))!.systemPrompt!, /WHEN TO SAVE/);
  assert.ok(requests.some(path => path.endsWith('/prompts')), 'ordinary prompt automatic capture survives');
  await writeFile(path, content); sm.appendCustomEntry('advisor-session', { workstream: 'check', sessionId: owner, initializedAt: 'now', workerHarness: 'pi' });
  requests.length = 0;
  await host.runner.emit({ type: 'session_start', reason: 'reload' });
  assert.match((await host.prompt())!.systemPrompt!, /single operational checkpoint/);
  await host.runner.emit({ type: 'session_compact', compactionEntry: { summary: 'old diary' }, fromExtension: false, reason: 'manual', willRetry: false } as any);
  await host.runner.emit({ type: 'tool_execution_end', toolCallId: 'edit', toolName: 'edit', args: {}, result: 'important code change '.repeat(20), isError: false });
  assert.equal(requests.length, 0, 'managed duplicate automatic records are suppressed');
  for (const bytes of ['', 'bad', 'x'.repeat(65537), content.replace(owner, 'foreign')]) {
    await writeFile(path, bytes); assert.match((await host.prompt())!.systemPrompt!, /corrupt|unknown/);
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
  await rm(path); assert.match((await host.prompt())!.systemPrompt!, /unknown/);
  await writeFile(path, content);
  await host.runner.emit({ type: 'session_shutdown', reason: 'new' }); sm.newSession();
  const normal = await start(); await normal.runner.emit({ type: 'session_start', reason: 'new' });
  assert.match((await normal.prompt())!.systemPrompt!, /WHEN TO SAVE/);
  await normal.runner.emit({ type: 'tool_execution_end', toolCallId: 'edit', toolName: 'edit', args: {}, result: 'important code change '.repeat(20), isError: false });
  assert.ok(requests.some(path => path.endsWith('/observations/passive')), 'ordinary passive capture survives');
  assert.deepEqual(host.errors, []); assert.deepEqual(normal.errors, []);
  await normal.runner.emit({ type: 'session_shutdown', reason: 'quit' });
  // Pi deduplicates tool names, not independently loaded providers' event handlers.
  const duplicateOwner = sm.getSessionId();
  await writeFile(path, content.replace(owner, duplicateOwner));
  sm.appendCustomEntry('advisor-session', { workstream: 'check', sessionId: duplicateOwner, initializedAt: 'now', workerHarness: 'pi' });
  for (const paths of [
    [join(installed, 'extensions/advisor-memory.ts'), join(installed, 'third-party/gentle-engram/index.ts')],
    [join(installed, 'third-party/gentle-engram/index.ts'), join(installed, 'extensions/advisor-memory.ts')],
  ]) {
    const duplicate = await start(paths); const prompt = (await duplicate.prompt())!.systemPrompt!;
    assert.match(prompt, /single operational checkpoint/); assert.match(prompt, /WHEN TO SAVE/, 'an extra upstream activation is genuinely conflicting, not suppressed by tool dedupe');
    await duplicate.runner.emit({ type: 'session_shutdown', reason: 'quit' });
  }
  const settingsPath = join(installed, 'settings.json'); const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.extensions = [join(installed, 'third-party/gentle-engram/index.ts')]; await writeFile(settingsPath, JSON.stringify(settings));
  const doctor = spawnSync(process.execPath, [resolve('scripts/meta-harness.mjs'), 'doctor', '--target', installed], { encoding: 'utf8' });
  assert.equal(doctor.status, 1); assert.match(doctor.stderr, /Duplicate Engram activation conflicts with advisor-memory/);
  delete settings.extensions; await writeFile(settingsPath, JSON.stringify(settings));
  const healthy = spawnSync(process.execPath, [resolve('scripts/meta-harness.mjs'), 'doctor', '--target', installed], { encoding: 'utf8' });
  assert.equal(healthy.status, 0, healthy.stderr);

  // Actual advisor initializer + memory composition; only the Herdr display/process calls are fake.
  const oldEnv = Object.fromEntries(['HERDR_ENV', 'HERDR_PANE_ID', 'PI_CODING_AGENT_DIR', 'ADVISOR_WORKSTREAM', 'ADVISOR_STATE_ROOT', 'PI_DETACH_WORKER_HARNESS'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.HERDR_ENV = '1'; process.env.HERDR_PANE_ID = 'fake-checker-pane'; process.env.PI_CODING_AGENT_DIR = installed;
  sm.newSession(); let rejectRename = true;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: installed, settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(installed, 'extensions/advisor-memory.ts')],
    extensionFactories: [pi => installSession(new Proxy(pi, { get(target, key) {
      if (key === 'exec') return async (_command: string, args: string[]) => ({ code: rejectRename && args[0] === 'agent' && args[1] === 'rename' ? 1 : 0, stdout: '', stderr: 'fixture refusal' });
      return Reflect.get(target, key);
    } }))],
  });
  await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  Object.assign(loaded.runtime, { appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data), setSessionName: (name: string) => sm.appendSessionInfo(name), getSessionName: () => sm.getSessionName(), getActiveTools: () => ['read', 'bg_agent'], setActiveTools() {} });
  const advisor = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sm, {} as ModelRegistry); const errors: unknown[] = []; advisor.onError(error => errors.push(error));
  const init = advisor.getToolDefinition('advisor_session_init')!;
  await assert.rejects(init.execute('init', { workstream: 'fresh', workerHarness: 'pi' }, undefined, undefined, advisor.createContext()), /could not name/);
  assert.match((await advisor.emitBeforeAgentStart('The initializer failed', undefined, 'BASE', { cwd: root }))!.systemPrompt!, /WHEN TO SAVE/, 'failed initialization cannot establish a managed session pointer');
  rejectRename = false;
  await init.execute('retry', { workstream: 'fresh', workerHarness: 'pi' }, undefined, undefined, advisor.createContext());
  const initialized = (await advisor.emitBeforeAgentStart('Continue initialized outcome', undefined, 'BASE', { cwd: root }))!.systemPrompt!;
  assert.match(initialized, /single operational checkpoint/); assert.doesNotMatch(initialized, /WHEN TO SAVE/);
  await advisor.emit({ type: 'session_compact', compactionEntry: { summary: 'old' }, fromExtension: false, reason: 'manual', willRetry: false } as any);
  assert.match((await advisor.emitBeforeAgentStart('Resume', undefined, 'BASE', { cwd: root }))!.systemPrompt!, /fresh/);
  await advisor.emit({ type: 'session_shutdown', reason: 'quit' });
  await advisor.emit({ type: 'session_start', reason: 'resume' });
  const resumed = (await advisor.emitBeforeAgentStart('Resume same session', undefined, 'BASE', { cwd: root }))!.systemPrompt!;
  assert.match(resumed, /single operational checkpoint/); assert.doesNotMatch(resumed, /WHEN TO SAVE/);
  const parentSession = sm.getSessionId();
  await advisor.emit({ type: 'session_shutdown', reason: 'fork' });
  sm.createBranchedSession(sm.getLeafId()!); assert.notEqual(sm.getSessionId(), parentSession);
  await advisor.emit({ type: 'session_start', reason: 'fork' });
  const forked = (await advisor.emitBeforeAgentStart('Forked session', undefined, 'BASE', { cwd: root }))!.systemPrompt!;
  assert.match(forked, /WHEN TO SAVE/); assert.doesNotMatch(forked, /single operational checkpoint/);
  assert.deepEqual(errors, []);
  await advisor.emit({ type: 'session_shutdown', reason: 'quit' });
});
