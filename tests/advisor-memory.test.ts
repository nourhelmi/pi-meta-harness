import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorMemory, { registerAdvisorMemory } from "../extensions/advisor-memory.ts";
import { advisorCheckpoint } from "../extensions/advisor-core/advisor-state.ts";

function api() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>(); const tools: string[] = [];
  const pi = { on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerTool(tool: { name: string }) { tools.push(tool.name); } } as unknown as ExtensionAPI;
  return { pi, tools, async emit(name: string, event: any, ctx: ExtensionContext) { let result; for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx) ?? result; return result; } };
}
async function fixture(t: any) {
  const dir = await mkdtemp('/tmp/advisor-memory-'); const old = process.env.ADVISOR_STATE_DIR; process.env.ADVISOR_STATE_DIR = dir;
  t.after(async () => { if (old === undefined) delete process.env.ADVISOR_STATE_DIR; else process.env.ADVISOR_STATE_DIR = old; await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'workstreams'));
  const path = join(dir, 'workstreams/work.md');
  const content = '# Workstream: work\n- Owner session: `owner`\n## Current state\nOnly accepted checkpoint.\n'; await writeFile(path, content);
  const branch: any[] = [{ type: 'custom', customType: 'advisor-session', data: { workstream: 'work', sessionId: 'owner', initializedAt: 'now', workerHarness: 'pi' } }];
  const ctx = (sessionId = 'owner', entries = branch) => ({ cwd: dir, sessionManager: { getSessionId: () => sessionId, getBranch: () => entries } }) as unknown as ExtensionContext;
  return { dir, path, content, branch, ctx };
}

test('installed upstream registration uses single checkpoint on start, resume and compact; no server or diary side effects', async t => {
  const f = await fixture(t); const a = api(); await advisorMemory(a.pi);
  assert.ok(a.tools.includes('mem_save')); assert.ok(a.tools.includes('mem_context'));
  await a.emit('session_start', {}, f.ctx());
  const first = await a.emit('before_agent_start', { systemPrompt: 'base', prompt: 'Continue' }, f.ctx());
  assert.match(first.systemPrompt, /single operational checkpoint/); assert.ok(first.systemPrompt.includes(f.path));
  assert.doesNotMatch(first.systemPrompt, /WHEN TO SAVE|SESSION CLOSE PROTOCOL|Call `mem_save` IMMEDIATELY/);
  await a.emit('session_compact', { compactionEntry: { summary: 'Do not archive this old diary' } }, f.ctx());
  await a.emit('tool_execution_end', { toolName: 'edit', result: 'long result '.repeat(20) }, f.ctx());
  const resumed = await a.emit('before_agent_start', { systemPrompt: 'base' }, f.ctx()); assert.equal(resumed.systemPrompt, first.systemPrompt);
  assert.equal(await readFile(f.path, 'utf8'), f.content);
  await a.emit('session_shutdown', {}, f.ctx());
});

test('normal sessions forward upstream hooks and exact prompt unchanged; forks never acquire parent authority', async t => {
  const f = await fixture(t); const a = api(); const calls: string[] = [];
  registerAdvisorMemory(a.pi, pi => { for (const name of ['session_start', 'session_compact', 'tool_execution_end', 'before_agent_start', 'session_shutdown']) {
    (pi.on as any)(name, (event: any) => { calls.push(name); return name === 'before_agent_start' ? { systemPrompt: event.systemPrompt + '\nUPSTREAM MANDATORY MEMORY' } : undefined; });
  } });
  const fork = f.ctx('fork'); assert.equal(await advisorCheckpoint(fork), undefined);
  for (const name of ['session_start', 'session_compact', 'tool_execution_end']) await a.emit(name, {}, fork);
  const normal = await a.emit('before_agent_start', { systemPrompt: 'ordinary' }, fork); assert.equal(normal.systemPrompt, 'ordinary\nUPSTREAM MANDATORY MEMORY');
  await a.emit('session_shutdown', {}, fork); assert.equal(calls.length, 5);
  const managed = await a.emit('before_agent_start', { systemPrompt: 'base' }, f.ctx()); assert.doesNotMatch(managed.systemPrompt, /UPSTREAM/); assert.equal(calls.length, 5);
  await a.emit('session_shutdown', {}, f.ctx());
  assert.equal((await a.emit('before_agent_start', { systemPrompt: 'ordinary' }, f.ctx('new', []))).systemPrompt, normal.systemPrompt);
});

test('missing, corrupt, oversized and transferred checkpoint remain explicit unknown without overwriting or upstream fallback', async t => {
  const f = await fixture(t); const a = api(); let upstreamCalls = 0;
  registerAdvisorMemory(a.pi, pi => { pi.on('before_agent_start', () => { upstreamCalls++; return { systemPrompt: 'WRONG MEMORY' }; }); });
  for (const content of [null, 'bad', 'x'.repeat(65537), f.content.replace('`owner`', '`foreign`')]) {
    if (content === null) await rm(f.path); else await writeFile(f.path, content);
    const checkpoint = await advisorCheckpoint(f.ctx()); assert.ok(checkpoint?.problem); assert.equal(checkpoint?.content, undefined);
    const prompt = await a.emit('before_agent_start', { systemPrompt: 'base' }, f.ctx()); assert.match(prompt.systemPrompt, /unknown|corrupt/); assert.doesNotMatch(prompt.systemPrompt, /WRONG MEMORY/);
    if (content !== null) assert.equal(await readFile(f.path, 'utf8'), content);
  }
  assert.equal(upstreamCalls, 0);
});

test('entry before initialization suppresses contradictory protocol for raw input and expanded CLI skill, not later ordinary turns', async t => {
  const f = await fixture(t); const a = api(); registerAdvisorMemory(a.pi, pi => pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\nUPSTREAM' })));
  const ctx = f.ctx('new', []);
  await a.emit('input', { text: '/skill:advisor-pi' }, ctx);
  assert.doesNotMatch((await a.emit('before_agent_start', { systemPrompt: 'base' }, ctx)).systemPrompt, /UPSTREAM/);
  assert.match((await a.emit('before_agent_start', { systemPrompt: 'base' }, ctx)).systemPrompt, /UPSTREAM/);
  assert.doesNotMatch((await a.emit('before_agent_start', { systemPrompt: 'base', prompt: '<skill name="advisor-native" location="/test">' }, ctx)).systemPrompt, /UPSTREAM/);
});
