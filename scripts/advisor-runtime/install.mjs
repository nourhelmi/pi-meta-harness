import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, demand, safeFile, within, RuntimeError } from './security.mjs';
import { createHash } from 'node:crypto';

const START = '# BEGIN portable-advisor-runtime v1';
const END = '# END portable-advisor-runtime v1';
const hash = text => createHash('sha256').update(text).digest('hex');
function json(text) { try { return JSON.parse(text); } catch { throw new RuntimeError('INSTALL_JSON'); } }
function safePath(root, path) {
  demand(within(root, path), 'INSTALL_PATH');
  let current = path;
  while (within(root, current)) {
    try { const stat = lstatSync(current); demand(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'INSTALL_SYMLINK_OR_OWNER'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === root) break; current = dirname(current);
  }
}
function rootPath(target) {
  const root = resolve(target); demand(existsSync(root) && realpathSync(root) === root && lstatSync(root).isDirectory(), 'EXPLICIT_REAL_PROJECT_REQUIRED');
  demand(lstatSync(root).uid === process.getuid(), 'INSTALL_OWNER'); return root;
}
function load(root, path) { safePath(root, path); if (!existsSync(path)) return null; demand(lstatSync(path).isFile() && lstatSync(path).nlink === 1 && lstatSync(path).size <= 262144, 'INSTALL_FILE'); return readFileSync(path, 'utf8'); }
function put(root, path, value) {
  safePath(root, path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); safePath(root, path);
  if (value === null) { if (existsSync(path)) unlinkSync(path); } else atomicWrite(path, value);
}
function codexFragment(text) {
  if (text === null) return null;
  const start = text.indexOf(START); const end = text.indexOf(END);
  if (start < 0 && end < 0) { demand(!text.includes('advisor_runtime'), 'FOREIGN_FRAGMENT'); return null; }
  demand(start >= 0 && end > start && text.indexOf(START, start + START.length) < 0 && text.indexOf(END, end + END.length) < 0, 'OWNED_FRAGMENT_TAMPERED');
  const fragment = text.slice(start, end + END.length);
  demand(!text.replace(fragment, '').includes('advisor_runtime'), 'FOREIGN_FRAGMENT'); return fragment;
}
function currentFragment(host, text) {
  if (host === 'codex') return codexFragment(text);
  if (text === null) return null;
  const value = json(text); demand(value && typeof value === 'object' && !Array.isArray(value), 'INSTALL_JSON');
  demand(value.mcpServers === undefined || (value.mcpServers && typeof value.mcpServers === 'object' && !Array.isArray(value.mcpServers)), 'INSTALL_JSON');
  return value.mcpServers?.advisor_runtime ?? null;
}
function replaceFragment(host, text, fragment) {
  if (host === 'codex') {
    const prior = codexFragment(text); const base = prior ? text.replace(prior, '') : text ?? '';
    return fragment === null ? base : `${base}${base && !base.endsWith('\n') ? '\n' : ''}${fragment}\n`;
  }
  const value = text === null ? {} : json(text);
  value.mcpServers ??= {};
  if (fragment === null) { delete value.mcpServers.advisor_runtime; if (Object.keys(value.mcpServers).length === 0) delete value.mcpServers; }
  else value.mcpServers.advisor_runtime = fragment;
  return JSON.stringify(value, null, 2) + '\n';
}
function installation(host, descriptorPath, root) {
  const descriptor = resolve(descriptorPath); safeFile(descriptor);
  demand(existsSync(descriptor) && realpathSync(descriptor) === descriptor && !within(root, descriptor), 'DESCRIPTOR_OUTSIDE_PROJECT_REQUIRED');
  const value = json(readFileSync(descriptor, 'utf8')); demand(value.v === 1 && typeof value.socketPath === 'string' && /^[a-f0-9]{64}$/.test(value.token), 'INVALID_CREDENTIAL');
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const mcp = { command: process.execPath, args: [cli, 'mcp-env'], env: { ADVISOR_RUNTIME_DESCRIPTOR_PATH: descriptor } };
  const fragment = host === 'codex' ? `${START}\n[mcp_servers.advisor_runtime]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\nenabled = true\nrequired = true\nstartup_timeout_sec = 8\ntool_timeout_sec = 15\n[mcp_servers.advisor_runtime.env]\nADVISOR_RUNTIME_DESCRIPTOR_PATH = ${JSON.stringify(descriptor)}\n${END}` : { type: 'stdio', ...mcp };
  const skill = readFileSync(new URL('../../skills/advisor-native-entry/SKILL.md', import.meta.url), 'utf8');
  return { fragment, skill, hash: hash(JSON.stringify([fragment, skill])), mcp };
}
/** Read-only owned-entry preflight; never repair or widen a modified installation. */
export function inspectInstallation(host, target, descriptorPath) {
  const root = rootPath(target); const manifestPath = join(root, `.advisor-native-${host}.json`);
  safeFile(manifestPath); const manifest = json(load(root, manifestPath) ?? 'null');
  demand(manifest?.v === 1 && manifest.host === host && manifest.state === 'installed', 'INSTALL_MANIFEST_REQUIRED');
  const config = load(root, join(root, host === 'codex' ? '.codex/config.toml' : '.mcp.json'));
  const skill = load(root, join(root, host === 'codex' ? '.agents/skills/advisor-runtime/SKILL.md' : '.claude/skills/advisor-runtime/SKILL.md'));
  const desired = installation(host, descriptorPath, root);
  demand(manifest.hash === desired.hash && JSON.stringify(currentFragment(host, config)) === JSON.stringify(desired.fragment) && skill === desired.skill, 'OWNED_FRAGMENT_TAMPERED');
  return { root, mcp: desired.mcp };
}
export function projectInstall(action, host, target, descriptorPath) {
  demand(['install', 'uninstall', 'restore'].includes(action) && ['codex', 'claude-code'].includes(host), 'INSTALL_USAGE');
  const root = rootPath(target); const manifestPath = join(root, `.advisor-native-${host}.json`);
  const configPath = join(root, host === 'codex' ? '.codex/config.toml' : '.mcp.json');
  const skillPath = join(root, host === 'codex' ? '.agents/skills/advisor-runtime/SKILL.md' : '.claude/skills/advisor-runtime/SKILL.md');
  const beforeConfig = load(root, configPath); const beforeSkill = load(root, skillPath); const manifestText = load(root, manifestPath);
  let manifest;
  if (manifestText === null) {
    demand(action === 'install' && descriptorPath, 'INSTALL_MANIFEST_REQUIRED');
    demand(currentFragment(host, beforeConfig) === null && beforeSkill === null, 'FOREIGN_FRAGMENT');
    manifest = { v: 1, host, state: 'uninstalled', ...installation(host, descriptorPath, root), originalFragment: null, originalSkill: null };
  } else {
    safeFile(manifestPath); manifest = json(manifestText);
    demand(manifest.v === 1 && manifest.host === host && ['installed', 'uninstalled'].includes(manifest.state) && manifest.hash === hash(JSON.stringify([manifest.fragment, manifest.skill])), 'INSTALL_MANIFEST_TAMPERED');
  }
  const installed = manifest.state === 'installed'; const expected = installed ? manifest.fragment : manifest.originalFragment;
  demand(JSON.stringify(currentFragment(host, beforeConfig)) === JSON.stringify(expected) && beforeSkill === (installed ? manifest.skill : manifest.originalSkill), 'OWNED_FRAGMENT_TAMPERED');
  const installing = action !== 'uninstall';
  if (action === 'install') {
    const desired = installation(host, descriptorPath, root);
    demand(!installed || desired.hash === manifest.hash, 'UNINSTALL_BEFORE_REINSTALL');
    if (!installed) Object.assign(manifest, desired);
  }
  if (installing === installed) return { changed: false, state: manifest.state };
  const config = replaceFragment(host, beforeConfig, installing ? manifest.fragment : manifest.originalFragment);
  // Preflight all paths and ownership before the first write; a pending manifest makes interrupted installs fail closed.
  safePath(root, configPath); safePath(root, skillPath); safePath(root, manifestPath);
  put(root, manifestPath, JSON.stringify({ ...manifest, state: 'pending' }, null, 2));
  put(root, configPath, config); put(root, skillPath, installing ? manifest.skill : manifest.originalSkill);
  manifest.state = installing ? 'installed' : 'uninstalled'; put(root, manifestPath, JSON.stringify(manifest, null, 2));
  return { changed: true, state: manifest.state };
}
