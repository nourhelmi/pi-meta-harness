import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The caller supplies a fresh HOME and production package roots. No Herdr/model.
assert.match(process.versions.node, /^22\./);
const meta = process.env.PI_BRIDGE_META_PACKAGE, detach = process.env.PI_DETACH_TEST_PACKAGE;
assert.ok(meta && detach);
for (const key of Object.keys(process.env)) if (/^(HERDR_|ADVISOR_|PI_DETACH_)/.test(key)) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, 'agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
const bootstrap = await import(pathToFileURL(join(meta, 'scripts/advisor-runtime/pi-detach-bootstrap.mjs')));
await import(pathToFileURL(join(meta, 'scripts/advisor-runtime/pi-detach-client.mjs')));
const bridge = await import(pathToFileURL(join(detach, 'src/runtime-bridge.ts')));
assert.equal(bootstrap.managedBridgeEnabled(), false); assert.equal(bridge.bridgeEnabled(), false);
const extension = (await import(pathToFileURL(join(detach, 'extensions/index.ts')))).default;
const tools = new Map(), handlers = new Map();
extension({ registerTool(t) { tools.set(t.name, t); }, registerCommand() {}, registerMessageRenderer() {}, on(n, h) { handlers.set(n, [...handlers.get(n) || [], h]); }, sendMessage() {} });
const ctx = { cwd: process.env.HOME, sessionManager: { getSessionId: () => 'unmanaged-consumer' }, isIdle: () => true, ui: { notify() {} } };
const invoke = (tool, params) => tools.get(tool).execute(tool, params, undefined, undefined, ctx);
for (const h of handlers.get('session_start') || []) await h({}, ctx);
const run = await invoke('bg_run', { command: 'printf CONSUMER_OK', promoteAfterMs: 1000 });
assert.equal(run.details.exitCode, 0);
assert.match((await invoke('bg_output', { runId: run.details.runId })).content[0].text, /CONSUMER_OK/);
const waited = await invoke('bg_await', { command: 'printf READY', untilPattern: 'READY', timeoutSeconds: 1, intervalSeconds: 1 });
assert.equal(waited.details.exitCode, 0);
const watch = await invoke('bg_watch', { command: 'printf WATCH_READY; sleep 10' });
assert.equal((await invoke('bg_list', {})).details.runs.find(r => r.id === watch.details.runId).status, 'running');
await invoke('bg_stop', { runId: watch.details.runId });
for (const h of handlers.get('session_shutdown') || []) await h({}, ctx);
// The default fence does not import/start SQLite and leaves no legacy writer hooks.
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'pi-detach-runtime.json'), '{}');
const host = (await import(pathToFileURL(join(meta, 'extensions/advisor-pi-host.ts')))).default;
let legacyHooks = 0; host({ on() { legacyHooks++; } }); assert.equal(legacyHooks, 0);
assert.equal(bridge.bridgeEnabled(), true);
process.env.PI_DETACH_BACKEND = 'legacy'; assert.equal(bridge.bridgeEnabled(), false);
console.log(JSON.stringify({ status: 'PASS', node: process.versions.node, inactiveImports: true, unmanagedRunWatchAwaitListOutput: true, managedLegacyWriterFenced: true }));
