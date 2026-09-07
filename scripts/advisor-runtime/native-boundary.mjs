import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { demand, canonicalLocation, disjointControlPath, privateDirectory, within } from './security.mjs';
import { fields, OPERATIONS } from './contract.mjs';
import { canonicalJson } from '../advisor-core/command-contract.mjs';

export const READ_PROFILE = 'advisor-task-read-v1';
export const WRITE_PROFILE = 'advisor-task-write-v1';
// Pinned public features. Shell/apply_patch use the native permission profile;
// separate browser, image, plugin, memory, agent and code execution surfaces stay off.
export const CODEX_FEATURES = Object.freeze({ multi_agent: false, multi_agent_v2: false, collab: false, enable_fanout: false,
  auth_elicitation: false, background_paginated_rollout_migration: false, mcp_2026_07_28: false, mentions_v2: false, remote_plugin: false,
  apps: false, connectors: false, plugins: false, plugin_hooks: false, hooks: false, codex_hooks: false,
  browser_use: false, browser_use_external: false, computer_use: false, in_app_browser: false, in_app_local_automation: false,
  view_image: false, image_generation: false, imagegenext: false, js_repl: false, code_mode: false, code_mode_host: false,
  memories: false, memory_tool: false, external_agent_memory_import: false, request_permissions_tool: false,
  request_permissions: false, request_rule: false, tool_suggest: false, skill_search: false, skip_host_skill_discovery: true,
  skill_mcp_dependency_install: false, shell_snapshot: false, shell_snapshot_v2: false, remote_control: false,
  shell_tool: true, unified_exec: true, exec_permission_approvals: false });

export function permissionConfig(cwd, controls = [], readRoots = []) {
  demand(realpathSync(cwd) === cwd && readRoots.every(path => realpathSync(path) === path), 'BOUNDARY_CWD');
  const roots = [...new Set([cwd, ...readRoots])];
  const denied = Object.fromEntries(controls.map(path => [disjointControlPath(path, roots), 'deny']));
  const extraReads = Object.fromEntries(readRoots.map(path => [path, 'read']));
  const protectedPaths = Object.fromEntries(roots.flatMap(path => [[join(path, '.git'), 'read'], [join(path, '.codex'), 'deny'], [join(path, '.claude'), 'deny'], [join(path, '.agents'), 'read']]));
  // Node 24's macOS OpenSSL runtime loads this root-owned system file; :minimal
  // in Codex 0.153.4 omits it. Grant only the file, never an auth/home tree.
  const runtimeReads = process.platform === 'darwin' ? { '/System/Library/OpenSSL/openssl.cnf': 'read' } : {};
  const profile = write => ({ filesystem: { ':minimal': 'read', ...runtimeReads, ...extraReads, [cwd]: write ? 'write' : 'read', ...denied, ...protectedPaths }, network: { enabled: false } });
  return { default_permissions: READ_PROFILE, permissions: { [READ_PROFILE]: profile(false), [WRITE_PROFILE]: profile(true) },
    approval_policy: 'on-request', allow_login_shell: false, features: { ...CODEX_FEATURES }, agents: { enabled: false },
    web_search: 'disabled', project_doc_max_bytes: 0, shell_environment_policy: { inherit: 'none', include_only: ['PATH', 'LANG'] } };
}
function toml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  demand(value && typeof value === 'object', 'BOUNDARY_CONFIG');
  return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`).join(',')}}`;
}
export function configArgs(config) { return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]); }
function withoutNulls(value) {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
  return value;
}
export function assertPermissionConfig(actual, expected) {
  demand(actual && actual.sandbox_mode == null && actual.sandbox_workspace_write == null, 'CODEX_LEGACY_PERMISSION_OVERRIDE');
  for (const key of ['permissions', 'default_permissions', 'features', 'agents', 'projects', 'mcp_servers', 'web_search', 'allow_login_shell', 'project_doc_max_bytes', 'shell_environment_policy']) {
    demand(canonicalJson(withoutNulls(actual[key] ?? null)) === canonicalJson(withoutNulls(expected[key] ?? null)), 'CODEX_CONFIG_DRIFT');
  }
}

