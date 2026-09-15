import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNativeSkills } from '../scripts/install-native-skills.mjs';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('native bundle installs advisor and CoS skills, resolves references and preserves profiles/settings', t => {
  const dir = home(t);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const settings = path.join(dir, '.claude/settings.json');
  fs.writeFileSync(settings, '{"untouched":true}');
  const installed = installNativeSkills(dir);
  assert.equal(installed.names.length, 8);
  assert.equal(installed.links.length, 16);
  for (const role of ['scout', 'planner', 'reducer', 'browser-verifier']) assert.ok(!installed.names.includes(`advisor-role-${role}`));
  assert.ok(installed.names.includes('advisor-role-advisor'));
  assert.match(fs.readFileSync(path.join(installed.bundle, 'advisor-role-foreman/SKILL.md'), 'utf8'), /compatibility link/);
  for (const link of installed.links) {
    const text = fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${path.basename(link)}\\n`));
    for (const match of text.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
      assert.ok(fs.existsSync(path.resolve(link, match[1].split('#')[0])), match[1]);
    }
  }
  for (const name of fs.readdirSync('config/intelligence-profiles').filter(n => n.endsWith('.json'))) {
    assert.deepEqual(fs.readFileSync(path.join(installed.bundle, 'advisor-intelligence/profiles', name)), fs.readFileSync(`config/intelligence-profiles/${name}`));
  }
  assert.deepEqual(installNativeSkills(dir), installed);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"untouched":true}');
  assert.equal(fs.existsSync(path.join(dir, '.pi')), false);
  assert.equal(fs.existsSync(path.join(dir, '.agents')), false);
});

test('collision in either host refuses before publishing anything', t => {
  const dir = home(t);
  const collision = path.join(dir, '.claude/skills/advisor');
  fs.mkdirSync(collision, { recursive: true });
  fs.writeFileSync(path.join(collision, 'SKILL.md'), 'user skill');
  assert.throws(() => installNativeSkills(dir), /Unowned native skill path/);
  assert.equal(fs.existsSync(path.join(dir, '.local')), false);
  assert.equal(fs.existsSync(path.join(dir, '.codex')), false);
  assert.equal(fs.readFileSync(path.join(collision, 'SKILL.md'), 'utf8'), 'user skill');
});

test('publication failure restores previous bundle and removes only newly created links', t => {
  const dir = home(t);
  const installed = installNativeSkills(dir);
  const sentinel = path.join(installed.bundle, 'sentinel');
  fs.writeFileSync(sentinel, 'previous');
  const missing = installed.links.slice(-2);
  missing.forEach(link => fs.unlinkSync(link));
  const original = fs.symlinkSync;
  let calls = 0;
  fs.symlinkSync = (...args) => { if (++calls === 2) throw new Error('injected failure'); return original(...args); };
  try { assert.throws(() => installNativeSkills(dir), /injected failure/); }
  finally { fs.symlinkSync = original; }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'previous');
  missing.forEach(link => assert.equal(fs.existsSync(link), false));
  assert.ok(fs.existsSync(path.join(installed.links[0], 'SKILL.md')));
});

test('native guidance separates schedulers and follows project-owned review gates without changing Pi discovery', () => {
  const advisor = fs.readFileSync('native-skills/advisor/SKILL.md', 'utf8');
  assert.match(advisor, /A root defaults to \*\*host-native orchestration\*\*/);
  assert.match(advisor, /A child inherits its parent's chosen lane and remaining limits/);
  assert.match(advisor, /Risk guides probe depth, not a mandatory harness reviewer/);
  assert.match(advisor, /Agentic PR review belongs to the project's review\/CI workflow/);
  assert.match(advisor, /Pending, unavailable or stale required review remains an unmet delivery gate/);
  assert.doesNotMatch(advisor, /High requires a designated independent checker/);
  assert.match(advisor, /Do not preload every role/);
  assert.match(advisor, /not automatically registered native agent types/);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.deepEqual(pkg.pi.skills, ['./skills']);
  assert.ok(pkg.files.includes('native-skills/'));
});

for (const fail of [false, true]) test(`retired native links ${fail ? 'roll back on failure' : 'are removed without touching user replacements'}`, t => {
  const dir = home(t);
  const installed = installNativeSkills(dir);
  for (const role of ['scout', 'planner', 'reducer', 'browser-verifier']) {
    const target = path.join(installed.bundle, `advisor-role-${role}`);
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'SKILL.md'), `old ${role}`);
  }
  const oldLinks = ['browser-verifier', 'planner'].map(role => {
    const link = path.join(dir, '.codex/skills', `advisor-role-${role}`);
    const target = path.join(installed.bundle, `advisor-role-${role}`);
    fs.symlinkSync(target, link, 'dir'); return { link, target };
  });
  const user = path.join(dir, '.claude/skills/advisor-role-browser-verifier');
  fs.mkdirSync(user); fs.writeFileSync(path.join(user, 'SKILL.md'), 'user replacement');
  const foreign = path.join(dir, '.claude/skills/advisor-role-reducer');
  fs.symlinkSync(user, foreign, 'dir');
  const unlink = fs.unlinkSync;
  if (fail) fs.unlinkSync = file => { if (file === oldLinks[1].link) throw new Error('retirement failure'); return unlink(file); };
  try {
    if (fail) assert.throws(() => installNativeSkills(dir), /retirement failure/);
    else installNativeSkills(dir);
  } finally { fs.unlinkSync = unlink; }
  for (const { link, target } of oldLinks) {
    if (fail) {
      assert.equal(fs.readlinkSync(link), target);
      assert.match(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), /^old /);
    } else assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
  }
  assert.equal(fs.readFileSync(path.join(user, 'SKILL.md'), 'utf8'), 'user replacement');
  assert.equal(fs.readlinkSync(foreign), user);
});
