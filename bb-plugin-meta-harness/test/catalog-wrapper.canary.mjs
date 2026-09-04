import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE = "v24.18.0";
const EXPECTED_PI = "0.84.4";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const metaRoot = dirname(packageRoot);
const detachRoot = "/Users/nour/Dev/pi-detach-worktrees/bb-adapter-poc";
const wrapper = join(packageRoot, "src", "catalog-wrapper.mjs");
const root = realpathSync(mkdtempSync(join(tmpdir(), "bb-meta-wrapper-canary-")));
const catalogCwd = join(root, "catalog-project");
const threadCwd = join(root, "thread-project");
const profile = join(root, "profile");
const sessionDir = join(root, "provider-sessions");
const sessionFile = join(sessionDir, "thread.jsonl");
const advisorRoot = join(root, "advisor");
const detachStateRoot = join(root, "detach-state");
const piExecutable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const skillRoot = join(root, "bb-global-skills");
// Keep the lexical macOS /var alias and exact process-temp shape produced by
// the pinned provider bridge worker.
const providerTempRoot = mkdtempSync(join(tmpdir(), "bb-provider-bridge-provider-pi-"));
const providerScratch = join(providerTempRoot, "pi");
mkdirSync(providerScratch);
const explicitExtension = join(providerScratch, "bb-pi-extension.mjs");
const systemPrompt = join(providerScratch, "pi-system-canary.md");
const toolsFile = join(providerScratch, "pi-tools-canary.json");
const poisonMarker = join(root, "catalog-poison-loaded");
const assertions = [];

for (const path of [catalogCwd, threadCwd, profile, sessionDir, dirname(sessionFile), advisorRoot, detachStateRoot, skillRoot, join(catalogCwd, ".pi", "extensions")]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(sessionFile, "", "utf8");
mkdirSync(join(skillRoot, "harmless-canary"));
writeFileSync(join(skillRoot, "harmless-canary", "SKILL.md"), "---\nname: harmless-canary\ndescription: Wrapper pass-through fixture.\n---\n\nDo nothing.\n");
writeFileSync(join(profile, "settings.json"), `${JSON.stringify({
  packages: [],
  extensions: [
    join(metaRoot, "extensions", "advisor-session.ts"),
    join(metaRoot, "extensions", "advisor-worker.ts"),
    join(metaRoot, "extensions", "advisor-graph.ts"),
    join(detachRoot, "extensions", "index.ts"),
  ],
}, null, 2)}\n`, "utf8");
writeFileSync(join(profile, "bg-agent-profiles.json"), readFileSync(join(packageRoot, "runtime", "pi-agent", "bg-agent-profiles.json")));
writeFileSync(join(profile, "auth.json"), "{}\n", { mode: 0o600 });
writeFileSync(join(profile, "models-store.json"), "{}\n", { mode: 0o600 });
const wrapperConfig = Buffer.from(JSON.stringify({
  advisorStateRoot: advisorRoot,
  allowedRoots: [root],
  detachRoot,
  detachStateRoot,
  hostId: "host-canary",
  piExecutable,
  profileRoot: profile,
  sessionRoot: sessionDir,
  skillRoots: [skillRoot],
})).toString("base64url");
const staticArgs = ["--bb-wrapper-static", "v1", "--config", wrapperConfig];
writeFileSync(join(catalogCwd, ".pi", "extensions", "poison.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(poisonMarker)}, "loaded"); export default function poison() {}`);
writeFileSync(explicitExtension, `
import { createReadStream, createWriteStream, existsSync, fstatSync } from "node:fs";
import { createInterface } from "node:readline";
const out = createWriteStream(null, { fd: 3, autoClose: false });
const input = createReadStream(null, { fd: 4, autoClose: false });
const lines = createInterface({ input });
const write = (value) => out.write(JSON.stringify(value) + "\\n");
const isPipe = (fd) => { try { const value = fstatSync(fd); return value.isFIFO() || value.isSocket(); } catch { return false; } };
const identityKeys = ["HERDR_ENV", "HERDR_PANE_ID", "PI_INTERCOM_SESSION_ID", "STABLE_INTERCOM_SESSION_ID", "SUBAGENT_RUN_ID", "ENGRAM_URL", "CODEX_HOME", "TMUX"];
write({ kind: "probe", node: process.version, cwd: process.cwd(), stagedIdentity: ["auth.json", "models-store.json"].every((name) => existsSync(process.env.PI_CODING_AGENT_DIR + "/" + name)), argv: process.argv.slice(2), fd3: isPipe(3), fd4: isPipe(4), env: {
  HOME: process.env.HOME ?? null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
  TMPDIR: process.env.TMPDIR ?? null, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
  PI_BB_CATALOG_CANARY: process.env.PI_BB_CATALOG_CANARY ?? null,
  BB_THREAD_ID: process.env.BB_THREAD_ID ?? null, BB_PROJECT_ID: process.env.BB_PROJECT_ID ?? null,
  BB_ENVIRONMENT_ID: process.env.BB_ENVIRONMENT_ID ?? null, BB_SERVER_URL: process.env.BB_SERVER_URL ?? null,
  PI_DETACH_BB_HOST_ID: process.env.PI_DETACH_BB_HOST_ID ?? null,
  PI_DETACH_STATE_ROOT: process.env.PI_DETACH_STATE_ROOT ?? null,
  ADVISOR_STATE_ROOT: process.env.ADVISOR_STATE_ROOT ?? null,
	PI_BB_TOOLS_FILE: process.env.PI_BB_TOOLS_FILE ?? null,
}, poisoned: identityKeys.filter((name) => process.env[name] !== undefined) });
lines.on("line", (line) => { try { const message = JSON.parse(line); if (message.kind === "ping") write({ kind: "ack", value: message.value }); } catch {} });
export default function canary(pi) {
  pi.on("session_start", (_event, context) => {
    const tools = pi.getAllTools().map((tool) => ({ name: tool.name, path: tool.sourceInfo.path, source: tool.sourceInfo.source }));
    write({ kind: "ready", mode: context.mode, hasUI: context.hasUI, tools });
  });
}
`, "utf8");
writeFileSync(systemPrompt, "You are the harmless BB Meta Harness wrapper canary.\n", "utf8");
writeFileSync(toolsFile, `${JSON.stringify([{
  name: "update_environment_directory",
  description: "Move this bb thread to a different working directory for subsequent turns. Use this when the user asks to switch to a new checkout, worktree, or local directory. The path must be an absolute existing directory on the current host. The tool reuses this project's existing bb environment for that host/path, otherwise it creates an unmanaged environment after validating the path. Another project may hold its own environment for the same directory; that is allowed, except for a bb-managed worktree owned by another project, which this tool refuses. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to an existing directory on the current host.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Moving the thread directory",
      completed: "Moved the thread directory",
    },
    icon: { glyph: "FolderOpen" },
  },
}])}\n`, "utf8");

function sha(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const productionTargets = [
  "/Users/nour/.pi/agent/settings.json",
  "/Users/nour/.pi/agent/mcp.json",
  "/Users/nour/.pi/agent/advisor-intelligence.json",
];
const productionBefore = productionTargets.map(sha);

function check(name, condition, evidence) {
  assertions.push({ name, status: condition ? "PASS" : "FAIL", evidence });
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds)),
  ]);
}

