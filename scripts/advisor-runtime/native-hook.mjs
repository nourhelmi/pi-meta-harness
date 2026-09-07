#!/usr/bin/env node
// Owned Claude PreToolUse command hook. Never a model, worker or general command runner.
import { realpathSync } from 'node:fs';
import { preToolGuard } from './native-boundary.mjs';
const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Invalid bounded advisor hook invocation.' } };
let bytes = Buffer.alloc(0); let output = deny;
const timer = setTimeout(() => { process.stdout.write(JSON.stringify(deny) + '\n'); process.exit(0); }, 5000);
try {
  if (process.argv.length !== 4 || realpathSync(process.argv[2]) !== process.argv[2]) throw new Error('scope');
  const readRoots = JSON.parse(process.argv[3]);
  if (!Array.isArray(readRoots) || !readRoots.length || readRoots.length > 64 || !readRoots.every(path => typeof path === 'string' && realpathSync(path) === path)) throw new Error('roots');
  for await (const chunk of process.stdin) { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 32768) throw new Error('bound'); }
  output = preToolGuard({ cwd: process.argv[2], readRoots, root: true, writer: false }, JSON.parse(bytes.toString('utf8')));
} catch { /* Only a constant typed denial, never the tool input or native exception. */ }
clearTimeout(timer); process.stdout.write(JSON.stringify(output) + '\n');
