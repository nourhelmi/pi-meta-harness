#!/usr/bin/env node

import { watch } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeSession, parseJsonl } from "./advisor-eval-lib.mjs";
import { createAtifTrajectory } from "./advisor-harbor-lib.mjs";
import {
  candidateFingerprint,
  parallelismDiagnostics,
  prospectiveSuiteFingerprint,
  summarizeResultDimensions,
} from "./advisor-prospective-results.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_ROOT = join(ROOT, "evals", "prospective");
const LOCAL_RUNS_ROOT = join(ROOT, "evals", "local", "prospective-runs");
const DEFAULT_PROFILE = "codex-lean";
const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
const DEFAULT_THINKING = "high";
const DEFAULT_TIMEOUT_MINUTES = 30;
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const WORKER_ROLES = new Set(["browser-verifier", "builder", "checker", "foreman", "planner", "reducer", "scout"]);
const SETTLEMENT_STATUSES = new Set(["successful", "blocked", "failed", "cancelled", "stopped"]);

function usage() {
  return `Prospective Advisor Evaluations

Usage:
  node scripts/advisor-prospective.mjs run <case-id> [options]
  node scripts/advisor-prospective.mjs prepare <case-id> [options]
  node scripts/advisor-prospective.mjs verify <run-directory>

Options:
  --output <directory>          Explicit run directory
  --profile <name>             Advisor intelligence profile (default: ${DEFAULT_PROFILE})
  --name <label>               Human setup-version name (default: working-tree)
  --model <provider/model>      Root advisor model (default: ${DEFAULT_MODEL})
  --thinking <level>           Root advisor thinking level (default: ${DEFAULT_THINKING})
  --timeout-minutes <number>    Completion-signal timeout (default: ${DEFAULT_TIMEOUT_MINUTES})
  --source-agent-dir <path>     Pi auth/package source (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
  --source-codex-home <path>    Codex auth source (default: CODEX_HOME or ~/.codex)

The run command requires Pi inside Herdr. It stages temporary isolated Pi and Codex homes,
copies subscription credentials with mode 0600, launches a visible advisor tab, waits for
an external completion signal, grades the workspace deterministically, stores only a
privacy-normalized trajectory, then removes both credential-bearing directories.`;
}

function parseOptions(argv) {
  const [command = "help", subject, ...rest] = argv;
  const options = { command, subject };
  const valued = new Set(["output", "profile", "name", "candidate", "model", "thinking", "timeout-minutes", "source-agent-dir", "source-codex-home"]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!valued.has(key)) throw new Error(`Unknown option: ${token}`);
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Option ${token} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function assertInside(parent, candidate, label) {
  const rel = relative(parent, candidate);
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside ${parent}`);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
    timeout: options.timeoutMs,
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed with exit ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function runJson(command, args, options) {
  const stdout = run(command, args, options);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} returned non-JSON output: ${stdout.slice(0, 500)}`);
  }
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

function generatedRunName(caseId) {
  return `${timestamp()}--${caseId}--${randomBytes(4).toString("hex")}`;
}

export async function findLatestSessionPath(agentDir) {
  const sessionsRoot = join(agentDir, "sessions");
  if (!(await exists(sessionsRoot))) return undefined;
  const candidates = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      }
    }
  }
  await visit(sessionsRoot);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path;
}

