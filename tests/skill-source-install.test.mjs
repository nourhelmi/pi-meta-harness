import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const SCRIPT = new URL("../scripts/meta-harness.mjs", import.meta.url);

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [script instanceof URL ? script.pathname : script, ...args], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scoped-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agent = join(home, ".pi", "agent");
  const source = join(root, "source");
  const repo = join(root, "upstream");
  const bin = join(root, "bin");
  const config = join(source, "config");
  await cp(new URL("scripts/", ROOT), join(source, "scripts"), { recursive: true });
  for (const directory of [config, bin, join(repo, "skills", "selected"), home]) await mkdir(directory, { recursive: true });
  const body = "---\nname: selected\ndescription: Test fixture\n---\nSelected skill\n";
  await writeFile(join(repo, "skills", "selected", "SKILL.md"), body);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const group = { source: "test/selected", sourceUrl: repo, commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), skills: ["selected"] };
  const unrelated = { ...group, source: "test/unrelated", sourceUrl: join(root, "must-not-fetch"), skills: ["unrelated"] };
  const manifest = { schemaVersion: 2, groups: [group, unrelated] };
  const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
  await json(join(config, "skill-sources.json"), manifest);
  await json(join(config, "skill-removals.json"), ["retired"]);
  await json(join(config, "third-party-skills.lock.json"), {
    schemaVersion: 4, installer: "skills@^1.5.23",
    skills: { selected: { ...group, sha256: createHash("sha256").update("SKILL.md").update(body).digest("hex") } },
  });
  await mkdir(join(home, ".agents", "skills", "retired"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "retired", "SKILL.md"), "retained retirement sentinel");
  await json(join(home, ".agents", ".skill-lock.json"), { version: 3, skills: { unrelated: { keep: true }, retired: { keep: true } } });
  // Stand in only for the external skills CLI: Git pin checks and our installer run for real.
  await writeFile(join(bin, "npx"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const checkout = args[args.indexOf('add') + 1];
const names = args.slice(args.indexOf('--skill') + 1, args.lastIndexOf('--yes'));
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(names) + '\\n');
const lockPath = path.join(process.env.HOME, '.agents', '.skill-lock.json');
const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : {version:3, skills:{}};
fs.mkdirSync(path.dirname(lockPath), {recursive:true});
for (const name of names) {
  fs.cpSync(path.join(checkout, 'skills', name), path.join(process.env.PI_CODING_AGENT_DIR, 'skills', name), {recursive:true});
  lock.skills[name] = {fromInstaller:true};
  if (process.env.SKILL_TEST_CORRUPT) fs.appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'skills', name, 'SKILL.md'), 'corrupt');
}
fs.writeFileSync(lockPath, JSON.stringify(lock));
if (process.env.SKILL_TEST_FAIL) process.exit(1);
`);
  await chmod(join(bin, "npx"), 0o755);
  const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: join(root, "calls.log") };
  const execute = (...args) => run(join(source, "scripts", "meta-harness.mjs"), args, env);
  return { root, home, agent, config, group, manifest, json, execute, body, env };
}

test("source selection is exact, bounded, and rejected before live mutation when unknown", async (t) => {
  const plan = run(SCRIPT, ["skills-plan", "--source", "DietrichGebert/ponytail"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.stdout.trim().split("\n").length, 1);
  assert.match(plan.stdout, /--skill ponytail ponytail-audit ponytail-debt ponytail-gain ponytail-help ponytail-review --yes/);
  for (const args of [["skills-plan", "--source"], ["skills-plan", "--source", "--live"], ["plan", "--source", "test/selected"]]) {
    assert.equal(run(SCRIPT, args).status, 1);
  }
  const f = await fixture(t);
  const before = await readdir(f.home);
  const result = f.execute("install-skills", "--live", "--allow-active", "--source", "unknown/repo");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown or ambiguous skill source/);
  assert.deepEqual(await readdir(f.home), before);
  await assert.rejects(readFile(join(f.root, "calls.log")));
});

test("scoped skill install verifies the selected pin/hash and preserves unrelated skills and lock entries", async (t) => {
  const f = await fixture(t);
  const result = f.execute("install-skills", "--live", "--allow-active", "--source", "test/selected");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified commits and hashes/);
  assert.equal(await readFile(join(f.root, "calls.log"), "utf8"), '["selected"]\n');
  assert.equal(await readFile(join(f.home, ".agents", "skills", "selected", "SKILL.md"), "utf8"), f.body);
  await assert.rejects(readFile(join(f.agent, "skills", "selected", "SKILL.md")), "no duplicate Pi copy");
  assert.equal(await readFile(join(f.home, ".agents", "skills", "retired", "SKILL.md"), "utf8"), "retained retirement sentinel");
  assert.deepEqual(JSON.parse(await readFile(join(f.home, ".agents", ".skill-lock.json"), "utf8")), {
    version: 3, skills: { unrelated: { keep: true }, retired: { keep: true } },
  });
  // Scoped verification must not demand or fetch the deliberately unavailable unrelated source.
  await assert.rejects(readFile(join(f.home, ".agents", "skills", "unrelated", "SKILL.md")));
});

test("scoped installation cannot bypass selected/retired conflicts or Git tree verification", async (t) => {
  const f = await fixture(t);
  await f.json(join(f.config, "skill-removals.json"), ["selected"]);
  const conflict = f.execute("install-skills", "--live", "--allow-active", "--source", "test/selected");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /both selected and retired/);
  await assert.rejects(readFile(join(f.root, "calls.log")));
  await f.json(join(f.config, "skill-removals.json"), []);
  f.group.tree = "0".repeat(40);
  await f.json(join(f.config, "skill-sources.json"), f.manifest);
  const lockPath = join(f.config, "third-party-skills.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.skills.selected.tree = f.group.tree;
  await f.json(lockPath, lock);
  const tree = f.execute("install-skills", "--live", "--allow-active", "--source", "test/selected");
  assert.equal(tree.status, 1);
  assert.match(tree.stderr, /Pinned skill source verification failed/);
  await assert.rejects(readFile(join(f.root, "calls.log")));
});

test("hash mismatch and partial CLI failure never publish bytes or alter live lock state", async (t) => {
  for (const failure of ["hash", "corrupt", "cli"]) {
    for (const present of [false, true]) {
      await t.test(`${failure}, previously installed: ${present}`, async (t) => {
        const f = await fixture(t);
        const canonical = join(f.home, ".agents", "skills", "selected", "SKILL.md");
        const piCopy = join(f.agent, "skills", "selected", "SKILL.md");
        if (present) {
          for (const file of [canonical, piCopy]) {
            await mkdir(join(file, ".."), { recursive: true });
            await writeFile(file, "original trusted content");
          }
        }
        const generic = join(f.home, ".agents", ".skill-lock.json");
        await f.json(generic, { version: 3, skills: { selected: { old: true }, unrelated: { keep: true } } });
        const before = await readFile(generic);
        if (failure === "hash") {
          const path = join(f.config, "third-party-skills.lock.json");
          const lock = JSON.parse(await readFile(path, "utf8"));
          lock.skills.selected.sha256 = "0".repeat(64);
          await f.json(path, lock);
        } else if (failure === "corrupt") f.env.SKILL_TEST_CORRUPT = "1";
        else f.env.SKILL_TEST_FAIL = "1";
        const result = f.execute("install-skills", "--live", "--allow-active", "--source", "test/selected");
        assert.equal(result.status, 1);
        assert.match(result.stderr, failure === "cli" ? /npx failed with exit 1/ : /Pinned skill content drift: selected/);
        for (const file of [canonical, piCopy]) {
          if (present) assert.equal(await readFile(file, "utf8"), "original trusted content");
          else await assert.rejects(readFile(file));
        }
        assert.deepEqual(await readFile(generic), before);
        await assert.rejects(readdir(join(f.agent, "backups")), "pre-activation failure needs no live backup or mutation");
      });
    }
  }
});

test("selected lock metadata is validated before running the CLI or touching live state", async (t) => {
  const f = await fixture(t);
  const path = join(f.config, "third-party-skills.lock.json");
  const lock = JSON.parse(await readFile(path, "utf8"));
  lock.skills.selected.commit = "0".repeat(40);
  await f.json(path, lock);
  const before = await readFile(join(f.home, ".agents", ".skill-lock.json"));
  const result = f.execute("install-skills", "--live", "--allow-active", "--source", "test/selected");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Skill lock does not match its pinned source/);
  await assert.rejects(readFile(join(f.root, "calls.log")));
  assert.deepEqual(await readFile(join(f.home, ".agents", ".skill-lock.json")), before);
});

test("failure after verified promotion restores both skill roots and the exact generic lock", async (t) => {
  const f = await fixture(t);
  const canonical = join(f.home, ".agents", "skills", "selected", "SKILL.md");
  const piCopy = join(f.agent, "skills", "selected", "SKILL.md");
  for (const file of [canonical, piCopy]) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "original trusted content");
  }
  // Staging must not use this live lock. Releasing ownership after promotion fails.
  const generic = join(f.home, ".agents", ".skill-lock.json");
  const originalLock = '{"version":3,"skills":42}\n';
  await writeFile(generic, originalLock);
  const result = f.execute("install-skills", "--live", "--allow-active", "--source", "test/selected");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid global skill lock/);
  assert.match(result.stdout, /Restored/);
  for (const file of [canonical, piCopy]) assert.equal(await readFile(file, "utf8"), "original trusted content");
  assert.equal(await readFile(generic, "utf8"), originalLock);
});
