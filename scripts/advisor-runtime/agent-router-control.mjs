import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadAgentRouter } from './agent-router.mjs';
import { atomicWrite, boundedRead, canonicalLocation, demand, disjointControlPath, privateDirectory, safeFile } from './security.mjs';

const GATE = 'router-control.json';
const SNAPSHOT = 'router-config.json';
const SEED = 'router-seed.json';
const hash = text => createHash('sha256').update(text).digest('hex');
const pathValue = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && isAbsolute(value) && resolve(value) === value;
const sessionValue = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const errors = new Set(['AGENT_ROUTER_CONFIG_INVALID', 'AGENT_ROUTER_MODULE_INVALID', 'AGENT_ROUTER_DEFAULTS_INVALID']);
const exact = (value, keys, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...keys, ...optional].includes(key));

function readText(path, privateFile = true) {
  canonicalLocation(path);
  if (privateFile) safeFile(path);
  else {
    const stat = lstatSync(path);
    demand(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o022), 'AGENT_ROUTER_CONFIG_INVALID');
  }
  // Bound trusted catalogs too; one descriptor read preserves UTF-8 across page boundaries.
  demand(lstatSync(path).size <= 4 * 1024 * 1024, 'AGENT_ROUTER_CONFIG_INVALID');
  const result = boundedRead(dirname(path), basename(path), null);
  demand(result.bytes <= 4 * 1024 * 1024, 'AGENT_ROUTER_CONFIG_INVALID');
  return result.text;
}
function readJson(path, privateFile = true) {
  try { return JSON.parse(readText(path, privateFile)); }
  catch (error) { if (error.code) throw error; demand(false, 'AGENT_ROUTER_CONFIG_INVALID'); }
}
function defaultsPath(env) {
  const directory = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.pi', 'agent');
  demand(pathValue(directory), 'AGENT_ROUTER_DEFAULTS_INVALID');
  return join(directory, 'jev-router.json');
}
function validateDefaults(value) {
  demand(exact(value, ['version', 'enabled', 'configPath']) && value.version === 1 && typeof value.enabled === 'boolean'
    && (value.configPath === null || pathValue(value.configPath)), 'AGENT_ROUTER_DEFAULTS_INVALID');
  return { ...value };
}
function templateEnabled(path) {
  if (!path || !existsSync(path)) return false;
  const value = readJson(path, false);
  demand(value?.version === 1 && typeof value.enabled === 'boolean', 'AGENT_ROUTER_CONFIG_INVALID');
  return value.enabled;
}

/** Future-session defaults only. Explicit host overrides also override initial mode. */
export function readJevRouterDefaults(env = process.env) {
  if (env.AGENT_ROUTER_CONFIG) {
    demand(pathValue(env.AGENT_ROUTER_CONFIG), 'AGENT_ROUTER_DEFAULTS_INVALID');
    return { version: 1, enabled: templateEnabled(env.AGENT_ROUTER_CONFIG), configPath: env.AGENT_ROUTER_CONFIG };
  }
  const path = defaultsPath(env); safeFile(path);
  if (existsSync(path)) return validateDefaults(readJson(path));
  const home = env.HOME || homedir();
  const configPath = ['config.pi.json', 'config.json'].map(name => join(home, '.config', 'agent-router', name)).find(existsSync) ?? null;
  return { version: 1, enabled: templateEnabled(configPath), configPath };
}
export function writeJevRouterDefaults(value, env = process.env) {
  const validated = validateDefaults(value); const path = defaultsPath(env);
  canonicalLocation(dirname(path)); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  // Pi's existing agent directory may be 0755. Keep it unchanged; the file itself is private.
  demand(directory.isDirectory() && directory.uid === process.getuid() && !(directory.mode & 0o022), 'UNSAFE_DIRECTORY');
  safeFile(path);
  atomicWrite(path, JSON.stringify(validated));
  return validated;
}