export function managedProviderHomes(stateRoot, allowedRoots, supplied) {
  const homes = supplied ?? { codex: join(stateRoot, 'providers', 'codex'), 'claude-code': join(stateRoot, 'providers', 'claude-code') };
  fields(homes, ['codex', 'claude-code']);
  for (const path of Object.values(homes)) {
    disjointControlPath(path, [...allowedRoots, join(stateRoot, 'runs')]);
    demand(!within(path, stateRoot), 'PROVIDER_HOME_OVERLAP');
  }
  demand(!within(homes.codex, homes['claude-code']) && !within(homes['claude-code'], homes.codex), 'PROVIDER_HOME_OVERLAP');
  return { ...homes };
}
/** Trusted provider process state is never a model filesystem grant. No implicit global HOME. */
export function providerEnvironment(provider, env, cwd, artifactDirectory, controls = []) {
  const key = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  demand(env[key] && env.HOME, 'MANAGED_PROVIDER_HOME_REQUIRED');
  const homes = [...new Set([env[key], env.HOME])].map(path => disjointControlPath(path, [cwd, artifactDirectory]));
  for (const path of controls) disjointControlPath(path, [cwd]);
  for (const path of homes) privateDirectory(path);
  return { env: { ...env, HOME: canonicalLocation(env.HOME) }, controls: [...new Set([...controls, ...homes, artifactDirectory])] };
}