function validateRoleList(value, label) {
  if (!Array.isArray(value) || !value.length || value.some((role) => !WORKER_ROLES.has(role))) {
    throw new Error(`${label} must be a non-empty array of known worker roles`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicate roles`);
}

function validateTopologyPolicy(topology) {
  if (!topology || typeof topology !== "object" || Array.isArray(topology)) {
    throw new Error("Prospective topology policy must be an object");
  }
  if (topology.allowedRoles !== undefined) validateRoleList(topology.allowedRoles, "Prospective topology allowedRoles");
  for (const [field, label] of [
    ["maximumSuccessfulWorkers", "maximumSuccessfulWorkers"],
    ["maximumGraphPlans", "maximumGraphPlans"],
    ["maximumUserQuestions", "maximumUserQuestions"],
  ]) {
    if (topology[field] !== undefined && (!Number.isInteger(topology[field]) || topology[field] < 0 || topology[field] > 24)) {
      throw new Error(`Prospective topology ${label} must be an integer from 0 through 24`);
    }
  }
  if (topology.requiredOrder !== undefined && !Array.isArray(topology.requiredOrder)) {
    throw new Error("Prospective topology requiredOrder must be an array");
  }
  const orderIds = new Set();
  for (const order of topology.requiredOrder ?? []) {
    if (!order || !CASE_ID.test(order.id ?? "")) throw new Error("Every topology order needs a slug id");
    if (orderIds.has(order.id)) throw new Error(`Duplicate prospective topology order: ${order.id}`);
    orderIds.add(order.id);
    validateRoleList(order.beforeRoles, `Topology order ${order.id} beforeRoles`);
    validateRoleList(order.afterRoles, `Topology order ${order.id} afterRoles`);
    if (order.beforeRoles.some((role) => order.afterRoles.includes(role))) {
      throw new Error(`Topology order ${order.id} must use disjoint role sets`);
    }
    if (topology.allowedRoles && [...order.beforeRoles, ...order.afterRoles].some((role) => !topology.allowedRoles.includes(role))) {
      throw new Error(`Topology order ${order.id} references a role outside allowedRoles`);
    }
  }
}

export async function waitForPiPromptRecord(agentDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessionPath = await findLatestSessionPath(agentDir);
    if (sessionPath) {
      const session = await readFile(sessionPath, "utf8");
      if (/"type":"message".*"role":"user"/.test(session)) return sessionPath;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Pi did not record the submitted task before the run deadline");
}

export async function loadProspectiveCase(subject, { casesRoot = CASES_ROOT } = {}) {
  if (typeof subject !== "string" || !subject.trim()) throw new Error("A prospective case ID or path is required");
  const caseDir = CASE_ID.test(subject) ? join(resolve(casesRoot), subject) : resolve(subject);
  const definitionPath = join(caseDir, "case.json");
  const definition = await readJsonFile(definitionPath, "prospective case");
  if (definition.schemaVersion !== 1) throw new Error("Prospective case schemaVersion must be 1");
  if (!CASE_ID.test(definition.id)) throw new Error("Prospective case id must be a lowercase slug");
  if (basename(caseDir) !== definition.id) throw new Error("Prospective case directory must match case id");
  if (typeof definition.title !== "string" || !definition.title.trim()) throw new Error("Prospective case title is required");
  if (typeof definition.instruction !== "string" || !definition.instruction.trim()) {
    throw new Error("Prospective case instruction is required");
  }
  if (!Array.isArray(definition.acceptance) || !definition.acceptance.length) {
    throw new Error("Prospective case acceptance criteria are required");
  }
  const criterionIds = new Set();
  for (const criterion of definition.acceptance) {
    if (!criterion || !CASE_ID.test(criterion.id) || typeof criterion.claim !== "string" || typeof criterion.proof !== "string") {
      throw new Error("Every prospective acceptance criterion needs a slug id, claim, and proof");
    }
    if (criterionIds.has(criterion.id)) throw new Error(`Duplicate prospective criterion: ${criterion.id}`);
    criterionIds.add(criterion.id);
  }
  if (definition.process !== undefined) {
    if (!definition.process || typeof definition.process !== "object" || Array.isArray(definition.process)) {
      throw new Error("Prospective case process must be an object");
    }
    if (definition.process.instruction !== undefined && (typeof definition.process.instruction !== "string" || !definition.process.instruction.trim())) {
      throw new Error("Prospective process instruction must be a non-empty string");
    }
    if (definition.process.expectedCompletionStatus !== undefined && !["completed", "blocked"].includes(definition.process.expectedCompletionStatus)) {
      throw new Error("Prospective expected completion status must be completed or blocked");
    }
    if (definition.process.requiredDelegation !== undefined && !Array.isArray(definition.process.requiredDelegation)) {
      throw new Error("Prospective required delegation must be an array");
    }
    for (const requirement of definition.process.requiredDelegation ?? []) {
      if (!requirement || !CASE_ID.test(requirement.id) || !Array.isArray(requirement.roles) || !requirement.roles.length) {
        throw new Error("Every delegation requirement needs a slug id and at least one role");
      }
      if (requirement.roles.some((role) => !CASE_ID.test(role)) || !Number.isInteger(requirement.minimum) || requirement.minimum < 1) {
        throw new Error("Delegation roles must be slugs and minimum must be a positive integer");
      }
      if (requirement.statuses !== undefined && (
        !Array.isArray(requirement.statuses)
        || !requirement.statuses.length
        || requirement.statuses.some((status) => typeof status !== "string" || !SETTLEMENT_STATUSES.has(status))
      )) {
        throw new Error("Delegation statuses must be a non-empty array containing only successful, blocked, failed, cancelled, or stopped");
      }
    }
    if (definition.process.topology !== undefined) {
      validateTopologyPolicy(definition.process.topology);
      if (definition.process.topology.allowedRoles) {
        for (const requirement of definition.process.requiredDelegation ?? []) {
          if (!requirement.roles.some((role) => definition.process.topology.allowedRoles.includes(role))) {
            throw new Error(`Delegation requirement ${requirement.id} has no role permitted by topology allowedRoles`);
          }
        }
      }
    }
    if (definition.process.parallelism !== undefined) {
      const parallelism = definition.process.parallelism;
      if (!parallelism || typeof parallelism !== "object" || Array.isArray(parallelism)) {
        throw new Error("Prospective parallelism expectation must be an object");
      }
      if (!Number.isInteger(parallelism.maxUsefulWidth) || parallelism.maxUsefulWidth < 1 || parallelism.maxUsefulWidth > 6) {
        throw new Error("Prospective maxUsefulWidth must be an integer from 1 through 6");
      }
      if (!Array.isArray(parallelism.roles) || !parallelism.roles.length || parallelism.roles.some((role) => !CASE_ID.test(role))) {
        throw new Error("Prospective parallelism roles must be a non-empty slug array");
      }
      if (typeof parallelism.rationale !== "string" || !parallelism.rationale.trim()) {
        throw new Error("Prospective parallelism rationale is required");
      }
    }
  }
  if (typeof definition.verifier !== "string" || !definition.verifier.endsWith(".mjs")) {
    throw new Error("Prospective case verifier must reference an .mjs module");
  }
  const workspaceSource = join(caseDir, "workspace");
  const verifierPath = resolve(caseDir, definition.verifier);
  assertInside(caseDir, verifierPath, "Verifier");
  if (!(await exists(workspaceSource))) throw new Error(`Prospective workspace is missing: ${workspaceSource}`);
  if (!(await exists(verifierPath))) throw new Error(`Prospective verifier is missing: ${verifierPath}`);
  return { caseDir, definitionPath, definition, workspaceSource, verifierPath };
}

async function stageCandidateAgentDir(agentDir, profile, sourceAgentDir, piDetachSource, setupRoot = ROOT) {
  await mkdir(agentDir, { recursive: true });
  run(process.execPath, [join(setupRoot, "scripts", "meta-harness.mjs"), "install", "--target", agentDir]);
  run(process.execPath, [join(setupRoot, "scripts", "intelligence-profile.mjs"), profile, "--target", agentDir]);

  const authSource = join(sourceAgentDir, "auth.json");
  if (!(await exists(authSource))) {
    throw new Error(`Pi subscription credentials are missing at ${authSource}; run /login in Pi first`);
  }
  await cp(authSource, join(agentDir, "auth.json"));
  await chmod(join(agentDir, "auth.json"), 0o600);

  for (const name of ["models-store.json", "models.json"]) {
    const source = join(sourceAgentDir, name);
    if (await exists(source)) await cp(source, join(agentDir, name));
  }
  const fdSource = join(sourceAgentDir, "bin", "fd");
  if (await exists(fdSource)) {
    await mkdir(join(agentDir, "bin"), { recursive: true });
    await cp(fdSource, join(agentDir, "bin", "fd"));
    await chmod(join(agentDir, "bin", "fd"), 0o755);
  }
  for (const name of ["npm", "git"]) {
    const source = join(sourceAgentDir, name);
    const destination = join(agentDir, name);
    if (await exists(source)) await symlink(source, destination, "dir");
  }
  // Herdr installs its Pi lifecycle integration outside the harness. Without it,
  // Herdr never observes a staged Pi worker as working or idle and never learns
  // its session path, so every Pi-hosted worker would settle as stalled.
  const herdrIntegration = join(sourceAgentDir, "extensions", "herdr-agent-state.ts");
  if (await exists(herdrIntegration)) {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await cp(herdrIntegration, join(agentDir, "extensions", "herdr-agent-state.ts"));
  }

  if (piDetachSource) {
    const settingsPath = join(agentDir, "settings.json");
    const settings = await readJsonFile(settingsPath, "staged Pi settings");
    let replaced = false;
    settings.packages = (settings.packages ?? []).map((entry) => {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (!/github\.com[/:]nourhelmi\/pi-detach(?:@|$)/.test(source ?? "")) return entry;
      replaced = true;
      return typeof entry === "string" ? piDetachSource : { ...entry, source: piDetachSource };
    });
    if (!replaced) throw new Error("Could not replace the staged pi-detach package source");
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

async function stageCodexHome(codexHome, workspace, sourceCodexHome) {
  const authSource = join(sourceCodexHome, "auth.json");
  if (!(await exists(authSource))) {
    throw new Error(`Codex subscription credentials are missing at ${authSource}; run codex login first`);
  }
  await mkdir(codexHome, { recursive: true });
  await cp(authSource, join(codexHome, "auth.json"));
  await chmod(join(codexHome, "auth.json"), 0o600);
  const config = [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[features]",
    "hooks = false",
    "plugins = false",
    "",
    `[projects.${JSON.stringify(workspace)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), config);
}

export function localPiDetachRevision(source, expectedRevision) {
  if (!source) return undefined;
  const path = resolve(source);
  if (expectedRevision) {
    if (!/^[0-9a-f]{40}$/.test(expectedRevision)) throw new Error("Pinned pi-detach revision must be a full Git SHA");
    return { source: "suite-snapshot", revision: expectedRevision, path };
  }
  const revision = run("git", ["-C", path, "rev-parse", "HEAD"]).trim();
  const dirty = run("git", ["-C", path, "status", "--porcelain"]).trim();
  if (dirty) throw new Error(`Local pi-detach source must be committed before evaluation: ${path}`);
  return { source: "local-committed", revision, path };
}

export function harnessRevision() {
  const revision = run("git", ["rev-parse", "HEAD"]).trim();
  const dirty = run("git", ["status", "--porcelain"]).trim().length > 0;
  return { revision, dirty };
}

async function initializeWorkspace(workspace) {
  run("git", ["init", "-q"], { cwd: workspace });
  run("git", ["config", "user.email", "advisor-eval@localhost"], { cwd: workspace });
  run("git", ["config", "user.name", "Advisor Eval"], { cwd: workspace });
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["commit", "-qm", "fixture: initial state"], { cwd: workspace });
}

export function buildAdvisorPrompt(caseDefinition, completionPath, runId) {
  const criteria = caseDefinition.acceptance
    .map((criterion, index) => `${index + 1}. **${criterion.id}** — ${criterion.claim}\n   Proof: ${criterion.proof}`)
    .join("\n");
  const processInstruction = caseDefinition.process?.instruction
    ?? "Delegate implementation through the normal visible advisor worker path, independently rerun the named deterministic checks after settlement, and judge completion from those checks rather than worker prose.";
  return `/skill:advisor-native

Call advisor_session_init with workstream "eval-${runId.slice(-12)}" and workerHarness "native" before any other tool.

You are running one trusted local prospective evaluation. Treat the workspace as disposable and do not perform any external effect: no network publishing, push, PR, deployment, credential change, or access outside the workspace except the staged Pi agent directory for required advisor-doctrine and intelligence-guide reads, plus normal advisor state and worker result paths.

## Task

${caseDefinition.instruction.trim()}

## Frozen acceptance criteria

${criteria}

The root advisor must not implement product changes. ${processInstruction}

After the work is terminal, write exactly one lifecycle artifact to:

\`${completionPath}\`

The artifact must be JSON with this bounded shape:

\`\`\`json
{
  "schemaVersion": 1,
  "status": "completed or blocked",
  "criteria": [{ "id": "criterion-id", "status": "passed or failed" }]
}
\`\`\`

This artifact is only a completion signal; the external verifier is authoritative. Do not include repository content, paths other than the supplied artifact path, model identities, credentials, or free-text summaries.`;
}

export async function prepareProspectiveRun({
  subject,
  output,
  profile = DEFAULT_PROFILE,
  candidateLabel = "working-tree",
  model = DEFAULT_MODEL,
  thinking = DEFAULT_THINKING,
  timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  piDetachSource = process.env.ADVISOR_EVAL_PI_DETACH_SOURCE,
  piDetachRevision,
  setupRoot = ROOT,
  setupRevision,
} = {}) {
  if (!THINKING_LEVELS.has(thinking)) throw new Error(`Unsupported thinking level: ${thinking}`);
  if (!model.includes("/")) throw new Error("Prospective model must use provider/model format");
  const timeout = Number(timeoutMinutes);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 240) {
    throw new Error("timeout-minutes must be greater than 0 and at most 240");
  }
  const resolvedSetupRoot = resolve(setupRoot);
  const loaded = await loadProspectiveCase(subject, {
    casesRoot: join(resolvedSetupRoot, "evals", "prospective"),
  });
  const runDir = output ? resolve(output) : join(LOCAL_RUNS_ROOT, generatedRunName(loaded.definition.id));
  if (!output) assertInside(LOCAL_RUNS_ROOT, runDir, "Run directory");
  if (await exists(runDir)) throw new Error(`Prospective run directory already exists: ${runDir}`);

  const workspace = join(runDir, "workspace");
  const agentDir = join(runDir, ".agent");
  const codexHome = join(runDir, ".codex");
  const advisorStateDir = join(runDir, "advisor-state");
  const completionPath = join(runDir, "completion.json");
  const piDetach = localPiDetachRevision(piDetachSource, piDetachRevision);
  await mkdir(runDir, { recursive: true });
  await cp(loaded.workspaceSource, workspace, { recursive: true });
  await initializeWorkspace(workspace);
  await mkdir(advisorStateDir, { recursive: true });

  const runId = basename(runDir);
  const [fingerprint, evaluationFingerprint] = await Promise.all([
    candidateFingerprint(resolvedSetupRoot, {
      piDetachRevision: piDetach?.revision,
    }),
    prospectiveSuiteFingerprint(resolvedSetupRoot),
  ]);
  const manifest = {
    schemaVersion: 1,
    runId,
    case: {
      id: loaded.definition.id,
      title: loaded.definition.title,
      ...(loaded.definition.process?.parallelism
        ? { parallelism: loaded.definition.process.parallelism }
        : {}),
    },
    candidate: {
      ...(setupRevision ?? harnessRevision()),
      label: candidateLabel,
      fingerprint,
      profile,
      model,
      thinking,
    },
    evaluation: {
      fingerprint: evaluationFingerprint,
    },
    execution: {
      kind: "herdr-visible-pi-advisor",
      workerHarness: "native",
      timeoutMinutes: timeout,
      credentialPolicy: "temporary-isolated-copies-removed-after-run",
      rawSessionPolicy: "normalize-then-delete",
      nativeWorkerEnvironment: "isolated-codex-home-with-doctor-preflight",
      ...(piDetach ? { piDetach: { source: piDetach.source, revision: piDetach.revision } } : {}),
    },
  };
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(runDir, "prompt.md"), `${buildAdvisorPrompt(loaded.definition, completionPath, runId)}\n`);
  try {
    await stageCandidateAgentDir(agentDir, profile, resolve(sourceAgentDir), piDetach?.path, resolvedSetupRoot);
    await stageCodexHome(codexHome, workspace, resolve(sourceCodexHome));
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
  return {
    ...loaded,
    runDir,
    runId,
    workspace,
    agentDir,
    codexHome,
    advisorStateDir,
    completionPath,
    manifest,
    timeoutMs: timeout * 60_000,
  };
}