function snapshotMetadata(value, configPath) {
  demand(value && !Array.isArray(value) && value.version === 1 && typeof value.enabled === 'boolean', 'AGENT_ROUTER_CONFIG_INVALID');
  for (const key of ['modulePath', 'stateDir', 'credentialsFile']) demand(pathValue(value[key]), 'AGENT_ROUTER_CONFIG_INVALID');
  for (const key of ['credentialFile', 'benchmarkFile']) demand(value[key] === undefined || pathValue(value[key]), 'AGENT_ROUTER_CONFIG_INVALID');
  let moduleStat;
  try { canonicalLocation(value.modulePath); moduleStat = lstatSync(value.modulePath); }
  catch { demand(false, 'AGENT_ROUTER_MODULE_INVALID'); }
  demand(moduleStat.isFile() && !(moduleStat.mode & 0o022), 'AGENT_ROUTER_MODULE_INVALID');
  return Object.freeze({ version: 1, enabled: true, configPath, modulePath: value.modulePath });
}
function validateRecord(value, seed = false) {
  const identity = seed ? ['parentStateRoot', 'parentSessionId'] : ['sessionId'];
  demand(exact(value, ['version', ...identity, 'enabled', 'generation', 'templatePath', 'snapshotSha256'], ['error'])
    && value.version === 1 && typeof value.enabled === 'boolean' && Number.isSafeInteger(value.generation) && value.generation >= 0
    && (value.templatePath === null || pathValue(value.templatePath))
    && (value.snapshotSha256 === null || typeof value.snapshotSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.snapshotSha256))
    && (value.error === undefined || errors.has(value.error))
    && (seed ? pathValue(value.parentStateRoot) && sessionValue(value.parentSessionId) : sessionValue(value.sessionId)), 'AGENT_ROUTER_CONTROL_INVALID');
  return value;
}

