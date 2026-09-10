import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function installNativeSkills(home = os.homedir()) {
  const bundle = path.join(home, '.local/share/pi-meta-harness/native-skills');
  const names = fs.readdirSync(path.join(source, 'native-skills')).sort();
  const links = ['.codex', '.claude'].flatMap(host => names.map(name => ({
    link: path.join(home, host, 'skills', name), target: path.join(bundle, name),
  })));
  // Refuse collisions before touching either host or the existing bundle.
  for (const { link, target } of links) {
    const stat = exists(link);
    if (stat && (!stat.isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== target)) {
      throw new Error(`Unowned native skill path: ${link}`);
    }
  }
  const prior = exists(bundle);
  if (prior && (!prior.isDirectory() || fs.readFileSync(path.join(bundle, '.owner'), 'utf8') !== 'pi-meta-harness-native-v1\n')) {
    throw new Error(`Unowned bundle: ${bundle}`);
  }
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(bundle), '.native-stage-'));
  const backup = `${stage}-previous`;
  const created = [];
  let promoted = false;
  let moved = false;
  try {
    fs.cpSync(path.join(source, 'native-skills'), stage, { recursive: true });
    const profiles = path.join(stage, 'advisor-intelligence/profiles');
    fs.mkdirSync(profiles);
    for (const name of fs.readdirSync(path.join(source, 'config/intelligence-profiles')).filter(n => n.endsWith('.json'))) {
      const bytes = fs.readFileSync(path.join(source, 'config/intelligence-profiles', name));
      JSON.parse(bytes.toString());
      fs.writeFileSync(path.join(profiles, name), bytes);
    }
    fs.writeFileSync(path.join(stage, '.owner'), 'pi-meta-harness-native-v1\n');
    if (prior) { fs.renameSync(bundle, backup); moved = true; }
    fs.renameSync(stage, bundle);
    promoted = true;
    for (const { link, target } of links) {
      if (exists(link)) continue;
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, 'dir');
      created.push(link);
    }
  } catch (error) {
    for (const link of created.reverse()) fs.unlinkSync(link);
    if (promoted) fs.rmSync(bundle, { recursive: true });
    if (moved) fs.renameSync(backup, bundle);
    throw error;
  } finally {
    if (exists(stage)) fs.rmSync(stage, { recursive: true });
  }
  if (moved) fs.rmSync(backup, { recursive: true });
  return { bundle, names, links: links.map(({ link }) => link) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/install-native-skills.mjs');
  const result = installNativeSkills();
  console.log(`Installed ${result.names.length} native skills for Codex and Claude Code into ${result.bundle}.\nNo runtime/settings changes. Start fresh native conversations to discover them.`);
}