export async function verifyProspectiveWorkspace(loaded, workspace) {
  const verifierUrl = `${pathToFileURL(loaded.verifierPath).href}?run=${Date.now()}-${randomBytes(3).toString("hex")}`;
  const verifier = await import(verifierUrl);
  if (typeof verifier.verify !== "function") throw new Error(`${loaded.verifierPath} must export verify(workspace)`);
  const result = await verifier.verify(workspace);
  if (!result || !Array.isArray(result.checks) || !result.checks.length) {
    throw new Error("Prospective verifier must return at least one check");
  }
  for (const check of result.checks) {
    if (!check || !CASE_ID.test(check.id) || typeof check.passed !== "boolean" || typeof check.evidence !== "string") {
      throw new Error("Prospective verifier checks need id, passed, and bounded evidence");
    }
  }
  return {
    checks: result.checks,
    reward: result.checks.every((check) => check.passed) ? 1 : 0,
  };
}

async function waitForFile(path, timeoutMs) {
  if (await exists(path)) return;
  await new Promise((resolvePromise, reject) => {
    let settled = false;
    let watcher;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${path}`)), timeoutMs);
    try {
      watcher = watch(dirname(path), async (_event, filename) => {
        if (filename === basename(path) && await exists(path)) finish();
      });
      watcher.on("error", finish);
    } catch (error) {
      finish(error);
    }
  });
}

function herdrAgentInfo(target) {
  const payload = runJson("herdr", ["agent", "get", target]);
  return payload?.result?.agent;
}

async function persistTrajectory(runState, sessionPath) {
  if (!sessionPath || !(await exists(sessionPath))) return undefined;
  const raw = await readFile(sessionPath, "utf8");
  const normalized = normalizeSession(parseJsonl(raw));
  await writeFile(join(runState.runDir, "trace.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  const trajectory = createAtifTrajectory(normalized);
  await writeFile(join(runState.runDir, "trajectory.json"), `${JSON.stringify(trajectory, null, 2)}\n`);
  return normalized;
}

function topologyChecks(normalized, topology) {
  if (!topology) return [];
  const hasTrace = Boolean(normalized);
  const events = normalized?.events ?? [];
  const launches = events.filter((event) => event.kind === "worker_launch");
  const settlements = events.filter((event) =>
    event.kind === "worker_launch_result" || event.kind === "worker_status"
  );
  const checks = [];

  if (topology.allowedRoles) {
    const allowed = new Set(topology.allowedRoles);
    const launchedRoles = [...new Set(launches.map((event) => event.role ?? "unknown"))].sort();
    const unexpected = launchedRoles.filter((role) => !allowed.has(role));
    checks.push({
      id: "orchestration-allowed-roles",
      passed: hasTrace && unexpected.length === 0,
      evidence: hasTrace
        ? `${launches.length} worker launch(es); roles: ${launchedRoles.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`
        : "root trajectory unavailable for role-policy evaluation",
    });
  }

  if (topology.maximumSuccessfulWorkers !== undefined) {
    const successfulWorkers = new Set(
      settlements
        .filter((event) => event.status === "successful")
        .map((event) => event.workerAlias ?? event.attemptAlias)
        .filter(Boolean),
    );
    checks.push({
      id: "orchestration-successful-worker-budget",
      passed: hasTrace && successfulWorkers.size <= topology.maximumSuccessfulWorkers,
      evidence: hasTrace
        ? `${successfulWorkers.size} distinct successful worker(s); maximum ${topology.maximumSuccessfulWorkers}`
        : "root trajectory unavailable for worker-budget evaluation",
    });
  }

  if (topology.maximumGraphPlans !== undefined) {
    const graphPlans = events.filter((event) => event.kind === "graph_plan").length;
    checks.push({
      id: "orchestration-graph-budget",
      passed: hasTrace && graphPlans <= topology.maximumGraphPlans,
      evidence: hasTrace
        ? `${graphPlans} graph plan(s); maximum ${topology.maximumGraphPlans}`
        : "root trajectory unavailable for graph-budget evaluation",
    });
  }

  if (topology.maximumUserQuestions !== undefined) {
    // A hermetic run has no user to answer, so a question can only stall the run;
    // a case that budgets zero questions is asserting the packet already settles
    // every material decision and the advisor should proceed on evidence.
    const questions = events.filter((event) => event.kind === "tool_call" && event.toolName === "ask_user_question").length;
    checks.push({
      id: "orchestration-user-question-budget",
      passed: hasTrace && questions <= topology.maximumUserQuestions,
      evidence: hasTrace
        ? `${questions} user question(s); maximum ${topology.maximumUserQuestions}`
        : "root trajectory unavailable for user-question-budget evaluation",
    });
  }

  for (const order of topology.requiredOrder ?? []) {
    const settledBefore = events.findIndex((event) =>
      ["worker_launch_result", "worker_status"].includes(event.kind)
      && event.status === "successful"
      && order.beforeRoles.includes(event.role)
    );
    const launchedAfter = events.findIndex((event) =>
      event.kind === "worker_launch" && order.afterRoles.includes(event.role)
    );
    checks.push({
      id: `orchestration-${order.id}`,
      passed: hasTrace && settledBefore >= 0 && launchedAfter > settledBefore,
      evidence: hasTrace
        ? `successful ${order.beforeRoles.join("-or-")} settlement event index ${settledBefore}; first ${order.afterRoles.join("-or-")} launch event index ${launchedAfter}`
        : "root trajectory unavailable for delegation-order evaluation",
    });
  }
  return checks;
}

export function processChecks(normalized, completion, caseDefinition) {
  const launches = normalized?.events?.filter((event) => event.kind === "worker_launch") ?? [];
  const settlements = normalized?.events?.filter(
    (event) => event.kind === "worker_launch_result" || event.kind === "worker_status",
  ) ?? [];
  const process = caseDefinition.process ?? {};
  const expectedStatus = process.expectedCompletionStatus ?? "completed";
  const requirements = process.requiredDelegation ?? [{ id: "builder-delegation", roles: ["builder", "foreman"], minimum: 1 }];
  return [
    {
      id: "completion-signal",
      passed: completion?.schemaVersion === 1 && completion?.status === expectedStatus,
      evidence: completion?.status === expectedStatus ? `bounded ${expectedStatus} signal recorded` : `completion signal missing, malformed, or not ${expectedStatus}`,
    },
    {
      id: "root-trajectory",
      passed: Boolean(normalized),
      evidence: normalized ? `privacy-normalized root trajectory contains ${normalized.events.length} events` : "root trajectory unavailable",
    },
    ...requirements.map((requirement) => {
      const requested = launches.filter((event) => requirement.roles.includes(event.role)).length;
      const acceptedStatuses = requirement.statuses ?? ["successful"];
      const accepted = new Set(
        settlements
          .filter((event) => requirement.roles.includes(event.role) && acceptedStatuses.includes(event.status))
          .map((event) => event.attemptAlias),
      ).size;
      const statusLabel = acceptedStatuses.join("-or-");
      const failureCounts = {};
      for (const event of settlements.filter(
        (candidate) => requirement.roles.includes(candidate.role)
          && candidate.status === "failed"
          && !acceptedStatuses.includes("failed")
          && candidate.failureKind,
      )) {
        failureCounts[event.failureKind] = (failureCounts[event.failureKind] ?? 0) + 1;
      }
      const failureSummary = Object.entries(failureCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, count]) => `${kind}=${count}`)
        .join(", ");
      return {
        id: requirement.id,
        passed: accepted >= requirement.minimum,
        evidence: `${accepted} ${statusLabel} ${requirement.roles.join("-or-")} settlement(s) from ${requested} launch(es); required ${requirement.minimum}${failureSummary ? `; failures: ${failureSummary}` : ""}`,
      };
    }),
    ...topologyChecks(normalized, process.topology),
  ];
}

export async function verifyPreparedRun(runDir) {
  const manifest = await readJsonFile(join(runDir, "manifest.json"), "prospective run manifest");
  const loaded = await loadProspectiveCase(manifest.case.id);
  const deterministic = await verifyProspectiveWorkspace(loaded, join(runDir, "workspace"));
  let completion;
  try {
    completion = JSON.parse(await readFile(join(runDir, "completion.json"), "utf8"));
  } catch {
    completion = undefined;
  }
  let normalized;
  try {
    normalized = JSON.parse(await readFile(join(runDir, "trace.json"), "utf8"));
  } catch {
    normalized = undefined;
  }
  let priorLifecycle;
  try {
    const prior = JSON.parse(await readFile(join(runDir, "result.json"), "utf8"));
    priorLifecycle = prior.checks?.find((check) => check.id === "lifecycle");
  } catch {
    priorLifecycle = undefined;
  }
  const checks = [
    ...deterministic.checks,
    ...processChecks(normalized, completion, loaded.definition),
    priorLifecycle ?? {
      id: "lifecycle",
      passed: true,
      evidence: "deterministic re-verifier reconstructed the bounded run artifacts",
    },
  ];
  const passed = checks.every((check) => check.passed);
  const result = {
    schemaVersion: 1,
    runId: manifest.runId,
    case: manifest.case,
    candidate: manifest.candidate,
    status: passed ? "passed" : "failed",
    reward: passed ? 1 : 0,
    checks,
    dimensions: summarizeResultDimensions({ checks }),
    parallelism: parallelismDiagnostics(normalized, loaded.definition.process?.parallelism),
  };
  await writeFile(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function createHerdrTab(runState) {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Prospective advisor runs require a Herdr-managed caller pane");
  }
  const args = ["tab", "create"];
  if (process.env.HERDR_WORKSPACE_ID) args.push("--workspace", process.env.HERDR_WORKSPACE_ID);
  args.push(
    "--cwd", runState.workspace,
    "--label", `eval · ${runState.definition.id}`,
    "--env", `PI_CODING_AGENT_DIR=${runState.agentDir}`,
    "--env", `CODEX_HOME=${runState.codexHome}`,
    "--env", `ADVISOR_STATE_DIR=${runState.advisorStateDir}`,
    "--env", `PI_DETACH_AGENT_PROFILES=${join(runState.agentDir, "bg-agent-profiles.json")}`,
    "--env", `PATH=${join(runState.agentDir, "bin")}:${process.env.PATH ?? ""}`,
    "--no-focus",
  );
  const created = runJson("herdr", args);
  const tabId = created?.result?.tab?.tab_id;
  const paneId = created?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error("Herdr did not return a tab and root pane for the prospective run");
  return { tabId, paneId };
}

export async function startHerdrAgentWithRetry(
  args,
  deadline,
  execute = () => run("herdr", args),
  delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      execute();
      return;
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (!detail.includes("agent_pane_busy") && !detail.includes("not an available shell")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("Herdr agent start remained busy until the run deadline");
}

export async function runProspectiveCase(options) {
  const runState = await prepareProspectiveRun(options);
  const deadline = Date.now() + runState.timeoutMs;
  let tab;
  let sessionPath;
  let lifecycleError;
  let completion;
  let normalized;
  try {
    run("codex", ["doctor", "--summary", "--no-color", "--ascii"], {
      cwd: runState.workspace,
      env: { CODEX_HOME: runState.codexHome },
      timeoutMs: 60_000,
    });
    tab = createHerdrTab(runState);
    const agentName = `eval-${randomBytes(6).toString("hex")}`;
    await startHerdrAgentWithRetry([
      "agent", "start", agentName,
      "--kind", "pi",
      "--pane", tab.paneId,
      "--timeout", "120000",
      "--",
      "--model", runState.manifest.candidate.model,
      "--thinking", runState.manifest.candidate.thinking,
      "--approve",
    ], deadline);
    run("herdr", [
      "pane", "wait-output", tab.paneId,
      "--match", "0.0%/", "--timeout", String(Math.max(1, deadline - Date.now())),
    ]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    run("herdr", [
      "agent", "prompt", tab.paneId,
      await readFile(join(runState.runDir, "prompt.md"), "utf8"),
    ]);
    sessionPath = await waitForPiPromptRecord(runState.agentDir, Math.max(1, deadline - Date.now()));
    await waitForFile(runState.completionPath, Math.max(1, deadline - Date.now()));
    try {
      run("herdr", ["agent", "wait", tab.paneId, "--timeout", "120000"]);
    } catch {
      // The completion artifact is the lifecycle boundary; a late UI state is diagnostic only.
    }
    const info = herdrAgentInfo(tab.paneId);
    sessionPath = info?.agent_session?.kind === "path" ? info.agent_session.value : undefined;
    completion = JSON.parse(await readFile(runState.completionPath, "utf8"));
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
    if (tab?.paneId) {
      try {
        const info = herdrAgentInfo(tab.paneId);
        sessionPath = info?.agent_session?.kind === "path" ? info.agent_session.value : undefined;
      } catch {
        // Preserve the original lifecycle error.
      }
    }
  } finally {
    sessionPath ??= await findLatestSessionPath(runState.agentDir);
    if (sessionPath) {
      try {
        normalized = await persistTrajectory(runState, sessionPath);
      } catch (error) {
        lifecycleError ??= `Could not normalize root session: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (tab?.tabId) {
      try {
        run("herdr", ["tab", "close", tab.tabId]);
      } catch (error) {
        lifecycleError ??= `Could not close eval tab: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await Promise.all([
      rm(runState.agentDir, { recursive: true, force: true }),
      rm(runState.codexHome, { recursive: true, force: true }),
    ]);
  }

  const deterministic = await verifyProspectiveWorkspace(runState, runState.workspace);
  const checks = [
    ...deterministic.checks,
    ...processChecks(normalized, completion, runState.definition),
    {
      id: "lifecycle",
      passed: !lifecycleError,
      evidence: lifecycleError?.slice(0, 500) ?? "root advisor lifecycle completed within the bounded runner",
    },
  ];
  const passed = checks.every((check) => check.passed);
  const result = {
    schemaVersion: 1,
    runId: runState.runId,
    case: runState.manifest.case,
    candidate: runState.manifest.candidate,
    status: passed ? "passed" : "failed",
    reward: passed ? 1 : 0,
    checks,
    dimensions: summarizeResultDimensions({ checks }),
    parallelism: parallelismDiagnostics(normalized, runState.definition.process?.parallelism),
  };
  await writeFile(join(runState.runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return { runDir: runState.runDir, result };
}

export async function runCli(argv) {
  const options = parseOptions(argv);
  if (options.command === "help" || options.command === "--help" || options.command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "verify") {
    if (!options.subject) throw new Error("verify requires a run directory");
    const result = await verifyPreparedRun(resolve(options.subject));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!["prepare", "run"].includes(options.command)) throw new Error(`Unknown command: ${options.command}\n\n${usage()}`);
  if (!options.subject) throw new Error(`${options.command} requires a case ID`);
  const invocation = {
    subject: options.subject,
    output: options.output,
    profile: options.profile,
    candidateLabel: options.name ?? options.candidate,
    model: options.model,
    thinking: options.thinking,
    timeoutMinutes: options["timeout-minutes"],
    sourceAgentDir: options["source-agent-dir"],
    sourceCodexHome: options["source-codex-home"],
  };
  if (options.command === "prepare") {
    const prepared = await prepareProspectiveRun(invocation);
    await Promise.all([
      rm(prepared.agentDir, { recursive: true, force: true }),
      rm(prepared.codexHome, { recursive: true, force: true }),
    ]);
    process.stdout.write(`${prepared.runDir}\n`);
    return;
  }
  const finished = await runProspectiveCase(invocation);
  process.stdout.write(`${JSON.stringify(finished, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