function collectJsonLines(stream) {
  const messages = [];
  const waiters = [];
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  return {
    messages,
    wait(predicate, milliseconds = 10_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error("timed out waiting for JSON line"));
          }, milliseconds),
        };
        waiters.push(waiter);
      });
    },
  };
}

const baseEnv = {
  ...process.env,
  PATH: "/usr/bin:/bin",
  BB_THREAD_ID: "thread-canary",
  BB_PROJECT_ID: "project-canary",
  BB_ENVIRONMENT_ID: "environment-canary",
  BB_SERVER_URL: "http://127.0.0.1:38886",
	PI_BB_TOOLS_FILE: toolsFile,
  HERDR_ENV: "1",
  HERDR_PANE_ID: "poison-pane",
  PI_INTERCOM_SESSION_ID: "poison-intercom",
  STABLE_INTERCOM_SESSION_ID: "poison-stable",
  SUBAGENT_RUN_ID: "poison-run",
  ENGRAM_URL: "http://127.0.0.1:9999",
  CODEX_HOME: "/poison/codex",
  TMUX: "poison-tmux",
};

const versionProbe = spawnSync(
  process.execPath,
  [wrapper, ...staticArgs, "--version"],
  { cwd: catalogCwd, env: baseEnv, encoding: "utf8" },
);

