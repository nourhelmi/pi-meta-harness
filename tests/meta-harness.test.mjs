import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "meta-harness.mjs");

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry.source;
}

async function temporaryTarget() {
  return mkdtemp(join(tmpdir(), "pi-meta-harness-"));
}

test("plan does not create the sandbox target", async () => {
  const parent = await temporaryTarget();
  const target = join(parent, "agent");
  const result = run("plan", "--target", target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO reload/);
  assert.match(result.stdout, /MATERIALIZE selected guide -> advisor-intelligence\.json/);
  assert.match(result.stdout, /NEVER mutate bg-agent-profiles\.json/);
  assert.match(result.stdout, /REFUSE install before mutation when ACTIVE and advisor-intelligence\.json are inconsistent/);
  await assert.rejects(readFile(join(target, "settings.json")));
  await rm(parent, { recursive: true, force: true });
});

test("install merges user settings, copies the harness, and is idempotent", async () => {
  const target = await temporaryTarget();
  await writeFile(
    join(target, "settings.json"),
    `${JSON.stringify({ packages: ["npm:custom-package@1.0.0", "npm:pi-footer@0.5.1", "git:https://github.com/nourhelmi/pi-powerline@old", "git:https://github.com/nourhelmi/pi-detach@old"], customSetting: true, defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol", defaultThinkingLevel: "high" }, null, 2)}\n`,
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
  assert(packageSources.includes("npm:custom-package@1.0.0"));
  assert(packageSources.includes("git:https://github.com/nourhelmi/pi-detach@8d3a78f0fbbe2bfea2223e12b9555cf0abe426bd"));
  assert(packageSources.includes("npm:@ogulcancelik/pi-codex-compaction@0.1.3"));
  assert(packageSources.includes("npm:pi-mermaid@0.3.0"));
  assert(packageSources.includes("git:https://github.com/Davidcreador/pi-ui-pack@cc2b98f66cb9d7d61b1bcf022cb60271efe6102b"));
  assert(packageSources.includes("git:https://github.com/Davidcreador/pi-skill-tags@15ee7dd4786b07e310971f4c3814b03eb0ed239f"));
  assert(!packageSources.includes("npm:pi-footer@0.5.1"));
  assert(!packageSources.some((entry) => entry.includes("nourhelmi/pi-powerline")));
  assert(!packageSources.includes("git:https://github.com/nourhelmi/pi-detach@old"));
  assert(!packageSources.includes("packages/pi-openai-server-compaction"));
  assert.equal(settings.theme, "tokyo-night");
  assert(!packageSources.some((entry) => entry.includes("mitsuhiko/agent-stuff")));

  const unifiedEdit = await readFile(join(target, "extensions", "unified-edit.ts"));
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
  assert.equal(roles.profiles.checker.requireAnchor, true);
  assert.equal("models" in roles, false);
  assert.equal("allowedModels" in roles.profiles.builder, false);
  const guide = JSON.parse(await readFile(join(target, "advisor-intelligence.json"), "utf8"));
  assert.equal(guide.name, "codex-max");
  assert.equal(guide.recommendations.planner[0].model, "claude-bridge/claude-fable-5");
  assert.equal(guide.recommendations.checker[0].model, "openai-codex/gpt-5.6-terra");
  assert.equal(guide.recommendations.builder[0].thinking, "high");
  assert.equal(await readFile(join(target, "intelligence-profiles", "ACTIVE"), "utf8"), "codex-max\n");
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

test("worker runtime leaves filesystem tools available and blocks nested coordination", async () => {
  const worker = await readFile(join(ROOT, "extensions", "advisor-worker.ts"), "utf8");
  assert.match(worker, /COORDINATION_TOOLS\.has\(toolName\)/);
  assert.match(worker, /HEADLESS_AGENT_COMMAND\.test\(command\)/);
  assert.doesNotMatch(worker, /toolName !== "edit"/);
  assert.doesNotMatch(worker, /toolName !== "write"/);
  assert.doesNotMatch(worker, /role is read-only outside/);
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

test("doctor rejects a package source that does not match its exact pin", async () => {
  const target = await temporaryTarget();
  const install = run("install", "--target", target);
  assert.equal(install.status, 0, install.stderr);
  const path = join(target, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.packages = settings.packages.map((entry) =>
    entry === "npm:pi-mermaid@0.3.0" ? "npm:pi-mermaid@0.2.0" : entry,
  );
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);

  const doctor = run("doctor", "--target", target);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /Pi package is not pinned as configured: npm:pi-mermaid@0\.3\.0/);
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

test("every managed Pi package uses an exact source", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, "config", "settings.overlay.json"), "utf8"));
  for (const entry of settings.packages) {
    const source = packageSource(entry);
    const exactNpm = /^npm:(?:@[^/]+\/[^@]+|[^@]+)@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(source);
    const exactGit = /^git:.+@[0-9a-f]{40}$/.test(source);
    assert(exactNpm || exactGit, `Package is not exact: ${source}`);
  }
});

test("exact Git pin fetch verification is explicit and bounded", async () => {
  const help = run("help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /meta-harness\.mjs verify-git-pins/);
  const script = await readFile(SCRIPT, "utf8");
  assert.match(script, /const GIT_PIN_FETCH_TIMEOUT_MS = 20_000/);
  assert.match(script, /timeout: GIT_PIN_FETCH_TIMEOUT_MS/);
  assert.match(script, /\["-C", checkout, "fetch", "--quiet", "--depth", "1", pin\.url, pin\.commit\]/);
});

test("reviewed pi-skill-tags metadata matches its managed commit pin", async () => {
  const settings = JSON.parse(await readFile(join(ROOT, "config", "settings.overlay.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(ROOT, "config", "third-party-extensions.lock.json"), "utf8"));
  const skillTags = lock.extensions.find((extension) => extension.name === "pi-skill-tags");
  assert.deepEqual(skillTags, {
    name: "pi-skill-tags",
    repository: "https://github.com/Davidcreador/pi-skill-tags",
    commit: "15ee7dd4786b07e310971f4c3814b03eb0ed239f",
    tree: "ef2ff66e027e4aeb54a71c97403a6c08039076db",
    installSource: "git:https://github.com/Davidcreador/pi-skill-tags@15ee7dd4786b07e310971f4c3814b03eb0ed239f",
    license: "MIT",
    package: "@davecodes/pi-skill-tags@0.1.1",
    purpose: "Add searchable inline skill tags and expand them into Pi's native skill format.",
  });
  assert(settings.packages.map(packageSource).includes(skillTags.installSource));
});

test("skill plan preserves source attribution and all 58 skills", () => {
  const result = run("skills-plan");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^PIN https:\/\/github\.com\/.+\.git@[0-9a-f]{40} tree=[0-9a-f]{40} :: npx --yes skills@1\.5\.22 add <verified-checkout>/m,
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
  assert.equal(skillCount, 58);
});

test("skill lock matches every pinned source and selected skill", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "config", "skill-sources.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(ROOT, "config", "third-party-skills.lock.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(lock.schemaVersion, 4);
  assert.equal(lock.installer, "skills@1.5.22");
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
  assert.equal(Object.keys(lock.skills).length, 58);
});

test("npm archive excludes credentials and runtime state", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const [manifest] = JSON.parse(result.stdout);
  const forbidden = manifest.files
    .map((entry) => entry.path)
    .filter((path) => /(^|\/)(\.advisor|auth\.json|trust\.json|sessions|backups)(\/|$)|(^|\/)\.env$/.test(path));
  assert.deepEqual(forbidden, []);
});

test("bootstrap runs every required live stage without bypassing safety", async () => {
  const bootstrap = await readFile(join(ROOT, "scripts", "bootstrap.sh"), "utf8");
  const stages = [
    "npm ci",
    "npm test",
    "npm install --global agent-browser@0.32.3",
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
