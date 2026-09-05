import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "meta-harness.mjs");

function runWith(options, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function run(...args) {
  return runWith({}, ...args);
}

function hookGroups(snippet) {
  return Object.values(snippet.hooks).flat();
}

function hookCommands(snippet) {
  return hookGroups(snippet).flatMap((group) => group.hooks.map((hook) => hook.command));
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry.source;
}

async function temporaryTarget() {
  return realpath(await mkdtemp(join(tmpdir(), "pi-meta-harness-")));
}

test("plan does not create the sandbox target", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  const result = run("plan", "--target", target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO reload/);
  assert.match(result.stdout, /MATERIALIZE selected guide -> advisor-intelligence\.json/);
  assert.match(result.stdout, /COPY  extensions\/herdr-blocked-bridge\.ts -> extensions\/herdr-blocked-bridge\.ts/);
  assert.match(result.stdout, /NEVER mutate bg-agent-profiles\.json/);
  assert.match(result.stdout, /REFUSE install before mutation when ACTIVE and advisor-intelligence\.json are inconsistent/);
  assert.match(result.stdout, /MATERIALIZE config\/advisor-core\/hosts\/claude-code\/hooks\.json/);
  await assert.rejects(readFile(join(target, "settings.json")));
  await rm(parent, { recursive: true, force: true });
});

test("install merges user settings, copies the harness, and is idempotent", async () => {
  const target = await temporaryTarget();
  const removedModels = JSON.parse(
    await readFile(join(ROOT, "config", "model-removals.json"), "utf8"),
  );
  await writeFile(
    join(target, "settings.json"),
    `${JSON.stringify({ packages: ["npm:custom-package@1.0.0", "npm:pi-footer@0.5.1", "npm:pi-claude-bridge@^0.7.0", "git:https://github.com/nourhelmi/pi-powerline@old", "git:https://github.com/nourhelmi/pi-detach@old"], enabledModels: ["custom/model", ...removedModels], customSetting: true, defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol", defaultThinkingLevel: "high" }, null, 2)}\n`,
  );
  await writeFile(
    join(target, "mcp.json"),
    `${JSON.stringify({ mcpServers: { retained: { command: "true" } } }, null, 2)}\n`,
  );

  const first = run("install", "--target", target);
  assert.equal(first.status, 0, first.stderr);
  const settingsPath = join(target, "settings.json");
  const firstSettingsText = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(firstSettingsText);
  const packageSources = settings.packages.map(packageSource);
  assert.equal(settings.customSetting, true);
  assert.equal(settings.defaultProvider, "openai-codex");
  assert.equal(settings.defaultModel, "gpt-5.6-sol");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert(settings.enabledModels.includes("custom/model"));
  for (const model of removedModels) assert(!settings.enabledModels.includes(model));
  assert(!settings.enabledModels.includes("claude-bridge/claude-fable-5"));
  assert(packageSources.includes("npm:custom-package@1.0.0"));
  assert(packageSources.includes("git:https://github.com/nourhelmi/pi-detach"));
  assert(packageSources.includes("npm:@ogulcancelik/pi-codex-compaction@^0.1.4"));
  assert(packageSources.includes("npm:pi-better-edit@^1.4.3"));
  assert(packageSources.includes("npm:pi-claude-agent-sdk@^0.8.6"));
  assert(!packageSources.includes("npm:pi-claude-bridge@^0.7.0"));
  assert(packageSources.includes("npm:pi-mermaid@^0.3.0"));
  assert(packageSources.includes("git:https://github.com/Davidcreador/pi-ui-pack@322d857080524477309e9d14d1c38312515e1913"));
  assert(packageSources.includes("git:https://github.com/Davidcreador/pi-skill-tags@6cdf0f67041a175edb17d83e0b0739a6544ef927"));
  assert(!packageSources.includes("npm:pi-footer@0.5.1"));
  assert(!packageSources.some((entry) => entry.includes("nourhelmi/pi-powerline")));
  assert(!packageSources.includes("git:https://github.com/nourhelmi/pi-detach@old"));
  assert(!packageSources.includes("packages/pi-openai-server-compaction"));
  assert.equal(settings.theme, "tokyo-night");
  assert(!packageSources.some((entry) => entry.includes("mitsuhiko/agent-stuff")));

  const unifiedEdit = await readFile(join(target, "extensions", "unified-edit-fallback", "upstream.ts"));
  assert.equal(
    createHash("sha256").update(unifiedEdit).digest("hex"),
    "7c878434810cb48d4127efba9f8b5c77e65b36d679e1893563c37ca9f48cf1d1",
  );
  assert.match(unifiedEdit.toString("utf8"), /name: "edit"/);

  const uiPack = JSON.parse(await readFile(join(target, "ui-pack.config.json"), "utf8"));
  assert.equal(uiPack.toolCards, "builtin");
  assert.equal(uiPack.herdrStatus, true);
  assert.equal(uiPack.frameStyle, "heavy");
  assert.deepEqual(uiPack.top, ["logo", "model", "project", "branch", "cost"]);
  assert.deepEqual(uiPack.bottom, ["subagents", "context", "elapsed", "thinking"]);

  await assert.rejects(readFile(join(target, "openai-server-compaction.json")));
  await assert.rejects(readFile(join(target, "packages", "pi-detach", "package.json")));
  await assert.rejects(readFile(join(target, "packages", "pi-openai-server-compaction", "package.json")));

  const mcp = JSON.parse(await readFile(join(target, "mcp.json"), "utf8"));
  assert(mcp.mcpServers.retained);
  assert(mcp.mcpServers.engram);
  assert(mcp.mcpServers.figma);
  assert.equal(mcp.mcpServers.newrelic.env.NEW_RELIC_API_KEY, "${NEW_RELIC_API_KEY}");
  assert.equal(mcp.mcpServers.context7.headers.CONTEXT7_API_KEY, "${CONTEXT7_API_KEY}");

  const roles = JSON.parse(await readFile(join(target, "bg-agent-profiles.json"), "utf8"));
  assert.deepEqual(Object.keys(roles).sort(), ["defaultAgent", "profiles"]);
  assert.equal(roles.profiles.planner.skill, "advisor-role-planner");
  assert.equal(roles.profiles.builder.maxTurns, 6);
  assert.equal(roles.profiles.foreman.skill, "advisor-role-foreman");
  assert.equal(roles.profiles.foreman.harness, "pi");
  assert(roles.profiles.foreman.cliArgs.includes("--advisor-worker-allow-subagents"));
  assert.equal("allowSubagents" in roles.profiles.foreman, false);
  assert.equal("excludeTools" in roles.profiles.foreman, false);
  assert.equal(roles.profiles.checker.requireAnchor, true);
  assert.equal(roles.profiles.scout.skillPath, "skills/advisor-worker/roles/scout/SKILL.md");
  assert.equal(roles.profiles["browser-verifier"].skillPath, "skills/advisor-worker/roles/browser-verifier/SKILL.md");

  assert.equal("models" in roles, false);
  assert.equal("allowedModels" in roles.profiles.builder, false);
  assert.match(await readFile(join(target, "skills", "advisor-native", "SKILL.md"), "utf8"), /workerHarness: "native"/);
  assert.match(await readFile(join(target, "skills", "advisor-pi", "SKILL.md"), "utf8"), /workerHarness: "pi"/);
  const guide = JSON.parse(await readFile(join(target, "advisor-intelligence.json"), "utf8"));
  assert.equal(guide.name, "codex-max");
  assert.equal(guide.recommendations.planner[0].model, "claude-bridge/claude-fable-5-1");
  assert.equal(guide.recommendations.checker[0].model, "openai-codex/gpt-5.6-sol");
  assert.equal(guide.recommendations.checker[0].thinking, "high");
  assert.equal(guide.recommendations.builder[0].thinking, "xhigh");
  assert.equal(await readFile(join(target, "intelligence-profiles", "ACTIVE"), "utf8"), "codex-max\n");
  assert(settings.enabledModels.includes("claude-bridge/claude-fable-5-1"));
  assert(settings.enabledModels.includes("claude-bridge/claude-sonnet-5"));
  assert.equal(await readFile(join(target, "bg-agent-profiles.json"), "utf8"), await readFile(join(ROOT, "config", "bg-agent-profiles.json"), "utf8"));
  assert.equal(await readFile(join(target, "advisor-intelligence.json"), "utf8"), await readFile(join(ROOT, "config", "intelligence-profiles", "codex-max.json"), "utf8"));

  const second = run("install", "--target", target);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(settingsPath, "utf8"), firstSettingsText);

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
  assert.match(doctor.stdout, /Doctor passed/);
  await rm(target, { recursive: true, force: true });
});

