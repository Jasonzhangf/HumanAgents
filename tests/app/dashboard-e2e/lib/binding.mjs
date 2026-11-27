/**
 * Attempt binding + resource registration — real implementation.
 *
 * Owns graph node: candidate_binding (in every per-command graph).
 *
 * `bindCandidate` establishes one attempt: its id, its owner-scoped runtime
 * subdirectory under the fixed Dashboard E2E test root, the business scope it targets and the paths the product config
 * owner derives. `registerAttemptResources` records that the attempt owns the
 * resources it will later release. No source revision identity is captured or
 * compared; the harness does not need the checkout to be a Git worktree.
 *
 * Candidate runtime paths are derived by the single product owner
 * (`packages/config` `resolveRuntimePaths`) from an attempt-local control root.
 * That keeps every session/journal/checkpoint/artifact/memory/profile/lock path
 * inside the attempt root, so a test never registers a temporary project in the
 * operator's canonical project store. The receipt/screenshots are the only
 * evidence retained outside the removed runtime root.
 */

import { lstat, mkdir, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = resolve(__dirname, '..', '..', '..', '..');

// One stable test root gives every scenario the same runnable filesystem
// entry. A version is a path segment too, so a future fixture layout cannot
// silently reuse state created by this one. Attempts add a separate owner and
// attempt-id subdirectory beneath it.
export const DASHBOARD_E2E_TEST_ROOT = resolve(join(tmpdir(), 'humanagent-e2e'));
export const SCENARIO_LAYOUT_VERSION = 'v1';
const DEFAULT_ATTEMPT_OWNER = 'humanagent.dashboard-e2e';

/**
 * The product config module is the unique owner of control-root/project path
 * derivation. The runner imports its build output; it never parses TOML itself.
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
 * control root.
 */
export async function loadConfigModule(repoPath = DEFAULT_REPO_PATH) {
  const modulePath = join(resolve(repoPath), CONFIG_MODULE_RELATIVE);
  if (!existsSync(modulePath)) {
    throw new Error(
      `product config module is not built at ${modulePath}; run \`pnpm build:config\` before running the Dashboard E2E runner`,
    );
  }
  const mod = await import(pathToFileURL(modulePath).href);
  return mod;
}

export async function loadConfigResolver(repoPath = DEFAULT_REPO_PATH) {
  const mod = await loadConfigModule(repoPath);
  if (typeof mod.resolveRuntimePaths !== 'function') {
    throw new Error(`${CONFIG_MODULE_RELATIVE} does not export resolveRuntimePaths`);
  }
  return mod.resolveRuntimePaths;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function requirePathSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be one non-empty path segment, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function bindCandidate(repoPath = DEFAULT_REPO_PATH, options = {}) {
  const repo = resolve(repoPath);
  const stamp = nowStamp();
  const suffix = options.attemptIdSuffix ?? Math.random().toString(36).slice(2, 8);
  const scenario = requirePathSegment(options.scenario ?? process.env.E2E_SCENARIO ?? 'scenario', 'scenario');
  const attemptOwner = requirePathSegment(
    options.attemptOwner ?? process.env.E2E_ATTEMPT_OWNER ?? DEFAULT_ATTEMPT_OWNER,
    'attempt owner',
  );
  // Unique attempt identity: scenario + wall-clock stamp + random suffix, and a
  // caller-supplied suffix keeps contract tests deterministic without collisions.
  const attemptId = requirePathSegment(
    options.attemptId ?? process.env.E2E_ATTEMPT_ID ?? `${scenario}-${stamp}-${suffix}`,
    'attempt id',
  );
  const testRoot = DASHBOARD_E2E_TEST_ROOT;
  const attemptRoot = join(testRoot, SCENARIO_LAYOUT_VERSION, scenario, attemptOwner, attemptId);
  // Runtime state (control root, workspace, journal, checkpoints, index and
  // logs) belongs to this attempt and is removed with it. The receipt and
  // screenshots are the small evidence set retained outside that runtime.
  const evidenceRoot = resolve(
    options.evidenceRoot
      ?? process.env.E2E_EVIDENCE_ROOT
      ?? join(tmpdir(), 'humanagent-e2e-evidence'),
  );
  return {
    repoPath: repo,
    candidateVersion: readReleaseVersion(repo),
    attemptId,
    scenario,
    entry: options.entry ?? 'dashboard',
    outcome: options.outcome ?? 'success',
    serviceMode: options.serviceMode ?? 'candidate',
    resolvePaths: options.resolvePaths ?? null,
    recoveryOwner: options.recoveryOwner ?? process.env.E2E_RECOVERY_OWNER ?? 'humanagent.runtime.task-recovery',
    startedAt: new Date().toISOString(),
    testRoot,
    scenarioLayoutVersion: SCENARIO_LAYOUT_VERSION,
    attemptOwner,
    attemptRoot,
    workspace: join(attemptRoot, 'workspace'),
    evidenceRoot,
    // The whole runtime tree below this attempt root is ephemeral. Its control
    // root, workspace, journal, checkpoints and logs are removed together.
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
    receiptDir: join(evidenceRoot, attemptId),
    screenshotsDir: null,
    servePid: null,
    servePort: null,
    servePidFile: join(attemptRoot, 'serve.pid'),
    browser: null,
    cleaned: false,
  };
}

/**
 * Derive this attempt's runtime paths through the product config owner from an
 * attempt-local control root. A resolver may be injected for deterministic
 * contract tests; the default is the real `resolveRuntimePaths` build output.
 * Receipts and screenshots live under the separate evidence root so cleanup can
 * remove the complete runtime tree without losing the small evidence set.
 */
export async function resolveAttemptPaths(binding, options = {}) {
  if (!binding || typeof binding !== 'object') {
    throw new Error('resolveAttemptPaths requires a binding record from bindCandidate()');
  }
  const configModule = await loadConfigModule(binding.repoPath);
  const resolvePaths = options.resolvePaths ?? binding.resolvePaths ?? configModule.resolveRuntimePaths;
  const requestedControlRoot = options.controlRoot
    ?? binding.controlRoot
    ?? join(binding.attemptRoot, 'control');
  if (!isWithin(binding.attemptRoot, requestedControlRoot)) {
    throw new Error(
      `candidate control root must stay inside the fixed test-root attempt (${resolve(requestedControlRoot)}); `
      + `expected a child of ${resolve(binding.attemptRoot)}`,
    );
  }
  // `resolveRuntimePaths` requires an existing workspace directory. Both the
  // workspace and control root stay under this owner-scoped attempt.
  await mkdir(binding.workspace, { recursive: true });
  await mkdir(requestedControlRoot, { recursive: true });
  const attemptRoot = await realpath(binding.attemptRoot).catch(() => resolve(binding.attemptRoot));
  const workspace = await realpath(binding.workspace).catch(() => resolve(binding.workspace));
  const controlRoot = await realpath(requestedControlRoot).catch(() => resolve(requestedControlRoot));
  if (!isWithin(attemptRoot, workspace)) {
    throw new Error(
      `candidate workspace escaped the fixed test-root attempt (${workspace}); `
      + `expected a child of ${attemptRoot}`,
    );
  }
  if (!isWithin(attemptRoot, controlRoot)) {
    throw new Error(
      `candidate control root must stay inside the fixed test-root attempt (${controlRoot}); `
      + `expected a child of ${attemptRoot}`,
    );
  }
  const paths = await resolvePaths({
    workspace,
    controlRoot,
  });
  if (!paths || typeof paths.controlRoot !== 'string' || typeof paths.runNotesRoot !== 'string'
      || typeof paths.projectRoot !== 'string') {
    throw new Error('config resolver returned no controlRoot/runNotesRoot/projectRoot');
  }
  // The config owner may derive several state roots. Check the actual resolved
  // control, session project, and run-notes paths before allowing any runtime
  // write outside the owner-scoped attempt.
  for (const [label, path] of [
    ['control root', paths.controlRoot],
    ['project root', paths.projectRoot],
    ['run-notes root', paths.runNotesRoot],
  ]) {
    if (!isWithin(attemptRoot, await realpath(path).catch(() => resolve(path)))) {
      throw new Error(
        `candidate ${label} escaped the attempt root (${resolve(path)}); `
        + `candidate E2E runtime must stay under ${attemptRoot}`,
      );
    }
  }
  if (resolvePaths === configModule.resolveRuntimePaths && typeof configModule.loadConfiguration === 'function') {
    await configModule.loadConfiguration(paths);
  }
  binding.runtimePaths = paths;
  binding.controlRoot = paths.controlRoot;
  binding.runNotesRoot = paths.runNotesRoot;
  binding.projectRoot = paths.projectRoot ?? null;
  binding.projectKey = paths.projectKey ?? null;
  binding.receiptDir = join(binding.evidenceRoot, binding.attemptId);
  binding.screenshotsDir = join(binding.receiptDir, 'shots');
  // Candidate runtime roots are ephemeral; only the small evidence directory
  // survives the attempt. An explicit external control root remains caller
  // owned and is not silently added to this attempt's deletion inventory.
  binding.persistentRoots = [binding.receiptDir];
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
  const configModule = await loadConfigModule(binding.repoPath);
  const resolvePaths = options.resolvePaths ?? binding.resolvePaths ?? configModule.resolveRuntimePaths;
  if (typeof resolvePaths !== 'function') {
    throw new Error(`${CONFIG_MODULE_RELATIVE} does not export resolveRuntimePaths`);
  }
  let controlRoot = options.controlRoot ?? process.env.HUMANAGENT_ATTACH_CONTROL_ROOT;
  if (!controlRoot) {
    if (typeof configModule.resolveProductPaths !== 'function') {
      throw new Error('installed-attach requires an explicit formal control root or resolveProductPaths');
    }
    controlRoot = (await configModule.resolveProductPaths({})).controlRoot;
  }
  // `resolveRuntimePaths` may create missing default files. Installed-attach is
  // read-only, so refuse a root whose required product files are absent instead
  // of writing them during an acceptance observation.
  for (const required of ['internal.toml']) {
    try {
      await lstat(join(resolve(controlRoot), required));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `installed-attach refused read-only formal root ${resolve(controlRoot)}: ${required} is missing; `
          + 'no runtime or project file was written',
        );
      }
      throw error;
    }
  }
  const paths = await resolvePaths({ workspace: resolve(formalWorkspace), controlRoot: resolve(controlRoot) });
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
  return binding;
}

export async function prepareAttemptRoots(binding) {
  if (!binding.receiptDir) {
    throw new Error('prepareAttemptRoots requires a bound evidence directory');
  }
  binding.screenshotsDir = join(binding.receiptDir, 'shots');
  await mkdir(binding.workspace, { recursive: true });
  await mkdir(binding.receiptDir, { recursive: true });
  await mkdir(binding.screenshotsDir, { recursive: true });
  return binding;
}