/** Called only after service ownership, bootstrap identity, and any child grant are validated. */
export function createAgentRouterControl({ stateRoot, sessionId, allowedRoots, allowInitialize = false, childGrant = null,
  env = process.env, configPath, assertOwner = () => {} }) {
  demand(sessionValue(sessionId), 'AGENT_ROUTER_CONTROL_INVALID');
  disjointControlPath(stateRoot, allowedRoots); privateDirectory(stateRoot); assertOwner();
  const gatePath = join(stateRoot, GATE); const snapshotPath = join(stateRoot, SNAPSHOT); const seedPath = join(stateRoot, SEED);
  let record; let uncertainWrite = false;
  if (existsSync(gatePath)) {
    record = validateRecord(readJson(gatePath));
    demand(record.sessionId === sessionId, 'BRIDGE_SESSION_MISMATCH');
  } else {
    if (!allowInitialize || childGrant && (childGrant.v !== 2 || !existsSync(seedPath))) return null;
    if (childGrant) {
      const seed = validateRecord(readJson(seedPath), true);
      demand(seed.parentStateRoot === childGrant.parent.stateRoot && seed.parentSessionId === childGrant.parent.sessionId, 'AGENT_ROUTER_SEED_MISMATCH');
      const { parentStateRoot: _root, parentSessionId: _session, ...selection } = seed;
      record = { ...selection, sessionId, generation: 0 };
    } else {
      let defaults;
      try { defaults = readJevRouterDefaults(configPath ? { ...env, AGENT_ROUTER_CONFIG: configPath } : env); }
      catch {
        // Unknown/malformed defaults are not consent to bypass routing. Only explicit OFF clears the gate.
        const selected = configPath || env.AGENT_ROUTER_CONFIG;
        defaults = { enabled: true, configPath: pathValue(selected) ? selected : null, error: 'AGENT_ROUTER_DEFAULTS_INVALID' };
      }
      record = { version: 1, sessionId, enabled: defaults.enabled, generation: 0, templatePath: defaults.configPath, snapshotSha256: null,
        ...(defaults.error ? { error: defaults.error } : {}) };
      if (defaults.configPath && !defaults.error) {
        try {
          const value = readJson(defaults.configPath, false);
          snapshotMetadata(value, snapshotPath);
          const bytes = JSON.stringify({ ...value, enabled: true });
          safeFile(snapshotPath); demand(!existsSync(snapshotPath), 'AGENT_ROUTER_CONTROL_INVALID');
          atomicWrite(snapshotPath, bytes); record.snapshotSha256 = hash(bytes);
        } catch (error) {
          record.error = errors.has(error.code) ? error.code : 'AGENT_ROUTER_CONFIG_INVALID';
        }
      }
    }
    // The snapshot is committed first. An interrupted initialization is never adopted over an old runtime.
    if (record.enabled && !record.snapshotSha256 && !record.error) record.error = 'AGENT_ROUTER_CONFIG_INVALID';
    safeFile(gatePath); atomicWrite(gatePath, JSON.stringify(record));
  }
  const snapshot = () => {
    demand(record.snapshotSha256, 'AGENT_ROUTER_CONFIG_INVALID');
    const bytes = readText(snapshotPath);
    demand(hash(bytes) === record.snapshotSha256, 'AGENT_ROUTER_CONFIG_INVALID');
    try { return snapshotMetadata(JSON.parse(bytes), snapshotPath); }
    catch (error) { demand(false, errors.has(error.code) ? error.code : 'AGENT_ROUTER_CONFIG_INVALID'); }
  };
  const status = () => {
    assertOwner(); demand(!uncertainWrite, 'AGENT_ROUTER_CONTROL_WRITE_UNCONFIRMED');
    const { snapshotSha256: _hash, ...value } = record;
    if (value.enabled && !value.error) {
      try { snapshot(); } catch (error) { value.error = errors.has(error.code) ? error.code : 'AGENT_ROUTER_CONFIG_INVALID'; }
    }
    // OFF is usable even without setup. Retain the private error for a future enable attempt.
    if (!value.enabled) delete value.error;
    return value;
  };
  const capture = () => {
    const value = status();
    let config = null; let error = record.error;
    if (record.snapshotSha256) {
      try { config = snapshot(); }
      catch (cause) { error = errors.has(cause.code) ? cause.code : 'AGENT_ROUTER_CONFIG_INVALID'; }
    }
    if (value.enabled) demand(!error && config, error ?? 'AGENT_ROUTER_CONFIG_INVALID');
    return Object.freeze({ enabled: value.enabled, generation: value.generation, snapshot: config,
      templatePath: record.templatePath, snapshotSha256: record.snapshotSha256, ...(error ? { error } : {}) });
  };
  return {
    status, capture,
    snapshot,
    async set(value) {
      demand(exact(value, ['enabled', 'expectedGeneration']) && typeof value.enabled === 'boolean'
        && Number.isSafeInteger(value.expectedGeneration) && value.expectedGeneration >= 0, 'AGENT_ROUTER_CONTROL_INVALID');
      assertOwner(); demand(!uncertainWrite, 'AGENT_ROUTER_CONTROL_WRITE_UNCONFIRMED');
      demand(value.expectedGeneration === record.generation, 'AGENT_ROUTER_GENERATION_CONFLICT');
      if (value.enabled) {
        demand(!record.error, record.error);
        // Check the API only on explicit enable/use, never OFF or status/defaults.
        try { await loadAgentRouter(snapshot()); }
        catch (error) { demand(false, errors.has(error.code) ? error.code : 'AGENT_ROUTER_MODULE_INVALID'); }
      }
      assertOwner(); // Re-fence ownership and CAS after the import await.
      demand(value.expectedGeneration === record.generation, 'AGENT_ROUTER_GENERATION_CONFLICT');
      demand(record.generation < Number.MAX_SAFE_INTEGER, 'AGENT_ROUTER_GENERATION_EXHAUSTED');
      const next = { ...record, enabled: value.enabled, generation: record.generation + 1 };
      safeFile(gatePath);
      try { atomicWrite(gatePath, JSON.stringify(next)); }
      catch {
        // Rename may have succeeded before directory fsync failed. Never replay an old generation.
        try {
          const stored = validateRecord(readJson(gatePath));
          demand([JSON.stringify(record), JSON.stringify(next)].includes(JSON.stringify(stored)), 'AGENT_ROUTER_CONTROL_INVALID');
          record = stored;
        } catch { uncertainWrite = true; }
        demand(false, 'AGENT_ROUTER_CONTROL_WRITE_UNCONFIRMED');
      }
      record = next;
      return status();
    },
    seedChild(selection, intent, scope) {
      const childState = intent?.environment?.ADVISOR_BRIDGE_CHILD_STATE;
      if (!childState) return;
      assertOwner();
      const familyRoot = childGrant?.family?.rootStateRoot ?? stateRoot;
      demand(childState === scope?.childState && dirname(childState) === join(familyRoot, 'c') && /^[a-f0-9]{20}$/.test(basename(childState)), 'AGENT_ROUTER_SEED_MISMATCH');
      disjointControlPath(childState, allowedRoots); privateDirectory(childState);
      for (const name of [GATE, SEED, SNAPSHOT, 'runtime.sqlite', 'startup.json', 'child-grant.json']) {
        safeFile(join(childState, name)); demand(!existsSync(join(childState, name)), 'AGENT_ROUTER_SEED_EXISTS');
      }
      const { snapshot: _snapshot, ...mode } = selection;
      if (selection.snapshotSha256) {
        const bytes = readText(snapshotPath);
        demand(hash(bytes) === selection.snapshotSha256, 'AGENT_ROUTER_CONFIG_INVALID');
        atomicWrite(join(childState, SNAPSHOT), bytes);
      }
      atomicWrite(join(childState, SEED), JSON.stringify({ version: 1, parentStateRoot: stateRoot, parentSessionId: sessionId, ...mode }));
    },
  };
}