test("install materializes self-contained advisor host bindings with absolute commands", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);

  const installedTrace = join(target, "advisor-hosts", "scripts", "advisor-trace.mjs");
  const validation = spawnSync(process.execPath, [
    installedTrace,
    "validate",
    join(ROOT, "config", "advisor-core", "fixtures", "one-worker-done.jsonl"),
  ], { encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /ok: 7 event\(s\)/);
  await stat(join(target, "advisor-hosts", "scripts", "advisor-core", "advisor-state.d.mts"));
  await stat(join(target, "advisor-hosts", "config", "advisor-core", "canonical-events.schema.json"));

  const expected = {
    "claude-code": {
      path: join(target, "advisor-hosts", "claude-code", "settings-snippet.json"),
      script: join(target, "advisor-hosts", "scripts", "claude-advisor-trace.mjs"),
      groups: 5,
    },
    codex: {
      path: join(target, "advisor-hosts", "codex", "hooks.json"),
      script: join(target, "advisor-hosts", "scripts", "codex-advisor-trace.mjs"),
      groups: 4,
    },
  };
  for (const [host, details] of Object.entries(expected)) {
    const text = await readFile(details.path, "utf8");
    const snippet = JSON.parse(text);
    assert.equal(hookGroups(snippet).length, details.groups);
    assert(hookCommands(snippet).every((command) => command === `node ${details.script}`));
    assert.doesNotMatch(text, /node scripts\//);
    if (host === "claude-code") {
      assert.equal(snippet.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    }
  }
  await rm(parent, { recursive: true, force: true });
});

test("install-host-bindings merges Claude Code user settings with backup and byte idempotency", async () => {
  const parent = await temporaryTarget();
  const home = join(parent, "home");
  const agentDir = join(parent, "agent");
  const claudeDir = join(home, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const original = {
    env: { FOO: "kept" },
    hooks: {
      SessionStart: [{
        matcher: "*",
        hooks: [{ type: "command", command: "existing-session-start" }],
      }],
    },
  };
  const originalText = `${JSON.stringify(original, null, 2)}\n`;
  await mkdir(claudeDir, { recursive: true });
  await writeFile(settingsPath, originalText);
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
  assert.equal(run("install", "--target", agentDir).status, 0);

  const first = runWith(
    { env },
    "install-host-bindings",
    "--host",
    "claude-code",
    "--scope",
    "user",
  );
  assert.equal(first.status, 0, first.stderr);
  const firstText = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(firstText);
  assert.deepEqual(settings.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  assert.equal(settings.env.FOO, "kept");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  const command = `node ${join(agentDir, "advisor-hosts", "scripts", "claude-advisor-trace.mjs")}`;
  assert.equal(hookCommands(settings).filter((candidate) => candidate === command).length, 5);
  assert.equal(
    await readFile(join(claudeDir, "agents", "advisor-maker.md"), "utf8"),
    await readFile(join(agentDir, "advisor-hosts", "claude-code", "agents", "advisor-maker.md"), "utf8"),
  );
  const backup = first.stdout.match(/^Backup: (.+)$/m)?.[1];
  assert(backup);
  assert.equal(await readFile(join(backup, "files", "settings.json"), "utf8"), originalText);

  const second = runWith(
    { env },
    "install-host-bindings",
    "--host",
    "claude-code",
    "--scope",
    "user",
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(settingsPath, "utf8"), firstText);
  await rm(parent, { recursive: true, force: true });
});

test("install-host-bindings merges Codex project hooks without touching config.toml", async () => {
  const parent = await temporaryTarget();
  const home = join(parent, "home");
  const agentDir = join(parent, "agent");
  const project = join(parent, "project");
  const projectCodex = join(project, ".codex");
  const homeCodex = join(home, ".codex");
  const hooksPath = join(projectCodex, "hooks.json");
  const projectConfig = join(projectCodex, "config.toml");
  const homeConfig = join(homeCodex, "config.toml");
  const existingStop = [{ hooks: [{ type: "command", command: "existing-stop" }] }];
  await mkdir(projectCodex, { recursive: true });
  await mkdir(homeCodex, { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify({ hooks: { Stop: existingStop } }, null, 2)}\n`);
  await writeFile(projectConfig, "notify = [\"project-sentinel\"]\n");
  await writeFile(homeConfig, "notify = [\"home-sentinel\"]\n");
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
  assert.equal(run("install", "--target", agentDir).status, 0);

  const install = runWith(
    { env },
    "install-host-bindings",
    "--host",
    "codex",
    "--scope",
    "project",
    "--cwd",
    project,
  );
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Codex hooks require trust via \/hooks/);
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(hooks.hooks.Stop, existingStop);
  const command = `node ${join(agentDir, "advisor-hosts", "scripts", "codex-advisor-trace.mjs")}`;
  assert.equal(hookCommands(hooks).filter((candidate) => candidate === command).length, 4);
  assert.equal(
    await readFile(join(projectCodex, "agents", "advisor-maker.toml"), "utf8"),
    await readFile(join(agentDir, "advisor-hosts", "codex", "agents", "advisor-maker.toml"), "utf8"),
  );
  assert.equal(await readFile(projectConfig, "utf8"), "notify = [\"project-sentinel\"]\n");
  assert.equal(await readFile(homeConfig, "utf8"), "notify = [\"home-sentinel\"]\n");
  await assert.rejects(readFile(join(homeCodex, "hooks.json")));
  await rm(parent, { recursive: true, force: true });
});

test("install-host-bindings supports the remaining scope targets and preserves a Claude env override", async () => {
  const parent = await temporaryTarget();
  const home = join(parent, "home");
  const agentDir = join(parent, "agent");
  const project = join(parent, "project");
  const claudeSettings = join(project, ".claude", "settings.local.json");
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
  await mkdir(dirname(claudeSettings), { recursive: true });
  await writeFile(
    claudeSettings,
    `${JSON.stringify({ env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" } }, null, 2)}\n`,
  );
  assert.equal(run("install", "--target", agentDir).status, 0);

  const claude = runWith(
    { env },
    "install-host-bindings",
    "--host",
    "claude-code",
    "--scope",
    "project",
    "--cwd",
    project,
  );
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(
    JSON.parse(await readFile(claudeSettings, "utf8")).env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    "0",
  );
  await stat(join(project, ".claude", "agents", "advisor-maker.md"));

  const codex = runWith(
    { env },
    "install-host-bindings",
    "--host",
    "codex",
    "--scope",
    "user",
  );
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(hookGroups(JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"))).length, 4);
  await stat(join(home, ".codex", "agents", "advisor-maker.toml"));
  await assert.rejects(readFile(join(project, ".codex", "hooks.json")));
  await rm(parent, { recursive: true, force: true });
});

test("install-host-bindings dry-run plans changes without writing", async () => {
  const parent = await temporaryTarget();
  const home = join(parent, "home");
  const agentDir = join(parent, "agent");
  const claudeDir = join(home, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const agentPath = join(claudeDir, "agents", "advisor-maker.md");
  await mkdir(dirname(agentPath), { recursive: true });
  await writeFile(settingsPath, "{\n  \"existing\": true\n}\n");
  await writeFile(agentPath, "existing agent\n");
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
  assert.equal(run("install", "--target", agentDir).status, 0);
  const settingsBefore = await readFile(settingsPath);
  const agentBefore = await readFile(agentPath);
  const settingsStat = await stat(settingsPath);
  const agentStat = await stat(agentPath);

  const dryRun = runWith(
    { env },
    "install-host-bindings",
    "--host",
    "claude-code",
    "--scope",
    "user",
    "--dry-run",
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /DRY RUN/);
  assert.match(dryRun.stdout, /Would update configuration/);
  assert.match(dryRun.stdout, /Would update agent definition/);
  assert.deepEqual(await readFile(settingsPath), settingsBefore);
  assert.deepEqual(await readFile(agentPath), agentBefore);
  assert.equal((await stat(settingsPath)).mtimeMs, settingsStat.mtimeMs);
  assert.equal((await stat(agentPath)).mtimeMs, agentStat.mtimeMs);
  await assert.rejects(stat(join(claudeDir, "backups")));
  await rm(parent, { recursive: true, force: true });
});

test("doctor reports resolvable advisor host snippets and warns when absent", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  assert.equal(run("install", "--target", target).status, 0);
  const installed = run("doctor", "--target", target);
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.match(installed.stdout, /Advisor host bindings installed:/);
  assert.equal((installed.stdout.match(/Advisor host snippet resolves:/g) ?? []).length, 2);

  await rm(join(target, "advisor-hosts"), { recursive: true, force: true });
  const absent = run("doctor", "--target", target);
  assert.equal(absent.status, 0, `${absent.stdout}\n${absent.stderr}`);
  assert.match(absent.stderr, /Warning: advisor-hosts\/ is not installed/);
  await rm(parent, { recursive: true, force: true });
});

test("worker runtime uses instructional boundaries without tool blocking", async () => {
  const worker = await readFile(join(ROOT, "extensions", "advisor-worker.ts"), "utf8");
  assert.match(worker, /Never invoke \/advisor, advisor_session_init, another agent/);
  assert.doesNotMatch(worker, /tool_call/);
  assert.doesNotMatch(worker, /action: "handled"/);
});

test("advisor extension exposes new-tab launch and pane-label behavior", async () => {
  const extension = await readFile(join(ROOT, "extensions", "advisor-session.ts"), "utf8");
  assert.match(extension, /name: "advisor_launch"/);
  assert.match(extension, /\["tab", "create", "--no-focus", "--cwd", cwd, "--label", label\]/);
  assert.match(extension, /\["pane", "rename", paneId, label\]/);
  assert.match(extension, /\["pane", "run", paneId, "pi"\]/);
  assert.match(extension, /\["agent", "prompt", paneId, bootstrap\]/);
  assert.match(extension, /advisorPaneLabel\(workstream\)/);
  assert.doesNotMatch(extension, /\["pane", "split"/);
});

test("doctor rejects unified edit snapshot drift", async () => {
  const target = await temporaryTarget();
  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  await writeFile(join(target, "extensions", "unified-edit.ts"), "modified extension\n");

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Drift: extensions\/unified-edit\.ts/);
  await rm(target, { recursive: true, force: true });
});

test("doctor rejects invalid fixed roles and advisor guidance", async () => {
  const target = await temporaryTarget();
  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  const rolesPath = join(target, "bg-agent-profiles.json");
  const roles = JSON.parse(await readFile(rolesPath, "utf8"));
  roles.profiles.checker.requireAnchor = false;
  roles.profiles.builder.allowedModels = ["missing/model"];
  await writeFile(rolesPath, `${JSON.stringify(roles, null, 2)}\n`);
  const guidePath = join(target, "advisor-intelligence.json");
  const guide = JSON.parse(await readFile(guidePath, "utf8"));
  guide.recommendations.builder[0].model = "missing/model";
  await writeFile(guidePath, `${JSON.stringify(guide, null, 2)}\n`);

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Role does not require an anchor: checker/);
  assert.match(doctor.stderr, /Role builder contains intelligence policy field: allowedModels/);
  assert.match(doctor.stderr, /Active intelligence profile mismatch: ACTIVE names codex-max, but advisor-intelligence\.json matches no installed named profile/);
  await rm(target, { recursive: true, force: true });
});

test("doctor and reinstall reject a missing ACTIVE pointer", async () => {
  const target = await temporaryTarget();
  assert.equal(run("install", "--target", target).status, 0);
  const livePath = join(target, "advisor-intelligence.json");
  const liveBefore = await readFile(livePath);
  await rm(join(target, "intelligence-profiles", "ACTIVE"));

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Missing active intelligence profile pointer: intelligence-profiles\/ACTIVE/);
  const reinstall = run("install", "--target", target);
  assert.equal(reinstall.status, 1);
  assert.match(reinstall.stderr, /Refusing install because the active intelligence selection is inconsistent/);
  assert.match(reinstall.stderr, /Repair explicitly with:/);
  assert.deepEqual(await readFile(livePath), liveBefore);
  await assert.rejects(readFile(join(target, "intelligence-profiles", "ACTIVE")));
  await rm(target, { recursive: true, force: true });
});

test("doctor rejects empty and unknown ACTIVE pointers", async () => {
  const target = await temporaryTarget();
  assert.equal(run("install", "--target", target).status, 0);
  const active = join(target, "intelligence-profiles", "ACTIVE");

  await writeFile(active, "\n");
  const empty = run("doctor", "--target", target);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Active intelligence profile pointer is empty/);

  await writeFile(active, "not-a-profile\n");
  const unknown = run("doctor", "--target", target);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /ACTIVE names unknown installed intelligence profile: not-a-profile/);
  const reinstall = run("install", "--target", target);
  assert.equal(reinstall.status, 1);
  assert.match(reinstall.stderr, /ACTIVE names unknown installed intelligence profile: not-a-profile/);
  await rm(target, { recursive: true, force: true });
});

test("doctor and reinstall reject a stale ACTIVE pointer without reversing live guidance", async () => {
  const target = await temporaryTarget();
  assert.equal(run("install", "--target", target).status, 0);
  const active = join(target, "intelligence-profiles", "ACTIVE");
  const live = join(target, "advisor-intelligence.json");
  const liveBefore = await readFile(live);
  await writeFile(active, "codex-lean\n");

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Active intelligence profile mismatch: ACTIVE names codex-lean, but advisor-intelligence\.json matches codex-max/);
  const reinstall = run("install", "--target", target);
  assert.equal(reinstall.status, 1);
  assert.match(reinstall.stderr, /Refusing install/);
  assert.deepEqual(await readFile(live), liveBefore);
  assert.equal(await readFile(active, "utf8"), "codex-lean\n");
  const repair = spawnSync(process.execPath, [
    join(ROOT, "scripts", "intelligence-profile.mjs"),
    "codex-lean",
    "--target",
    target,
  ], { encoding: "utf8" });
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(run("doctor", "--target", target).status, 0);
  await rm(target, { recursive: true, force: true });
});

test("doctor catches an interrupted switch before reinstall", async () => {
  const target = await temporaryTarget();
  assert.equal(run("install", "--target", target).status, 0);
  const live = join(target, "advisor-intelligence.json");
  await cp(join(target, "intelligence-profiles", "codex-lean.json"), live);

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Active intelligence profile mismatch: ACTIVE names codex-max, but advisor-intelligence\.json matches codex-lean/);
  const reinstall = run("install", "--target", target);
  assert.equal(reinstall.status, 1);
  assert.deepEqual(await readFile(live), await readFile(join(target, "intelligence-profiles", "codex-lean.json")));
  await rm(target, { recursive: true, force: true });
});

test("doctor rejects a package source that does not match its configured range", async () => {
  const target = await temporaryTarget();
  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  const path = join(target, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.packages = settings.packages.map((entry) =>
    entry === "npm:pi-mermaid@^0.3.0" ? "npm:pi-mermaid@^0.2.0" : entry,
  );
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Pi package source does not match the configured range or commit: npm:pi-mermaid@\^0\.3\.0/);
  await rm(target, { recursive: true, force: true });
});

test("restore rejects traversal before it can remove an outside file", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  const backup = join(target, "backups", "pi-meta-harness", "malicious");
  const sentinel = join(parent, "sentinel.txt");
  await mkdir(backup, { recursive: true });
  await writeFile(sentinel, "must remain\n");
  await writeFile(
    join(backup, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      target,
      entries: [{ destination: "../sentinel.txt", wasPresent: false }],
    }, null, 2)}\n`,
  );

  const restore = run("restore", "--target", target, "--backup", backup);
  assert.equal(restore.status, 1);
  assert.match(restore.stderr, /destination is not allowed/);
  assert.equal(await readFile(sentinel, "utf8"), "must remain\n");
  await rm(parent, { recursive: true, force: true });
});

test("retired skill traversal is rejected before outside mutation", async () => {
  const parent = await temporaryTarget();
  const sourceRoot = join(parent, "source");
  const home = join(parent, "home");
  const agentDir = join(home, ".pi", "agent");
  const piVictim = join(home, ".pi", "victim", "sentinel.txt");
  const homeVictim = join(home, "victim", "sentinel.txt");
  await cp(join(ROOT, "scripts"), join(sourceRoot, "scripts"), { recursive: true });
  await mkdir(join(sourceRoot, "config"), { recursive: true });
  await writeFile(join(sourceRoot, "config", "skill-sources.json"), '{"schemaVersion":2,"groups":[]}\n');
  await writeFile(join(sourceRoot, "config", "skill-removals.json"), '["../../victim"]\n');
  await mkdir(resolve(piVictim, ".."), { recursive: true });
  await mkdir(resolve(homeVictim, ".."), { recursive: true });
  await writeFile(piVictim, "must remain\n");
  await writeFile(homeVictim, "must remain\n");

  const install = spawnSync(
    process.execPath,
    [join(sourceRoot, "scripts", "meta-harness.mjs"), "install-skills", "--live", "--allow-active"],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
    },
  );
  assert.equal(install.status, 1);
  assert.match(install.stderr, /Skill removal manifest contains an unsafe skill name/);
  assert.equal(await readFile(piVictim, "utf8"), "must remain\n");
  assert.equal(await readFile(homeVictim, "utf8"), "must remain\n");
  await rm(parent, { recursive: true, force: true });
});

test("restore rejects a managed parent symlink before outside mutation", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  const outside = join(parent, "outside");
  const sentinel = join(outside, "advisor-graph.ts");
  await mkdir(outside, { recursive: true });
  await writeFile(sentinel, "must remain\n");

  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  const state = JSON.parse(await readFile(join(target, ".pi-meta-harness-state.json"), "utf8"));
  await rm(join(target, "extensions"), { recursive: true, force: true });
  await symlink(outside, join(target, "extensions"), "dir");

  const restore = run("restore", "--target", target, "--backup", state.backup);
  assert.equal(restore.status, 1);
  assert.match(restore.stderr, /parent symlink outside its root/);
  assert.equal(await readFile(sentinel, "utf8"), "must remain\n");
  await rm(parent, { recursive: true, force: true });
});

test("restore rejects a backup files-root symlink before target mutation", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  const original = join(target, "extensions", "advisor-graph.ts");
  const outside = join(parent, "outside");
  await mkdir(join(target, "extensions"), { recursive: true });
  await writeFile(original, "original before install\n");

  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  const installedContents = await readFile(original, "utf8");
  const state = JSON.parse(await readFile(join(target, ".pi-meta-harness-state.json"), "utf8"));
  await mkdir(join(outside, "extensions"), { recursive: true });
  await writeFile(join(outside, "extensions", "advisor-graph.ts"), "outside source\n");
  await rm(join(state.backup, "files"), { recursive: true, force: true });
  await symlink(outside, join(state.backup, "files"), "dir");

  const restore = run("restore", "--target", target, "--backup", state.backup);
  assert.equal(restore.status, 1);
  assert.match(restore.stderr, /Backup source follows a symlink outside its files root/);
  assert.equal(await readFile(original, "utf8"), installedContents);
  await rm(parent, { recursive: true, force: true });
});

test("doctor rejects generated Taskplane state in the source repository", async () => {
  const parent = await temporaryTarget();
  const sourceRoot = join(parent, "source");
  const target = join(parent, "target");
  await mkdir(sourceRoot, { recursive: true });
  for (const entry of ["scripts", "config", "extensions", "skills", "herdr"]) {
    await cp(join(ROOT, entry), join(sourceRoot, entry), { recursive: true });
  }
  await mkdir(join(sourceRoot, ".pi"), { recursive: true });
  await writeFile(join(sourceRoot, ".pi", "taskplane.json"), "{\"runtime\":true}\n");
  const copiedScript = join(sourceRoot, "scripts", "meta-harness.mjs");
  const install = spawnSync(process.execPath, [copiedScript, "install", "--target", target], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  const doctor = spawnSync(process.execPath, [copiedScript, "doctor", "--target", target], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Forbidden runtime-state path: \.pi\/taskplane\.json/);
  await rm(parent, { recursive: true, force: true });
});

test("restore returns existing files and removes newly managed files", async () => {
  const target = await temporaryTarget();
  await mkdir(join(target, "extensions"), { recursive: true });
  await writeFile(join(target, "extensions", "advisor-graph.ts"), "original extension\n");
  await writeFile(join(target, "settings.json"), "{\n  \"original\": true\n}\n");

  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  const state = JSON.parse(await readFile(join(target, ".pi-meta-harness-state.json"), "utf8"));

  const restore = run("restore", "--target", target, "--backup", state.backup);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(await readFile(join(target, "extensions", "advisor-graph.ts"), "utf8"), "original extension\n");
  assert.equal(await readFile(join(target, "settings.json"), "utf8"), "{\n  \"original\": true\n}\n");
  await assert.rejects(readFile(join(target, "bg-agent-profiles.json")));
  await assert.rejects(readFile(join(target, "advisor-intelligence.json")));
  await assert.rejects(readFile(join(target, "advisor-hosts", "scripts", "advisor-trace.mjs")));
  await rm(target, { recursive: true, force: true });
});

test("Herdr configuration installs with a restorable backup", async () => {
  const target = await temporaryTarget();
  await writeFile(join(target, "config.toml"), "original = true\n");
  const install = run("install-herdr-config", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  assert.match(await readFile(join(target, "config.toml"), "utf8"), /tokyo-night/);
  assert((await readFile(join(target, "sounds", "done.mp3"))).length > 0);
  const backup = install.stdout.match(/^Backup: (.+)$/m)?.[1];
  assert(backup);

  const restore = run("restore-herdr", "--target", target, "--backup", backup);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(await readFile(join(target, "config.toml"), "utf8"), "original = true\n");
  await assert.rejects(readFile(join(target, "sounds", "done.mp3")));
  await rm(target, { recursive: true, force: true });
});

test("managed npm packages use caret ranges, first-party Git tracks latest, and third-party Git stays pinned", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, "config", "settings.overlay.json"), "utf8"));
  for (const entry of settings.packages) {
    const source = packageSource(entry);
    const caretNpm = /^npm:(?:@[^/]+\/[^@]+|[^@]+)@\^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(source);
    const exactGit = /^git:.+@[0-9a-f]{40}$/.test(source);
    const firstPartyLatest = /^git:https:\/\/github\.com\/nourhelmi\/[^/@\s]+$/.test(source);
    assert(caretNpm || exactGit || firstPartyLatest, `Package source has no approved update policy: ${source}`);
    if (source.includes("nourhelmi/pi-detach")) assert.equal(source, "git:https://github.com/nourhelmi/pi-detach");
    if (source.startsWith("git:") && !firstPartyLatest) {
      assert(exactGit, `Third-party Git package is not pinned: ${source}`);
    }
  }
});

test("plan reports first-party latest-tracking Git sources", () => {
  const plan = run("plan");
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(
    plan.stdout,
    /PACKAGE first-party latest-tracking: git:https:\/\/github\.com\/nourhelmi\/pi-detach/,
  );
});

test("exact Git pin fetch verification is explicit and bounded", async () => {
  const help = run("help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /meta-harness\.mjs verify-git-pins/);
  const script = await readFile(SCRIPT, "utf8");
  assert.match(script, /const GIT_PIN_FETCH_TIMEOUT_MS = 20_000/);
  assert.match(script, /timeout: GIT_PIN_FETCH_TIMEOUT_MS/);
  assert.match(script, /\["-C", checkout, "fetch", "--quiet", "--depth", "1", pin\.url, pin\.commit\]/);
  assert.match(script, /SKIPPED .*first-party latest-tracking; pi update refreshes origin\/HEAD/);
});

test("reviewed pi-skill-tags metadata matches its managed commit pin", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, "config", "settings.overlay.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(ROOT, "config", "third-party-extensions.lock.json"), "utf8"));
  const skillTags = lock.extensions.find((extension) => extension.name === "pi-skill-tags");
  assert.deepEqual(skillTags, {
    name: "pi-skill-tags",
    repository: "https://github.com/Davidcreador/pi-skill-tags",
    commit: "6cdf0f67041a175edb17d83e0b0739a6544ef927",
    tree: "bc7518c4b68e45d8ab6b2b3ee196911c6e757158",
    installSource: "git:https://github.com/Davidcreador/pi-skill-tags@6cdf0f67041a175edb17d83e0b0739a6544ef927",
    license: "MIT",
    package: "@davecodes/pi-skill-tags@0.1.1",
    purpose: "Add searchable inline skill tags and expand them into Pi's native skill format.",
  });
  assert(settings.packages.map(packageSource).includes(skillTags.installSource));
});

test("primary hash-anchored editor metadata matches its compatible package range", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, "config", "settings.overlay.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(ROOT, "config", "third-party-extensions.lock.json"), "utf8"));
  const betterEdit = lock.extensions.find((extension) => extension.name === "pi-better-edit");
  assert.deepEqual(betterEdit, {
    name: "pi-better-edit",
    repository: "https://github.com/Rianico/pi-better-edit",
    commit: "eb4118cb479174fa6518523e9dfe0b1edb456290",
    installSource: "npm:pi-better-edit@^1.4.3",
    integrity: "sha512-+LO1Qpe78nUmv/BZ3eor6yXub+FAhdZKA21cZvi5pJ+grYrDqlo3kjEgFq9nB3d8xL+mATA6Gh8gZlGKWiW56Q==",
    license: "MIT",
    package: "pi-better-edit@1.4.3",
    runtimeState: "~/.config/pi-better-edit/hash-store.sqlite (local only; never tracked)",
    purpose: "Provide the primary hash-anchored read, edit, and undo tools with served-range verification and reject-and-serve recovery.",
  });
  assert(settings.packages.map(packageSource).includes(betterEdit.installSource));
});

test("Claude subscription bridge metadata matches the Fable 5.1 package range", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, "config", "settings.overlay.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(ROOT, "config", "third-party-extensions.lock.json"), "utf8"));
  const bridgeConfig = JSON.parse(await readFile(join(ROOT, "config", "claude-bridge.json"), "utf8"));
  const removals = JSON.parse(await readFile(join(ROOT, "config", "package-removals.json"), "utf8"));
  const bridge = lock.extensions.find((extension) => extension.name === "pi-claude-agent-sdk");
  assert.deepEqual(bridge, {
    name: "pi-claude-agent-sdk",
    repository: "https://github.com/pi-pod/pi-claude-agent-sdk",
    commit: "5293c03fc1e250725c9e23472eec767a5a302caf",
    installSource: "npm:pi-claude-agent-sdk@^0.8.6",
    integrity: "sha512-nVyqRVm5yu78K8TbAkdY7UORg0olyn6QNNaaAKUcFsizuB961+XQdlu5qoYOzZknXXNULY0Cs45UYjy8iS01Yw==",
    license: "MIT",
    package: "pi-claude-agent-sdk@0.8.6",
    runtimeState: "~/.claude and ~/.pi/agent/claude-bridge*.log (local only; never tracked)",
    purpose: "Expose Claude Code subscription models, including Fable 5.1, as the claude-bridge provider while Pi owns tool execution.",
  });
  assert(settings.packages.map(packageSource).includes(bridge.installSource));
  assert.equal(settings.defaultProvider, "claude-bridge");
  assert.equal(settings.defaultModel, "claude-fable-5-1");
  assert(settings.enabledModels.includes("claude-bridge/claude-fable-5-1"));
  assert.equal(bridgeConfig.provider.longContextExtraUsage, false);
  assert(removals.includes("npm:pi-claude-bridge"));
});

test("skill plan preserves source attribution and all 57 skills", () => {
  const result = run("skills-plan");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^PIN https:\/\/github\.com\/.+\.git@[0-9a-f]{40} tree=[0-9a-f]{40} :: npx --yes skills@\^1\.5\.23 add <verified-checkout>/m,
  );
  assert.match(result.stdout, /vercel-labs\/agent-skills/);
  assert.match(result.stdout, /backnotprop\/plannotator/);
  assert.match(result.stdout, /plannotator-annotate/);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 19);
  const skillCount = lines.reduce((total, line) => {
    const [, values = ""] = line.split(" --skill ");
    return total + values.split(" --yes")[0].trim().split(/\s+/).filter(Boolean).length;
  }, 0);
  assert.equal(skillCount, 57);
});

test("skill lock matches every pinned source and selected skill", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "config", "skill-sources.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(ROOT, "config", "third-party-skills.lock.json"), "utf8"));
  const removals = JSON.parse(await readFile(join(ROOT, "config", "skill-removals.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(lock.schemaVersion, 4);
  assert.equal(lock.installer, "skills@^1.5.23");
  for (const group of manifest.groups) {
    assert.match(group.commit, /^[0-9a-f]{40}$/);
    assert.match(group.tree, /^[0-9a-f]{40}$/);
    for (const skill of group.skills) {
      assert.equal(lock.skills[skill].sourceUrl, group.sourceUrl);
      assert.equal(lock.skills[skill].commit, group.commit);
      assert.equal(lock.skills[skill].tree, group.tree);
      assert.match(lock.skills[skill].sha256, /^[0-9a-f]{64}$/);
    }
  }
  assert.equal(Object.keys(lock.skills).length, 57);
  assert(lock.skills.cro);
  assert(lock.skills.genmedia);
  assert.equal(lock.skills["page-cro"], undefined);
  assert.equal(lock.skills["fal-generate"], undefined);
  assert.equal(removals.length, 19);
  assert(removals.includes("page-cro"));
  assert(removals.includes("fal-generate"));
  assert(removals.every((skill) => lock.skills[skill] === undefined));
});

test("npm archive excludes credentials and runtime state", async () => {
  const bytecodeDir = join(ROOT, "evals", "harbor", "synthetic-cache", "__pycache__");
  const bytecodePath = join(bytecodeDir, "verifier.cpython-312.pyc");
  await mkdir(bytecodeDir, { recursive: true });
  await writeFile(bytecodePath, "generated bytecode sentinel");
  try {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const [manifest] = JSON.parse(result.stdout);
    const archivePaths = manifest.files.map((entry) => entry.path);
    const forbidden = archivePaths.filter((path) =>
      /(^|\/)(\.advisor|auth\.json|trust\.json|sessions|backups|__pycache__)(\/|$)|(^|\/)evals\/local(\/|$)|\.py[cod]$|(^|\/)\.env$/.test(path)
    );
    assert.deepEqual(forbidden, []);
    assert(archivePaths.includes("evals/harbor/evidence-rich-routing-defect/tests/run_rewardkit.py"));
    assert(archivePaths.includes("evals/harbor/adaptive-cross-repo-delivery/tests/run_rewardkit.py"));
    assert(archivePaths.includes("scripts/advisor-prospective.mjs"));
    assert(archivePaths.includes("scripts/advisor-prospective-manage.mjs"));
    assert(archivePaths.includes("scripts/advisor-prospective-results.mjs"));
    assert(archivePaths.includes("scripts/advisor-eval-dashboard/server.mjs"));
    assert(archivePaths.includes("scripts/advisor-eval-dashboard/index.html"));
    assert(archivePaths.includes("scripts/advisor-eval-dashboard/app.js"));
    assert(archivePaths.includes("scripts/advisor-eval-dashboard/styles.css"));
    assert(archivePaths.includes("evals/prospective/foreman-cross-repo/case.json"));
    assert(archivePaths.includes("evals/prospective/false-fail-review/tests/verify.mjs"));
    assert(archivePaths.includes("evals/baselines/prospective/builder-self-verification/phase0-canary/baseline.json"));
    assert(archivePaths.includes("evals/prospective/builder-self-verification/case.json"));
    assert(archivePaths.includes("evals/prospective/builder-self-verification/tests/verify.mjs"));
    assert(archivePaths.includes("evals/prospective/single-maker-fast-path/case.json"));
    assert(archivePaths.includes("evals/prospective/cohesive-medium-maker/case.json"));
    assert(archivePaths.includes("evals/prospective/risk-triggered-checker/case.json"));
  } finally {
    await rm(join(ROOT, "evals", "harbor", "synthetic-cache"), { recursive: true, force: true });
  }
});

test("bootstrap runs every required live stage without bypassing safety", async () => {
  const bootstrap = await readFile(join(ROOT, "scripts", "bootstrap.sh"), "utf8");
  const stages = [
    "npm ci",
    "npm test",
    "npm install --global 'agent-browser@^0.36.0'",
    "agent-browser install",
    "plan --live",
    "install --live",
    "pi update --extensions",
    "install-skills --live",
    "install-herdr-config --live",
    "install-herdr-integration --live",
    "doctor --live",
  ];
  let previous = -1;
  for (const stage of stages) {
    const index = bootstrap.indexOf(stage);
    assert(index > previous, `Missing or out-of-order bootstrap stage: ${stage}`);
    previous = index;
  }
  assert(!bootstrap.includes("--allow-active"));
});

test("install migrates a legacy mixed config with a known ACTIVE selection and restore returns it", async () => {
  const target = await temporaryTarget();
  const legacyRoles = `${JSON.stringify({ defaultAgent: "pi", models: { "legacy/model": {} }, profiles: {} }, null, 2)}\n`;
  await mkdir(join(target, "intelligence-profiles"), { recursive: true });
  await writeFile(join(target, "bg-agent-profiles.json"), legacyRoles);
  await writeFile(join(target, "intelligence-profiles", "ACTIVE"), "anthropic-heavy\n");

  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Intelligence selection: anthropic-heavy \(legacy\)/);
  assert.equal(await readFile(join(target, "intelligence-profiles", "ACTIVE"), "utf8"), "anthropic-heavy\n");
  assert.equal(
    await readFile(join(target, "advisor-intelligence.json"), "utf8"),
    await readFile(join(ROOT, "config", "intelligence-profiles", "anthropic-heavy.json"), "utf8"),
  );
  assert.equal(run("doctor", "--target", target).status, 0);

  const state = JSON.parse(await readFile(join(target, ".pi-meta-harness-state.json"), "utf8"));
  const restore = run("restore", "--target", target, "--backup", state.backup);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(await readFile(join(target, "bg-agent-profiles.json"), "utf8"), legacyRoles);
  assert.equal(await readFile(join(target, "intelligence-profiles", "ACTIVE"), "utf8"), "anthropic-heavy\n");
  await assert.rejects(readFile(join(target, "advisor-intelligence.json")));
  await rm(target, { recursive: true, force: true });
});

test("reinstall keeps a switched intelligence profile", async () => {
  const target = await temporaryTarget();
  const first = run("install", "--target", target);
  assert.equal(first.status, 0, first.stderr);
  const switched = spawnSync(process.execPath, [
    join(ROOT, "scripts", "intelligence-profile.mjs"),
    "codex-lean",
    "--target",
    target,
  ], { encoding: "utf8" });
  assert.equal(switched.status, 0, switched.stderr);
  const fixedRoles = await readFile(join(target, "bg-agent-profiles.json"));
  const second = run("install", "--target", target);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(target, "intelligence-profiles", "ACTIVE"), "utf8"), "codex-lean\n");
  assert.deepEqual(await readFile(join(target, "bg-agent-profiles.json")), fixedRoles);
  const guide = JSON.parse(await readFile(join(target, "advisor-intelligence.json"), "utf8"));
  assert.equal(guide.name, "codex-lean");
  assert.equal(guide.recommendations.planner[0].model, "openai-codex/gpt-5.6-sol");
  assert.equal(guide.recommendations.builder[1].model, "claude-bridge/claude-sonnet-5");
  assert(!Object.keys(guide.models).some((id) => id.startsWith("cursor/")));
  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
  await rm(target, { recursive: true, force: true });
});