async function runValid(name, cwd, args) {
  const child = spawn(process.execPath, [wrapper, ...staticArgs, ...args], {
    cwd,
    env: baseEnv,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const stdout = collectJsonLines(child.stdout);
  const channel = collectJsonLines(child.stdio[3]);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let response;
  let probe;
  let ready;
  let ack;
  try {
    child.stdin.write(`${JSON.stringify({ id: `${name}-state`, type: "get_state" })}\n`);
    response = await stdout.wait((message) => message.type === "response" && message.id === `${name}-state`);
    probe = await channel.wait((message) => message.kind === "probe");
    ready = await channel.wait((message) => message.kind === "ready");
    child.stdio[4].write(`${JSON.stringify({ kind: "ping", value: `${name}-round-trip` })}\n`);
    ack = await channel.wait((message) => message.kind === "ack");
  } catch (error) {
    child.kill("SIGKILL");
    await exit;
    throw new Error(`${name} failed before RPC readiness: ${String(error)}; stderr=${stderr}`);
  }
  child.stdin.end();
  child.stdio[4].end();
  let exited;
  try {
    exited = await withTimeout(exit, 12_000, `${name} Pi child did not exit`);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return { response, probe, ready, ack, exit: exited, stderr, channel: channel.messages };
}

async function runRejected(name, cwd, args) {
  const child = spawn(process.execPath, [wrapper, ...args], { cwd, env: baseEnv, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  const channel = collectJsonLines(child.stdio[3]);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await withTimeout(new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))), 5_000, `${name} did not reject`);
  return { exit, stderr, channel: channel.messages };
}

const catalogArgs = ["--mode", "rpc", "--no-session", "--extension", explicitExtension];
const threadArgs = [
  "--mode", "rpc",
  "--session", sessionFile,
  "--session-dir", sessionDir,
  "--extension", explicitExtension,
  "--system-prompt", systemPrompt,
  "--skill", skillRoot,
  "--model", "openai-codex/gpt-5.6-sol",
  "--thinking", "high",
];
const catalog = await runValid("catalog", catalogCwd, catalogArgs);
const thread = await runValid("thread", threadCwd, threadArgs);
const rejectedInputs = [
  ["static-prefix", ["--wrong", "v1", ...catalogArgs]],
  ["non-rpc", [...staticArgs, "--mode", "print", "--no-session", "--extension", explicitExtension]],
  ["both-selectors", [...staticArgs, "--mode", "rpc", "--no-session", "--session", sessionFile, "--session-dir", sessionDir, "--extension", explicitExtension]],
  ["missing-extension", [...staticArgs, "--mode", "rpc", "--no-session"]],
  ["caller-no-extensions", [...staticArgs, ...catalogArgs, "--no-extensions"]],
];
const rejects = [];
for (const [name, args] of rejectedInputs) rejects.push([name, await runRejected(name, catalogCwd, args)]);

const requiredOwners = new Map([
  ["advisor_launch", join(metaRoot, "extensions", "advisor-session.ts")],
  ["advisor_session_init", join(metaRoot, "extensions", "advisor-session.ts")],
  ["advisor_graph_plan", join(metaRoot, "extensions", "advisor-graph.ts")],
  ["bg_run", join(detachRoot, "extensions", "index.ts")],
  ["bg_watch", join(detachRoot, "extensions", "index.ts")],
  ["bg_await", join(detachRoot, "extensions", "index.ts")],
  ["bg_agent", join(detachRoot, "extensions", "index.ts")],
  ["bg_output", join(detachRoot, "extensions", "index.ts")],
  ["bg_list", join(detachRoot, "extensions", "index.ts")],
  ["bg_stop", join(detachRoot, "extensions", "index.ts")],
]);
const curatedPaths = new Set([
  join(metaRoot, "extensions", "advisor-session.ts"),
  join(metaRoot, "extensions", "advisor-worker.ts"),
  join(metaRoot, "extensions", "advisor-graph.ts"),
  join(detachRoot, "extensions", "index.ts"),
]);
const tools = thread.ready.tools;
const curatedTools = tools.filter((tool) => curatedPaths.has(tool.path));
const catalogRoots = [catalog.probe.env.HOME, catalog.probe.env.PI_CODING_AGENT_DIR, catalog.probe.env.TMPDIR, catalog.probe.env.XDG_CONFIG_HOME];

check("1 runtime is exact Node 24.18.0 and Pi 0.84.4", process.version === EXPECTED_NODE && versionProbe.status === 0 && versionProbe.stdout.trim() === EXPECTED_PI && versionProbe.stderr === "" && catalog.probe.node === EXPECTED_NODE && thread.probe.node === EXPECTED_NODE && catalog.exit.code === 0 && thread.exit.code === 0, { node: process.version, expectedPi: EXPECTED_PI, versionProbe: { status: versionProbe.status, stdout: versionProbe.stdout, stderr: versionProbe.stderr } });
check("2 catalog real Pi answers harmless get_state", catalog.response.success === true && catalog.response.command === "get_state" && catalog.ready.mode === "rpc", catalog.response);
check("3 catalog appends exactly one no-extensions", catalog.probe.argv.filter((arg) => arg === "--no-extensions").length === 1 && catalog.probe.argv.at(-1) === "--no-extensions" && catalog.probe.argv.filter((arg) => arg === "--extension").length === 1, catalog.probe.argv);
check("4 catalog roots are fresh and isolated", catalogRoots.every((path) => typeof path === "string" && path.includes("bb-meta-catalog-") && !path.startsWith("/Users/nour/.pi")) && new Set(catalogRoots).size === catalogRoots.length && catalog.probe.cwd.includes("bb-meta-catalog-") && catalog.probe.cwd.endsWith("/workspace") && catalog.probe.cwd !== catalogCwd && catalog.probe.stagedIdentity === true, catalog.probe);
check("5 catalog strips inherited identity", catalog.probe.poisoned.length === 0 && catalog.probe.env.BB_THREAD_ID === null && catalog.probe.env.PI_BB_CATALOG_CANARY === "1", catalog.probe);
check("6 catalog loads explicit fixture only with no production mutation", !existsSync(poisonMarker) && productionTargets.map(sha).every((value, index) => value === productionBefore[index]), { poisonLoaded: existsSync(poisonMarker), productionBefore, productionAfter: productionTargets.map(sha) });
check("7 catalog preserves fd3 and fd4 round trip", catalog.probe.fd3 === true && catalog.probe.fd4 === true && catalog.ack.value === "catalog-round-trip", { probe: catalog.probe, ack: catalog.ack });
check("8 thread real Pi answers harmless get_state", thread.response.success === true && thread.response.command === "get_state" && thread.ready.mode === "rpc", thread.response);
check("9 thread preserves normal provider argv", thread.probe.cwd === threadCwd && thread.probe.argv.filter((arg) => arg === "--no-extensions").length === 0 && thread.probe.argv.filter((arg) => arg === "--extension").length === 1 && thread.probe.argv.includes(sessionFile) && thread.probe.argv.includes(realpathSync(systemPrompt)) && thread.probe.argv.includes(skillRoot) && thread.probe.argv.includes("openai-codex/gpt-5.6-sol") && thread.probe.argv.includes("high"), thread.probe);
check("10 thread uses only the curated profile roots", thread.probe.env.HOME === join(profile, "home") && thread.probe.env.PI_CODING_AGENT_DIR === profile && thread.probe.env.TMPDIR === join(profile, "tmp") && thread.probe.env.XDG_CONFIG_HOME === join(profile, "xdg-config"), thread.probe.env);
check("11 all ten required public tools exist exactly once", [...requiredOwners.keys()].every((name) => tools.filter((tool) => tool.name === name).length === 1) && curatedTools.length === 10, curatedTools);
check("12 every required tool has its sole curated owner", [...requiredOwners].every(([name, path]) => tools.some((tool) => tool.name === name && tool.path === path)) && curatedTools.every((tool) => requiredOwners.get(tool.name) === tool.path), curatedTools);
check("13 thread strips poison and installs only trusted BB correlation roots", thread.probe.poisoned.length === 0 && thread.probe.env.BB_THREAD_ID === "thread-canary" && thread.probe.env.BB_PROJECT_ID === "project-canary" && thread.probe.env.BB_ENVIRONMENT_ID === "environment-canary" && thread.probe.env.BB_SERVER_URL === "http://127.0.0.1:38886" && thread.probe.env.PI_DETACH_BB_HOST_ID === "host-canary" && thread.probe.env.PI_DETACH_STATE_ROOT === detachStateRoot && thread.probe.env.ADVISOR_STATE_ROOT === advisorRoot && thread.probe.env.PI_BB_TOOLS_FILE === null, thread.probe);
check("14 thread preserves fd3 and fd4 round trip", thread.probe.fd3 === true && thread.probe.fd4 === true && thread.ack.value === "thread-round-trip", { probe: thread.probe, ack: thread.ack });
for (const [name, rejected] of rejects) {
  check(`reject ${name} exits 64 before Pi`, rejected.exit.code === 64 && rejected.exit.signal === null && rejected.channel.length === 0 && /bb-meta-pi-wrapper:/u.test(rejected.stderr), rejected);
}

const counts = {
  assertions: assertions.length,
  passed: assertions.filter((item) => item.status === "PASS").length,
  failed: assertions.filter((item) => item.status === "FAIL").length,
  realPiChildren: 2,
  exit64Rejects: rejects.filter(([, item]) => item.exit.code === 64).length,
};
const resultPath = join(root, "result.json");
writeFileSync(resultPath, `${JSON.stringify({ status: counts.failed === 0 ? "PASS" : "FAIL", root, counts, assertions }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: counts.failed === 0 ? "PASS" : "FAIL", counts, resultPath }, null, 2));
if (assertions.length !== 19 || counts.failed !== 0) process.exitCode = 1;
