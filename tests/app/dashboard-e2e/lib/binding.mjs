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
 * The persistent control root, the project/session tree, the journal/checkpoint
 * roots and the receipt root are all derived by the single product owner
 * (`packages/config` `resolveRuntimePaths`), never re-derived here and never
 * redirected through a temporary `HOME`/`HUMANAGENT_HOME`. Only the execution
 * workspace and this attempt's own run-notes directory are ephemeral; no
 * session/journal/checkpoint/artifact/memory/profile/lock data lives inside the
 * repo or inside an attempt tmp control root.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = resolve(__dirname, '..', '..', '..', '..');

/**
 * The product config module is the unique owner of control-root/project path
 * derivation. The runner imports its build output; it never parses TOML itself
 * and never substitutes a temporary control root.
 */
export const CONFIG_MODULE_RELATIVE = join('dist', 'config', 'config', 'src', 'index.js');

/**
 * The built contracts module is the public owner of typed identity validation.
 * It is loaded lazily so `--help` and option parsing still work without a
 * build; a missing build fails closed when a task URL is actually built. The
 * harness projects a typed `TaskId` to its string value through the public
 * `id('task', value)` constructor instead of reimplementing the id grammar.
 */
const CONTRACTS_MODULE_RELATIVE = join('dist', 'app', 'contracts', 'src', 'index.js');
let contractId = null;
try {
  const contracts = await import(pathToFileURL(join(DEFAULT_REPO_PATH, CONTRACTS_MODULE_RELATIVE)).href);
  if (typeof contracts.id === 'function') contractId = contracts.id;
} catch {
  contractId = null;
}

/**
 * Project a task identity to the string task value used at task URL boundaries.
 *
 * Accepts either an existing string task value or a typed `TaskId`
 * (`{ scope: 'task', value }`). The value is validated by the public contracts
 * `id('task', value)` constructor, so a missing value, a wrong scope, a
 * non-string value or an invalid id fails closed and an object is never
 * stringified into a request. The input identity is not mutated.
 */
export function taskIdValue(taskId) {
  if (contractId === null) {
    throw new Error('contracts module is not built; run `pnpm build:app` before building a task URL');
  }
  if (typeof taskId === 'string') return contractId('task', taskId).value;
  if (taskId && typeof taskId === 'object' && taskId.scope === 'task' && typeof taskId.value === 'string') {
    return contractId('task', taskId.value).value;
  }
  throw new Error(`task identity must be a string or a typed TaskId { scope: 'task', value }, got ${JSON.stringify(taskId)}`);
}

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

/**
 * Load the product config owner's `resolveRuntimePaths`. The runner fails closed
 * when the candidate has not been built; it never falls back to a self-derived
 * or temporary control root.
 */
export async function loadConfigResolver(repoPath = DEFAULT_REPO_PATH) {
  const modulePath = join(resolve(repoPath), CONFIG_MODULE_RELATIVE);
  if (!existsSync(modulePath)) {
    throw new Error(
      `product config module is not built at ${modulePath}; run \`pnpm build:config\` before running the Dashboard E2E runner`,
    );
  }
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.resolveRuntimePaths !== 'function') {
    throw new Error(`${modulePath} does not export resolveRuntimePaths`);
  }
  return mod.resolveRuntimePaths;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function bindCandidate(repoPath = DEFAULT_REPO_PATH, options = {}) {
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
  const suffix = options.attemptIdSuffix ?? Math.random().toString(36).slice(2, 8);
  const scenario = options.scenario ?? process.env.E2E_SCENARIO ?? 'scenario';
  // Unique attempt identity: scenario + wall-clock stamp + random suffix, and a
  // caller-supplied suffix keeps contract tests deterministic without collisions.
  const attemptId = options.attemptId ?? process.env.E2E_ATTEMPT_ID ?? `${scenario}-${stamp}-${suffix}`;
  const attemptRoot = join(tmpdir(), `humanagent-e2e-${scenario}-${stamp}-${suffix}`);
  return {
    repoPath: repo,
    candidateSha,
    candidateVersion: readReleaseVersion(repo),
    treeDigest,
    headFiles,
    attemptId,
    scenario,
    entry: options.entry ?? 'dashboard',
    outcome: options.outcome ?? 'success',
    serviceMode: options.serviceMode ?? 'candidate',
    resolvePaths: options.resolvePaths ?? null,
    recoveryOwner: options.recoveryOwner ?? process.env.E2E_RECOVERY_OWNER ?? 'humanagent.runtime.task-recovery',
    startedAt: new Date().toISOString(),
    attemptRoot,
    workspace: join(attemptRoot, 'workspace'),
    // Only the execution workspace and this attempt's own run-notes dir are
    // ephemeral. The persistent control root/journal/receipts are filled by
    // resolveAttemptPaths() from the product config owner.
    tempRoots: [attemptRoot],
    controlRoot: null,
    runNotesRoot: null,
    projectRoot: null,
    projectKey: null,
    formalWorkspace: options.formalWorkspace ?? null,
    formalPaths: null,
    attachedOwner: null,
    scope: options.scope ?? null,
    taskId: options.scope?.taskId ?? null,
    operationId: options.scope?.operationId ?? null,
    cycleId: options.scope?.cycleId ?? null,
    executionEpoch: options.scope?.executionEpoch ?? null,
    receiptDir: null,
    screenshotsDir: null,
    servePid: null,
    servePort: null,
    servePidFile: join(attemptRoot, 'serve.pid'),
    browser: null,
    cleaned: false,
  };
}

