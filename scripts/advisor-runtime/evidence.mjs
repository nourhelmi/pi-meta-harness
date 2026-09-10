import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { validateResultArtifact, resultSectionBody } from '../advisor-core/result-artifact.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A projection of the existing report, not another worker report contract. */
export function reportSummary(markdown) {
  const validation = validateResultArtifact(markdown);
  const section = name => resultSectionBody(markdown, name);
  return { status: validation.status?.slice(0, 256) ?? 'unknown', claims: section('Claims'), evidence: section('Evidence'), risks: section('Remaining Risk'),
    valid: validation.valid && /^(PASS|DONE|FAIL|BLOCKED)\b/i.test(validation.status ?? ''), limitations: validation.notes.slice(0, 8) };
}

/** Exact git-visible content, including dirty/untracked files and deletions. No HEAD-only proof. */
export function contentSurface(cwd) {
  try {
    const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const root = realpathSync(git(['rev-parse', '--show-toplevel']).trim());
    const paths = [...new Set(git(['-C', root, 'ls-files', '--full-name', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
    if (paths.length > 10000) return null;
    const digest = createHash('sha256'); let bytes = 0;
    for (const path of paths) {
      let data; let mode = 0; let exists = true;
      try {
        const info = lstatSync(join(root, path));
        if (!info.isFile() || info.size > 16 * 1024 * 1024) return null;
        mode = info.mode; data = readFileSync(join(root, path));
      } catch (error) { if (error.code !== 'ENOENT') return null; exists = false; data = Buffer.alloc(0); }
      bytes += data.length; if (bytes > 128 * 1024 * 1024) return null;
      digest.update(JSON.stringify([path, exists, mode, sha256(data)]) + '\n');
    }
    return { root, revision: git(['rev-parse', 'HEAD']).trim(), sha256: digest.digest('hex'), files: paths.length,
      limitations: ['Git-visible files only; ignored files, external services and environment are not covered.'] };
  } catch { return null; }
}

export function sameSurface(a, b) { return Boolean(a && b && a.root === b.root && a.sha256 === b.sha256); }
