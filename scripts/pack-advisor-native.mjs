#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function packNative(destination) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE_24_REQUIRED');
  const output = resolve(destination); mkdirSync(output, { recursive: true }); const stage = mkdtempSync(join(output, 'native-stage-'));
  try {
    const assets = ['scripts/advisor-runtime', 'scripts/advisor-core/command-contract.mjs', 'scripts/advisor-core/command-admission.mjs', 'scripts/advisor-core/result-artifact.mjs', 'scripts/advisor-trace.mjs', 'config/advisor-core/canonical-events.schema.json', 'skills/advisor-native-entry', 'skills/advisor-native-maker', 'docs/advisor-durable-runtime.md', 'docs/advisor-native.md', 'LICENSE'];
    for (const path of assets) { mkdirSync(dirname(join(stage, path)), { recursive: true }); cpSync(join(root, path), join(stage, path), { recursive: true, dereference: false }); }
    const manifest = { name: '@nourhelmi/advisor-native', version: '0.1.0', type: 'module', description: 'Standalone scoped durable native advisor runtime', license: 'MIT', engines: { node: '>=24' }, bin: { 'advisor-runtime': './scripts/advisor-runtime/cli.mjs', 'advisor-native': './scripts/advisor-runtime/native-cli.mjs' }, optionalDependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.263' }, files: ['scripts', 'config', 'skills', 'docs', 'LICENSE'] };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8', timeout: 60000, maxBuffer: 1048576 });
    if (packed.status !== 0) throw new Error('NATIVE_PACK_FAILED');
    const result = JSON.parse(packed.stdout)[0]; const tarball = join(output, result.filename);
    if (!readFileSync(tarball).length) throw new Error('EMPTY_PACKAGE');
    return { tarball, integrity: result.integrity, shasum: result.shasum, files: result.files.map(file => file.path) };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3) throw new Error('USAGE_PACK_DESTINATION'); process.stdout.write(JSON.stringify(packNative(process.argv[2]), null, 2) + '\n'); }
  catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error.message) ? error.message : 'PACK_ERROR') + '\n'); process.exitCode = 1; }
}
