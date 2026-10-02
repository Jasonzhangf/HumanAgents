/**
 * Candidate binding + attempt resource registration — real implementation.
 *
 * Owns graph node: candidate_binding (in every per-command graph).
 *
 * `bindCandidate` binds this attempt to exactly one candidate revision: the HEAD
 * SHA of the reviewed worktree, a digest of its tracked tree, and the release
 * version stamped at that SHA. It also registers every resource this attempt
 * owns so the cleanup closure can release exactly them and nothing else.
 *
 * No session/journal/checkpoint/artifact/memory/profile/lock data may live
 * inside the repo: the control root and workspace are created under `tmpdir()`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = resolve(__dirname, '..', '..', '..', '..');

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function readReleaseVersion(repoPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
    return pkg.releaseVersion ?? pkg.version ?? null;
  } catch {
    return null;
  }
}

export function bindCandidate(repoPath = DEFAULT_REPO_PATH) {
  const repo = resolve(repoPath);
  const candidateSha = git(repo, ['rev-parse', 'HEAD']);
  const files = git(repo, ['ls-files', '-s'])
    .split('\n')
    .filter((line) => line && !line.includes('dist/receipts/'))
    .sort();
  // `ls-files -s` hashes the index, not the working tree, so an uncommitted
  // change would leave the digest unchanged. Fold in the working-tree diff and
  // the status list so the digest actually identifies the tested candidate.
  const worktreeDiff = git(repo, ['diff', 'HEAD']);
  const worktreeStatus = git(repo, ['status', '--porcelain']);
  const treeDigest = `sha256:${createHash('sha256')
    .update(`${files.join('\n')}\n`)
    .update(`--diff--\n${worktreeDiff}\n--status--\n${worktreeStatus}\n`)
    .digest('hex')}`;
  const headFiles = git(repo, ['show', '--name-only', '--format=', 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .slice(0, 80);
  const stamp = nowStamp();
  const suffix = Math.random().toString(36).slice(2, 8);
  const attemptId = process.env.E2E_ATTEMPT_ID ?? `${stamp}-${suffix}`;
  const scenario = process.env.E2E_SCENARIO ?? 'scenario';
  const attemptRoot = join(tmpdir(), `humanagent-e2e-${stamp}-${suffix}`);
  return {
    repoPath: repo,
    candidateSha,
    candidateVersion: readReleaseVersion(repo),
    treeDigest,
    headFiles,
    attemptId,
    scenario,
    startedAt: new Date().toISOString(),
    receiptDir: join(repo, 'dist', 'receipts', 'dashboard-e2e', scenario),
    screenshotsDir: join(repo, 'dist', 'receipts', 'dashboard-e2e', scenario, 'shots'),
    attemptRoot,
    workspace: join(attemptRoot, 'workspace'),
    controlRoot: join(attemptRoot, 'control'),
    tempRoots: [attemptRoot],
    servePid: null,
    servePort: null,
    servePidFile: join(attemptRoot, 'serve.pid'),
    browser: null,
    cleaned: false,
  };
}

export function registerAttemptResources(binding) {
  if (!binding || typeof binding !== 'object') {
    throw new Error('registerAttemptResources requires a binding record from bindCandidate()');
  }
  if (typeof binding.candidateSha !== 'string' || !/^[0-9a-f]{40}$/.test(binding.candidateSha)) {
    throw new Error(`binding is not bound to a full candidate SHA: ${String(binding.candidateSha)}`);
  }
  return binding;
}

export async function prepareAttemptRoots(binding) {
  await mkdir(binding.workspace, { recursive: true });
  await mkdir(binding.controlRoot, { recursive: true });
  await mkdir(binding.receiptDir, { recursive: true });
  await mkdir(binding.screenshotsDir, { recursive: true });
  return binding;
}