const MCP_TOOLS = new Set(OPERATIONS.map(op => `mcp__advisor_runtime__advisor_${op.replaceAll('.', '_')}`));
const READ_FIELDS = ['offset', 'limit', 'pages'];
const GREP_FIELDS = ['path', 'glob', 'output_mode', '-B', '-A', '-C', 'context', '-n', '-i', '-o', 'type', 'head_limit', 'offset', 'multiline'];
function safePattern(value) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'TOOL_INPUT');
  demand(!isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !value.startsWith('!'), 'TOOL_PATTERN');
}
function pathInWorkspace(cwd, value, { directory = false, missing = false } = {}) {
  demand(typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.split(/[\\/]/).includes('..'), 'TOOL_PATH_FORBIDDEN');
  const path = resolve(cwd, value); demand(within(cwd, path), 'TOOL_PATH_FORBIDDEN');
  // Both existing components and missing-file parents are checked without following aliases.
  canonicalLocation(path);
  let current = path;
  while (within(cwd, current)) {
    try { const stat = lstatSync(current); demand(!stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)), 'TOOL_PATH_FORBIDDEN'); }
    catch (error) { if (error.code !== 'ENOENT' || !missing) throw error; }
    if (current === cwd) break; current = dirname(current);
  }
  if (!missing) { const stat = lstatSync(path); demand(directory ? stat.isDirectory() : stat.isFile(), 'TOOL_PATH_FORBIDDEN'); }
  demand(!['.codex', '.claude', '.git'].some(name => within(join(cwd, name), path)), 'TOOL_CONTROL_PATH');
  return path;
}
function scanTree(path, root) {
  const pending = [path]; let count = 0;
  while (pending.length) {
    const next = pending.pop(); demand(++count <= 10000, 'TOOL_SCAN_BOUND');
    demand(!['.codex', '.claude', '.git'].some(name => within(join(root, name), next)), 'TOOL_CONTROL_PATH');
    const stat = lstatSync(next); demand(!stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)), 'TOOL_PATH_FORBIDDEN');
    if (stat.isDirectory()) for (const name of readdirSync(next)) pending.push(join(next, name));
  }
}
/** Synchronous gate shared by SDK PreToolUse and the owned CLI hook; no permission expansion. */
export function guardTool({ cwd, writer = false, root = false, readRoots = [] }, name, input) {
  demand(realpathSync(cwd) === cwd && (!readRoots.length || (root && !writer)), 'BOUNDARY_CWD');
  const readRoot = value => {
    demand(value === undefined || (typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.split(/[\\/]/).includes('..')), 'TOOL_PATH_FORBIDDEN');
    const path = resolve(cwd, value ?? cwd);
    const selected = [cwd, ...readRoots].find(base => within(base, path));
    demand(selected && realpathSync(selected) === selected, 'TOOL_PATH_FORBIDDEN');
    return selected;
  };
  demand(input && typeof input === 'object' && !Array.isArray(input), 'TOOL_INPUT');
  if (root && MCP_TOOLS.has(name)) { fields(input, ['v', 'scope', 'payload'], ['commandId', 'expectedRevision']); return; } // runtime authorizes exact command/scope
  if (name === 'AskUserQuestion') {
    fields(input, ['questions'], ['answers', 'metadata']);
    demand(Array.isArray(input.questions) && input.questions.length >= 1 && input.questions.length <= 4, 'TOOL_QUESTION');
    for (const q of input.questions) { fields(q, ['question', 'header', 'options', 'multiSelect']); demand(typeof q.question === 'string' && typeof q.header === 'string' && typeof q.multiSelect === 'boolean' && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4, 'TOOL_QUESTION'); }
    return;
  }
  if (name === 'Read') {
    fields(input, ['file_path'], READ_FIELDS); pathInWorkspace(readRoot(input.file_path), resolve(cwd, input.file_path));
    for (const key of ['offset', 'limit']) if (input[key] !== undefined) demand(Number.isSafeInteger(input[key]) && input[key] > 0, 'TOOL_INPUT');
    if (input.pages !== undefined) demand(typeof input.pages === 'string' && /^[0-9]+(?:-[0-9]+)?$/.test(input.pages), 'TOOL_INPUT');
    return;
  }
  if (name === 'Glob' || name === 'Grep') {
    fields(input, ['pattern'], name === 'Glob' ? ['path'] : GREP_FIELDS);
    demand(typeof input.pattern === 'string' && input.pattern.length > 0 && input.pattern.length <= 4096, 'TOOL_INPUT');
    if (name === 'Glob') safePattern(input.pattern);
    if (input.glob !== undefined) safePattern(input.glob);
    if (input.type !== undefined) demand(typeof input.type === 'string' && /^[a-z0-9_-]+$/i.test(input.type), 'TOOL_INPUT');
    if (input.output_mode !== undefined) demand(['content', 'files_with_matches', 'count'].includes(input.output_mode), 'TOOL_INPUT');
    for (const key of ['-B', '-A', '-C', 'context', 'head_limit', 'offset']) if (input[key] !== undefined) demand(Number.isSafeInteger(input[key]) && input[key] >= 0, 'TOOL_INPUT');
    for (const key of ['-n', '-i', '-o', 'multiline']) if (input[key] !== undefined) demand(typeof input[key] === 'boolean', 'TOOL_INPUT');
    const target = resolve(cwd, input.path ?? cwd); const base = readRoot(input.path);
    const directory = lstatSync(target).isDirectory();
    // Validate the original spelling too: normalization must not erase traversal components.
    demand(!(input.path ?? '').split(/[\\/]/).includes('..'), 'TOOL_PATH_FORBIDDEN');
    pathInWorkspace(base, target, { directory }); scanTree(target, base); return;
  }
  demand(writer && ['Edit', 'Write'].includes(name), 'TOOL_FORBIDDEN');
  fields(input, name === 'Write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string'], name === 'Edit' ? ['replace_all'] : []);
  pathInWorkspace(cwd, input.file_path, { missing: name === 'Write' });
  for (const key of name === 'Write' ? ['content'] : ['old_string', 'new_string']) demand(typeof input[key] === 'string', 'TOOL_INPUT');
  if (input.replace_all !== undefined) demand(typeof input.replace_all === 'boolean', 'TOOL_INPUT');
}
export function preToolGuard(policy, event) {
  try {
    demand(event?.hook_event_name === 'PreToolUse' && event.cwd === policy.cwd && !event.agent_id, 'HOOK_SCOPE');
    guardTool(policy, event.tool_name, event.tool_input);
    return { continue: true }; // preserve native question/permission handling, never auto-grant an escalation
  } catch { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Outside the bounded advisor tool policy.' } }; }
}
