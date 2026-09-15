#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisorStateRoot, nativeAdvisorIdentity, readAdvisorSession, claimAdvisorCheckpoint, readAdvisorCheckpoint, updateAdvisorCheckpoint } from './advisor-state.mjs';

export async function checkpointCommand(argv, env = process.env, input) {
  const [op, ...args] = argv;
  if (!['init', 'read', 'write'].includes(op) || args.length % 2) throw new Error('Usage: advisor-state-cli.mjs init|read|write [--cwd path] [--workstream slug] [--mode advisor|cos] [--expected-digest hash]. write reads the checkpoint from stdin.');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--cwd', '--workstream', '--mode', '--expected-digest'].includes(key) || Object.hasOwn(options, key)) throw new Error('Unknown or duplicate checkpoint option; owner/session/display overrides are not accepted.');
    options[key] = args[i + 1];
  }
  const identity = nativeAdvisorIdentity(env);
  const root = await advisorStateRoot(resolve(options['--cwd'] ?? process.cwd()));
  const prior = readAdvisorSession({ root, identity });
  const workstream = options['--workstream'] ?? prior?.workstream;
  const request = { root, identity, workstream };
  let value;
  if (op === 'init') value = claimAdvisorCheckpoint({ ...request, workerHarness: 'native', mode: options['--mode'] });
  else if (op === 'read') value = readAdvisorCheckpoint(request);
  else {
    let content = input;
    if (content === undefined) {
      content = readFileSync(0, 'utf8');
    }
    value = updateAdvisorCheckpoint({ ...request, content, expectedDigest: options['--expected-digest'] });
  }
  return { ...value, lane: 'unchanged', executionRuntimeStarted: false, identitySource: 'local trusted host context; not host-attested evidence' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await checkpointCommand(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