/**
 * Derive the canonical persistent paths for this attempt through the product
 * config owner and root this attempt's receipts/screenshots under its
 * `runNotesRoot`. A resolver may be injected for deterministic contract tests;
 * the default is the real `resolveRuntimePaths` build output.
 */
export async function resolveAttemptPaths(binding, options = {}) {
  if (!binding || typeof binding !== 'object') {
    throw new Error('resolveAttemptPaths requires a binding record from bindCandidate()');
  }
  // `resolveRuntimePaths` requires an existing workspace directory; the
  // ephemeral workspace is the only persistent root input the runner supplies.
  await mkdir(binding.workspace, { recursive: true });
  const resolvePaths = options.resolvePaths ?? binding.resolvePaths ?? await loadConfigResolver(binding.repoPath);
  const paths = await resolvePaths({
    workspace: binding.workspace,
    ...(options.controlRoot ? { controlRoot: options.controlRoot } : {}),
  });
  if (!paths || typeof paths.controlRoot !== 'string' || typeof paths.runNotesRoot !== 'string') {
    throw new Error('config resolver returned no controlRoot/runNotesRoot');
  }
  // Fail closed if a resolver roots the persistent control root inside this
  // attempt's ephemeral tmp: that would silently bypass the canonical root.
  if (isWithin(binding.attemptRoot, paths.controlRoot)) {
    throw new Error(
      `config resolver rooted the persistent control root inside the ephemeral attempt tmp (${paths.controlRoot}); `
      + 'persistent state must derive from the canonical control root',
    );
  }
  binding.runtimePaths = paths;
  binding.controlRoot = paths.controlRoot;
  binding.runNotesRoot = paths.runNotesRoot;
  binding.projectRoot = paths.projectRoot ?? null;
  binding.projectKey = paths.projectKey ?? null;
  binding.receiptDir = join(paths.runNotesRoot, binding.attemptId);
  binding.screenshotsDir = join(binding.receiptDir, 'shots');
  binding.persistentRoots = [paths.controlRoot, paths.runNotesRoot, binding.receiptDir];
  return paths;
}

/**
 * Resolve the formal installed owner's paths from the explicit harness input.
 * The attempt workspace stays ephemeral. The formal workspace is used only as
 * the config resolver input, never as a write target.
 */
export async function resolveFormalAttachPaths(binding, options = {}) {
  if (!binding || typeof binding !== 'object') {
    throw new Error('resolveFormalAttachPaths requires a binding record from bindCandidate()');
  }
  const formalWorkspace = options.formalWorkspace
    ?? binding.formalWorkspace
    ?? process.env.HUMANAGENT_ATTACH_WORKSPACE
    ?? null;
  if (!formalWorkspace || typeof formalWorkspace !== 'string') {
    throw new Error(
      'installed-attach requires an explicit formal workspace via HUMANAGENT_ATTACH_WORKSPACE (or attachedWorkspace)',
    );
  }
  const resolvePaths = options.resolvePaths ?? binding.resolvePaths ?? await loadConfigResolver(binding.repoPath);
  const paths = await resolvePaths({ workspace: resolve(formalWorkspace), controlRoot: options.controlRoot });
  if (!paths || typeof paths.controlRoot !== 'string' || typeof paths.projectRoot !== 'string') {
    throw new Error('config resolver returned no formal controlRoot/projectRoot');
  }
  binding.formalWorkspace = resolve(formalWorkspace);
  binding.formalPaths = paths;
  binding.journalControlRoot = paths.controlRoot;
  binding.journalProjectKey = paths.projectKey;
  return paths;
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
  if (!binding.receiptDir || !binding.screenshotsDir) {
    throw new Error('prepareAttemptRoots requires resolveAttemptPaths() to have run first');
  }
  await mkdir(binding.workspace, { recursive: true });
  await mkdir(binding.receiptDir, { recursive: true });
  await mkdir(binding.screenshotsDir, { recursive: true });
  return binding;
}
