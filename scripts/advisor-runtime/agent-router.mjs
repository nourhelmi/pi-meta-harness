import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PREFLIGHT_MODEL = 'openai-codex/agent-router-preflight';
const DEFAULT_RENEW_MS = 30_000;
const THINKING_WITHOUT_MODEL = 'BRIDGE_INVALID_INPUT';
const modules = new Map();

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function agentRouterConfigPath(env = process.env) {
  return env.AGENT_ROUTER_CONFIG || join(homedir(), '.config', 'agent-router', 'config.json');
}

/** Trusted host configuration only. Tool arguments never select this path or module. */
export function readAgentRouterConfig({ env = process.env, configPath = agentRouterConfigPath(env) } = {}) {
  if (!existsSync(configPath)) return { version: 1, enabled: false, configPath };
  let value;
  try { value = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { throw codedError('AGENT_ROUTER_CONFIG_INVALID'); }
  if (!value || Array.isArray(value) || value.version !== 1 || typeof value.enabled !== 'boolean') throw codedError('AGENT_ROUTER_CONFIG_INVALID');
  if (!value.enabled) return { version: 1, enabled: false, configPath };
  if (typeof value.modulePath !== 'string' || !isAbsolute(value.modulePath) || !existsSync(value.modulePath)) throw codedError('AGENT_ROUTER_CONFIG_INVALID');
  return { version: 1, enabled: true, configPath, modulePath: value.modulePath };
}

export function agentRouterEnabled(options) {
  return readAgentRouterConfig(options).enabled;
}

async function loadRouter(config) {
  let loaded = modules.get(config.modulePath);
  if (!loaded) {
    loaded = import(pathToFileURL(config.modulePath).href).catch(() => { throw codedError('AGENT_ROUTER_MODULE_INVALID'); });
    modules.set(config.modulePath, loaded);
  }
  const api = await loaded;
  if (typeof api.route !== 'function' || typeof api.release !== 'function' || typeof api.renew !== 'function') throw codedError('AGENT_ROUTER_MODULE_INVALID');
  return api;
}

function routingRecord(decision) {
  if (!decision || decision.version !== 1 || typeof decision.id !== 'string' || !decision.id ||
      !decision.selected || typeof decision.selected.model !== 'string' || !decision.selected.model ||
      typeof decision.selected.thinking !== 'string' || !decision.selected.thinking ||
      !['jev', 'fallback', 'pinned'].includes(decision.strategy) || typeof decision.at !== 'string' || !decision.at) {
    throw codedError('AGENT_ROUTER_DECISION_INVALID');
  }
  return {
    version: 1,
    id: decision.id,
    selected: { model: decision.selected.model, thinking: decision.selected.thinking },
    strategy: decision.strategy,
    at: decision.at,
  };
}

function routedPreparation(params, scope) {
  if (!params || typeof params !== 'object') return { params, scope, invalidInput: true };
  if (params.thinking !== undefined && params.model === undefined) return { params, scope, invalidThinking: true };
  // Freeform workers remain Pi-hosted even when specialist roles inherit native.
  if (params.role === undefined) {
    if (params.harness !== undefined && !['pi', 'native'].includes(params.harness)) return { params, scope, invalidInput: true };
    if (params.harness === 'native') return { params, scope, invalidFreeformHarness: true };
    const { workerHarness: _workerHarness, ...piScope } = scope ?? {};
    return { params: { ...params, harness: 'pi' }, scope: piScope };
  }
  return { params, scope };
}

function routeFailure(error) {
  if (error?.code === 'AGENT_ROUTER_NO_FEASIBLE_ROUTE') return codedError('AGENT_ROUTER_NO_FEASIBLE_ROUTE');
  return codedError('AGENT_ROUTER_ROUTE_FAILED');
}

function definitiveFreshLaunchFailure(error) {
  const code = error?.code ?? error?.message;
  // All other driver failures can follow an unproven pane/process effect.
  return code === 'agent command is empty';
}

/** Wrap the side-effect-free prepare boundary and the owned launch lifecycle. */
export function createRoutedExecutionPort(port, { env = process.env, configPath, renewIntervalMs = DEFAULT_RENEW_MS } = {}) {
  if (!Number.isInteger(renewIntervalMs) || renewIntervalMs < 1) throw codedError('AGENT_ROUTER_CONFIG_INVALID');
  const leases = new Map();

  const leaseError = () => codedError('BRIDGE_ROUTER_LEASE_LOST');
  const stopRenewal = lease => { clearTimeout(lease.timer); lease.timer = undefined; };
  const reportRecovery = (lease, cause = 'BRIDGE_ROUTER_LEASE_LOST') => {
    try { lease.input?.hooks.recoveryRequired?.(cause); }
    catch { /* The owner may already be fenced or closed; never bypass that fence. */ }
  };
  const releaseLease = async lease => {
    if (!lease || lease.released) return;
    stopRenewal(lease);
    if (lease.releasing) return lease.releasing;
    lease.releasing = (async () => {
      await lease.renewing?.catch(() => {});
      await lease.api.release(lease.id, { configPath: lease.configPath });
      lease.released = true;
    })().finally(() => { lease.releasing = undefined; });
    return lease.releasing;
  };
  const renewLease = async lease => {
    if (lease.failed || lease.released || lease.releasing) throw leaseError();
    lease.renewing ??= Promise.resolve().then(() => lease.api.renew(lease.id, { configPath: lease.configPath }))
      .catch(() => { lease.failed = true; stopRenewal(lease); throw leaseError(); })
      .finally(() => { lease.renewing = undefined; });
    await lease.renewing;
    if (lease.failed || lease.released || lease.releasing) throw leaseError();
  };
  const recoverLease = lease => {
    lease.failed = true;
    stopRenewal(lease);
    return lease.recovery ??= (async () => {
      await lease.launching?.catch(() => {});
      const input = lease.input;
      let driver = lease.driver;
      try {
        // Rebind only for observation when the previous driver's attempt is stale.
        // This never replays a task or invents an occupant after uncertain launch.
        lease.recovering = true;
        if (!driver && lease.handle) driver = await port.launch({ ...input, reply: undefined, hooks: {
          ...input.hooks, expectedHandle: lease.handle, observeOnly: true, completed: true,
          settled: () => ({ terminal: false, close: false }),
          recoveryRequired: () => reportRecovery(lease),
        } });
        if (driver?.interrupt) await driver.interrupt({
          beforeInterrupt: input.hooks.beforeInterrupt,
          // Safety interruption is not node.cancel: no cancelled result or exit claim.
          settled() { void releaseLease(lease).catch(() => reportRecovery(lease)); },
          superseded() {}, // An already idle keepAlive worker still owns its slot.
          recoveryRequired() { reportRecovery(lease); },
        });
        else if (!lease.launchStarted && !lease.handle) await releaseLease(lease);
      } catch (error) {
        if (error?.message === 'BRIDGE_SESSION_UNAVAILABLE') {
          lease.unavailable = true;
          await releaseLease(lease).catch(() => reportRecovery(lease));
        }
        // Every other ownership/stop failure is uncertain; retain the reservation.
      } finally {
        lease.recovering = false;
        // recoveryRequired fences assertActive. Attempt owned Escape first; a later
        // fenced observation is uncertainty, never evidence to release capacity.
        if (!(lease.unavailable && input.hooks.observeOnly)) reportRecovery(lease);
      }
    })();
  };
  const startRenewal = lease => {
    if (lease.failed || lease.released || lease.releasing || lease.timer || lease.renewalTick) return;
    lease.timer = setTimeout(() => {
      lease.timer = undefined;
      lease.renewalTick = (async () => {
        await renewLease(lease);
        const { driver, input } = lease;
        // Kept workers detach turn waiters on completion. Continue checking the
        // exact owned occupant so manual pane closure ends its lifetime lease.
        if (input?.intent.keepAlive && driver?.runtimeObservation) {
          try { await driver.runtimeObservation(); }
          catch (error) {
            if (lease.driver !== driver || lease.input !== input) return;
            if (error?.message !== 'BRIDGE_SESSION_UNAVAILABLE') throw error;
            await releaseLease(lease);
            reportRecovery(lease, 'BRIDGE_SESSION_UNAVAILABLE');
          }
        }
      })().catch(() => recoverLease(lease)).finally(() => { lease.renewalTick = undefined; startRenewal(lease); });
    }, renewIntervalMs);
    lease.timer.unref?.();
  };
  const leaseFor = async routing => {
    const existing = leases.get(routing.id);
    if (existing) return existing;
    const config = readAgentRouterConfig({ env, ...(configPath ? { configPath } : {}) });
    if (!config.enabled) throw codedError('AGENT_ROUTER_CONFIG_INVALID');
    const lease = { id: routing.id, api: await loadRouter(config), configPath: config.configPath, released: false, timer: undefined, releasing: undefined };
    leases.set(routing.id, lease);
    return lease;
  };

  return {
    version: port.version,
    async prepare(params, sourceDirectory, scope) {
      const config = readAgentRouterConfig({ env, ...(configPath ? { configPath } : {}) });
      if (!config.enabled) return port.prepare(params, sourceDirectory, scope);
      const prepared = routedPreparation(params, scope);
      if (prepared.invalidInput) {
        await port.prepare(params, sourceDirectory, scope);
        throw codedError('BRIDGE_INVALID_INPUT');
      }
      if (prepared.invalidThinking) {
        await port.prepare(params, sourceDirectory, scope);
        throw codedError(THINKING_WITHOUT_MODEL);
      }
      if (prepared.invalidFreeformHarness) {
        await port.prepare(params?.model === undefined ? { ...params, model: PREFLIGHT_MODEL, thinking: 'off' } : params, sourceDirectory, scope);
        throw codedError('BRIDGE_INVALID_INPUT');
      }
      const previewParams = params?.model === undefined
        ? { ...prepared.params, model: PREFLIGHT_MODEL, thinking: 'off' }
        : prepared.params;
      const preview = await port.prepare(previewParams, sourceDirectory, prepared.scope);
      const api = await loadRouter(config);
      let pin;
      if (params?.model !== undefined) pin = { model: params.model, ...(params.thinking !== undefined ? { thinking: params.thinking } : {}) };
      let decision;
      try {
        decision = await api.route({ role: preview.role, task: params.prompt, harness: preview.harness, ...(pin ? { pin } : {}) }, { configPath: config.configPath });
      } catch (error) { throw routeFailure(error); }
      let routing; let createdLease; let duplicateDecision = false;
      try {
        routing = routingRecord(decision);
        if (pin && (routing.selected.model !== pin.model || pin.thinking !== undefined && routing.selected.thinking !== pin.thinking)) throw codedError('AGENT_ROUTER_PIN_MISMATCH');
        if (leases.has(routing.id)) { duplicateDecision = true; throw codedError('AGENT_ROUTER_DECISION_INVALID'); }
        createdLease = { id: routing.id, api, configPath: config.configPath, released: false, timer: undefined, releasing: undefined };
        leases.set(routing.id, createdLease);
        const intent = await port.prepare({ ...prepared.params, model: routing.selected.model, thinking: routing.selected.thinking }, sourceDirectory, prepared.scope);
        if (intent.model !== routing.selected.model || intent.thinking !== routing.selected.thinking || intent.role !== preview.role || intent.harness !== preview.harness) throw codedError('AGENT_ROUTER_DECISION_INVALID');
        return { ...intent, routing };
      } catch (error) {
        if (createdLease) await releaseLease(createdLease).catch(() => {});
        else if (routing && !duplicateDecision) await Promise.resolve(api.release(routing.id, { configPath: config.configPath })).catch(() => {});
        else if (!routing && typeof decision?.id === 'string' && decision.id && !leases.has(decision.id)) await Promise.resolve(api.release(decision.id, { configPath: config.configPath })).catch(() => {});
        throw error;
      }
    },
    async release(intent) {
      if (!intent?.routing) return;
      await releaseLease(await leaseFor(intent.routing));
    },
    async launch(input) {
      const routing = input.intent?.routing;
      if (!routing) return port.launch(input);
      const lease = await leaseFor(routing);
      // The latest attempt owns recovery; never call a previous attempt's hooks.
      lease.input = input;
      lease.driver = undefined;
      lease.handle = input.hooks.expectedHandle ?? lease.handle;
      lease.recovery = undefined;
      try { await renewLease(lease); }
      catch {
        await recoverLease(lease);
        throw lease.unavailable && input.hooks.observeOnly ? codedError('BRIDGE_SESSION_UNAVAILABLE') : leaseError();
      }
      startRenewal(lease);
      const hooks = {
        ...input.hooks,
        assertActive() {
          input.hooks.assertActive?.();
          if (lease.failed && !lease.recovering) throw leaseError();
        },
        recordHandle(handle) { input.hooks.recordHandle?.(handle); lease.handle = handle; },
        recoveryRequired(cause) {
          if (lease.failed) { void recoverLease(lease); return; }
          input.hooks.recoveryRequired?.(cause);
        },
        async settled(...args) {
          if (lease.failed) return { terminal: false, close: false };
          const outcome = await input.hooks.settled(...args);
          if (outcome?.terminal && !input.intent.keepAlive) await releaseLease(lease).catch(() => reportRecovery(lease));
          return outcome;
        },
      };
      try {
        lease.launchStarted = true;
        lease.launching = Promise.resolve().then(() => port.launch({ ...input, hooks }))
          .then(driver => { lease.driver = driver; return driver; });
        const driver = await lease.launching;
        if (lease.failed) { await recoverLease(lease); throw leaseError(); }
        const wrapped = {};
        if (input.hooks.observeOnly && typeof driver.runtimeObservation === 'function') {
          const observe = driver.runtimeObservation.bind(driver);
          wrapped.runtimeObservation = async () => {
            const observation = await observe();
            if (!input.intent.keepAlive && input.hooks.completed && ['done', 'idle'].includes(observation?.state)) await releaseLease(lease).catch(() => reportRecovery(lease));
            return observation;
          };
        }
        if (typeof driver.message === 'function') {
          wrapped.message = async message => {
            try { await renewLease(lease); }
            catch { await recoverLease(lease); throw leaseError(); }
            return driver.message(message);
          };
        }
        if (typeof driver.interrupt === 'function') {
          const interrupt = driver.interrupt.bind(driver);
          wrapped.interrupt = async observer => interrupt(observer ? {
            ...observer,
            settled(...args) {
              // DriverHandle does not await this callback. Handle synchronous throws
              // and async rejection without releasing an unconfirmed cancellation.
              try {
                return Promise.resolve(observer.settled(...args)).then(() => releaseLease(lease))
                  .catch(() => reportRecovery(lease));
              } catch { reportRecovery(lease); }
            },
          } : observer);
        }
        return Object.keys(wrapped).length ? { ...driver, ...wrapped } : driver;
      } catch (error) {
        if (!input.hooks.expectedHandle && definitiveFreshLaunchFailure(error)) await releaseLease(lease).catch(() => {});
        throw error;
      }
    },
  };
}
