import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { admitCommand } from '../advisor-core/command-admission.mjs';
import { canonicalJson } from '../advisor-core/command-contract.mjs';
import { validateResultArtifact, resultStatusBody } from '../advisor-core/result-artifact.mjs';
import { validateTrace } from '../advisor-trace.mjs';
import { OPERATIONS, WORKER_OPERATIONS, LIMITS, fields, integer, parseEnvelope, text, validatePacket } from './contract.mjs';
import { RuntimeError, acquireLock, atomicWrite, boundedRead, demand, disjointControlPath, id, privateDirectory, safeFile, within, withRunOwnership } from './security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function decode(value) { try { return JSON.parse(value); } catch { throw new RuntimeError('STORE_CORRUPT'); } }
const clone = value => decode(canonicalJson(value));
const scopeMatches = (a, b) => a.workstream === b.workstream && a.run === b.run && a.node === b.node;
const rejection = error => ({ ok: false, error: error instanceof RuntimeError ? error.code : ['ENVELOPE_TOO_LARGE', 'NON_JSON'].includes(error?.reason) ? error.reason : 'INTERNAL_ERROR' });

/** Trusted host API. Never expose registration, ingestion, SQL, or adapters over transport. */
export class AdvisorRuntime {
  #db; #release; #owner; #root; #allowedRoots; #adapters; #fault; #schema; #closed = false; #dispatching = null;
  #piBridge;
  #controlPaths = new Set(); #controlDirectories = new Set();
  #notifications = new EventEmitter();
  constructor({ stateRoot, allowedRoots, controlPaths = [], controlDirectories = [], adapters = { roots: {}, workers: {} }, piBridge = null, fault = () => {} }) {
    demand(Array.isArray(allowedRoots) && allowedRoots.length > 0, 'ALLOWED_ROOTS_REQUIRED');
    this.#allowedRoots = allowedRoots.map(path => realpathSync(path));
    demand(Array.isArray(controlPaths) && controlPaths.length <= 128, 'INVALID_CONTROL_PATHS');
    for (const path of [stateRoot, ...controlPaths]) this.#controlPaths.add(disjointControlPath(path, this.#allowedRoots));
    demand(Array.isArray(controlDirectories) && controlDirectories.length <= 16, 'INVALID_CONTROL_DIRECTORIES');
    for (const path of controlDirectories) this.#controlDirectories.add(disjointControlPath(path, this.#allowedRoots));
    for (const path of [...controlPaths, ...controlDirectories]) demand(!within(join(stateRoot, 'runs'), path), 'CONTROL_IN_ARTIFACT_SCOPE');
    // Read the persisted inventory without changing SQLite, locks or directories. A
    // newly widened task grant or changed provider inventory must fail before writes.
    const existingDatabase = join(stateRoot, 'runtime.sqlite');
    if (existsSync(existingDatabase)) {
      safeFile(existingDatabase); const prior = new DatabaseSync(existingDatabase, { readOnly: true });
      try {
        const tables = new Set(prior.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        const storedDirectories = tables.has('control_directories') ? prior.prepare('SELECT path FROM control_directories').all().map(row => row.path) : [];
        const storedPaths = tables.has('control_paths') ? prior.prepare('SELECT path FROM control_paths').all().map(row => row.path) : [];
        for (const path of [...storedDirectories, ...storedPaths]) disjointControlPath(path, this.#allowedRoots);
        if (controlDirectories.length && storedDirectories.length) demand(canonicalJson([...this.#controlDirectories].sort()) === canonicalJson(storedDirectories.sort()), 'CONTROL_INVENTORY_MISMATCH');
        for (const path of storedDirectories) this.#controlDirectories.add(path);
      } finally { prior.close(); }
    }
    this.#root = privateDirectory(stateRoot);
    for (const path of this.#controlDirectories) privateDirectory(path);
    for (const path of controlPaths) { privateDirectory(dirname(path)); safeFile(path); }
    for (const directory of ['traces', 'runs', 'ownership']) privateDirectory(join(this.#root, directory));
    this.#release = acquireLock(join(this.#root, 'service.lock'));
    this.#piBridge = piBridge;
    this.#owner = randomUUID(); this.#adapters = adapters; this.#fault = fault;
    this.#notifications.setMaxListeners(64);
    try {
      const path = join(this.#root, 'runtime.sqlite');
      if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
      for (const suffix of ['', '-wal', '-shm', '-journal']) safeFile(path + suffix);
      this.#db = new DatabaseSync(path);
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), nonce TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, principal TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL, owner TEXT, data TEXT NOT NULL, handle TEXT);
        CREATE TABLE IF NOT EXISTS events (run TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run,seq));
        CREATE TABLE IF NOT EXISTS ingested (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, node TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS acks (principal TEXT NOT NULL, delivery INTEGER NOT NULL, PRIMARY KEY(principal,delivery));
        CREATE TABLE IF NOT EXISTS exports (run TEXT PRIMARY KEY, seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS control_paths (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS control_directories (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS scope_grants (principal TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(principal,data));
        CREATE TABLE IF NOT EXISTS pi_bindings (id TEXT PRIMARY KEY, principal TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bootstrap (singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL);`);
      for (const row of this.#all('SELECT path FROM control_paths')) this.#controlPaths.add(disjointControlPath(row.path, this.#allowedRoots));
      for (const row of this.#all('SELECT path FROM control_directories')) this.#controlDirectories.add(disjointControlPath(row.path, this.#allowedRoots));
      for (const path of this.#controlDirectories) this.#write('INSERT OR IGNORE INTO control_directories VALUES (?)', path);
      this.#db.prepare('INSERT INTO owner VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET nonce=excluded.nonce').run(this.#owner);
      this.#schema = decode(readFileSync(new URL('../../config/advisor-core/canonical-events.schema.json', import.meta.url), 'utf8'));
      this.#recover();
      for (const row of this.#all('SELECT id FROM runs')) this.#tryExport(row.id);
    } catch (error) { this.#db?.close(); this.#release(); throw error; }
  }
  get stateRoot() { return this.#root; }
  #one(sql, ...args) { return this.#db.prepare(sql).get(...args); }
  #all(sql, ...args) { return this.#db.prepare(sql).all(...args); }
  #write(sql, ...args) { return this.#db.prepare(sql).run(...args); }
  #fence() {
    demand(!this.#closed && this.#one('SELECT nonce FROM owner WHERE singleton=1')?.nonce === this.#owner, 'OWNER_FENCE');
    for (const root of this.#allowedRoots) demand(realpathSync(root) === root, 'WORKSPACE_PATH_CHANGED');
    for (const path of this.#controlDirectories) { disjointControlPath(path, this.#allowedRoots); privateDirectory(path); }
    for (const path of this.#controlPaths) {
      disjointControlPath(path, this.#allowedRoots);
      if (path !== this.#root) { privateDirectory(dirname(path)); safeFile(path); }
    }
  }
  /** Trusted host: reserve control storage before issuing a descriptor, never a model operation. */
  protectControlPath(path) {
    const canonical = disjointControlPath(path, this.#allowedRoots);
    privateDirectory(dirname(canonical)); safeFile(canonical);
    this.#transaction(() => this.#write('INSERT OR IGNORE INTO control_paths VALUES (?)', canonical));
    this.#controlPaths.add(canonical); return canonical;
  }
  /** Failed startup has not dispatched effects; release only this unused process ownership. */
  disposeUnstarted() {
    demand(!this.#dispatching && !this.#one('SELECT id FROM effects WHERE owner=? LIMIT 1', this.#owner), 'OWNER_IN_USE');
    this.#closed = true; this.#db.close(); this.#release();
  }
  #transaction(action, fault = false) {
    demand(!this.#closed, 'CLOSED');
    this.#db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      this.#fence(); const value = action();
      if (fault) this.#fault('transaction.beforeCommit');
      this.#db.exec('COMMIT'); committed = true;
      if (fault) this.#fault('transaction.afterCommit');
      return value;
    } catch (error) { if (!committed) this.#db.exec('ROLLBACK'); throw error; }
  }
  #load(run) { const row = this.#one('SELECT data FROM runs WHERE id=?', run); return row ? decode(row.data) : null; }
  #save(run) {
    demand(run.revision < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED');
    const changed = this.#write('UPDATE runs SET revision=?,data=? WHERE id=? AND revision=?', run.revision + 1, canonicalJson({ ...run, revision: run.revision + 1 }), run.id, run.revision);
    demand(changed.changes === 1, 'STALE_REVISION'); run.revision += 1;
  }
  #cwd(path) {
    const real = realpathSync(path);
    demand(this.#allowedRoots.some(root => within(root, real)), 'CWD_FORBIDDEN');
    return real;
  }
  /** Bootstrap: trusted local operator must enumerate exact operations and scopes. Token returned once. */
  #principalInput(registration) {
    const input = clone(registration);
    fields(input, ['id', 'kind', 'scopes', 'operations']); id(input.id);
    demand(['operator', 'advisor', 'worker'].includes(input.kind), 'INVALID_PRINCIPAL');
    demand(Array.isArray(input.scopes) && input.scopes.length > 0 && input.scopes.length <= 64, 'INVALID_SCOPES');
    input.scopes.forEach(scope => { fields(scope, ['workstream', 'run', 'node']); Object.values(scope).forEach(id); demand(input.kind !== 'worker' || scope.node !== 'root', 'WORKER_SCOPE'); });
    demand(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.every(op => OPERATIONS.includes(op)), 'INVALID_OPERATIONS');
    demand(input.kind !== 'worker' || input.operations.every(op => WORKER_OPERATIONS.includes(op)), 'WORKER_OPERATION');
    return input;
  }
  registerPrincipal(registration) {
    const input = this.#principalInput(registration); const token = randomBytes(32).toString('hex');
    this.#transaction(() => {
      demand(!this.#one('SELECT id FROM principals WHERE id=?', input.id), 'PRINCIPAL_EXISTS');
      this.#write('INSERT INTO principals(id,token,data) VALUES (?,?,?)', input.id, hash(token), canonicalJson(input));
    });
    return token;
  }
  /** Exact all-or-nothing bootstrap identity; never rotate lost credentials or revive revocations. */
  bootstrapPrincipals(registrations, credentials, bootstrapPath = null, providerHomes = null) {
    const inputs = registrations.map(({ principal, credentialPath }) => ({ principal: this.#principalInput(principal), credentialPath: disjointControlPath(credentialPath, this.#allowedRoots) }));
    demand(new Set(inputs.map(v => v.principal.id)).size === inputs.length && new Set(inputs.map(v => v.credentialPath)).size === inputs.length, 'DUPLICATE_BOOTSTRAP_PRINCIPAL');
    const digest = hash(canonicalJson({ allowedRoots: this.#allowedRoots, inputs, bootstrapPath, providerHomes, controlDirectories: [...this.#controlDirectories].sort() }));
    return this.#transaction(() => {
      const prior = this.#one('SELECT digest FROM bootstrap WHERE singleton=1');
      if (prior) {
        demand(prior.digest === digest, 'BOOTSTRAP_MISMATCH');
        for (let i = 0; i < inputs.length; i++) {
          const row = this.#one('SELECT * FROM principals WHERE id=?', inputs[i].principal.id);
          demand(row && !row.revoked, 'BOOTSTRAP_PRINCIPAL_REVOKED');
          demand(row.data === canonicalJson(inputs[i].principal), 'BOOTSTRAP_MISMATCH');
          const credential = credentials[i]; demand(credential, 'BOOTSTRAP_CREDENTIAL_MISSING');
          demand(credential.socketPath === join(this.#root, 'runtime.sock') && row.token === hash(credential.token), 'BOOTSTRAP_CREDENTIAL_MISMATCH');
        }
        return null;
      }
      demand(this.#one('SELECT COUNT(*) AS n FROM principals').n === 0 && credentials.every(value => value === null), 'BOOTSTRAP_OWNERSHIP_CONFLICT');
      const tokens = inputs.map(() => randomBytes(32).toString('hex'));
      inputs.forEach((input, i) => {
        this.#write('INSERT INTO principals(id,token,data) VALUES (?,?,?)', input.principal.id, hash(tokens[i]), canonicalJson(input.principal));
        this.#write('INSERT OR IGNORE INTO control_paths VALUES (?)', input.credentialPath);
      });
      if (bootstrapPath) this.#write('INSERT OR IGNORE INTO control_paths VALUES (?)', disjointControlPath(bootstrapPath, this.#allowedRoots));
      this.#write('INSERT INTO bootstrap VALUES (1,?)', digest); return tokens;
    });
  }
  describe(token, audience = 'model') {
    demand(typeof token === 'string' && /^[0-9a-f]{64}$/.test(token), 'UNAUTHORIZED');
    const row = this.#one('SELECT * FROM principals WHERE token=?', hash(token));
    demand(row && !row.revoked, 'UNAUTHORIZED');
    const principal = decode(row.data); demand(audience !== 'model' || principal.kind !== 'operator', 'MODEL_OPERATOR_FORBIDDEN');
    return { operations: principal.operations, scopes: principal.scopes };
  }
  /** Bounded host-configured Pi scopes. No wildcard grants or client-selected enrollment. */
  async piDetachRequest(token, input, audience) {
    try {
      const c = clone(input);
      fields(c, ['v', 'op', 'sessionId', 'action', 'payload']);
      demand(c.v === 1 && c.op === 'pi.detach' && audience === 'model', 'BRIDGE_VERSION');
      text(c.sessionId, 256);
      const config = this.#piBridge;
      demand(config?.version === 1 && typeof config.prepare === 'function' && config.portVersion === 1, 'BRIDGE_UNAVAILABLE');
      this.describe(token, audience);
      demand(c.sessionId === config.sessionId, 'BRIDGE_SESSION_MISMATCH');
      const scopes = config.scopes;
      demand(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 32, 'BRIDGE_CONFIGURATION');
      // Every bridge operation rechecks both the exact root and child grants.
      for (const root of scopes) {
        const auth = this.#authorize(token, { op: 'progress', scope: root });
        demand(auth.id === config.principalId, 'PRINCIPAL_MISMATCH');
        this.#requireTargets(auth, root, ['worker']);
      }
      const principal = config.principalId;
      const p = c.payload;
      const call = (scope, op, payload, commandId, expectedRevision) => this.execute(token, { v: 1, op, scope, payload, ...(commandId ? { commandId, expectedRevision } : {}) }, audience);
      if (c.action === 'connect') {
        fields(p, ['identity', 'cwd']);
        demand(config.managedIdentity && canonicalJson(p.identity) === canonicalJson(config.managedIdentity) && realpathSync(p.cwd) === config.cwd, 'PI_DETACH_BINDING_MISMATCH');
        this.#fence();
        return { ok: true, value: { ready: true, revision: config.revision ?? null } };
      }
      const bindings = () => this.#all('SELECT data FROM pi_bindings WHERE principal=?', principal).map(row => decode(row.data));
      const owned = runId => {
        id(runId);
        const binding = bindings().find(row => row.action === 'launch' && row.runId === runId);
        demand(binding, 'BRIDGE_TARGET_FORBIDDEN');
        const run = this.#scopeRun({ scope: binding.scope });
        demand(run.nodes.worker, 'BRIDGE_RECOVERY_REQUIRED');
        return { binding, run, node: run.nodes.worker };
      };
      if (c.action === 'shutdown') { fields(p, []); this.#fence(); return { ok: true, value: { closed: true } }; }
      if (c.action === 'supervision') {
        fields(p, []); this.#fence();
        const rows = bindings().filter(row => row.action === 'launch');
        return { ok: true, value: { settled: rows.every(row => { const node = this.#load(row.runId)?.nodes.worker; return node?.snapshot.state === 'terminal' && node.runtimeState !== 'recovery-required' && !this.#pending(this.#load(row.runId), 'worker'); }), revision: config.revision ?? null } };
      }
      if (c.action === 'list') {
        fields(p, []);
        return { ok: true, value: bindings().filter(row => row.action === 'launch').map(row => {
          const node = this.#load(row.runId)?.nodes.worker;
          return { runId: row.runId, node: node ? { status: node.status, runtimeState: node.runtimeState, snapshot: { state: node.snapshot.state, cancel: node.snapshot.cancel }, packet: { cwd: node.packet.cwd, execution: { label: node.packet.execution.label.slice(0, 128) } } } : null };
        }) };
      }
      if (['get', 'output', 'wait', 'ack'].includes(c.action)) {
        fields(p, ['runId'], c.action === 'ack' ? ['deliveryId'] : c.action === 'wait' ? ['timeoutMs'] : []);
        const { binding, run, node } = owned(p.runId);
        if (c.action === 'get') return { ok: true, value: node };
        if (c.action === 'output' && node.snapshot.state === 'running' && node.runtimeState !== 'recovery-required') {
          const output = await config.readLive?.(run.id, node.handle);
          return { ok: true, value: { text: output ?? 'Worker acquisition pending; no captured output yet.' } };
        }
        if (c.action === 'output') return call({ ...binding.scope, node: 'worker' }, 'log.read', { path: 'output.log', offset: 0, maxBytes: 32768 });
        if (c.action === 'wait') { integer(p.timeoutMs ?? 1000, 0, 1000); return this.request(token, { v: 1, op: 'wait', scope: binding.scope, payload: { timeoutMs: p.timeoutMs ?? 1000, limit: 16 } }, audience); }
        integer(p.deliveryId, 1);
        if (this.#one('SELECT a.delivery FROM acks a JOIN deliveries d ON d.id=a.delivery WHERE a.principal=? AND a.delivery=? AND d.run=?', principal, p.deliveryId, run.id)) return { ok: true, value: { acknowledged: true } };
        return call(binding.scope, 'delivery.ack', { deliveryId: p.deliveryId }, `pi-ack-${hash(canonicalJson({ principal, run: run.id, delivery: p.deliveryId }))}`, run.revision);
      }
      if (c.action === 'result') {
        fields(p, ['toolCallId', 'seal']); text(p.toolCallId, 512); demand(typeof p.seal === 'boolean', 'BRIDGE_INVALID_INPUT');
        const key = `pi-${hash(canonicalJson({ session: c.sessionId, toolCallId: p.toolCallId }))}`;
        return this.#transaction(() => {
          const row = this.#one('SELECT * FROM pi_bindings WHERE id=?', key);
          demand(row?.principal === principal, 'BRIDGE_TARGET_FORBIDDEN');
          const binding = decode(row.data);
          const run = this.#scopeRun({ scope: binding.scope });
          if (binding.toolResult || !p.seal) return { ok: true, value: binding.toolResult ?? null };
          const node = run.nodes.worker; demand(node, 'BRIDGE_RECOVERY_REQUIRED');
          const status = node.runtimeState === 'recovery-required' ? 'recovery-required' : node.snapshot.cancel && node.snapshot.state !== 'terminal' ? 'cancel-pending' : node.status;
          const e = node.packet.execution;
          const reusable = Boolean(e.keepAlive && node.snapshot.state === 'terminal' && ['done', 'failed'].includes(node.status) && !node.snapshot.cancel && node.processExited === undefined && node.runtimeState !== 'recovery-required' && !this.#pending(run, 'worker'));
          binding.toolResult = { runId: run.id, agentName: run.id, promoted: node.snapshot.state === 'running', status, agentState: status, durationMs: 0, role: e.role, model: e.model, thinking: e.thinking, maxTurns: e.maxTurns, keepAlive: e.keepAlive, reusable };
          this.#write('UPDATE pi_bindings SET data=? WHERE id=?', canonicalJson(binding), key);
          return { ok: true, value: binding.toolResult };
        });
      }
      demand(c.action === 'call', 'BRIDGE_OPERATION');
      fields(p, ['toolCallId', 'tool', 'params', 'cwd']); text(p.toolCallId, 512); text(p.cwd, 4096);
      demand(['bg_agent', 'bg_stop'].includes(p.tool), 'BRIDGE_OPERATION');
      const key = `pi-${hash(canonicalJson({ session: c.sessionId, toolCallId: p.toolCallId }))}`;
      demand(realpathSync(p.cwd) === config.cwd, 'BRIDGE_CWD_FORBIDDEN');
      const digest = hash(canonicalJson(p));
      const previous = this.#one('SELECT * FROM pi_bindings WHERE id=?', key);
      if (previous) {
        demand(previous.principal === principal, 'PRINCIPAL_MISMATCH'); demand(previous.digest === digest, 'COMMAND_ID_REUSE');
        const binding = decode(previous.data);
        if (binding.action === 'rejected') return clone(binding.response);
        this.#scopeRun({ scope: binding.scope });
        if (binding.response) return clone(binding.response);
        demand(binding.command, 'BRIDGE_RECOVERY_REQUIRED');
        return this.execute(token, binding.command, audience);
      }
      demand(this.#one('SELECT COUNT(*) AS n FROM pi_bindings').n < 100000, 'BRIDGE_BINDING_LIMIT');
      if (p.tool === 'bg_stop' || p.params?.name !== undefined) {
        if (p.tool === 'bg_stop') fields(p.params, ['runId']);
        else fields(p.params, ['name', 'prompt'], ['keepAlive', 'promoteAfterMs']);
        const { binding, node } = owned(p.tool === 'bg_stop' ? p.params.runId : p.params.name);
        const op = p.tool === 'bg_stop' ? 'node.cancel' : node.snapshot.state === 'terminal' ? 'node.task' : 'node.reply';
        if (op === 'node.cancel') demand(node.snapshot.state !== 'terminal', 'BRIDGE_ALREADY_SETTLED');
        if (op !== 'node.cancel') {
          demand(node.snapshot.state === 'blocked' || node.snapshot.state === 'terminal' && node.packet.execution.keepAlive && ['done', 'failed'].includes(node.status), 'BRIDGE_RESUME_OR_STEER_UNSUPPORTED');
          demand(!['credential', 'secret'].includes(node.requestDetail?.kind), 'CREDENTIAL_REPLY_FORBIDDEN');
          text(p.params.prompt);
          demand(p.params.keepAlive === undefined || p.params.keepAlive === node.packet.execution.keepAlive, 'BRIDGE_REPLY_INTENT_CHANGE_UNSUPPORTED');
          demand(p.params.promoteAfterMs === undefined || typeof p.params.promoteAfterMs === 'number' && Number.isFinite(p.params.promoteAfterMs), 'BRIDGE_INVALID_INPUT');
        }
        const command = { v: 1, op, scope: { ...binding.scope, node: 'worker' }, commandId: key, expectedRevision: node.revision,
          payload: op === 'node.cancel' ? { attempt: node.snapshot.attempt, reason: 'bg_stop requested Escape; process exit is unconfirmed' } : op === 'node.task' ? { attempt: node.snapshot.attempt, handleId: node.handle.id, generation: node.executionObservation?.generation, text: p.params.prompt } : { attempt: node.snapshot.attempt, requestId: node.snapshot.request.id, text: p.params.prompt } };
        // Persist the exact CAS/request binding before admission, including failures.
        this.#transaction(() => this.#write('INSERT INTO pi_bindings VALUES (?,?,?,?)', key, principal, digest, canonicalJson({ action: op, scope: binding.scope, command })));
        const result = this.execute(token, command, audience);
        const response = result.ok ? { ok: true, value: { runId: binding.runId, status: op === 'node.cancel' ? 'cancel-pending' : 'admitted', receipt: result.receipt } } : result;
        this.#transaction(() => this.#write('UPDATE pi_bindings SET data=? WHERE id=?', canonicalJson({ action: op, scope: binding.scope, command, response }), key));
        return response;
      }
      demand(p.params && typeof p.params === 'object', 'BRIDGE_INVALID_INPUT');
      const cwd = this.#cwd(p.params.cwd ? resolve(p.cwd, p.params.cwd) : p.cwd);
      demand(config.dynamic ? config.allowedRoots.includes(cwd) : cwd === config.cwd, 'BRIDGE_CWD_FORBIDDEN');
      const used = new Set(bindings().filter(row => row.action === 'launch').map(row => row.runId));
      demand(!config.dynamic || used.size < config.maxLaunches, 'BRIDGE_LAUNCH_LIMIT');
      const scope = config.dynamic ? { ...scopes[0], run: `pib-${randomUUID()}` } : scopes.find(scope => !used.has(scope.run)); demand(scope, 'BRIDGE_POOL_EXHAUSTED');
      const sourceDirectory = join(this.#nodeDirectory(scope.run, 'worker'), 'source');
      // Reserve one exact scope before asynchronous role resolution.
      // A crash here is a durable incomplete binding, never a blind launch.
      this.#transaction(() => {
        demand(this.#one('SELECT COUNT(*) AS n FROM pi_bindings').n < 100000, 'BRIDGE_BINDING_LIMIT');
        if (config.dynamic) {
          const { ownerEpoch, ...grant } = scope;
          for (const node of ['root', 'worker']) this.#write('INSERT INTO scope_grants VALUES (?,?)', principal, canonicalJson({ ...grant, node }));
        }
        this.#write('INSERT INTO pi_bindings VALUES (?,?,?,?)', key, principal, digest, canonicalJson({ action: 'launch', runId: scope.run, scope }));
      });
      let execution;
      try { execution = await config.prepare(p.params, sourceDirectory); }
      catch {
        const response = { ok: false, error: 'BRIDGE_PREPARATION_REJECTED' };
        this.#transaction(() => this.#write('UPDATE pi_bindings SET data=? WHERE id=?', canonicalJson({ action: 'rejected', scope, response }), key));
        return response;
      }
      const packet = { role: execution.role, task: execution.prompt, acceptance: [...(p.params.acceptance ?? []), ...(p.params.anchor ? [p.params.anchor] : [])], riskTier: 'high', cwd, adapter: 'pi-detach', model: execution.model, thinking: execution.thinking, execution };
      if (!packet.acceptance.length) packet.acceptance.push('Return the requested bounded result with direct evidence.');
      try { validatePacket(packet); } catch {
        const response = { ok: false, error: 'BRIDGE_INTENT_REJECTED' };
        this.#transaction(() => this.#write('UPDATE pi_bindings SET data=? WHERE id=?', canonicalJson({ action: 'rejected', scope, response }), key));
        return response;
      }
      this.#transaction(() => {
        this.#write('UPDATE pi_bindings SET data=? WHERE id=? AND principal=? AND digest=?', canonicalJson({ action: 'launch', runId: scope.run, scope, packet }), key, principal, digest);
      });
      let result = call(scope, 'workstream.create', { cwd, host: 'pi' }, `${key}-create`, 0);
      if (result.ok) result = call(scope, 'packet.admit', { node: 'worker', packet }, `${key}-packet`, 1);
      if (result.ok) result = call(scope, 'node.launch', { node: 'worker' }, `${key}-launch`, 2);
      const response = result.ok ? { ok: true, value: { runId: scope.run, status: 'admitted', receipt: result.receipt } } : result;
      this.#transaction(() => this.#write('UPDATE pi_bindings SET data=? WHERE id=?', canonicalJson({ action: 'launch', runId: scope.run, scope, packet, response }), key));
      return response;
    } catch (error) { return rejection(error); }
  }
  /** Host-only attestation after inspecting deterministic evidence, never a model tool. */
  verifyNode({ scope, expectedRevision, resultSha256, evidenceSha256 }) {
    demand(/^[a-f0-9]{64}$/.test(resultSha256) && /^[a-f0-9]{64}$/.test(evidenceSha256), 'INVALID_VERIFICATION');
    this.#transaction(() => {
      const run = this.#scopeRun({ scope }); const node = run.nodes[scope.node];
      demand(node?.status === 'done' && node.revision === expectedRevision, 'VERIFICATION_NOT_READY');
      const result = boundedRead(this.#nodeDirectory(run.id, scope.node), 'result.md');
      demand(result.eof && hash(result.text) === resultSha256, 'RESULT_CHANGED');
      node.verified = true; node.verification = { resultSha256, evidenceSha256 };
      node.snapshot.revision += 1; node.revision = node.snapshot.revision; this.#save(run);
    });
  }
  revokePrincipal(principalId) { id(principalId); this.#transaction(() => this.#write('UPDATE principals SET revoked=1 WHERE id=?', principalId)); this.#notifications.emit('change'); }
  #authorize(token, command) {
    demand(typeof token === 'string' && /^[0-9a-f]{64}$/.test(token), 'UNAUTHORIZED');
    const row = this.#one('SELECT * FROM principals WHERE token=?', hash(token));
    demand(row && !row.revoked, 'UNAUTHORIZED');
    const principal = decode(row.data);
    principal.scopes.push(...this.#all('SELECT data FROM scope_grants WHERE principal=?', principal.id).map(row => decode(row.data)));
    demand(principal.scopes.some(grant => scopeMatches(grant, command.scope)), 'SCOPE_FORBIDDEN');
    demand(principal.operations.includes(command.op), 'OPERATION_FORBIDDEN');
    return principal;
  }
  #requireTargets(principal, scope, names) {
    for (const node of new Set(names)) demand(principal.scopes.some(grant => scopeMatches(grant, { ...scope, node })), 'TARGET_SCOPE_FORBIDDEN');
  }
  #commandTargets(principal, c, run) {
    let names = [];
    if (['packet.admit', 'node.launch'].includes(c.op)) names = [c.payload.node];
    if (c.op === 'graph.admit') names = [...c.payload.waves.flat(), ...Object.keys(c.payload.dependencies), ...Object.values(c.payload.dependencies).flat()];
    if (c.op === 'wave.launch' && run?.graph) names = run.graph.waves.flat();
    this.#requireTargets(principal, c.scope, names);
  }
  #scopeRun(command, allowMissing = false) {
    const run = this.#load(command.scope.run);
    if (!run && allowMissing) { demand(command.scope.ownerEpoch === 1, 'OWNER_EPOCH_MISMATCH'); return null; }
    demand(run && run.workstream === command.scope.workstream, 'RUN_FORBIDDEN');
    demand(run.epoch === command.scope.ownerEpoch, 'OWNER_EPOCH_MISMATCH');
    return run;
  }
  #nodeDirectory(run, node) { return join(this.#root, 'runs', run, node); }
  #event(run, node, type, data) {
    const prior = this.#one('SELECT seq,data FROM events WHERE run=? ORDER BY seq DESC LIMIT 1', run.id);
    const at = new Date(Math.max(Date.now(), prior ? Date.parse(decode(prior.data).at) : 0)).toISOString();
    const event = { v: 1, seq: (prior?.seq ?? 0) + 1, at, run: run.id, node, parent: node ? 'root' : null, host: run.host, type, data };
    demand(event.seq <= 10000 && this.#one('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM events WHERE run=?', run.id).bytes + Buffer.byteLength(canonicalJson(event)) <= 16 * 1024 * 1024, 'EVENT_LIMIT');
    this.#write('INSERT INTO events VALUES (?,?,?)', run.id, event.seq, canonicalJson(event)); return event.seq;
  }
  #delivery(run, node, data) {
    const encoded = canonicalJson(data, 65536);
    demand(this.#one('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM deliveries WHERE run=?', run.id).bytes + Buffer.byteLength(encoded) <= 16 * 1024 * 1024, 'DELIVERY_LIMIT');
    this.#write('INSERT INTO deliveries(run,node,data) VALUES (?,?,?)', run.id, node, encoded);
  }
  #effect(run, node, op, payload, commandId, extra = {}) {
    const attempt = node === 'root' ? run.root.attempt : run.nodes[node].snapshot.attempt;
    const effect = { id: `effect-${hash(canonicalJson({ commandId, node }))}`, commandId, scope: { workstream: run.workstream, run: run.id, node, ownerEpoch: run.epoch }, op, payload, attempt, ...extra };
    this.#write('INSERT INTO effects(id,run,node,state,data) VALUES (?,?,?,?,?)', effect.id, run.id, node, 'pending', canonicalJson(effect));
    return effect.id;
  }
  #pending(run, node) { return Boolean(this.#one("SELECT id FROM effects WHERE run=? AND node=? AND state IN ('pending','claimed','recovery-required')", run.id, node)); }
  #adapter(kind, key, method) {
    const adapter = this.#adapters[kind]?.[key];
    demand(adapter && adapter.capabilities?.[method] === true && typeof adapter.execute === 'function', 'UNSUPPORTED_CAPABILITY');
    return adapter;
  }
  execute(token, input, audience = 'operator') {
    try {
      const parsed = parseEnvelope(input);
      const response = this.#transaction(() => {
        const { command: c, mutation, digest } = parsed;
        const principal = this.#authorize(token, c);
        demand(['operator', 'model'].includes(audience), 'INVALID_AUDIENCE');
        demand(audience !== 'model' || principal.kind !== 'operator', 'MODEL_OPERATOR_FORBIDDEN');
        const prior = mutation ? this.#one('SELECT * FROM receipts WHERE id=?', c.commandId) : null;
        if (prior) {
          demand(prior.principal === principal.id, 'PRINCIPAL_MISMATCH'); demand(prior.digest === digest, 'COMMAND_ID_REUSE');
          const replayRun = this.#scopeRun(c); this.#commandTargets(principal, c, replayRun);
          return { ok: true, receipt: decode(prior.data), replayed: true };
        }
        let run = this.#scopeRun(c, c.op === 'workstream.create');
        this.#commandTargets(principal, c, run);
        if (!mutation) return { ok: true, value: this.#read(principal, run, c) };
        demand(this.#one('SELECT COUNT(*) AS count FROM receipts').count < 100000, 'RECEIPT_LIMIT');
        const nodeOp = c.op.startsWith('node.') && c.op !== 'node.launch';
        demand(nodeOp ? c.scope.node !== 'root' : ['delivery.ack'].includes(c.op) || c.scope.node === 'root', 'ROOT_SCOPE');
        const target = nodeOp || (c.op === 'delivery.ack' && c.scope.node !== 'root') ? run?.nodes[c.scope.node] : run;
        demand((target?.revision ?? 0) === c.expectedRevision, 'STALE_REVISION');
        let receipt;
        if (c.op === 'workstream.create') {
          demand(!run, 'RUN_EXISTS');
          withRunOwnership(this.#root, c.scope.run, 'runtime', 'runtime', () => {});
          privateDirectory(join(this.#root, 'runs', c.scope.run));
          privateDirectory(this.#nodeDirectory(c.scope.run, 'root'));
          run = { id: c.scope.run, workstream: c.scope.workstream, epoch: 1, revision: 0, cwd: this.#cwd(c.payload.cwd), host: c.payload.host, nodes: {}, packets: {}, graph: null, wave: 0, completedWave: 0, root: null };
          this.#write('INSERT INTO runs VALUES (?,?,?)', run.id, 0, canonicalJson(run));
          this.#event(run, null, 'run.created', { workstream: run.workstream, root: { node: 'root', session: `runtime-${run.id}` } });
        } else if (nodeOp) {
          receipt = this.#nodeCommand(run, c, principal);
        } else { this.#mutation(run, c, principal); }
        if (['root.create', 'root.message', 'root.reply', 'node.reply'].includes(c.op)) {
          this.#delivery(run, c.scope.node, { kind: 'user.message', source: principal.kind === 'operator' ? 'user' : 'advisor', op: c.op, commandId: c.commandId, text: c.payload.text, ...(c.payload.requestId ? { requestId: c.payload.requestId } : {}) });
        }
        this.#save(run);
        receipt ??= { commandId: c.commandId, outcome: 'accepted', revision: c.scope.node === 'root' ? run.revision : run.nodes[c.scope.node].revision };
        this.#write('INSERT INTO receipts VALUES (?,?,?,?)', c.commandId, principal.id, digest, canonicalJson(receipt));
        return { ok: true, receipt, replayed: false };
      }, parsed.mutation);
      if (parsed.mutation && response.ok) this.#tryExport(parsed.command.scope.run);
      this.#notifications.emit('change'); return response;
    } catch (error) { return rejection(error); }
  }
  #nodeCommand(run, c, principal) {
    demand(c.op !== 'node.resume', 'RESUME_UNSUPPORTED');
    const node = run.nodes[c.scope.node]; demand(node?.launched, 'NODE_NOT_LAUNCHED');
    if (['node.reply', 'node.task'].includes(c.op)) demand(!['credential', 'secret'].includes(node.requestDetail?.kind), 'CREDENTIAL_REPLY_FORBIDDEN');
    demand(node.runtimeState !== 'recovery-required', 'RECOVERY_REQUIRED');
    if (c.op === 'node.task') {
      demand(node.packet.adapter === 'pi-detach' && node.packet.execution.keepAlive && node.snapshot.state === 'terminal' && ['done', 'failed'].includes(node.status) && !node.snapshot.cancel && node.processExited === undefined, 'TASK_TARGET_UNAVAILABLE');
      demand(node.snapshot.attempt === c.payload.attempt, 'ATTEMPT_MISMATCH');
      demand(node.handle?.id === c.payload.handleId && node.executionObservation?.generation === c.payload.generation, 'BRIDGE_HANDLE_MISMATCH');
      demand(!this.#pending(run, c.scope.node), 'TASK_PENDING');
      this.#assertWriterAvailable(node.packet.role, this.#cwd(node.packet.cwd), c.scope);
      this.#adapter('workers', node.packet.adapter, c.op);
      demand(node.snapshot.attempt < Number.MAX_SAFE_INTEGER && node.revision < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED');
      node.snapshot.attempt += 1; node.snapshot.revision += 1; node.revision = node.snapshot.revision;
      node.snapshot.state = 'running'; node.snapshot.request = null; node.snapshot.blockedSequence = null; node.requestDetail = null;
      node.status = 'running'; node.verified = false; delete node.verification;
      this.#effect(run, c.scope.node, c.op, c.payload, c.commandId, { executionObservation: node.executionObservation });
      this.#event(run, c.scope.node, 'node.resumed', { reason: 'follow-up' });
      return { commandId: c.commandId, outcome: 'accepted', revision: node.revision };
    }
    const decision = admitCommand({ command: c, principal: { id: principal.id, scopes: principal.scopes }, snapshot: node.snapshot, receipts: new Map() });
    demand(decision.commit, decision.receipt.reason ?? 'ADMISSION_REJECTED');
    const next = clone(decision.commit.nextSnapshot);
    node.snapshot = next; node.revision = next.revision;
    for (const intent of decision.intents) {
      const adapter = this.#adapter('workers', node.packet.adapter, c.op); void adapter;
      this.#effect(run, c.scope.node, intent.op, intent.payload, c.commandId, { nextAttempt: intent.nextAttempt ?? null, blockedSequence: intent.blockedSequence ?? null, intentId: intent.id, ...(node.packet.adapter === 'pi-detach' && c.op === 'node.reply' ? { executionObservation: node.executionObservation ?? null } : {}) });
      if (c.op === 'node.reply') {
        this.#event(run, c.scope.node, 'node.reply.sent', { text: c.payload.text, source: principal.kind === 'operator' ? 'user' : 'advisor', replyTo: intent.blockedSequence });
        this.#event(run, c.scope.node, 'node.resumed', { reason: 'reply' });
        node.status = 'running';
      } else this.#event(run, c.scope.node, 'node.cancel.requested', { reason: c.payload.reason });
    }
    return decision.receipt;
  }
  #assertWriterAvailable(role, cwd, exclude = null) {
    if (['builder', 'foreman'].includes(role)) {
      for (const row of this.#all('SELECT data FROM runs')) {
        for (const node of Object.values(decode(row.data).nodes)) {
          if (node.snapshot.scope.run === exclude?.run && node.snapshot.scope.node === exclude?.node) continue;
          demand(!(['builder', 'foreman'].includes(node.packet.role) && (within(cwd, node.packet.cwd) || within(node.packet.cwd, cwd)) && (node.snapshot.state !== 'terminal' || ((node.handle?.pid || node.handle?.requiresExit) && node.processExited === undefined))), 'WRITER_CONCURRENCY');
        }
      }
    }
  }
  #launch(run, name, c) {
    const packet = run.packets[name]; demand(packet && !run.nodes[name], 'NODE_ALREADY_RESERVED_OR_MISSING');
    const cwd = this.#cwd(packet.cwd);
    this.#assertWriterAvailable(packet.role, cwd);
    const adapter = this.#adapter('workers', packet.adapter, 'node.launch');
    privateDirectory(this.#nodeDirectory(run.id, name));
    run.nodes[name] = { revision: 0, packet, launched: false, runtimeState: 'pending', status: 'running', verified: false, handle: null,
      snapshot: { scope: { ...c.scope, node: name }, revision: 0, state: 'running', attempt: 1, blockedSequence: null, request: null, cancel: null,
        capabilities: { 'node.reply': adapter.capabilities['node.reply'] === true, 'node.cancel': adapter.capabilities['node.cancel'] === true } } };
    this.#effect(run, name, 'node.launch', { packet, resultPath: join(this.#nodeDirectory(run.id, name), 'result.md') }, c.commandId);
  }
  #mutation(run, c, principal) {
    const p = c.payload;
    switch (c.op) {
      case 'packet.admit': {
        demand(!run.graph && !run.packets[p.node], 'PACKET_FROZEN');
        demand(Object.keys(run.packets).length < 24, 'GRAPH_TOO_LARGE');
        const packet = { ...p.packet, cwd: this.#cwd(p.packet.cwd) };
        if (packet.adapter === 'pi-detach') demand(this.#all('SELECT data FROM pi_bindings').some(row => { const binding = decode(row.data); return binding.action === 'launch' && binding.runId === run.id && canonicalJson(binding.packet) === canonicalJson(packet); }), 'BRIDGE_TRUSTED_INTENT_REQUIRED');
        this.#adapter('workers', packet.adapter, 'node.launch');
        run.packets[p.node] = packet; break;
      }
      case 'graph.admit': {
        demand(!run.graph && Object.keys(run.nodes).length === 0, 'GRAPH_FROZEN');
        const nodes = p.waves.flat();
        demand(nodes.length === Object.keys(run.packets).length && nodes.every(node => run.packets[node]), 'PACKET_MISMATCH');
        for (const wave of p.waves) demand(wave.filter(node => ['builder', 'foreman'].includes(run.packets[node].role)).length <= 1, 'WRITER_CONCURRENCY');
        run.graph = p;
        this.#event(run, null, 'graph.planned', { graph: p.graph, waves: p.waves, maxParallel: p.maxParallel, maxRepairLoops: p.maxRepairLoops }); break;
      }
      case 'wave.launch': {
        demand(run.graph && p.wave === run.wave + 1 && run.completedWave === run.wave, 'WAVE_NOT_READY');
        const wave = run.graph.waves[p.wave - 1]; demand(wave, 'INVALID_WAVE');
        for (const name of wave) {
          demand(run.graph.dependencies[name].every(dep => run.nodes[dep]?.status === 'done' && run.nodes[dep]?.verified === true), 'UPSTREAM_NOT_VERIFIED');
          for (const dep of run.graph.dependencies[name]) {
            const verification = run.nodes[dep].verification;
            if (verification) { const result = boundedRead(this.#nodeDirectory(run.id, dep), 'result.md'); demand(result.eof && hash(result.text) === verification.resultSha256, 'VERIFIED_RESULT_CHANGED'); }
          }
          this.#adapter('workers', run.packets[name].adapter, 'node.launch');
          this.#cwd(run.packets[name].cwd);
        }
        this.#event(run, null, 'wave.started', { wave: p.wave, nodes: wave }); run.wave = p.wave;
        for (const name of wave) this.#launch(run, name, c);
        break;
      }
      case 'node.launch':
        demand(!run.graph, 'DIRECT_GRAPH_CONFLICT'); this.#launch(run, p.node, c); break;
      case 'root.stop':
        demand(run.root?.state === 'idle' && run.root.processExited === undefined && !this.#pending(run, 'root'), 'ROOT_NOT_IDLE');
        this.#adapter('roots', run.root.adapter, c.op); this.#effect(run, 'root', c.op, {}, c.commandId); break;
      case 'root.create':
        demand(!run.root, 'ROOT_EXISTS'); this.#adapter('roots', p.adapter, c.op);
        run.root = { adapter: p.adapter, handle: null, state: 'pending', request: null, attempt: 1 };
        this.#effect(run, 'root', c.op, { ...p, cwd: run.cwd }, c.commandId); break;
      case 'root.message': case 'root.reply': case 'root.cancel': {
        demand(run.root?.handle && run.root.state !== 'recovery-required', 'ROOT_NOT_READY');
        demand(run.root.processExited === undefined, 'ROOT_EXITED');
        this.#adapter('roots', run.root.adapter, c.op);
        demand(!this.#pending(run, 'root'), 'ROOT_BUSY');
        if (c.op === 'root.message') { demand(run.root.state === 'idle', 'ROOT_BUSY'); demand(run.root.attempt < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED'); run.root.attempt += 1; }
        if (c.op === 'root.reply') {
          demand(!['credential', 'secret'].includes(run.root.request?.kind), 'CREDENTIAL_REPLY_FORBIDDEN');
          demand(run.root.state === 'blocked' && run.root.request?.id === p.requestId, 'REQUEST_MISMATCH');
        }
        if (c.op === 'root.cancel') demand(['running', 'blocked'].includes(run.root.state), 'ROOT_NOT_RUNNING');
        run.root.state = c.op === 'root.cancel' ? 'cancel-pending' : 'running'; run.root.request = null;
        this.#effect(run, 'root', c.op, p, c.commandId); break;
      }
      case 'root.resume': throw new RuntimeError('RESUME_UNSUPPORTED');
      case 'delivery.ack': {
        const delivery = this.#one('SELECT * FROM deliveries WHERE id=?', p.deliveryId);
        demand(delivery && delivery.run === run.id && (c.scope.node === 'root' || delivery.node === c.scope.node), 'DELIVERY_FORBIDDEN');
        this.#requireTargets(principal, c.scope, [delivery.node]);
        this.#fault('ack.before');
        this.#write('INSERT OR IGNORE INTO acks VALUES (?,?)', principal.id, p.deliveryId);
        if (c.scope.node !== 'root') {
          const node = run.nodes[c.scope.node];
          demand(node && node.revision < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED');
          node.snapshot.revision += 1; node.revision = node.snapshot.revision;
        }
        this.#fault('ack.afterWrite'); break;
      }
      default: throw new RuntimeError('UNSUPPORTED_OPERATION');
    }
  }
  #read(principal, run, c) {
    if (c.scope.node === 'root' && ['progress', 'workstream.open', 'history', 'wait'].includes(c.op)) this.#requireTargets(principal, c.scope, [...Object.keys(run.packets), ...Object.keys(run.nodes)]);
    if (c.op === 'artifact.read' || c.op === 'log.read') {
      demand(c.scope.node !== 'root' || run.root, 'NODE_NOT_FOUND');
      demand(c.scope.node === 'root' || run.nodes[c.scope.node], 'NODE_NOT_FOUND');
      return boundedRead(this.#nodeDirectory(run.id, c.scope.node), c.payload.path, c.payload.maxBytes, c.payload.offset);
    }
    if (c.op === 'history') {
      demand(c.scope.node === 'root' || run.nodes[c.scope.node], 'NODE_NOT_FOUND');
      const rows = this.#all(`SELECT d.*, a.delivery AS acked FROM deliveries d LEFT JOIN acks a ON a.delivery=d.id AND a.principal=? WHERE d.run=? AND d.id>? AND (?='root' OR d.node=?) ORDER BY d.id LIMIT ?`, principal.id, run.id, c.payload.cursor, c.scope.node, c.scope.node, c.payload.limit + 1);
      const entries = []; let bytes = 128;
      for (const row of rows) {
        const entry = { id: row.id, node: row.node, ...decode(row.data), acked: row.acked !== null };
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (entries.length === c.payload.limit || bytes + size > c.payload.maxBytes) break;
        entries.push(entry); bytes += size;
      }
      return { entries, nextCursor: entries.at(-1)?.id ?? c.payload.cursor, hasMore: rows.length > entries.length };
    }
    if (c.op === 'wait') {
      const rows = this.#all(`SELECT d.* FROM deliveries d LEFT JOIN acks a ON a.delivery=d.id AND a.principal=? WHERE d.run=? AND a.delivery IS NULL AND (?='root' OR d.node=?) ORDER BY d.id LIMIT ?`, principal.id, run.id, c.scope.node, c.scope.node, c.payload.limit);
      return rows.map(row => ({ id: row.id, node: row.node, ...decode(row.data) }));
    }
    if (c.scope.node !== 'root') {
      const node = run.nodes[c.scope.node]; demand(node, 'NODE_NOT_FOUND'); return clone(node);
    }
    const committedSequence = this.#one('SELECT MAX(seq) AS seq FROM events WHERE run=?', run.id)?.seq ?? 0;
    const exportedSequence = this.#one('SELECT seq FROM exports WHERE run=?', run.id)?.seq ?? 0;
    return { ...clone(run), export: { committedSequence, exportedSequence, pending: committedSequence !== exportedSequence } };
  }
  async request(token, input, audience = 'operator') {
    const result = this.execute(token, input, audience);
    if (!result.ok || input.op !== 'wait' || result.value.length || input.payload.timeoutMs === 0) return result;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.#notifications.off('change', finish); resolve(); };
      const timer = setTimeout(finish, input.payload.timeoutMs);
      this.#notifications.once('change', finish);
    });
    // Always reauthenticate, including revocation while blocked in wait.
    return this.execute(token, input, audience);
  }
  #recover() {
    this.#transaction(() => {
      const effects = this.#all("SELECT * FROM effects WHERE state IN ('claimed','done')");
      const marked = new Set();
      for (const effect of effects) {
        const run = this.#load(effect.run);
        const active = effect.node === 'root' ? Boolean(run.root?.handle && run.root.processExited === undefined) || run.root?.state !== 'idle' : run.nodes[effect.node]?.snapshot.state !== 'terminal';
        const key = `${effect.run}/${effect.node}`;
        if (effect.state === 'claimed' || (active && !marked.has(key))) { this.#markRecovery(effect, 'owner-restarted'); marked.add(key); }
      }
    });
  }
  #markRecovery(effect, reason) {
    this.#write("UPDATE effects SET state='recovery-required' WHERE id=?", effect.id);
    const run = this.#load(effect.run);
    if (effect.node === 'root') run.root.state = 'recovery-required';
    else run.nodes[effect.node].runtimeState = 'recovery-required';
    this.#delivery(run, effect.node, { kind: 'recovery-required', effectId: effect.id, recordedHandle: Boolean(effect.handle), reason }); this.#save(run);
  }
  /** Explicitly pump committed work. No strategy or dependent-wave auto-launch. */
  dispatch() {
    if (this.#dispatching) return this.#dispatching;
    this.#dispatching = this.#drain().finally(() => { this.#dispatching = null; this.#notifications.emit('change'); });
    return this.#dispatching;
  }
  async #drain() {
    while (!this.#closed) {
      const row = this.#transaction(() => {
        for (const candidate of this.#all("SELECT * FROM effects WHERE state='pending' ORDER BY seq")) {
          const run = this.#load(candidate.run);
          const target = candidate.node === 'root' ? run.root : run.nodes[candidate.node];
          if (target.state === 'recovery-required' || target.runtimeState === 'recovery-required') continue;
          this.#fault('claim.before');
          const changed = this.#write("UPDATE effects SET state='claimed',owner=? WHERE id=? AND state='pending'", this.#owner, candidate.id);
          demand(changed.changes === 1, 'CLAIM_CONFLICT'); return candidate;
        }
        return null;
      });
      if (!row) return;
      try {
        this.#fault('claim.after');
        const run = this.#load(row.run); const effect = decode(row.data);
        const root = row.node === 'root'; const target = root ? run.root : run.nodes[row.node];
        const adapter = this.#adapter(root ? 'roots' : 'workers', root ? target.adapter : target.packet.adapter, effect.op);
        const context = { cwd: this.#cwd(root ? run.cwd : target.packet.cwd), artifactDirectory: this.#nodeDirectory(run.id, row.node), resultPath: join(this.#nodeDirectory(run.id, row.node), 'result.md'), nestedDelegation: false, scope: effect.scope, attempt: effect.attempt,
          controlPaths: [...this.#controlPaths, ...this.#controlDirectories] };
        context.assertActive = () => {
          this.#fence(); const current = this.#one("SELECT * FROM effects WHERE id=?", row.id);
          demand(current && ["claimed", "done"].includes(current.state) && current.owner === this.#owner, "OWNER_FENCE");
        };
        context.recoveryRequired = () => {
          this.#transaction(() => { const current = this.#one('SELECT * FROM effects WHERE id=?', row.id); if (['claimed', 'done'].includes(current.state)) this.#markRecovery(current, 'adapter-protocol-or-bound'); });
          this.#notifications.emit('change');
        };
        let timer;
        let output;
        try {
          output = await Promise.race([
            Promise.resolve().then(() => adapter.execute({ effect: clone(effect), handle: clone(target.handle), context,
              recordHandle: handle => this.#recordHandle(row.id, handle), emit: event => this.ingest(row.id, event) })),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new RuntimeError('ADAPTER_TIMEOUT')), LIMITS.waitMs); }),
          ]);
        } finally { clearTimeout(timer); }
        fields(output, ['accepted']); demand(output.accepted === true, 'ADAPTER_REJECTED');
        this.#transaction(() => {
          const current = this.#one('SELECT * FROM effects WHERE id=?', row.id);
          demand(current.state === 'claimed' && current.owner === this.#owner, 'OWNER_FENCE');
          if (effect.op === 'node.launch' || effect.op === 'root.create') demand(current.handle, 'HANDLE_REQUIRED');
          this.#write("UPDATE effects SET state='done' WHERE id=?", row.id);
        });
        this.#fault('effect.afterDone');
      } catch {
        this.#transaction(() => {
          const current = this.#one('SELECT * FROM effects WHERE id=?', row.id);
          if (current.state === 'claimed') this.#markRecovery(current, 'effect-unproven');
        });
      }
    }
  }
  #recordHandle(effectId, handleInput) {
    const handle = clone(handleInput); fields(handle, ['id'], ['session', 'pid', 'requiresExit']); text(handle.id, 1024);
    if (handle.session !== undefined) text(handle.session, 1024);
    if (handle.pid !== undefined) integer(handle.pid, 1);
    if (handle.requiresExit !== undefined) demand(handle.requiresExit === true, 'INVALID_EXIT_CONTRACT');
    this.#fault('handle.before');
    this.#transaction(() => {
      const effect = this.#one('SELECT * FROM effects WHERE id=?', effectId);
      demand(effect?.state === 'claimed' && effect.owner === this.#owner, 'OWNER_FENCE');
      if (effect.handle) { demand(effect.handle === canonicalJson(handle), 'HANDLE_CONFLICT'); return; }
      const run = this.#load(effect.run); const root = effect.node === 'root'; const target = root ? run.root : run.nodes[effect.node];
      // Non-create effects retain their owned session; no client-selected attachment.
      demand(!target.handle || canonicalJson(target.handle) === canonicalJson(handle), 'HANDLE_CONFLICT');
      target.handle = handle;
      if (root) target.state = 'running';
      else if (!target.launched) {
        target.launched = true; target.runtimeState = 'running';
        const p = target.packet;
        this.#event(run, effect.node, 'node.launched', { role: p.role, label: effect.node, harness: run.host, model: p.model, thinking: p.thinking, cwd: p.cwd, riskTier: p.riskTier, acceptance: p.acceptance, resultPath: join(this.#nodeDirectory(run.id, effect.node), 'result.md'), launchRef: { id: handle.id } });
      }
      this.#write('UPDATE effects SET handle=? WHERE id=?', canonicalJson(handle), effectId); this.#save(run);
    });
    this.#fault('handle.after');
    this.#tryExport(this.#one('SELECT run FROM effects WHERE id=?', effectId).run);
  }
  /** Adapter-only, deduplicated, bounded semantic events; never a command endpoint. */
  ingest(effectId, eventInput) {
    const event = decode(canonicalJson(eventInput, 32768));
    // Canonical vocabulary remains credential; secret-class adapters use the same out-of-band path.
    if (event.kind === 'blocked' && event.data?.kind === 'secret') event.data.kind = 'credential';
    fields(event, ['id', 'kind', 'attempt', 'data']); id(event.id); integer(event.attempt, 1);
    const digest = hash(canonicalJson({ effectId, event }));
    const result = this.#transaction(() => {
      const effect = this.#one('SELECT * FROM effects WHERE id=?', effectId);
      demand(effect && ['claimed', 'done'].includes(effect.state) && effect.owner === this.#owner, 'OWNER_FENCE');
      const prior = this.#one('SELECT digest FROM ingested WHERE id=?', event.id);
      if (prior) { demand(prior.digest === digest, 'EVENT_ID_REUSE'); return { replayed: true }; }
      const run = this.#load(effect.run); const root = effect.node === 'root'; const target = root ? run.root : run.nodes[effect.node];
      demand(target.handle && (root || target.launched), 'HANDLE_REQUIRED');
      demand(event.attempt === decode(effect.data).attempt && event.attempt === (root ? target.attempt : target.snapshot.attempt), 'ATTEMPT_MISMATCH');
      if (root) this.#rootEvent(run, event);
      else this.#workerEvent(run, effect.node, event);
      this.#write('INSERT INTO ingested VALUES (?,?)', event.id, digest); this.#save(run); return { replayed: false };
    });
    this.#tryExport(this.#one('SELECT run FROM effects WHERE id=?', effectId).run);
    this.#notifications.emit('change'); return result;
  }
  #rootEvent(run, event) {
    const p = event.data;
    switch (event.kind) {
      case 'progress': fields(p, ['text']); text(p.text); demand(run.root.state === 'running', 'ROOT_NOT_RUNNING'); break;
      case 'blocked': fields(p, ['requestId', 'kind', 'text']); id(p.requestId); text(p.text); demand(['question', 'decision', 'permission', 'credential', 'external-action'].includes(p.kind), 'INVALID_REQUEST'); demand(run.root.state === 'running', 'ROOT_NOT_RUNNING'); run.root.state = 'blocked'; run.root.request = { id: p.requestId, ...p }; break;
      case 'completed': fields(p, ['text']); text(p.text); demand(['running', 'cancel-pending'].includes(run.root.state), 'ROOT_NOT_RUNNING'); run.root.state = 'idle'; break;
      case 'process-exited': fields(p, ['code']); integer(p.code, 0, 255); run.root.processExited = p.code; break;
      default: throw new RuntimeError('UNKNOWN_EVENT');
    }
    this.#delivery(run, 'root', { kind: `root.${event.kind}`, ...p });
  }
  #workerEvent(run, name, event) {
    const node = run.nodes[name]; const p = event.data;
    if (event.kind === 'process-exited') { fields(p, ['code']); integer(p.code, 0, 255); node.processExited = p.code; this.#delivery(run, name, { kind: 'process-exited', ...p }); return; }
    demand(node.snapshot.state !== 'terminal', 'NODE_TERMINAL');
    if (event.kind === 'progress') {
      fields(p, ['note']); text(p.note); demand(node.snapshot.state === 'running', 'NOT_RUNNING');
      this.#event(run, name, 'node.progress', p); this.#delivery(run, name, { kind: 'progress', ...p });
    } else if (event.kind === 'settled' || event.kind === 'blocked') {
      if (event.kind === 'blocked') { fields(p, ['requestId', 'kind', 'text']); id(p.requestId); text(p.text); demand(['question', 'decision', 'permission', 'credential', 'external-action'].includes(p.kind), 'INVALID_REQUEST'); }
      else { fields(p, ['status', 'reason', 'verified'], ['observation']); demand(['done', 'failed', 'stalled', 'cancelled'].includes(p.status), 'INVALID_STATUS'); text(p.reason, 1024); demand(typeof p.verified === 'boolean', 'INVALID_VERIFICATION'); }
      if (p.observation !== undefined) {
        demand(node.packet.adapter === 'pi-detach', 'OBSERVATION_ADAPTER');
        fields(p.observation, ['handleId', 'generation']); integer(p.observation.generation, 1);
        demand(p.observation.handleId === node.handle.id, 'OBSERVATION_HANDLE_MISMATCH');
        node.executionObservation = p.observation;
      }
      demand(node.snapshot.state !== 'blocked' || p.status === 'cancelled', 'ALREADY_BLOCKED');
      if (p.status === 'cancelled') demand(node.snapshot.cancel, 'CANCEL_NOT_ACCEPTED');
      let artifact = null;
      let artifactProblem = null;
      try { artifact = boundedRead(this.#nodeDirectory(run.id, name), 'result.md', 65536); demand(artifact.eof, 'RESULT_TOO_LARGE'); }
      catch (error) { artifact = null; artifactProblem = error.code === 'ENOENT' ? 'result-missing' : 'result-unreadable'; }
      if (artifact && !artifact.text.trim()) artifactProblem = 'result-blank';
      const validation = validateResultArtifact(artifact?.text ?? '');
      let status = event.kind === 'blocked' ? 'blocked' : p.status;
      if (status === 'done' && validation.classification === 'blocked') status = 'blocked';
      if (['done', 'blocked'].includes(status) && (!validation.valid || validation.classification === 'in-progress')) status = 'stalled';
      if (status === 'blocked') {
        const request = event.kind === 'blocked' ? p : { requestId: `request-${hash(event.id)}`, kind: 'question', text: resultStatusBody(artifact.text) ?? 'Blocked; inspect the result artifact.' };
        const sequence = this.#event(run, name, 'node.blocked', { request: { kind: request.kind, text: request.text } });
        node.snapshot.blockedSequence = sequence;
        node.snapshot.request = { id: request.requestId, run: run.id, node: name, attempt: node.snapshot.attempt, blockedSequence: sequence, answered: false };
        node.requestDetail = { id: request.requestId, kind: request.kind, text: request.text };
      }
      if (artifact?.text.trim() && !(node.snapshot.state === 'blocked' && status === 'cancelled')) {
        const path = join(this.#nodeDirectory(run.id, name), 'result.md');
        this.#event(run, name, 'node.result.written', { path, sha256: hash(artifact.text) });
        this.#event(run, name, 'node.result.validated', { path, valid: validation.valid, problems: [...validation.problems, ...validation.notes], ...(validation.valid ? { status: validation.status ?? 'unknown' } : {}) });
      }
      const reason = status === 'stalled' && artifactProblem ? artifactProblem : event.kind === 'blocked' ? p.text : p.reason;
      this.#event(run, name, 'node.settled', { status, reason });
      node.status = status; node.verified = status === 'done' && p.verified === true;
      node.snapshot.state = status === 'blocked' ? 'blocked' : 'terminal';
      this.#delivery(run, name, { kind: 'settled', status, reason, attempt: node.snapshot.attempt, request: node.snapshot.request, validation });
      const wave = run.graph?.waves[run.wave - 1];
      if (wave && run.completedWave < run.wave && wave.every(n => run.nodes[n]?.snapshot.state === 'terminal')) {
        this.#event(run, null, 'wave.completed', { wave: run.wave, nodes: wave }); run.completedWave = run.wave;
      }
    } else throw new RuntimeError('UNKNOWN_EVENT');
    demand(node.snapshot.revision < Number.MAX_SAFE_INTEGER, 'COUNTER_EXHAUSTED');
    node.snapshot.revision += 1; node.revision = node.snapshot.revision;
  }
  #tryExport(runId) {
    // Export failure cannot undo an admitted receipt or create effect ambiguity.
    // SQL rows remain authoritative. A later command/ingestion/startup retries.
    try { this.exportTrace(runId); } catch { /* pending cursor remains behind SQL */ }
  }
  exportTrace(runId) {
    id(runId);
    return this.#transaction(() => withRunOwnership(this.#root, runId, 'runtime', 'runtime', () => {
      demand(this.#load(runId), 'RUN_FORBIDDEN');
      const events = this.#all('SELECT data FROM events WHERE run=? ORDER BY seq', runId).map(row => decode(row.data));
      const verdict = validateTrace(events, this.#schema); demand(verdict.ok, 'CANONICAL_INVALID');
      const path = join(this.#root, 'traces', `${runId}.jsonl`);
      atomicWrite(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', this.#fault);
      this.#write('INSERT INTO exports VALUES (?,?) ON CONFLICT(run) DO UPDATE SET seq=excluded.seq', runId, events.length);
      return { path, events: events.length };
    }));
  }
  /** Typed refusal, never shutdown-as-cancel. Unacked deliveries also keep the service alive. */
  assertClosable() {
    this.#transaction(() => {
      demand(!this.#dispatching, 'SHUTDOWN_BUSY');
      demand(!this.#one("SELECT id FROM effects WHERE state!='done' LIMIT 1"), 'SHUTDOWN_PENDING');
      for (const row of this.#all('SELECT data FROM runs')) {
        const run = decode(row.data);
        demand(!run.root || (run.root.state === 'idle' && (!(run.root.handle?.pid || run.root.handle?.requiresExit) || run.root.processExited !== undefined)), 'SHUTDOWN_ACTIVE');
        demand(Object.values(run.nodes).every(node => node.snapshot.state === 'terminal' && (!(node.handle?.pid || node.handle?.requiresExit) || node.processExited !== undefined)), 'SHUTDOWN_ACTIVE');
      }
      demand(!this.#one('SELECT d.id FROM deliveries d WHERE NOT EXISTS (SELECT 1 FROM acks a WHERE a.delivery=d.id) LIMIT 1'), 'SHUTDOWN_DELIVERY');
    });
  }
  close() {
    this.assertClosable();
    for (const row of this.#all('SELECT id FROM runs')) this.exportTrace(row.id);
    this.#closed = true; this.#notifications.emit('change'); this.#db.close(); this.#release();
  }
}
