#!/usr/bin/env node
/**
 * Dashboard E2E runner contract tests.
 *
 * These are deterministic contract tests over the PUBLIC runner entry
 * (`parseOptions`, `assertSupportedCombination`, `runScenario`, `main`) and the
 * public lib helpers they call. They feed explicit fake/temp task-bound data
 * where permitted and never start a real service, browser, provider or port.
 *
 * They prove the runner contract:
 *   - accepted option semantics are reported and unsupported combinations are
 *     rejected up front (never downgraded to a new service or a success);
 *   - persistent paths come from the real config-derived resolver
 *     (`resolveRuntimePaths`), not from a temporary control root;
 *   - settlement requires the authoritative Journal terminal, checkpoint
 *     closure and effect evidence; a missing/corrupt journal stays unsettled;
 *   - a real non-success requested outcome produces a non-SUCCESS receipt and
 *     the unsettled branch retains the exact recovery resources with a named
 *     recovery owner;
 *   - candidate cleanup targets only the runner's exact recorded PID;
 *   - installed-attach never stops the attached owner.
 *
 * These fake contract tests are NOT real scenario acceptance. Real success /
 * failure / cancel screenshots and receipts, and the installed/takeover path,
 * are I1-V gates and remain UNVERIFIED here.
 *
 * Precondition: the candidate is built (`dist/config/config/src/index.js`);
 * the runner already requires the built product CLI for real runs.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  ENTRIES,
  OUTCOMES,
  SCENARIOS,
  SERVICE_MODES,
  USAGE,
  assertSupportedCombination,
  main,
  parseOptions,
} from './runner.mjs';
import {
  bindCandidate,
  resolveAttemptPaths,
  resolveFormalAttachPaths,
} from './lib/binding.mjs';
import {
  assessSettlement,
  journalPathFor,
  manifestsIdentical,
  readToolOutputReports,
  workspaceManifest,
} from './lib/journal.mjs';
import {
  attachToInstalledService,
  captureDashboardEvidence,
  describeDraftStage,
  openTaskDashboard,
  readDashboardProbe,
  readObservationDom,
  submitDirectiveAndConfirmDraft,
} from './lib/browser.mjs';
import {
  closeSettledAttempt,
  retainUnsettledRecovery,
  stopTaskAndSettle,
} from './lib/cleanup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..', '..');
const CONFIG_MODULE = join(REPO, 'dist', 'config', 'config', 'src', 'index.js');

// The real product owner of control-root/project path derivation.
const { resolveRuntimePaths } = existsSync(CONFIG_MODULE)
  ? await import(pathToFileURL(CONFIG_MODULE).href)
  : { resolveRuntimePaths: null };

const tempRoots = [];
async function makeTempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `i1e-contract-${label}-`));
  tempRoots.push(root);
  return root;
}

function assertResolverAvailable() {
  if (typeof resolveRuntimePaths !== 'function') {
    throw new Error(`product config module is not built at ${CONFIG_MODULE}; run \`pnpm build:config\` first`);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function spawnIdle() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  return child;
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await Promise.race([exited, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('option surface is reported and accepted combinations parse', () => {
  assert.deepEqual([...SCENARIOS], ['web-search', 'local-file-search', 'aitest']);
  assert.deepEqual([...ENTRIES], ['homepage', 'dashboard']);
  assert.deepEqual([...OUTCOMES], ['success', 'failure', 'cancel']);
  assert.deepEqual([...SERVICE_MODES], ['candidate', 'installed-attach']);
  assert.match(USAGE, /--entry <homepage\|dashboard>/);
  assert.match(USAGE, /--outcome <success\|failure\|cancel>/);
  assert.match(USAGE, /--service-mode <candidate\|installed-attach>/);

  // Documented defaults.
  assert.deepEqual(parseOptions(['--scenario', 'local-file-search']), {
    scenario: 'local-file-search', entry: 'dashboard', outcome: 'success', serviceMode: 'candidate',
  });
  // Explicit accepted combinations.
  assert.deepEqual(
    parseOptions(['--scenario', 'local-file-search', '--entry', 'homepage', '--outcome', 'cancel', '--service-mode', 'candidate']),
    { scenario: 'local-file-search', entry: 'homepage', outcome: 'cancel', serviceMode: 'candidate' },
  );
  // Positional scenario (the current pnpm script form) is preserved.
  assert.equal(parseOptions(['local-file-search']).scenario, 'local-file-search');
});

test('unsupported combinations are rejected, never downgraded', () => {
  assert.throws(() => parseOptions(['--scenario', 'nope']), /unknown scenario/);
  assert.throws(() => parseOptions(['--scenario', 'local-file-search', '--entry', 'kiosk']), /unsupported --entry/);
  assert.throws(() => parseOptions(['--scenario', 'local-file-search', '--outcome', 'partial']), /unsupported --outcome/);
  assert.throws(() => parseOptions(['--scenario', 'local-file-search', '--service-mode', 'detached']), /unsupported --service-mode/);
  // A scenario with no wired non-success path must refuse the request.
  assert.throws(() => parseOptions(['--scenario', 'web-search', '--outcome', 'failure']), /cannot exercise a real failure outcome/);
  assert.throws(() => parseOptions(['--scenario', 'aitest', '--outcome', 'cancel']), /cannot exercise a real cancel outcome/);
  // Attach cannot create a new task through the homepage.
  assert.throws(
    () => parseOptions(['--scenario', 'local-file-search', '--service-mode', 'installed-attach', '--entry', 'homepage']),
    /installed-attach.*homepage.*unsupported/,
  );
  // Only the scenario with an implemented existing-task observer may attach.
  assert.throws(
    () => parseOptions(['--scenario', 'web-search', '--service-mode', 'installed-attach']),
    /does not implement installed-attach/,
  );
  // Accepted attach combination with an existing-task entry.
  assert.deepEqual(
    parseOptions(['--scenario', 'local-file-search', '--service-mode', 'installed-attach', '--entry', 'dashboard']),
    { scenario: 'local-file-search', entry: 'dashboard', outcome: 'success', serviceMode: 'installed-attach' },
  );
  assert.deepEqual(assertSupportedCombination('local-file-search', { entry: 'dashboard', outcome: 'failure', serviceMode: 'candidate' }).outcome, 'failure');
});

test('unsupported installed-attach scenarios refuse before browser or service hooks', async () => {
  let touched = false;
  const { runScenario } = await import('./runner.mjs');
  await assert.rejects(
    () => runScenario('web-search', {
      serviceMode: 'installed-attach',
      hooks: {
        probeProvider: async () => { touched = true; },
        startServeForAttempt: async () => { touched = true; },
        attachToInstalledService: async () => { touched = true; },
      },
    }),
    /does not implement installed-attach/,
  );
  assert.equal(touched, false);
});

test('main --help prints the accepted options without running a scenario', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  let result;
  try {
    result = await main(['--help']);
  } finally {
    console.log = original;
  }
  assert.deepEqual(result, { help: true });
  assert.match(logs.join('\n'), /Usage: node tests\/app\/dashboard-e2e\/runner\.mjs/);
});

test('persistent paths derive from the real config resolver, not the attempt tmp', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('control');
  const binding = bindCandidate(REPO, {
    scenario: 'local-file-search',
    entry: 'dashboard',
    outcome: 'success',
    serviceMode: 'candidate',
    attemptIdSuffix: 'contract',
  });
  const paths = await resolveAttemptPaths(binding, { resolvePaths: resolveRuntimePaths, controlRoot });

  assert.equal(binding.scenario, 'local-file-search');
  // The ephemeral attempt root only holds the execution workspace.
  assert.equal(binding.workspace, join(binding.attemptRoot, 'workspace'));
  // Control root is config-derived and can never live inside the attempt tmp.
  assert.equal(binding.controlRoot, paths.controlRoot);
  assert.equal(binding.runNotesRoot, paths.runNotesRoot);
  assert.ok(paths.runNotesRoot.startsWith(paths.controlRoot), 'runNotesRoot must sit under the canonical control root');
  assert.ok(!paths.controlRoot.startsWith(binding.attemptRoot), 'control root must not sit inside the attempt tmp');
  assert.ok(!binding.workspace.startsWith(paths.controlRoot), 'workspace must not sit under the persistent control root');
  // Receipts/screenshots root under the config-derived runNotesRoot/<attempt>.
  assert.equal(binding.receiptDir, join(paths.runNotesRoot, binding.attemptId));
  assert.equal(binding.screenshotsDir, join(binding.receiptDir, 'shots'));
  assert.deepEqual(binding.persistentRoots, [paths.controlRoot, paths.runNotesRoot, binding.receiptDir]);
});

test('a resolver that roots the control root inside the attempt tmp fails closed', async () => {
  const binding = bindCandidate(REPO, { scenario: 'local-file-search', attemptIdSuffix: 'badroot' });
  const badResolver = async ({ workspace }) => ({
    controlRoot: join(binding.attemptRoot, 'control'),
    runNotesRoot: join(binding.attemptRoot, 'control', 'run-notes'),
    projectRoot: join(binding.attemptRoot, 'control', 'project'),
    workspaceCwd: workspace,
  });
  await assert.rejects(
    () => resolveAttemptPaths(binding, { resolvePaths: badResolver }),
    /persistent control root inside the ephemeral attempt tmp/,
  );
});

/**
 * Fixture writers built on the existing public Journal owners. `UiRuntimeJournal`
 * validates the projection/tool-fact chain and `FileCheckpointStore` delegates
 * to `JsonlOrganJournal`, so these fixtures carry real digests, predecessors and
 * commit fields instead of a flat shape with no integrity.
 */
const JSONL_MODULE = join(REPO, 'dist', 'app', 'adapters', 'jsonl', 'src', 'index.js');
const UI_JOURNAL_MODULE = join(REPO, 'dist', 'app', 'app', 'src', 'ui-runtime', 'journal.js');
const { JsonlOrganJournal } = await import(pathToFileURL(JSONL_MODULE).href);
const { UiRuntimeJournal, FileCheckpointStore } = await import(pathToFileURL(UI_JOURNAL_MODULE).href);

const CONTRACT_ORGAN = Object.freeze({ scope: 'organ', value: 'organ-contract' });
const CONTRACT_TASK = Object.freeze({ scope: 'task', value: 'task-contract' });
const CONTRACT_CYCLE = Object.freeze({ scope: 'cycle', value: 'cycle-contract' });
const CONTRACT_OPERATION = Object.freeze({ scope: 'operation', value: 'operation-contract' });
const CONTRACT_EPOCH = 1;
const CONTRACT_SCOPE = Object.freeze({
  organId: CONTRACT_ORGAN,
  taskId: CONTRACT_TASK,
  cycleId: CONTRACT_CYCLE,
  operationId: CONTRACT_OPERATION,
  executionEpoch: CONTRACT_EPOCH,
});

function operationEvent(record, scope = CONTRACT_SCOPE) {
  const seq = eventSeq += 1;
  return {
    eventId: `${scope.operationId.value}-${seq}`,
    seq,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    taskId: scope.taskId,
    operationId: scope.operationId.value,
    executionEpoch: scope.executionEpoch,
    kind: 'provider.model',
    state: 'running',
    summary: 'fixture event',
    evidenceRefs: [],
    ...record,
  };
}

let eventSeq = 0;

function resetEventSeq() { eventSeq = 0; }

function operationStartedEvent(scope = CONTRACT_SCOPE, operationCounter = 1) {
  return {
    kind: 'operation.started',
    operationId: scope.operationId,
    taskId: scope.taskId,
    cycleId: scope.cycleId,
    scope: {
      organId: scope.organId,
      taskId: scope.taskId,
      cycleId: scope.cycleId,
      operationId: scope.operationId,
    },
    executionEpoch: scope.executionEpoch,
    operationCounter,
    cycleCounter: operationCounter,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString(),
    input: 'fixture directive',
  };
}

function eventRecord(event, scope = CONTRACT_SCOPE) {
  return { kind: 'operation.event', operationId: scope.operationId, event };
}

/**
 * Build the normal success/failure fixture the way the runtime emits it:
 * provider terminal -> business checkpoint commit/projection -> final terminal.
 */
async function writeOutcomeFixture(dir, name, options = {}) {
  resetEventSeq();
  const scope = options.scope ?? CONTRACT_SCOPE;
  const terminalState = options.terminalState ?? 'succeeded';
  const checkpointOutcome = options.checkpointOutcome ?? terminalState;
  const includeFinal = options.includeFinal !== false;
  const providerTerminal = options.providerTerminal !== false;
  const skipCheckpoint = options.skipCheckpoint === true;
  const providerPhase = options.providerPhase === undefined ? 'provider' : options.providerPhase;
  const finalPhase = options.finalPhase === undefined ? 'final' : options.finalPhase;
  const uiPath = join(dir, options.uiFile ?? `ui-${name ?? 'outcome'}.jsonl`);
  const checkpointPath = join(dir, options.checkpointFile ?? `task-${scope.taskId.value}-cycle-${scope.cycleId.value}-${name ?? 'outcome'}.jsonl`);
  await rm(uiPath, { force: true });
  await rm(checkpointPath, { force: true });
  const ui = new UiRuntimeJournal(uiPath);
  const store = new FileCheckpointStore(checkpointPath);
  ui.append(operationStartedEvent(scope));
  ui.append(eventRecord(operationEvent({ kind: 'provider.request-start', summary: 'provider requested model work' }, scope), scope));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.tool',
    summary: 'file.search marker',
    callId: 'call_1',
    toolId: 'file.search',
    arguments: { query: 'marker' },
  }, scope), scope));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.tool-result',
    summary: 'file.search marker -> hit',
    callId: 'call_1',
    toolId: 'file.search',
    status: 'succeeded',
    outputRef: 'asset://r',
    outputDigest: 'sha256:abc',
  }, scope), scope));
  if (providerTerminal) {
    ui.append(eventRecord(operationEvent({
      kind: 'execution.terminal',
      state: terminalState,
      summary: 'provider reported terminal',
      ...(providerPhase === null ? {} : { terminalPhase: providerPhase }),
      ...(terminalState === 'failed' ? { error: 'file.read: EISDIR' } : {}),
    }, scope), scope));
  }
  if (!skipCheckpoint) {
    const checkpoint = makeCheckpoint(scope, checkpointOutcome, 1, null, options.checkpointOverrides);
    await store.commit(checkpoint);
    const committedRecord = (await new JsonlOrganJournal(checkpointPath).verify()).records.at(-1);
    ui.append(eventRecord(operationEvent({
      kind: 'checkpoint.committed',
      state: checkpointOutcome,
      summary: `execution ${checkpointOutcome}`,
      evidenceRefs: committedRecord.checkpoint.evidenceRefs,
    }, scope), scope));
  }
  if (includeFinal) {
    const finalState = options.finalState ?? terminalState;
    ui.append(eventRecord(operationEvent({
      kind: 'execution.terminal',
      state: finalState,
      summary: `execution ${finalState}; provider closed`,
      ...(finalPhase === null ? {} : { terminalPhase: finalPhase }),
      ...(finalState === 'failed' ? { error: 'file.read: EISDIR' } : {}),
    }, scope), scope));
  }
  return {
    uiPath,
    checkpointPath,
    paths: skipCheckpoint ? [uiPath] : [uiPath, checkpointPath],
  };
}

function cancelJournalPaths(binding) {
  const journalRoot = join(
    binding.controlRoot,
    'sessions',
    binding.projectKey,
    'checkpoints',
    binding.journalMode ?? 'rcc',
  );
  return {
    journalRoot,
    uiPath: join(journalRoot, 'ui-runtime-journal.jsonl'),
    checkpointPath: join(
      journalRoot,
      `task-${CONTRACT_TASK.value}-cycle-${CONTRACT_CYCLE.value}.jsonl`,
    ),
  };
}

/**
 * Write the running half of a real cancel attempt. The final stopped
 * checkpoint/final terminal is appended only after the first stop assessment,
 * so the test exercises the early-incomplete -> read-only-reassessment path.
 */
async function writeCancelRunningJournal(binding) {
  resetEventSeq();
  const paths = cancelJournalPaths(binding);
  await rm(paths.uiPath, { force: true });
  await rm(paths.checkpointPath, { force: true });
  const ui = new UiRuntimeJournal(paths.uiPath);
  ui.append(operationStartedEvent(CONTRACT_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.request-start',
    summary: 'provider requested model work',
  }, CONTRACT_SCOPE), CONTRACT_SCOPE));
  binding.journalPath = paths.uiPath;
  binding.journalPaths = [paths.uiPath];
  return paths;
}

async function writeCancelIdentityFixture(binding, variant) {
  const paths = cancelJournalPaths(binding);
  await rm(paths.uiPath, { force: true });
  await rm(paths.checkpointPath, { force: true });
  if (variant === 'missing') {
    binding.journalPath = paths.uiPath;
    binding.journalPaths = [paths.uiPath];
    return paths;
  }

  const ui = new UiRuntimeJournal(paths.uiPath);
  ui.append(operationStartedEvent(CONTRACT_SCOPE));
  if (variant === 'ambiguous') {
    const other = contractScope({
      cycleId: { scope: 'cycle', value: 'cycle-other' },
      operationId: { scope: 'operation', value: 'operation-other' },
    });
    ui.append(operationStartedEvent(other, 2));
  }
  if (variant === 'corrupt') {
    await writeFile(
      paths.uiPath,
      `${await readFile(paths.uiPath, 'utf8')}{"kind":"operation.event","event":\n`,
      'utf8',
    );
  }
  binding.journalPath = paths.uiPath;
  binding.journalPaths = [paths.uiPath];
  return paths;
}

async function appendCancelSettlement(binding) {
  const paths = cancelJournalPaths(binding);
  const store = new FileCheckpointStore(paths.checkpointPath);
  const checkpoint = makeCheckpoint(CONTRACT_SCOPE, 'stopped', 1, null);
  await store.commit(checkpoint);
  const committed = (await new JsonlOrganJournal(paths.checkpointPath).verify()).records.at(-1);
  const ui = new UiRuntimeJournal(paths.uiPath);
  ui.append(eventRecord(operationEvent({
    kind: 'checkpoint.committed',
    state: 'stopped',
    summary: 'stopped checkpoint committed',
    evidenceRefs: committed.checkpoint.evidenceRefs,
  }, CONTRACT_SCOPE), CONTRACT_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'execution.terminal',
    state: 'stopped',
    summary: 'execution stopped; provider closed',
    terminalPhase: 'final',
  }, CONTRACT_SCOPE), CONTRACT_SCOPE));
  binding.journalPath = paths.uiPath;
  binding.journalPaths = [paths.uiPath, paths.checkpointPath];
  return paths;
}

function makeEvidenceRef(scope, suffix, locator, kind = 'operation') {
  return {
    evidenceId: { scope: 'evidence', value: `evidence-${suffix}` },
    kind,
    source: 'humanagent.runtime',
    locator,
    scope,
  };
}

function makeCheckpoint(scope, outcome, seq, previous, overrides = {}) {
  const checkpointScope = overrides.scope ?? {
    organId: scope.organId,
    taskId: scope.taskId,
    cycleId: scope.cycleId,
    // Runtime business checkpoints are commonly committed without an operation
    // scope. The operation link is carried by recoveryStateRef/evidenceRefs.
    ...(scope.operationId && overrides.includeOperationId === true ? { operationId: scope.operationId } : {}),
  };
  const operationValue = scope.operationId?.value ?? 'operation-contract';
  const recoveryStateRef = overrides.recoveryStateRef
    ?? makeEvidenceRef(checkpointScope, `recovery-${operationValue}-${seq}`, `operation/${operationValue}/checkpoint-recovery`);
  const checkpointRef = overrides.checkpointRef
    ?? makeEvidenceRef(checkpointScope, `checkpoint-${operationValue}-${seq}`, `operation/${operationValue}/checkpoint`);
  const previousCheckpointId = overrides.previousCheckpointId !== undefined
    ? overrides.previousCheckpointId
    : previous;
  return {
    id: overrides.id ?? { scope: 'checkpoint', value: `checkpoint-${scope.taskId.value}-${scope.executionEpoch}-${seq}` },
    scope: checkpointScope,
    cycleId: overrides.cycleId ?? scope.cycleId,
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch: overrides.executionEpoch ?? scope.executionEpoch,
    outcome,
    summary: `execution ${outcome}`,
    recoveryStateRef,
    evidenceRefs: overrides.evidenceRefs ?? [checkpointRef],
    next: outcome === 'failed' || outcome === 'blocked'
      ? { kind: 'recover', ref: `task://${scope.taskId.value}/recovery` }
      : outcome === 'cancelled' || outcome === 'stopped'
        ? { kind: 'stop', ref: 'operator-stop' }
        : { kind: 'continue', ref: `task://${scope.taskId.value}/next` },
  };
}

async function writeRawJournal(dir, name, records) {
  const path = join(dir, name);
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return path;
}

function settlementBinding(journalPath, outcome, scope = CONTRACT_SCOPE) {
  const paths = Array.isArray(journalPath) ? journalPath : [journalPath];
  return {
    outcome,
    journalPath: paths[0],
    journalPaths: paths,
    ...scope,
    scope,
  };
}

function contractScope(overrides = {}) {
  const taskId = overrides.taskId ?? CONTRACT_TASK;
  const cycleId = overrides.cycleId ?? CONTRACT_CYCLE;
  const operationId = overrides.operationId ?? CONTRACT_OPERATION;
  const executionEpoch = overrides.executionEpoch ?? CONTRACT_EPOCH;
  return { organId: overrides.organId ?? CONTRACT_ORGAN, taskId, cycleId, operationId, executionEpoch };
}

// A completely distinct task/cycle/operation/epoch: its history is never the
// current attempt's evidence.
const OTHER_SCOPE = Object.freeze(contractScope({
  taskId: { scope: 'task', value: 'task-other' },
  cycleId: { scope: 'cycle', value: 'cycle-other' },
  operationId: { scope: 'operation', value: 'operation-other' },
  executionEpoch: 2,
}));

// A minimal authenticated fetch double that records every request and answers
// the task stop POST and the dashboard probe. It never opens a socket.
function fakeAuth(calls, options = {}) {
  const dashboardState = options.dashboardState ?? 'succeeded';
  const dashboardBody = options.dashboardBody ?? {
    state: dashboardState,
    operationId: options.operationId ?? CONTRACT_OPERATION.value,
    executionEpoch: options.executionEpoch ?? CONTRACT_EPOCH,
  };
  return {
    fetch: async (url, init = {}) => {
      const method = String(init.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (method === 'POST') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(dashboardBody) };
    },
  };
}

/**
 * Minimal browser boundary for the real cancel scenario. It implements only
 * the DOM observations that scenario/helper chain actually consumes; all task
 * state still comes through the fake authenticated transport and the public
 * Journal fixtures.
 */
function fakeBrowserPage() {
  let url = 'about:blank';
  const confirmButton = { textContent: async () => '确认并执行' };
  const compactBox = { width: 14, height: 14 };
  return {
    url: () => url,
    async goto(next) { url = String(next); return { ok: () => true, status: () => 200 }; },
    async waitForSelector() {},
    locator(selector) {
      return {
        boundingBox: async () => (String(selector).includes('autoConfirm') ? compactBox : { width: 100, height: 20 }),
      };
    },
    async fill() {},
    async click(selector) {
      if (String(selector).includes('.draft-actions')) {
        this.confirmed = true;
      }
    },
    async $(selector) {
      return String(selector).includes('.draft-actions') ? confirmButton : null;
    },
    async textContent(selector) {
      if (String(selector).includes('.draft-proposal')) return 'fixture proposal';
      if (String(selector).includes('.quick-create-form button')) return '确认并执行';
      return '';
    },
    async getAttribute() { return null; },
    async $$eval(selector, callback) {
      if (String(selector).includes('.draft-meta')) {
        return callback([{ textContent: '意图：create' }]);
      }
      return callback([]);
    },
    async waitForResponse() { return { status: () => 200 }; },
    async reload() {},
    async screenshot() {},
  };
}

function fakeHomepagePage(navigationUrl, options = {}) {
  let url = 'about:blank';
  const delayMs = options.delayMs ?? 0;
  // Real Playwright `page.waitForURL` synchronizes on the navigation/load state
  // and resolves `undefined`; the fake must not return a URL. `resolveWithoutNavigation`
  // models a wait that resolves without the page having navigated, so the
  // post-wait `page.url()` validation is exercised.
  const resolveWithoutNavigation = options.resolveWithoutNavigation === true;
  return {
    url: () => url,
    async goto(next) {
      url = String(next);
      return { ok: () => true, status: () => 200 };
    },
    async waitForSelector() {},
    locator() {
      return { boundingBox: async () => ({ width: 100, height: 20 }) };
    },
    async fill() {},
    async click(selector) {
      if (!String(selector).includes('entry-form')) return;
      if (resolveWithoutNavigation) return;
      if (delayMs > 0) await sleep(delayMs);
      if (navigationUrl !== null) url = String(navigationUrl);
    },
    async waitForURL(predicate, { timeout } = {}) {
      if (resolveWithoutNavigation) return undefined;
      const deadline = Date.now() + Number(timeout ?? 1000);
      for (;;) {
        if (url !== 'about:blank') {
          try {
            if (predicate(new URL(url))) return undefined;
          } catch {
            // Keep polling until the timeout; invalid navigation is a refusal.
          }
        }
        if (Date.now() > deadline) throw new Error('fixture navigation timeout');
        await sleep(10);
      }
    },
    async screenshot() {},
    async reload() {},
  };
}

function successRunEvidence(binding, overrides = {}) {
  const scope = binding.scope ?? CONTRACT_SCOPE;
  const terminalState = overrides.terminalState ?? 'succeeded';
  return {
    terminalState,
    dashboardState: terminalState,
    taskId: scope.taskId,
    scenarioEvidence: {
      taskId: scope.taskId,
      operationId: scope.operationId,
      cycleId: scope.cycleId,
      executionEpoch: scope.executionEpoch,
    },
    toolRounds: 1,
    requestStartTurns: 1,
    checkpointCommitted: 1,
    terminalRecord: { kind: 'execution.terminal', state: terminalState },
    evidenceRefs: [],
    screenshots: [],
    ...overrides,
  };
}

async function runContractMain(label, journalPath, options = {}) {
  const controlRoot = await makeTempRoot(`${label}-control`);
  const logs = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  let result;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const argv = ['--scenario', 'local-file-search'];
    if (options.outcome) argv.push('--outcome', options.outcome);
    result = await main(argv, {
      attemptIdSuffix: label,
      resolvePaths: resolveRuntimePaths,
      controlRoot,
      scope: options.scope ?? CONTRACT_SCOPE,
      hooks: {
        probeProvider: async () => {},
        startServeForAttempt: async (binding) => {
          binding.serveBaseUrl = 'http://127.0.0.1:1';
          binding.servePort = options.servePort ?? null;
          binding.servePid = options.servePid ?? null;
        },
        launchBrowserSession: async (binding) => {
          binding.browser = { close: options.closeBrowser ?? (async () => {}) };
        },
        runScenario: async (binding) => {
          binding.scope = options.scope ?? CONTRACT_SCOPE;
          binding.taskId = binding.scope.taskId;
          binding.operationId = binding.scope.operationId;
          binding.cycleId = binding.scope.cycleId;
          binding.executionEpoch = binding.scope.executionEpoch;
          const paths = (Array.isArray(journalPath) ? journalPath : [journalPath]).filter(Boolean);
          binding.journalPath = paths[0] ?? null;
          binding.journalPaths = paths;
          return successRunEvidence(binding, options.evidence);
        },
      },
    });
    return { result, logs, exitCode: process.exitCode ?? 0 };
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
}

test('settlement requires the authoritative Journal final + business checkpoint + effect', async () => {
  const dir = await makeTempRoot('journal');
  const ok = await writeOutcomeFixture(dir, 'ok');
  const settled = await assessSettlement(settlementBinding(ok.paths, 'success'));
  assert.equal(settled.settled, true, settled.reason);
  assert.equal(settled.terminal.state, 'succeeded');
  assert.equal(settled.terminal.terminalPhase, 'final');
  assert.equal(settled.evidence.checkpointCommitted, 1);
  assert.ok(settled.evidence.toolRounds >= 1);

  const committed = (await new JsonlOrganJournal(ok.checkpointPath).verify()).records.at(-1).checkpoint;
  assert.equal(committed.scope.operationId, undefined, 'runtime business checkpoints may omit operationId');
  assert.equal(committed.recoveryStateRef.locator, 'operation/operation-contract/checkpoint-recovery');
  assert.equal(committed.evidenceRefs[0].locator, 'operation/operation-contract/checkpoint');

  // Succeeded final but no committed checkpoint -> unsettled.
  const noCheckpoint = await writeOutcomeFixture(dir, 'nocheckpoint', { skipCheckpoint: true });
  const unresolved = await assessSettlement(settlementBinding(noCheckpoint.paths, 'success'));
  assert.equal(unresolved.settled, false);
  assert.match(unresolved.reason, /settlement evidence is incomplete/);

  // Missing/corrupt journal -> unsettled, and the read error is not swallowed.
  const missing = await assessSettlement(settlementBinding(join(dir, 'does-not-exist.jsonl'), 'success'));
  assert.equal(missing.settled, false);
  assert.match(missing.reason, /journal unavailable/);
  const noPath = await assessSettlement({ outcome: 'success' });
  assert.equal(noPath.settled, false);
  assert.match(noPath.reason, /journal unavailable/);

  // A provider-phase terminal is not the runtime's final settlement barrier.
  const providerOnly = await writeOutcomeFixture(dir, 'provider-only', { includeFinal: false });
  const providerOnlyResult = await assessSettlement(settlementBinding(providerOnly.paths, 'success'));
  assert.equal(providerOnlyResult.settled, false);
  assert.match(providerOnlyResult.reason, /provider-phase/);

  // A missing phase is also not a final terminal.
  const missingPhase = await writeOutcomeFixture(dir, 'missing-phase', { finalPhase: null });
  const missingPhaseResult = await assessSettlement(settlementBinding(missingPhase.paths, 'success'));
  assert.equal(missingPhaseResult.settled, false);
  assert.match(missingPhaseResult.reason, /provider-phase/);
});

test('scope settlement rejects mixed operation, task, cycle, organ and epoch evidence', async () => {
  const dir = await makeTempRoot('scope-settlement');
  const complete = await writeOutcomeFixture(dir, 'complete');

  // The identity is learned from the verified operation.started record; the
  // binding may omit redundant scope fields.
  const fromJournal = await assessSettlement({
    outcome: 'success',
    journalPath: complete.uiPath,
    journalPaths: complete.paths,
  });
  assert.equal(fromJournal.settled, true, fromJournal.reason);

  const otherOperation = contractScope({ operationId: { scope: 'operation', value: 'operation-other' } });
  const otherEpoch = contractScope({ executionEpoch: 2 });
  const otherTask = contractScope({ taskId: { scope: 'task', value: 'task-other' } });
  const otherCycle = contractScope({ cycleId: { scope: 'cycle', value: 'cycle-other' } });
  const otherOrgan = contractScope({ organId: { scope: 'organ', value: 'organ-other' } });

  for (const [label, scope] of [
    ['operation', otherOperation],
    ['epoch', otherEpoch],
    ['task', otherTask],
    ['cycle', otherCycle],
    ['organ', otherOrgan],
  ]) {
    const mismatch = await assessSettlement(settlementBinding(complete.paths, 'success', scope));
    assert.equal(mismatch.settled, false, label);
    assert.match(mismatch.reason, /execution identity is unavailable|no verified operation\.started/, label);
  }

  // A checkpoint that does not link to the verified operation cannot close the
  // current execution even when its task/cycle are otherwise identical.
  const wrongLink = await writeOutcomeFixture(dir, 'wrong-link', {
    checkpointOverrides: {
      recoveryStateRef: makeEvidenceRef(
        { organId: CONTRACT_ORGAN, taskId: CONTRACT_TASK, cycleId: CONTRACT_CYCLE },
        'recovery-wrong',
        'operation/operation-other/checkpoint-recovery',
      ),
    },
  });
  const wrongLinkResult = await assessSettlement(settlementBinding(wrongLink.paths, 'success'));
  assert.equal(wrongLinkResult.settled, false);
  assert.match(wrongLinkResult.reason, /settlement evidence is incomplete/);

  // A checkpoint with the correct recovery link but a mismatched committed
  // projection must not be selected by a newer unrelated record.
  const wrongProjection = await writeOutcomeFixture(dir, 'wrong-projection', {
    checkpointOverrides: {
      checkpointRef: makeEvidenceRef(
        { organId: CONTRACT_ORGAN, taskId: CONTRACT_TASK, cycleId: CONTRACT_CYCLE },
        'checkpoint-wrong',
        'operation/operation-other/checkpoint',
      ),
    },
  });
  const wrongProjectionResult = await assessSettlement(settlementBinding(wrongProjection.paths, 'success'));
  assert.equal(wrongProjectionResult.settled, false);
  assert.match(wrongProjectionResult.reason, /settlement evidence is incomplete/);

  // The checkpoint's own operation link is valid, but its committed projection
  // was published by another operation. The projection operation boundary must
  // still match; matching evidence refs alone are not enough.
  const crossedProjection = await writeOutcomeFixture(dir, 'crossed-projection');
  const crossedCheckpoint = (await new JsonlOrganJournal(crossedProjection.checkpointPath).verify()).records.at(-1).checkpoint;
  const crossedLines = (await readFile(crossedProjection.uiPath, 'utf8'))
    .trim()
    .split('\n')
    .filter((line) => JSON.parse(line).event?.kind !== 'checkpoint.committed');
  await writeFile(crossedProjection.uiPath, `${crossedLines.join('\n')}\n`, 'utf8');
  const crossedUi = new UiRuntimeJournal(crossedProjection.uiPath);
  crossedUi.append(operationStartedEvent(OTHER_SCOPE, 2));
  crossedUi.append(eventRecord(operationEvent({
    kind: 'checkpoint.committed',
    state: 'succeeded',
    summary: 'foreign operation projected the same evidence refs',
    evidenceRefs: crossedCheckpoint.evidenceRefs,
  }, OTHER_SCOPE), OTHER_SCOPE));
  const crossedResult = await assessSettlement(settlementBinding(crossedProjection.paths, 'success'));
  assert.equal(crossedResult.settled, false);
  assert.match(crossedResult.reason, /settlement evidence is incomplete/);
});

test('failure/cancel outcomes are distinguished from success', async () => {
  const dir = await makeTempRoot('outcome');
  const failed = await writeOutcomeFixture(dir, 'failed', {
    terminalState: 'failed',
    checkpointOutcome: 'failed',
  });
  const failedSettled = await assessSettlement(settlementBinding(failed.paths, 'failure'));
  assert.equal(failedSettled.settled, true, failedSettled.reason);
  assert.equal(failedSettled.terminal.state, 'failed');
  assert.equal(failedSettled.terminal.terminalPhase, 'final');
  // The same failed journal must not settle a requested success.
  const wrong = await assessSettlement(settlementBinding(failed.paths, 'success'));
  assert.equal(wrong.settled, false);
  assert.match(wrong.reason, /does not match the expected success outcome/);

  const stopped = await writeOutcomeFixture(dir, 'stopped', {
    terminalState: 'stopped',
    checkpointOutcome: 'stopped',
  });
  const cancelledSettled = await assessSettlement(settlementBinding(stopped.paths, 'cancel'));
  assert.equal(cancelledSettled.settled, true, cancelledSettled.reason);
  assert.equal(cancelledSettled.terminal.state, 'stopped');
  assert.equal((await assessSettlement(settlementBinding(stopped.paths, 'success'))).settled, false);
});

test('a damaged UI journal line fails the settlement proof closed', async () => {
  const dir = await makeTempRoot('damaged');
  const fixture = await writeOutcomeFixture(dir, 'damaged');
  const before = await readFile(fixture.uiPath, 'utf8');
  // A corrupt line sits after valid provider evidence and before the terminal:
  // the later final/checkpoint rows must not launder the damaged journal into a
  // settled result.
  await writeFile(fixture.uiPath, `${before}{"kind":"operation.event","event":\n`, 'utf8');
  const result = await assessSettlement(settlementBinding(fixture.paths, 'success'));
  assert.equal(result.settled, false);
  assert.match(result.reason, /damaged|invalid JSON|corrupt UI/i);
});

test('an invalid authoritative checkpoint or UI tool fact fails closed', async () => {
  const dir = await makeTempRoot('invalid');
  const digest = await writeOutcomeFixture(dir, 'bad-digest');
  const checkpointLines = (await readFile(digest.checkpointPath, 'utf8')).trim().split('\n');
  const checkpointRecord = JSON.parse(checkpointLines[0]);
  checkpointRecord.recordDigest = 'sha256:deadbeef';
  await writeFile(digest.checkpointPath, `${JSON.stringify(checkpointRecord)}\n`, 'utf8');
  const digestResult = await assessSettlement(settlementBinding(digest.paths, 'success'));
  assert.equal(digestResult.settled, false);
  assert.match(digestResult.reason, /digest|invalid|corrupt/i);

  // A valid-JSON checkpoint whose commit envelope is incomplete is still
  // rejected by JsonlOrganJournal.verify().
  const commitFields = await writeOutcomeFixture(dir, 'bad-commit-fields');
  const commitLines = (await readFile(commitFields.checkpointPath, 'utf8')).trim().split('\n');
  const commitRecord = JSON.parse(commitLines[0]);
  commitRecord.commitId = undefined;
  await writeFile(commitFields.checkpointPath, `${JSON.stringify(commitRecord)}\n`, 'utf8');
  const commitResult = await assessSettlement(settlementBinding(commitFields.paths, 'success'));
  assert.equal(commitResult.settled, false);
  assert.match(commitResult.reason, /commit fields|digest|invalid|corrupt/i);

  // A predecessor that points nowhere cannot be committed by the public writer.
  const badPredecessorPath = join(dir, 'task-task-contract-cycle-cycle-contract-bad-predecessor.jsonl');
  const badStore = new FileCheckpointStore(badPredecessorPath);
  const badCheckpoint = makeCheckpoint(CONTRACT_SCOPE, 'succeeded', 1, null, {
    previousCheckpointId: { scope: 'checkpoint', value: 'checkpoint-missing-predecessor' },
  });
  await assert.rejects(
    () => badStore.commit(badCheckpoint),
    /broken checkpoint predecessor|invalid root checkpoint/,
  );

  const toolFact = await writeOutcomeFixture(dir, 'bad-tool-fact');
  const toolLines = (await readFile(toolFact.uiPath, 'utf8')).trim().split('\n');
  const toolRecord = JSON.parse(toolLines[3]);
  toolRecord.event.executionFact = { malformed: true };
  toolLines[3] = JSON.stringify(toolRecord);
  await writeFile(toolFact.uiPath, `${toolLines.join('\n')}\n`, 'utf8');
  const toolFactResult = await assessSettlement(settlementBinding(toolFact.paths, 'success'));
  assert.equal(toolFactResult.settled, false);
  assert.match(toolFactResult.reason, /tool execution fact|corrupt UI|invalid/i);
});

test('outcome aliases cannot masquerade as a legal terminal state', async () => {
  const dir = await makeTempRoot('alias');
  const successAlias = await writeOutcomeFixture(dir, 'success-alias', {
    terminalState: 'success',
    finalState: 'success',
  });
  const successResult = await assessSettlement(settlementBinding(successAlias.paths, 'success'));
  assert.equal(successResult.settled, false);
  assert.match(successResult.reason, /does not match the expected success outcome/);

  const failureAlias = await writeOutcomeFixture(dir, 'failure-alias', {
    terminalState: 'failure',
    finalState: 'failure',
    checkpointOutcome: 'failed',
  });
  const failureResult = await assessSettlement(settlementBinding(failureAlias.paths, 'failure'));
  assert.equal(failureResult.settled, false);
  assert.match(failureResult.reason, /does not match the expected failure outcome/);
});

test('stop/settle helper and retention together issue exactly one stop', async () => {
  const dir = await makeTempRoot('one-stop');
  // A succeeded terminal without a committed checkpoint stays unsettled, so the
  // retention branch runs after the single stop.
  const journal = await writeOutcomeFixture(dir, 'unsettled', { skipCheckpoint: true });
  const calls = [];
  const binding = {
    serviceMode: 'candidate',
    outcome: 'success',
    ...CONTRACT_SCOPE,
    scope: CONTRACT_SCOPE,
    serveBaseUrl: 'http://127.0.0.1:1',
    journalPath: journal.uiPath,
    journalPaths: journal.paths,
    auth: fakeAuth(calls, { dashboardState: 'succeeded' }),
    browser: { close: async () => {} },
    tempRoots: [],
    persistentRoots: [],
    servePid: null,
  };
  const settleResult = await stopTaskAndSettle(binding, binding.taskId, { expectedOutcome: 'success' });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1, 'the helper issues the single stop');
  assert.equal(settleResult.stopped, true);
  assert.equal(settleResult.settled, false);
  const cleanup = await retainUnsettledRecovery(binding, 'settlement evidence incomplete', settleResult);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1, 'retention must not repeat the stop POST');
  assert.equal(cleanup.taskStop.stopped, true);
  assert.equal(cleanup.settled, false);
});

test('a task already at a legal terminal is assessed read-only, never stopped', async () => {
  const dir = await makeTempRoot('terminal');
  const journal = await writeOutcomeFixture(dir, 'ok');
  const calls = [];
  const binding = {
    serviceMode: 'candidate',
    outcome: 'success',
    ...CONTRACT_SCOPE,
    scope: CONTRACT_SCOPE,
    terminalState: 'succeeded',
    serveBaseUrl: 'http://127.0.0.1:1',
    journalPath: journal.uiPath,
    journalPaths: journal.paths,
    auth: fakeAuth(calls, { dashboardState: 'succeeded' }),
  };
  const result = await stopTaskAndSettle(binding, binding.taskId, { expectedOutcome: 'success', terminalState: 'succeeded' });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0, 'a terminal task must never receive a stop');
  assert.equal(result.readOnly, true);
  assert.equal(result.settled, true);
});

test('installed-attach stop/settle never posts a stop to the formal owner', async () => {
  const dir = await makeTempRoot('attach-stop');
  const journal = await writeOutcomeFixture(dir, 'ok');
  const calls = [];
  const binding = {
    serviceMode: 'installed-attach',
    outcome: 'success',
    ...CONTRACT_SCOPE,
    scope: CONTRACT_SCOPE,
    terminalState: 'succeeded',
    serveBaseUrl: 'http://127.0.0.1:1',
    journalPath: journal.uiPath,
    journalPaths: journal.paths,
    auth: fakeAuth(calls, { dashboardState: 'succeeded' }),
  };
  const result = await stopTaskAndSettle(binding, binding.taskId, { expectedOutcome: 'success' });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0, 'the attached owner must not be stopped');
  assert.equal(result.readOnly, true);
  assert.equal(result.settled, true);
});

test('installed-attach resolves explicit formal paths and reads the formal lease', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('attach-formal-control');
  const formalWorkspace = await makeTempRoot('attach-formal-workspace');
  const attempt = bindCandidate(REPO, {
    scenario: 'local-file-search',
    entry: 'dashboard',
    outcome: 'success',
    serviceMode: 'installed-attach',
    attemptIdSuffix: 'formal-attach',
  });
  await resolveAttemptPaths(attempt, { resolvePaths: resolveRuntimePaths, controlRoot });
  await resolveFormalAttachPaths(attempt, {
    formalWorkspace,
    resolvePaths: resolveRuntimePaths,
    controlRoot,
  });

  const leaseReads = [];
  const lease = {
    ownerId: 'humanagent.app.serve',
    pid: process.pid,
    controlEndpoint: { port: 1 },
    leaseId: 'lease-formal',
    generation: 1,
  };
  const calls = [];
  const auth = {
    paired: false,
    async pair() { this.paired = true; },
    async fetch(url, init = {}) {
      const target = String(url);
      calls.push({ target, method: String(init.method ?? 'GET').toUpperCase() });
      if (target.endsWith('/api/liveness')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: 'alive' }),
          headers: new Headers({ 'content-type': 'application/json' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '<html>dashboard</html>',
        headers: new Headers({ 'content-type': 'text/html' }),
      };
    },
  };

  await attachToInstalledService(attempt, {
    baseUrl: 'http://127.0.0.1:1',
    readLease: async (paths) => {
      leaseReads.push(paths);
      return lease;
    },
    auth,
    requiredTaskId: CONTRACT_TASK.value,
  });

  assert.equal(leaseReads.length, 1);
  assert.equal(leaseReads[0].controlRoot, attempt.formalPaths.controlRoot);
  assert.equal(leaseReads[0].projectRoot, attempt.formalPaths.projectRoot);
  assert.notEqual(leaseReads[0].projectRoot, attempt.projectRoot);
  assert.equal(attempt.auth, auth);
  assert.equal(attempt.attachedOwner.pid, process.pid);
  assert.equal(attempt.servePid, null, 'attached owner must never become a stop target');
  assert.equal(attempt.taskId, CONTRACT_TASK.value);
  assert.equal(auth.paired, true);
  assert.ok(calls.some((call) => call.target.endsWith('/api/liveness')));
  assert.ok(calls.some((call) => call.target.endsWith('/dashboard.html')));
});

test('installed-attach journal lookup uses the formal project root', async () => {
  const controlRoot = await makeTempRoot('attach-journal-control');
  const formalProjectKey = 'formal-project';
  const attemptProjectKey = 'attempt-project';
  const formalJournal = join(
    controlRoot,
    'sessions',
    formalProjectKey,
    'checkpoints',
    'rcc',
    'ui-runtime-journal.jsonl',
  );
  const attemptJournal = join(
    controlRoot,
    'sessions',
    attemptProjectKey,
    'checkpoints',
    'rcc',
    'ui-runtime-journal.jsonl',
  );
  await writeOutcomeFixture(dirname(formalJournal), 'formal', {
    uiFile: 'ui-runtime-journal.jsonl',
    checkpointFile: 'task-contract-cycle-contract.jsonl',
  });
  await writeOutcomeFixture(dirname(attemptJournal), 'attempt', {
    uiFile: 'ui-runtime-journal.jsonl',
    checkpointFile: 'task-contract-cycle-contract.jsonl',
  });

  const binding = {
    serviceMode: 'installed-attach',
    taskId: CONTRACT_TASK,
    controlRoot: controlRoot,
    projectKey: attemptProjectKey,
    journalControlRoot: controlRoot,
    journalProjectKey: formalProjectKey,
    formalPaths: { controlRoot, projectKey: formalProjectKey },
  };
  const selected = await journalPathFor(binding);
  assert.equal(selected, formalJournal);
  assert.notEqual(selected, attemptJournal);
});

test('retention reports pending recovery acceptance without a receipt', async () => {
  const binding = {
    serviceMode: 'candidate',
    outcome: 'success',
    taskId: null,
    serveBaseUrl: 'http://127.0.0.1:1',
    servePid: 0,
    servePort: 23457,
    controlRoot: '/tmp/persistent-control',
    recoveryOwner: 'humanagent.runtime.task-recovery',
    browser: { close: async () => {} },
    tempRoots: [],
    persistentRoots: [],
  };
  const cleanup = await retainUnsettledRecovery(binding, 'no acceptance receipt');
  assert.equal(cleanup.recoveryAccepted, false);
  assert.equal(cleanup.recoveryAcceptanceStatus, 'pending');
  assert.match(cleanup.recoveryAcceptedReason, /receipt/i);
  assert.ok(cleanup.nextStep);
  assert.equal(cleanup.settled, false);
  assert.ok(cleanup.recoveryRetained.length >= 1);

  // A real acceptance receipt flips the pending handoff to accepted.
  const accepted = await retainUnsettledRecovery(
    {
      ...binding,
      recoveryAcceptance: { receiptRef: 'run-notes/attempt/ack.json', acceptedBy: 'humanagent.runtime.task-recovery' },
    },
    'accepted handoff',
  );
  assert.equal(accepted.recoveryAccepted, true);
  assert.equal(accepted.recoveryAcceptanceStatus, 'accepted');
});

test('candidate settled cleanup targets only the exact recorded PID and keeps persistent roots', async () => {
  const owned = spawnIdle();
  const unrelated = spawnIdle();
  const attemptRoot = await makeTempRoot('attempt');
  const controlRoot = await makeTempRoot('persistent-control');
  const receiptDir = join(controlRoot, 'sessions', 'proj', 'run-notes', 'attempt');
  await mkdir(receiptDir, { recursive: true });
  try {
    const binding = {
      serviceMode: 'candidate',
      servePid: owned.pid,
      servePort: null,
      serveBaseUrl: 'http://127.0.0.1:1',
      tempRoots: [attemptRoot],
      persistentRoots: [controlRoot, receiptDir],
      browser: { close: async () => {} },
      taskId: 'task-contract',
      outcome: 'success',
    };
    const cleanup = await closeSettledAttempt(binding, { settled: true, state: 'succeeded' });
    assert.equal(cleanup.servePid, owned.pid);
    assert.equal(cleanup.serveExited, true);
    assert.equal(cleanup.tempRootsRemoved, true);
    assert.equal(binding.cleaned, true);
    await sleep(150);
    assert.equal(await isAlive(owned.pid), false, 'the exact recorded owned PID must be stopped');
    assert.equal(await isAlive(unrelated.pid), true, 'an unrelated PID must never be stopped');
    // Persistent control root + receipt directory are retained, not removed.
    assert.equal(existsSync(controlRoot), true);
    assert.equal(existsSync(receiptDir), true);
    assert.equal(existsSync(attemptRoot), false, 'only the ephemeral attempt root is removed');
    assert.deepEqual(cleanup.persistentRetained, [controlRoot, receiptDir]);
    assert.deepEqual(cleanup.recoveryRetained, []);
  } finally {
    await stopChild(owned);
    await stopChild(unrelated);
  }
});

test('installed-attach settled cleanup never stops the attached owner', async () => {
  const owner = spawnIdle();
  const attemptRoot = await makeTempRoot('attached-attempt');
  await mkdir(join(attemptRoot, 'workspace'), { recursive: true });
  await writeFile(join(attemptRoot, 'workspace', 'owned.tmp'), 'attempt-owned\n', 'utf8');
  const persistentRoot = await makeTempRoot('attached-persistent');
  const binding = {
    serviceMode: 'installed-attach',
    servePid: null,
    servePort: 12345,
    serveBaseUrl: 'http://127.0.0.1:12345',
    attachedOwner: { ownerId: 'humanagent.app.serve', pid: owner.pid, port: 12345 },
    tempRoots: [attemptRoot],
    persistentRoots: [persistentRoot],
    browser: { close: async () => {} },
    taskId: 'task-attached',
    outcome: 'success',
  };
  try {
    const cleanup = await closeSettledAttempt(binding, { settled: true, state: 'succeeded' });
    assert.equal(cleanup.branch, 'attached-released');
    assert.equal(cleanup.serveExited, null);
    assert.equal(cleanup.portClosed, null);
    assert.match(cleanup.serveExitReason, /attached owner must be retained/);
    assert.equal(binding.cleaned, true);
    await sleep(150);
    assert.equal(await isAlive(owner.pid), true, 'the attached owner must not be stopped');
    assert.equal(existsSync(attemptRoot), false, 'nonempty attempt-owned temp root must be removed');
    assert.equal(existsSync(persistentRoot), true, 'formal/persistent roots must be retained');
  } finally {
    await stopChild(owner);
  }
});

test('installed-attach cleanup reports not-cleaned when an attempt temp root cannot be removed', async () => {
  const owner = spawnIdle();
  const attemptRoot = await makeTempRoot('attached-delete-failure');
  await writeFile(join(attemptRoot, 'owned.tmp'), 'must-not-claim-removal\n', 'utf8');
  await chmod(attemptRoot, 0o555);
  const binding = {
    serviceMode: 'installed-attach',
    servePid: null,
    servePort: 12345,
    serveBaseUrl: 'http://127.0.0.1:12345',
    attachedOwner: { ownerId: 'humanagent.app.serve', pid: owner.pid, port: 12345 },
    tempRoots: [attemptRoot],
    persistentRoots: [],
    browser: { close: async () => {} },
    taskId: 'task-attached-delete-failure',
    outcome: 'success',
  };
  try {
    const cleanup = await closeSettledAttempt(binding, { settled: true, state: 'succeeded' });
    assert.equal(cleanup.tempRootsRemoved, false);
    assert.equal(binding.cleaned, false);
    assert.equal(await isAlive(owner.pid), true);
  } finally {
    await chmod(attemptRoot, 0o700).catch(() => {});
    await rm(attemptRoot, { recursive: true, force: true }).catch(() => {});
    await stopChild(owner);
  }
});

test('unsettled retention keeps the owned service and names a recovery owner', async () => {
  const owned = spawnIdle();
  const attemptRoot = await makeTempRoot('retain-attempt');
  const controlRoot = await makeTempRoot('retain-control');
  const binding = {
    serviceMode: 'candidate',
    servePid: owned.pid,
    servePort: 23456,
    serveBaseUrl: 'http://127.0.0.1:23456',
    tempRoots: [attemptRoot],
    persistentRoots: [controlRoot],
    recoveryOwner: 'humanagent.runtime.task-recovery',
    browser: { close: async () => {} },
    taskId: null,
    outcome: 'success',
    controlRoot,
  };
  try {
    const cleanup = await retainUnsettledRecovery(binding, 'terminal journal was unreadable');
    assert.equal(cleanup.branch, 'unsettled-recovery-retained');
    assert.equal(cleanup.settled, false);
    assert.equal(cleanup.recoveryOwner, 'humanagent.runtime.task-recovery');
    assert.equal(cleanup.serveExited, false);
    assert.equal(cleanup.tempRootsRemoved, false);
    assert.ok(cleanup.recoveryRetained.some((entry) => entry.kind === 'serve-pid' && entry.pid === owned.pid));
    assert.ok(cleanup.recoveryRetained.some((entry) => entry.kind === 'control-root'));
    assert.equal(binding.cleaned, false);
    await sleep(150);
    assert.equal(await isAlive(owned.pid), true, 'an unsettled attempt must retain its owned service');
    assert.equal(existsSync(attemptRoot), true, 'an unsettled attempt must retain its workspace/evidence');
  } finally {
    await stopChild(owned);
  }
});

test('runScenario writes a config-rooted receipt and retains resources when it cannot settle', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('run-control');
  const previousRcc = process.env.HUMANAGENT_RCC_BASE_URL;
  // Point the provider probe at a closed loopback port so the attempt fails
  // deterministically without touching a live provider or starting a service.
  process.env.HUMANAGENT_RCC_BASE_URL = 'http://127.0.0.1:9';
  let result;
  try {
    const { runScenario } = await import('./runner.mjs');
    result = await runScenario('local-file-search', {
      entry: 'dashboard',
      outcome: 'success',
      serviceMode: 'candidate',
      attemptIdSuffix: 'run',
      resolvePaths: resolveRuntimePaths,
      controlRoot,
    });
  } finally {
    if (previousRcc === undefined) delete process.env.HUMANAGENT_RCC_BASE_URL;
    else process.env.HUMANAGENT_RCC_BASE_URL = previousRcc;
  }

  assert.equal(result.receipt.result, 'INCOMPLETE');
  assert.equal(result.receipt.schema, 'humanagent.dashboard-e2e.receipt.v1');
  assert.equal(result.receipt.entry, 'dashboard');
  assert.equal(result.receipt.serviceMode, 'candidate');
  assert.equal(result.settled, false);
  assert.equal(result.receipt.settlement.settled, false);
  // Paths came from the real config resolver, not a tmp control root. The
  // resolver canonicalizes symlinked roots (e.g. /tmp -> /private/tmp).
  assert.ok(result.receipt.runtime.controlRoot.startsWith(await realpath(controlRoot)));
  assert.ok(result.receipt.runtime.runNotesRoot.includes('run-notes'));
  assert.equal(dirname(result.receiptPaths.jsonPath), result.receiptPaths.markdownPath.replace(/\/receipt\.md$/, ''));
  // The unsettled attempt retained its recovery resources and named the owner.
  assert.equal(result.receipt.cleanup.branch, 'unsettled-recovery-retained');
  assert.equal(result.receipt.cleanup.recoveryOwner, 'humanagent.runtime.task-recovery');
  // The owner name alone is not acceptance: with no receipt the handoff is
  // pending, so the attempt must not claim the recovery was accepted.
  assert.equal(result.receipt.cleanup.recoveryAccepted, false);
  assert.equal(result.receipt.cleanup.recoveryAcceptanceStatus, 'pending');
  assert.ok(result.receipt.resources.recoveryRetained.length >= 1);
  assert.equal(result.receipt.cleaned, false);
  // A receipt with no secrets was written where the contract says.
  const written = JSON.parse(await readFile(result.receiptPaths.jsonPath, 'utf8'));
  assert.equal(written.result, 'INCOMPLETE');
  assert.equal(JSON.stringify(written).includes('HA_SESSION'), false);
});

test('public main/CLI stays INCOMPLETE when scenario success has no strict Journal settlement', async () => {
  assertResolverAvailable();
  const dir = await makeTempRoot('strict-settlement');
  const damagedFixture = await writeOutcomeFixture(dir, 'damaged-public');
  await writeFile(
    damagedFixture.uiPath,
    `${await readFile(damagedFixture.uiPath, 'utf8')}{"kind":"operation.event","event":\n`,
    'utf8',
  );
  const variants = [
    { label: 'missing', journalPaths: [join(dir, 'missing.jsonl')], reason: /authoritative journal unavailable/ },
    { label: 'damaged', journalPaths: damagedFixture.paths, reason: /damaged|invalid JSON|corrupt UI/i },
    {
      label: 'provider-only',
      journalPaths: (await writeOutcomeFixture(dir, 'provider-only-public', { includeFinal: false })).paths,
      reason: /provider-phase/,
    },
    {
      label: 'missing-final-phase',
      journalPaths: (await writeOutcomeFixture(dir, 'missing-phase-public', { finalPhase: null })).paths,
      reason: /provider-phase/,
    },
    {
      label: 'blocked-final',
      journalPaths: (await writeOutcomeFixture(dir, 'blocked-public', { finalState: 'blocked' })).paths,
      reason: /does not match the expected success outcome/,
    },
    {
      label: 'no-terminal',
      journalPaths: (await writeOutcomeFixture(dir, 'no-terminal-public', {
        providerTerminal: false,
        includeFinal: false,
      })).paths,
      reason: /no execution\.terminal/,
    },
    {
      label: 'other-scope-complete',
      journalPaths: (await writeOutcomeFixture(dir, 'other-scope-public', { scope: OTHER_SCOPE })).paths,
      reason: /execution identity is unavailable|no verified operation\.started/,
    },
    {
      label: 'no-checkpoint',
      journalPaths: (await writeOutcomeFixture(dir, 'no-checkpoint-public', { skipCheckpoint: true })).paths,
      reason: /settlement evidence is incomplete/,
    },
    {
      label: 'disagrees',
      journalPaths: (await writeOutcomeFixture(dir, 'disagrees-public', {
        terminalState: 'failed',
        checkpointOutcome: 'failed',
      })).paths,
      reason: /does not match the expected success outcome/,
    },
  ];

  for (const variant of variants) {
    const { result, logs, exitCode } = await runContractMain(`strict-${variant.label}`, variant.journalPaths);
    const printed = JSON.parse(logs.join('\n'));
    const attemptRoot = dirname(result.receipt.runtime.workspace);
    try {
      assert.equal(result.receipt.result, 'INCOMPLETE', variant.label);
      assert.equal(result.outcome, 'INCOMPLETE', variant.label);
      assert.equal(printed.outcome, 'INCOMPLETE', variant.label);
      assert.equal(exitCode, 1, variant.label);
      assert.equal(result.receipt.settlement.settled, false, variant.label);
      assert.match(result.receipt.settlement.reason, variant.reason, variant.label);
      assert.ok(result.receipt.missingEvidence.some((item) => /strict settlement/.test(item)), variant.label);
      assert.equal(result.receipt.cleanup.branch, 'unsettled-recovery-retained', variant.label);
      assert.equal(result.receipt.cleanup.recoveryAccepted, false, variant.label);
      assert.ok(result.receipt.resources.recoveryRetained.some((entry) => entry.kind === 'control-root'), variant.label);
      assert.ok(result.receipt.resources.recoveryRetained.some((entry) => entry.kind === 'workspace'), variant.label);
      assert.equal(result.stageErrors.find((stage) => stage.stage === 'attempt_stop_settle').ok, false, variant.label);
      assert.equal(result.stageErrors.find((stage) => stage.stage === 'local-file-search_cleanup').ok, false, variant.label);
    } finally {
      await rm(attemptRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('public main/CLI stays INCOMPLETE when strict settlement passes but cleanup fails', async () => {
  assertResolverAvailable();
  const dir = await makeTempRoot('cleanup-failure');
  const journal = await writeOutcomeFixture(dir, 'settled');
  const owned = spawnIdle();
  try {
    const { result, logs, exitCode } = await runContractMain('cleanup-failure', journal.paths, {
      servePid: owned.pid,
      closeBrowser: async () => { throw new Error('fixture browser close failed'); },
    });
    const printed = JSON.parse(logs.join('\n'));

    assert.equal(result.receipt.result, 'INCOMPLETE');
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.equal(printed.outcome, 'INCOMPLETE');
    assert.equal(exitCode, 1);
    assert.equal(result.receipt.settlement.settled, true, result.receipt.settlement.reason);
    assert.equal(result.receipt.cleanup.browserClosed, false);
    assert.equal(result.receipt.cleaned, false);
    assert.ok(result.receipt.missingEvidence.some((item) => /cleanup/.test(item)));
    assert.equal(result.stageErrors.find((stage) => stage.stage === 'attempt_stop_settle').ok, true);
    assert.equal(result.stageErrors.find((stage) => stage.stage === 'local-file-search_cleanup').ok, false);
  } finally {
    await stopChild(owned);
  }
});

test('public main/CLI keeps SUCCESS when strict settlement and cleanup both complete', async () => {
  assertResolverAvailable();
  const dir = await makeTempRoot('success');
  const journal = await writeOutcomeFixture(dir, 'settled');
  const owned = spawnIdle();
  let result;
  let logs;
  let exitCode;
  try {
    ({ result, logs, exitCode } = await runContractMain('success', journal.paths, { servePid: owned.pid }));
    const printed = JSON.parse(logs.join('\n'));
    assert.equal(result.receipt.result, 'SUCCESS');
    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(printed.outcome, 'SUCCESS');
    assert.equal(exitCode, 0);
    assert.equal(result.receipt.settlement.settled, true);
    assert.equal(result.receipt.cleaned, true);
    assert.equal(result.stageErrors.find((stage) => stage.stage === 'local-file-search_cleanup').ok, true);
  } finally {
    await stopChild(owned);
  }
});

test('public main/CLI reports requested failure and cancel consistently as INCOMPLETE', async () => {
  assertResolverAvailable();
  const dir = await makeTempRoot('non-success-public');
  const variants = [
    {
      outcome: 'failure',
      journalPaths: (await writeOutcomeFixture(dir, 'failure', {
        terminalState: 'failed',
        checkpointOutcome: 'failed',
      })).paths,
      terminalState: 'failed',
    },
    {
      outcome: 'cancel',
      journalPaths: (await writeOutcomeFixture(dir, 'cancel', {
        terminalState: 'stopped',
        checkpointOutcome: 'stopped',
      })).paths,
      terminalState: 'stopped',
    },
  ];

  for (const variant of variants) {
    // A real candidate run owns the serve it started; the fixture must register
    // that exact PID so the settled cleanup can release and verify it. Without
    // it the attempt could not prove its own process exited.
    const owned = spawnIdle();
    let result;
    let logs;
    let exitCode;
    try {
      ({ result, logs, exitCode } = await runContractMain(
        `non-success-${variant.outcome}`,
        variant.journalPaths,
        {
          outcome: variant.outcome,
          servePid: owned.pid,
          evidence: {
            terminalState: variant.terminalState,
            dashboardState: variant.terminalState,
            checkpointCommitted: 0,
          },
        },
      ));
    } finally {
      await stopChild(owned);
    }
    const printed = JSON.parse(logs.join('\n'));

    assert.equal(result.receipt.result, 'INCOMPLETE', variant.outcome);
    assert.equal(result.outcome, 'INCOMPLETE', variant.outcome);
    assert.equal(printed.outcome, 'INCOMPLETE', variant.outcome);
    assert.equal(exitCode, 1, variant.outcome);
    assert.equal(result.requestedOutcomeReached, true, variant.outcome);
    assert.equal(result.receipt.settlement.requestedOutcomeReached, true, variant.outcome);
    assert.equal(result.receipt.settlement.achievedOutcome, variant.outcome, variant.outcome);
    assert.equal(result.receipt.settlement.settled, true, variant.outcome);
    assert.equal(result.receipt.cleanup.settled, true, variant.outcome);
    assert.equal(result.receipt.deviation, null, variant.outcome);
  }
});

test('real cancel scenario learns identity, stops once, and reassesses read-only', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('cancel-real-control');
  const owned = spawnIdle();
  const calls = [];
  let bindingRef = null;
  let stopPosts = 0;
  let stopPosted = false;
  let dashboardAfterStopReads = 0;
  let finalAppended = false;
  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  const auth = {
    fetch: async (url, init = {}) => {
      const target = String(url);
      const method = String(init.method ?? 'GET').toUpperCase();
      calls.push({ target, method });
      if (method === 'POST') {
        stopPosts += 1;
        stopPosted = true;
        return response({ ok: true });
      }
      if (target.endsWith('/api/tasks')) {
        return response({
          running: [{
            taskId: CONTRACT_TASK,
            updatedAt: new Date().toISOString(),
          }],
        });
      }
      if (target.includes('/dashboard')) {
        if (!stopPosted) {
          return response({
            state: 'running',
            operationId: CONTRACT_OPERATION.value,
            executionEpoch: CONTRACT_EPOCH,
          });
        }
        dashboardAfterStopReads += 1;
        // First post-stop read is the incomplete assessment. The next read
        // appends the real final/checkpoint; the later read-only assessment
        // must observe the replacement without another POST.
        if (dashboardAfterStopReads === 2 && !finalAppended) {
          finalAppended = true;
          await appendCancelSettlement(bindingRef);
        }
        return response({
          state: 'stopped',
          operationId: CONTRACT_OPERATION.value,
          executionEpoch: CONTRACT_EPOCH,
        });
      }
      return response({});
    },
  };

  try {
    const { runScenario } = await import('./runner.mjs');
    const result = await runScenario('local-file-search', {
      entry: 'dashboard',
      outcome: 'cancel',
      serviceMode: 'candidate',
      attemptIdSuffix: 'cancel-real',
      resolvePaths: resolveRuntimePaths,
      controlRoot,
      hooks: {
        probeProvider: async () => {},
        startServeForAttempt: async (binding) => {
          bindingRef = binding;
          binding.serveBaseUrl = 'http://127.0.0.1:1';
          binding.servePort = null;
          binding.servePid = owned.pid;
          binding.auth = auth;
          await writeCancelRunningJournal(binding);
        },
        launchBrowserSession: async (binding) => {
          binding.browser = { page: fakeBrowserPage(), close: async () => {} };
        },
      },
    });

    assert.equal(result.receipt.result, 'INCOMPLETE');
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.equal(result.requestedOutcomeReached, true, result.receipt.settlement.reason);
    assert.equal(result.settled, true, result.receipt.settlement.reason);
    assert.equal(result.receipt.settlement.settled, true);
    assert.equal(result.receipt.cleanup.settled, true);
    assert.equal(result.receipt.deviation, null);
    assert.equal(stopPosts, 1, 'the scenario must POST the task stop at most once');
    assert.equal(finalAppended, true);
    assert.ok(dashboardAfterStopReads >= 2);
    assert.equal(result.receipt.evidence.scenarioEvidence.stopResponse.status, 200);
  } finally {
    await stopChild(owned);
  }
});

test('cancel identity failures retain recovery and issue zero stop POSTs', async () => {
  assertResolverAvailable();
  const previousIdentityTimeout = process.env.E2E_IDENTITY_TIMEOUT_MS;
  process.env.E2E_IDENTITY_TIMEOUT_MS = '1';
  try {
    for (const variant of ['missing', 'corrupt', 'ambiguous', 'dashboard-conflict']) {
      const controlRoot = await makeTempRoot(`cancel-identity-${variant}`);
      const owned = spawnIdle();
      const calls = [];
      let bindingRef = null;
      let stopPosts = 0;
      const dashboardBody = variant === 'dashboard-conflict'
        ? {
            state: 'running',
            operationId: 'operation-other',
            executionEpoch: CONTRACT_EPOCH,
          }
        : {
            state: 'running',
            operationId: CONTRACT_OPERATION.value,
            executionEpoch: CONTRACT_EPOCH,
          };
      const response = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      });
      const auth = {
        async fetch(url, init = {}) {
          const target = String(url);
          const method = String(init.method ?? 'GET').toUpperCase();
          calls.push({ target, method });
          if (method === 'POST') {
            stopPosts += 1;
            return response({ ok: true });
          }
          if (target.endsWith('/api/tasks')) {
            return response({
              running: [{
                taskId: CONTRACT_TASK,
                updatedAt: new Date().toISOString(),
              }],
            });
          }
          if (target.includes('/dashboard')) return response(dashboardBody);
          return response({});
        },
      };

      try {
        const { runScenario } = await import('./runner.mjs');
        const result = await runScenario('local-file-search', {
          entry: 'dashboard',
          outcome: 'cancel',
          serviceMode: 'candidate',
          attemptIdSuffix: `cancel-identity-${variant}`,
          resolvePaths: resolveRuntimePaths,
          controlRoot,
          hooks: {
            probeProvider: async () => {},
            startServeForAttempt: async (binding) => {
              bindingRef = binding;
              binding.serveBaseUrl = 'http://127.0.0.1:1';
              binding.servePort = null;
              binding.servePid = owned.pid;
              binding.auth = auth;
              await writeCancelIdentityFixture(binding, variant);
            },
            launchBrowserSession: async (binding) => {
              binding.browser = { page: fakeBrowserPage(), close: async () => {} };
            },
          },
        });

        assert.equal(result.receipt.result, 'INCOMPLETE', variant);
        assert.equal(result.outcome, 'INCOMPLETE', variant);
        assert.equal(result.settled, false, variant);
        assert.equal(stopPosts, 0, `${variant} must not issue a stop POST`);
        assert.equal(result.receipt.cleanup.branch, 'unsettled-recovery-retained', variant);
        assert.equal(result.receipt.cleanup.recoveryAccepted, false, variant);
        assert.equal(result.receipt.cleanup.recoveryAcceptanceStatus, 'pending', variant);
        assert.equal(result.receipt.cleanup.browserClosed, true, variant);
        assert.ok(result.receipt.cleanup.recoveryRetained.some((entry) => entry.kind === 'serve-pid' && entry.pid === owned.pid), variant);
        assert.ok(result.receipt.cleanup.recoveryRetained.some((entry) => entry.kind === 'control-root'), variant);
        assert.ok(result.receipt.cleanup.recoveryRetained.some((entry) => entry.kind === 'workspace'), variant);
        assert.ok(result.receipt.cleanup.recoveryRetained.some((entry) => entry.kind === 'evidence'), variant);
        assert.equal(existsSync(bindingRef.workspace), true, variant);
        assert.equal(existsSync(bindingRef.controlRoot), true, variant);
        if (variant !== 'missing') {
          assert.equal(existsSync(bindingRef.journalPath), true, `${variant} journal evidence must be retained`);
        }
        assert.ok(calls.some((call) => call.target.includes('/dashboard')), variant);
        assert.equal(calls.some((call) => call.method === 'POST'), false, variant);
      } finally {
        await stopChild(owned);
        if (bindingRef?.workspace) {
          await rm(dirname(bindingRef.workspace), { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  } finally {
    if (previousIdentityTimeout === undefined) delete process.env.E2E_IDENTITY_TIMEOUT_MS;
    else process.env.E2E_IDENTITY_TIMEOUT_MS = previousIdentityTimeout;
  }
});

test('homepage submission binds to its task-scoped navigation, not a newer task update', async () => {
  const calls = [];
  const auth = {
    async fetch(url, init = {}) {
      const target = String(url);
      calls.push({ target, method: String(init.method ?? 'GET').toUpperCase() });
      if (target.endsWith('/api/tasks')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            running: [{
              taskId: { scope: 'task', value: 'task-existing' },
              updatedAt: '2999-01-01T00:00:00.000Z',
            }],
          }),
        };
      }
      if (target.includes('/dashboard')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            state: 'running',
            taskId: { scope: 'task', value: 'task-submitted' },
            operationId: CONTRACT_OPERATION.value,
            executionEpoch: CONTRACT_EPOCH,
          }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    },
  };
  const page = fakeHomepagePage(
    'http://127.0.0.1:1/observation.html?task=task-submitted',
    { delayMs: 40 },
  );
  const binding = {
    entry: 'homepage',
    serveBaseUrl: 'http://127.0.0.1:1',
    browser: { page },
    auth,
  };

  await submitDirectiveAndConfirmDraft(binding, 'submitted task', { confirmTimeoutMs: 1000 });
  assert.equal(binding.taskId, 'task-submitted');
  assert.equal(binding.submissionNavigation.pathname, '/observation.html');
  assert.equal(binding.submissionNavigation.taskId, 'task-submitted');
  assert.equal(binding.submissionNavigation.origin, 'http://127.0.0.1:1');
  assert.equal(calls.filter((call) => call.target.endsWith('/api/tasks')).length, 0);
  assert.equal(calls.some((call) => call.method === 'POST'), false);

  await openTaskDashboard(binding, { waitNonterminal: false });
  assert.ok(page.url().includes('/task-dashboard.html?task=task-submitted'));
  assert.equal(calls.some((call) => call.target.includes('task-existing')), false);
});

test('homepage submission fails closed on missing or invalid task-scoped navigation', async () => {
  const cases = [
    ['missing navigation', null, {}],
    ['wrong page', 'http://127.0.0.1:1/tasks.html?task=task-submitted', {}],
    ['missing task query', 'http://127.0.0.1:1/observation.html?task=', {}],
    ['wrong origin', 'http://127.0.0.1:2/observation.html?task=task-submitted', {}],
    // `waitForURL` resolves void (as real Playwright does) but the current page
    // URL is not a valid same-origin task-scoped navigation: the post-wait
    // `page.url()` validation must still refuse.
    ['resolved wait without navigation', null, { resolveWithoutNavigation: true }],
  ];
  for (const [label, navigationUrl, options] of cases) {
    const binding = {
      entry: 'homepage',
      serveBaseUrl: 'http://127.0.0.1:1',
      browser: { page: fakeHomepagePage(navigationUrl, options) },
      auth: { async fetch() { throw new Error('homepage refusal must not call the task API'); } },
    };
    await assert.rejects(
      () => submitDirectiveAndConfirmDraft(binding, 'submitted task', { confirmTimeoutMs: 40 }),
      /task-scoped (observation|navigation)/,
      label,
    );
    assert.equal(binding.taskId ?? null, null, label);
  }
});

test('public runScenario installed-attach reads the formal lease and releases the attempt temp root', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('attach-public-control');
  const formalWorkspace = await makeTempRoot('attach-public-formal');
  const formalPaths = await resolveRuntimePaths({ workspace: formalWorkspace, controlRoot });
  const journalDir = join(controlRoot, 'sessions', formalPaths.projectKey, 'checkpoints', 'rcc');
  await mkdir(journalDir, { recursive: true });
  const journal = await writeOutcomeFixture(journalDir, 'settled', {
    uiFile: 'ui-runtime-journal.jsonl',
    checkpointFile: `task-${CONTRACT_TASK.value}-cycle-${CONTRACT_CYCLE.value}.jsonl`,
  });
  const formalManifestBefore = await workspaceManifest(formalWorkspace);

  const leaseReads = [];
  const lease = {
    ownerId: 'humanagent.app.serve',
    pid: process.pid,
    controlEndpoint: { port: 1 },
    leaseId: 'lease-public',
    generation: 1,
  };
  const calls = [];
  const dashboard = {
    state: 'succeeded',
    taskId: CONTRACT_TASK,
    operationId: CONTRACT_OPERATION.value,
    executionEpoch: CONTRACT_EPOCH,
  };
  const toolReport = { query: 'marker', path: 'hello-agent.txt', matches: 1 };
  const base = 'http://127.0.0.1:1';
  const exactDashboard = `${base}/api/tasks/${CONTRACT_TASK.value}/dashboard`;
  const toolOutputUrl = `${base}/api/tasks/${CONTRACT_TASK.value}/operations/${CONTRACT_OPERATION.value}/executions/${CONTRACT_EPOCH}/events/3/tool-output`;
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  // Strict transport: the typed task identity must be projected to its exact
  // value. Only the exact task Dashboard and an exact
  // task/operation/epoch/seq tool-output report are served; any other task or
  // URL is refused, so a malformed typed-task projection (an encoded object)
  // fails instead of matching a `/dashboard` substring.
  const auth = {
    paired: false,
    async pair() { this.paired = true; },
    async fetch(url, init = {}) {
      const target = String(url);
      calls.push({ target, method: String(init.method ?? 'GET').toUpperCase() });
      if (target === `${base}/api/liveness`) return jsonResponse({ status: 'alive' });
      if (target === `${base}/dashboard.html`) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => '<html>dashboard</html>', json: async () => ({}) };
      }
      if (target === exactDashboard) return jsonResponse(dashboard);
      if (target === toolOutputUrl) return jsonResponse(toolReport);
      return jsonResponse({ error: { message: `unexpected target ${target}` } }, 404);
    },
  };
  let pageUrl = 'about:blank';
  const page = {
    url: () => pageUrl,
    async goto(next) {
      pageUrl = String(next);
      return { ok: () => true, status: () => 200 };
    },
    async screenshot() {},
    async reload() {},
    async waitForSelector() {},
  };
  let captured;
  const { runScenario } = await import('./runner.mjs');
  const result = await runScenario('local-file-search', {
    entry: 'dashboard',
    outcome: 'success',
    serviceMode: 'installed-attach',
    attemptIdSuffix: 'attach-public',
    resolvePaths: resolveRuntimePaths,
    controlRoot,
    scope: CONTRACT_SCOPE,
    formalWorkspace,
    hooks: {
      probeProvider: async () => {},
      // The attached path must never start a candidate service of its own.
      startServeForAttempt: async () => { throw new Error('installed-attach must never start a candidate serve'); },
      attachToInstalledService: async (binding) => {
        captured = binding;
        return attachToInstalledService(binding, {
          baseUrl: 'http://127.0.0.1:1',
          readLease: async (paths) => { leaseReads.push(paths); return lease; },
          auth,
          requiredTaskId: CONTRACT_TASK.value,
        });
      },
      launchBrowserSession: async (binding) => { binding.browser = { page, close: async () => {} }; },
    },
  });

  const formalManifestAfter = await workspaceManifest(formalWorkspace);
  assert.equal(result.receipt.result, 'INCOMPLETE', result.receipt.settlement.reason);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(result.requestedOutcomeReached, false);
  assert.equal(result.settled, true);
  assert.ok(result.receipt.missingEvidence.some((item) => /installed-attach observation/.test(item)));
  assert.equal(captured.serviceMode, 'installed-attach');
  assert.equal(captured.servePid, null, 'the attached owner must never become a stop target');
  assert.deepEqual(captured.taskId, CONTRACT_TASK, 'the explicit attached task identity must be preserved');
  assert.deepEqual(captured.operationId, CONTRACT_OPERATION, 'the explicit attached operation identity must be preserved');
  assert.equal(captured.executionEpoch, CONTRACT_EPOCH, 'the explicit attached execution epoch must be preserved');
  assert.equal(captured.attachTaskProbe.taskId.value, CONTRACT_TASK.value);
  assert.equal(leaseReads.length, 1, 'the public attach path reads exactly the formal lease');
  assert.equal(leaseReads[0].controlRoot, captured.formalPaths.controlRoot);
  assert.equal(leaseReads[0].projectRoot, captured.formalPaths.projectRoot);
  assert.notEqual(leaseReads[0].projectRoot, captured.projectRoot, 'the lease must come from the formal project, not the attempt project');
  assert.equal(calls.some((call) => call.method === 'POST'), false, 'attached observation must not submit, confirm, or stop');
  assert.equal(calls.some((call) => call.target.endsWith('/api/tasks')), false, 'attached observation must not list or mutate the task queue');
  assert.equal(calls.some((call) => call.target.includes('/api/explicit/')), false, 'attached observation must not submit or confirm a task');
  assert.equal(existsSync(captured.attemptRoot), false, 'the nonempty attempt temp root must actually be released');
  assert.equal(existsSync(formalWorkspace), true, 'the formal workspace must be retained');
  assert.equal(existsSync(controlRoot), true, 'the canonical control root must be retained');
  assert.equal(existsSync(journal.uiPath), true, 'the formal journal must be retained');
  assert.equal(manifestsIdentical(formalManifestBefore, formalManifestAfter), true, 'attached observation must not write a fixture into the formal workspace');
  assert.equal(result.receipt.cleanup.branch, 'attached-released');
  // Every task-scoped request must use the exact task value, and the tool-output
  // report body must be consumed, not merely requested.
  const taskRequests = calls.filter((call) => call.target.includes('/api/tasks/'));
  assert.ok(taskRequests.length >= 2, 'the exact task Dashboard and tool-output routes must be requested');
  for (const call of taskRequests) {
    assert.ok(
      call.target.includes(`/api/tasks/${CONTRACT_TASK.value}/`),
      `every task request must use the exact task value, got ${call.target}`,
    );
  }
  const reports = result.receipt.evidence.scenarioEvidence.toolOutputReports ?? [];
  const consumed = reports.filter((entry) => entry.ok);
  assert.equal(consumed.length, 1, 'exactly one succeeded tool-output report must be read back');
  assert.equal(
    consumed[0].path,
    toolOutputUrl.slice(base.length),
    'the tool-output route must address the exact task/operation/epoch/seq',
  );
  assert.ok(calls.some((call) => call.target === toolOutputUrl), 'the exact tool-output URL must actually be requested');
  assert.equal(consumed[0].report.matches, 1, 'the tool-output report body must be consumed, not just requested');
  assert.ok(JSON.stringify(consumed[0].report).includes('hello-agent.txt'));
});

test('public runScenario installed-attach retains formal recovery identity and releases attempt temp resources when Journal cannot settle', async () => {
  assertResolverAvailable();
  const { runScenario } = await import('./runner.mjs');
  const variants = [
    {
      label: 'missing-final-barrier',
      reason: /final barrier was not reached|sameExecutionAuthoritativeCheckpoints/,
      async fixture(journalDir) {
        return writeOutcomeFixture(journalDir, 'missing-final-barrier', {
          uiFile: 'ui-runtime-journal.jsonl',
          checkpointFile: `task-${CONTRACT_TASK.value}-cycle-${CONTRACT_CYCLE.value}.jsonl`,
          skipCheckpoint: true,
          includeFinal: false,
        });
      },
    },
    {
      label: 'corrupt-journal',
      reason: /authoritative journal unavailable/,
      async fixture(journalDir) {
        const journal = await writeOutcomeFixture(journalDir, 'corrupt-journal', {
          uiFile: 'ui-runtime-journal.jsonl',
          checkpointFile: `task-${CONTRACT_TASK.value}-cycle-${CONTRACT_CYCLE.value}.jsonl`,
        });
        await writeFile(
          journal.uiPath,
          `${await readFile(journal.uiPath, 'utf8')}{"kind":"operation.event","event":\n`,
          'utf8',
        );
        return journal;
      },
    },
  ];

  const createdRoots = [];
  try {
    for (const variant of variants) {
      const label = variant.label;
      const controlRoot = await makeTempRoot(`attach-unsettled-${label}-control`);
      createdRoots.push(controlRoot);
      const formalWorkspace = await makeTempRoot(`attach-unsettled-${label}-formal`);
      createdRoots.push(formalWorkspace);
      const formalPaths = await resolveRuntimePaths({ workspace: formalWorkspace, controlRoot });
      const journalDir = join(controlRoot, 'sessions', formalPaths.projectKey, 'checkpoints', 'rcc');
      await mkdir(journalDir, { recursive: true });
      const journal = await variant.fixture(journalDir);
      const leasePath = join(formalPaths.projectRoot, 'daemon', 'lease.json');
      const lease = {
        ownerId: 'humanagent.app.serve',
        pid: process.pid,
        controlEndpoint: { port: 1 },
        leaseId: `lease-${label}`,
        generation: label === 'missing-final-barrier' ? 7 : 9,
      };
      await mkdir(dirname(leasePath), { recursive: true });
      await writeFile(leasePath, `${JSON.stringify(lease)}\n`, 'utf8');

      const formalManifestBefore = await workspaceManifest(formalWorkspace);
      const leaseBefore = await readFile(leasePath);
      const journalBefore = await readFile(journal.uiPath);
      const checkpointBefore = existsSync(journal.checkpointPath) ? await readFile(journal.checkpointPath) : null;
      const base = 'http://127.0.0.1:1';
      const exactDashboard = `${base}/api/tasks/${CONTRACT_TASK.value}/dashboard`;
      const toolOutputUrl = `${base}/api/tasks/${CONTRACT_TASK.value}/operations/${CONTRACT_OPERATION.value}/executions/${CONTRACT_EPOCH}/events/3/tool-output`;
      const calls = [];
      const jsonResponse = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
        json: async () => body,
      });
      const auth = {
        paired: false,
        async pair() { this.paired = true; },
        async fetch(url, init = {}) {
          const target = String(url);
          const method = String(init.method ?? 'GET').toUpperCase();
          calls.push({ target, method });
          if (method === 'POST') throw new Error(`unexpected POST ${target}`);
          if (target === `${base}/api/liveness`) return jsonResponse({ status: 'alive' });
          if (target === `${base}/dashboard.html`) {
            return { ok: true, status: 200, headers: new Headers(), text: async () => '<html>dashboard</html>', json: async () => ({}) };
          }
          if (target === exactDashboard) {
            return jsonResponse({
              state: 'succeeded',
              taskId: CONTRACT_TASK,
              operationId: CONTRACT_OPERATION.value,
              executionEpoch: CONTRACT_EPOCH,
            });
          }
          if (target === toolOutputUrl) {
            return jsonResponse({ query: 'marker', path: 'hello-agent.txt', matches: 1 });
          }
          return jsonResponse({ error: { message: `unexpected target ${target}` } }, 404);
        },
      };
      let pageUrl = 'about:blank';
      const page = {
        url: () => pageUrl,
        async goto(next) {
          pageUrl = String(next);
          return { ok: () => true, status: () => 200 };
        },
        async screenshot() {},
        async reload() {},
        async waitForSelector() {},
      };
      let captured;
      let browserClosed = false;
      let candidateServeStarted = false;
        const result = await runScenario('local-file-search', {
        entry: 'dashboard',
        outcome: 'success',
        serviceMode: 'installed-attach',
        attemptIdSuffix: `attach-unsettled-${label}`,
        resolvePaths: resolveRuntimePaths,
        controlRoot,
        scope: CONTRACT_SCOPE,
        formalWorkspace,
        hooks: {
          probeProvider: async () => {},
          startServeForAttempt: async () => {
            candidateServeStarted = true;
            throw new Error('installed-attach must never start a candidate serve');
          },
          attachToInstalledService: async (binding) => {
            captured = binding;
            return attachToInstalledService(binding, {
              baseUrl: base,
              readLease: async (paths) => {
                assert.equal(paths.controlRoot, binding.formalPaths.controlRoot, `${label}: formal control root`);
                assert.equal(paths.projectRoot, binding.formalPaths.projectRoot, `${label}: formal project root`);
                return lease;
              },
              auth,
              requiredTaskId: CONTRACT_TASK.value,
            });
          },
          launchBrowserSession: async (binding) => {
            binding.browser = { page, close: async () => { browserClosed = true; } };
          },
        },
      });

        if (captured?.attemptRoot) createdRoots.push(captured.attemptRoot);
        const written = JSON.parse(await readFile(result.receiptPaths.jsonPath, 'utf8'));
      const markdown = await readFile(result.receiptPaths.markdownPath, 'utf8');
      const retained = written.resources?.recoveryRetained ?? [];
      const retainedEntry = (kind) => retained.find((entry) => entry.kind === kind);
      const formalOwner = retainedEntry('formal-owner');
      const formalWorkspaceEntry = retainedEntry('formal-workspace');
      const formalControlEntry = retainedEntry('formal-control-root');
      const formalProjectEntry = retainedEntry('formal-project-root');
      const formalLeaseEntry = retainedEntry('formal-lease');
      const formalJournalEntry = retainedEntry('formal-journal');

      assert.equal(result.receipt.result, 'INCOMPLETE', label);
      assert.equal(result.outcome, 'INCOMPLETE', label);
      assert.equal(result.settled, false, label);
      assert.equal(result.receipt.settlement.settled, false, label);
      assert.match(result.receipt.settlement.reason, variant.reason, label);
      assert.equal(result.receipt.cleaned, false, label);
      assert.equal(result.receipt.cleanup.settled, false, label);
      assert.match(result.receipt.cleanup.reason, variant.reason, label);
      assert.equal(result.receipt.cleanup.recoveryAccepted, false, label);
      assert.equal(result.receipt.cleanup.recoveryAcceptanceStatus, 'pending', label);

      assert.ok(formalOwner, `${label}: formal owner must be retained`);
      assert.equal(formalOwner.owner, 'formal', label);
      assert.equal(formalOwner.ownerId, lease.ownerId, label);
      assert.equal(formalOwner.pid, lease.pid, label);
      assert.equal(formalOwner.port, lease.controlEndpoint.port, label);
      assert.equal(formalOwner.leaseId, lease.leaseId, label);
      assert.equal(formalOwner.generation, lease.generation, label);
      assert.equal(formalWorkspaceEntry?.path, captured.formalWorkspace, label);
      assert.equal(formalControlEntry?.path, captured.formalPaths.controlRoot, label);
      assert.equal(formalProjectEntry?.path, captured.formalPaths.projectRoot, label);
      assert.equal(formalLeaseEntry?.path, captured.attachedLeasePath, label);
      assert.equal(formalJournalEntry?.path, captured.journalPath, label);
      assert.ok(retainedEntry('formal-checkpoint-root'), `${label}: formal checkpoint root must be retained`);
      if (checkpointBefore) {
        assert.equal(retainedEntry('formal-checkpoint')?.path, await realpath(journal.checkpointPath), label);
      }

      assert.equal(captured.servePid, null, label);
      assert.equal(written.runtime.servePid, null, label);
      assert.equal(written.cleanup.servePid, null, label);
      assert.equal(await isAlive(process.pid), true, label);
      assert.equal(existsSync(formalWorkspace), true, label);
      assert.equal(existsSync(formalPaths.projectRoot), true, label);
      assert.equal(existsSync(leasePath), true, label);
      assert.equal(existsSync(journal.uiPath), true, label);
      if (checkpointBefore) assert.equal(existsSync(journal.checkpointPath), true, label);
      assert.equal(manifestsIdentical(formalManifestBefore, await workspaceManifest(formalWorkspace)), true, label);
      assert.deepEqual(await readFile(leasePath), leaseBefore, label);
      assert.deepEqual(await readFile(journal.uiPath), journalBefore, label);
      if (checkpointBefore) assert.deepEqual(await readFile(journal.checkpointPath), checkpointBefore, label);

      assert.equal(calls.some((call) => call.method === 'POST'), false, label);
      assert.equal(calls.some((call) => call.target === `${base}/api/tasks`), false, label);
      assert.equal(calls.some((call) => call.target.includes('/api/explicit/')), false, label);
      assert.equal(candidateServeStarted, false, label);
      assert.equal(browserClosed, true, label);
      assert.equal(existsSync(captured.attemptRoot), false, `${label}: attempt temp root must be removed`);
      assert.ok(
        written.resources.released.some((entry) => entry.kind === 'attempt-root'
          && entry.path === captured.attemptRoot
          && entry.removed === true),
        `${label}: released attempt root must be persisted`,
      );
      assert.equal(
        retained.some((entry) => entry.kind === 'workspace' && entry.path === captured.workspace),
        false,
        `${label}: attempt workspace must not be retained as the execution workspace`,
      );
      assert.equal(written.cleaned, false, label);
      assert.ok(written.missingEvidence.some((item) => /strict settlement/.test(item)), label);
      assert.ok(markdown.includes(lease.leaseId), `${label}: Markdown must retain the lease identity`);
      assert.ok(markdown.includes(captured.formalWorkspace), `${label}: Markdown must retain the formal workspace`);
      assert.ok(markdown.includes(captured.formalPaths.projectRoot), `${label}: Markdown must retain the formal project root`);
      assert.ok(markdown.includes(captured.attachedLeasePath), `${label}: Markdown must retain the formal lease path`);
      assert.ok(markdown.includes(captured.journalPath), `${label}: Markdown must retain the Journal path`);
      assert.ok(markdown.includes('Recovery retained'), `${label}: Markdown must show retained recovery resources`);
    }
  } finally {
    for (const root of createdRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('public runScenario installed-attach refusal before owner verification accounts for attempt resources in persisted receipts', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('attach-refusal-control');
  const formalWorkspace = await makeTempRoot('attach-refusal-formal');
  const formalPaths = await resolveRuntimePaths({ workspace: formalWorkspace, controlRoot });
  const leasePath = join(formalPaths.projectRoot, 'daemon', 'lease.json');
  // A formal lease owned by a different service. The real installed-attachment
  // validation must refuse it before binding.attachedOwner is ever assigned.
  const refusedLease = {
    ownerId: 'some.other.owner',
    pid: process.pid,
    controlEndpoint: { port: 1 },
    leaseId: 'lease-refusal',
    generation: 3,
  };
  await mkdir(dirname(leasePath), { recursive: true });
  await writeFile(leasePath, `${JSON.stringify(refusedLease)}\n`, 'utf8');
  const formalManifestBefore = await workspaceManifest(formalWorkspace);
  const leaseBefore = await readFile(leasePath);

  const base = 'http://127.0.0.1:1';
  const calls = [];
  // A refusal before owner verification must never reach the owner network: the
  // auth transport fails loudly if any request is attempted.
  const auth = {
    paired: false,
    async pair() { this.paired = true; },
    async fetch(url, init = {}) {
      calls.push({ target: String(url), method: String(init.method ?? 'GET').toUpperCase() });
      throw new Error('refusal before owner verification must not reach the owner network');
    },
  };
  let captured;
  let browserLaunched = false;
  let candidateServeStarted = false;
  let scenarioRan = false;
  const createdRoots = [];
  try {
    const { runScenario } = await import('./runner.mjs');
    const result = await runScenario('local-file-search', {
      entry: 'dashboard',
      outcome: 'success',
      serviceMode: 'installed-attach',
      attemptIdSuffix: 'attach-refusal',
      resolvePaths: resolveRuntimePaths,
      controlRoot,
      scope: CONTRACT_SCOPE,
      formalWorkspace,
      hooks: {
        probeProvider: async () => {},
        // The attached path must never start a candidate service of its own.
        startServeForAttempt: async () => {
          candidateServeStarted = true;
          throw new Error('installed-attach must never start a candidate serve');
        },
        attachToInstalledService: async (binding) => {
          captured = binding;
          createdRoots.push(binding.attemptRoot);
          // Real installed-attachment validation: the wrong-owner lease is
          // refused before the owner/PID/endpoint are ever bound.
          return attachToInstalledService(binding, {
            baseUrl: base,
            readLease: async () => refusedLease,
            auth,
            requiredTaskId: CONTRACT_TASK.value,
          });
        },
        launchBrowserSession: async () => { browserLaunched = true; },
        runScenario: async () => { scenarioRan = true; return {}; },
      },
    });

    // The original refusal must survive the return value and both persisted
    // formats, and must not be replaced by a cleanup prerequisite error.
    assert.equal(result.receipt.result, 'INCOMPLETE');
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.equal(result.settled, false);
    assert.equal(result.receipt.settlement.settled, false);
    assert.equal(result.deviation.stage, 'attempt');
    assert.match(result.deviation.error, /refused owner "some\.other\.owner"; expected humanagent\.app\.serve/);

    // No fabricated formal identity: the refusal happened before owner binding.
    assert.equal(captured.attachedOwner, null);
    assert.equal(captured.servePid, null);
    assert.equal(result.receipt.runtime.servePid, null);
    assert.equal(result.receipt.cleanup.servePid, null);

    // Cleanup + resources must be populated, not serialized as null.
    assert.ok(result.receipt.cleanup, 'cleanup must be recorded');
    assert.ok(result.receipt.resources, 'resources must be recorded');
    assert.equal(result.receipt.cleanup.branch, 'unsettled-recovery-retained');
    assert.equal(result.receipt.cleanup.settled, false);
    assert.equal(result.receipt.cleaned, false);
    assert.ok(result.receipt.missingEvidence.some((item) => /strict settlement/.test(item)));
    assert.ok(result.receipt.missingEvidence.some((item) => /cleanup:/.test(item)));

    // No false formal recovery: there is no formal-owner entry to retain and the
    // summary must not claim a verified attached owner is retained.
    const recoveryRetained = result.receipt.resources.recoveryRetained ?? [];
    assert.equal(recoveryRetained.some((entry) => entry.kind === 'formal-owner'), false);
    assert.equal(
      result.receipt.resources.notApplicable.some((item) => /unverified attachment/.test(item)),
      true,
      'the no-owner terminal must report that no formal owner was verified',
    );
    assert.equal(
      result.receipt.resources.notApplicable.some((item) => /attached formal owner is retained/.test(item)),
      false,
      'the no-owner terminal must not claim a retained formal owner',
    );

    // The attempt temp root is actually released and recorded truthfully.
    assert.equal(existsSync(captured.attemptRoot), false, 'the attempt temp root must be released');
    assert.ok(
      result.receipt.resources.released.some((entry) => entry.kind === 'attempt-root'
        && entry.path === captured.attemptRoot
        && entry.removed === true),
      'the released attempt root must be persisted',
    );

    // Zero stop, queue/business mutation, candidate serve, browser or scenario.
    assert.equal(calls.length, 0, 'a pre-verification refusal must not reach the owner network');
    assert.equal(candidateServeStarted, false);
    assert.equal(browserLaunched, false);
    assert.equal(scenarioRan, false);

    // The fake formal fixture is untouched and the rejected lease PID is never a
    // stop target.
    assert.equal(existsSync(formalWorkspace), true);
    assert.equal(existsSync(formalPaths.projectRoot), true);
    assert.equal(existsSync(leasePath), true);
    assert.equal(manifestsIdentical(formalManifestBefore, await workspaceManifest(formalWorkspace)), true);
    assert.deepEqual(await readFile(leasePath), leaseBefore);
    assert.equal(await isAlive(process.pid), true);

    // Both receipt files remain readable and carry the refusal and accounting.
    const written = JSON.parse(await readFile(result.receiptPaths.jsonPath, 'utf8'));
    const markdown = await readFile(result.receiptPaths.markdownPath, 'utf8');
    assert.equal(written.result, 'INCOMPLETE');
    assert.ok(written.cleanup && written.resources, 'both receipts must persist cleanup and resources');
    assert.match(written.deviation.error, /refused owner "some\.other\.owner"/);
    assert.ok(markdown.includes('INCOMPLETE'));
    assert.ok(markdown.includes('refused owner'));
    assert.ok(markdown.includes(captured.attemptRoot), 'the released attempt root must appear in Markdown');
    assert.ok(markdown.includes('Released'), 'the Markdown resources section must list released roots');

    // Second bounded case: when the ownership guard cannot prove a temp root
    // belongs to the attempt, it must refuse release and persist exact retained
    // accounting instead of dropping it or mislabeling it as released.
    const guardRoot = await makeTempRoot('attach-refusal-guard');
    const guardBinding = {
      serviceMode: 'installed-attach',
      attachedOwner: null,
      servePid: null,
      servePort: null,
      serveBaseUrl: null,
      tempRoots: [guardRoot],
      // guardRoot is not inside the registered attempt root, so the guard must refuse.
      attemptRoot: join(guardRoot, 'nested-attempt'),
      persistentRoots: [],
      browser: null,
      taskId: null,
      outcome: 'success',
      recoveryOwner: 'humanagent.runtime.task-recovery',
    };
    const guardCleanup = await retainUnsettledRecovery(guardBinding, 'pre-verification refusal');
    assert.equal(guardCleanup.settled, false);
    assert.equal(guardCleanup.released.length, 0, 'an unprovable root must never be reported as released');
    const retainedRoot = guardCleanup.recoveryRetained.find((entry) => entry.kind === 'attempt-root');
    assert.ok(retainedRoot, 'a refused attempt root must be recorded as retained');
    assert.equal(retainedRoot.owner, 'attempt');
    assert.equal(retainedRoot.path, guardRoot);
    assert.equal(retainedRoot.retained, true);
    assert.match(retainedRoot.reason, /not within this attempt's registered root/);
    assert.equal(retainedRoot.recoveryOwner, 'humanagent.runtime.task-recovery');
    assert.ok(retainedRoot.nextStep, 'a retained root must carry a next step');
    assert.equal(existsSync(guardRoot), true, 'a refused attempt root must be left in place');
  } finally {
    for (const root of createdRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('installed-attach fails closed on missing formal identity, wrong owner or endpoint mismatch', async () => {
  assertResolverAvailable();
  const controlRoot = await makeTempRoot('attach-negative-control');
  const formalWorkspace = await makeTempRoot('attach-negative-formal');
  const previousWorkspace = process.env.HUMANAGENT_ATTACH_WORKSPACE;
  try {
    delete process.env.HUMANAGENT_ATTACH_WORKSPACE;
    // No explicit formal workspace anywhere -> refuse; never guess a project.
    await assert.rejects(
      () => resolveFormalAttachPaths(
        bindCandidate(REPO, { scenario: 'local-file-search', serviceMode: 'installed-attach', attemptIdSuffix: 'neg-formal' }),
        { resolvePaths: resolveRuntimePaths, controlRoot },
      ),
      /explicit formal workspace/,
    );
  } finally {
    if (previousWorkspace !== undefined) process.env.HUMANAGENT_ATTACH_WORKSPACE = previousWorkspace;
  }

  const attempt = bindCandidate(REPO, {
    scenario: 'local-file-search',
    entry: 'dashboard',
    outcome: 'success',
    serviceMode: 'installed-attach',
    attemptIdSuffix: 'neg-attach',
  });
  await resolveAttemptPaths(attempt, { resolvePaths: resolveRuntimePaths, controlRoot });
  await resolveFormalAttachPaths(attempt, { formalWorkspace, resolvePaths: resolveRuntimePaths, controlRoot });

  const liveLease = {
    ownerId: 'humanagent.app.serve',
    pid: process.pid,
    controlEndpoint: { port: 1 },
    leaseId: 'lease-neg',
    generation: 1,
  };
  const okAuth = { async fetch() { return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'alive' }), headers: new Headers() }; } };

  // A lease owned by a different service must be refused.
  await assert.rejects(
    () => attachToInstalledService(attempt, {
      baseUrl: 'http://127.0.0.1:1',
      readLease: async () => ({ ...liveLease, ownerId: 'some.other.owner' }),
      auth: okAuth,
      requiredTaskId: CONTRACT_TASK.value,
    }),
    /refused owner/,
  );
  // An endpoint that does not match the live lease port must be refused.
  await assert.rejects(
    () => attachToInstalledService(attempt, {
      baseUrl: 'http://127.0.0.1:2',
      readLease: async () => liveLease,
      auth: okAuth,
      requiredTaskId: CONTRACT_TASK.value,
    }),
    /does not match the live lease port/,
  );
  // A missing lease must be refused.
  await assert.rejects(
    () => attachToInstalledService(attempt, {
      baseUrl: 'http://127.0.0.1:1',
      readLease: async () => undefined,
      auth: okAuth,
      requiredTaskId: CONTRACT_TASK.value,
    }),
    /found no daemon lease/,
  );
  // None of these refusals may have turned the attached owner into a stop target.
  assert.equal(attempt.servePid, null);

  // The public entry point must fail closed without a formal workspace and must
  // never start a candidate service as a stand-in for the formal owner.
  let started = false;
  const { runScenario } = await import('./runner.mjs');
  await assert.rejects(
    () => runScenario('local-file-search', {
      entry: 'dashboard',
      outcome: 'success',
      serviceMode: 'installed-attach',
      attemptIdSuffix: 'neg-public',
      resolvePaths: resolveRuntimePaths,
      controlRoot,
      scope: CONTRACT_SCOPE,
      hooks: {
        startServeForAttempt: async () => { started = true; },
        attachToInstalledService: async () => { started = true; },
      },
    }),
    /explicit formal workspace/,
  );
  assert.equal(started, false, 'a missing formal identity must not start or attach anything');
});

/** A page double that records the URLs it navigates to. */
function recordingPage() {
  const gotos = [];
  let url = 'about:blank';
  return {
    gotos,
    url: () => url,
    async goto(next) {
      url = String(next);
      gotos.push(url);
      return { ok: () => true, status: () => 200 };
    },
    async waitForSelector() {},
    async evaluate() { return {}; },
    async screenshot() {},
    async reload() {},
  };
}

/** An auth double that records every request URL and returns benign JSON. */
function recordingAuth() {
  const calls = [];
  const auth = {
    async fetch(url, init = {}) {
      calls.push({ target: String(url), method: String(init.method ?? 'GET').toUpperCase() });
      const body = {};
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    },
  };
  return { auth, calls };
}

/**
 * Every task URL consumer must project a string task value and a typed TaskId to
 * the same exact task-scoped URL. This is the shared boundary the second review
 * finding names: the typed identity stays typed in the binding, but the value is
 * used in the request.
 */
test('every task URL consumer projects string and typed task identities to the same exact target', async () => {
  const task = CONTRACT_TASK.value;
  const base = 'http://127.0.0.1:1';
  const cases = [
    [
      'openTaskDashboard',
      async (binding) => { await openTaskDashboard(binding, { waitNonterminal: false }); },
      [`${base}/task-dashboard.html?task=${task}`],
    ],
    [
      'readDashboardProbe',
      async (binding) => { await readDashboardProbe(binding); },
      [`${base}/api/tasks/${task}/dashboard`],
    ],
    [
      'describeDraftStage',
      async (binding) => { await describeDraftStage(binding); },
      [`${base}/api/tasks/${task}/dashboard`],
    ],
    [
      'readObservationDom',
      async (binding) => { await readObservationDom(binding); },
      [`${base}/observation.html?task=${task}`],
    ],
    [
      'readToolOutputReports',
      async (binding) => {
        await readToolOutputReports(
          binding,
          { operationId: CONTRACT_OPERATION.value, executionEpoch: CONTRACT_EPOCH },
          [{ kind: 'provider.tool-result', status: 'succeeded', outputRef: 'asset://r', seq: 3, toolId: 'file.search' }],
        );
      },
      [`${base}/api/tasks/${task}/operations/${CONTRACT_OPERATION.value}/executions/${CONTRACT_EPOCH}/events/3/tool-output`],
    ],
    [
      'captureDashboardEvidence',
      async (binding) => {
        const evidence = await captureDashboardEvidence(binding);
        assert.equal(evidence.rootScopeRef, `task://${task}/observation`, 'the fallback observation scope ref must use the exact task value');
      },
      [`${base}/api/tasks/${task}/dashboard`, `${base}/api/tasks/${task}/observation`],
    ],
  ];

  for (const [name, run, expected] of cases) {
    const runOne = async (taskId) => {
      const page = recordingPage();
      const { auth, calls } = recordingAuth();
      const binding = { serveBaseUrl: base, taskId, browser: { page }, auth };
      await run(binding);
      return [...page.gotos, ...calls.map((call) => call.target)];
    };
    const stringUrls = await runOne(task);
    const typedUrls = await runOne(CONTRACT_TASK);
    assert.deepEqual(typedUrls, stringUrls, `${name}: typed and string identities must reach the same URLs`);
    for (const target of expected) {
      assert.ok(stringUrls.includes(target), `${name}: expected ${target} in ${JSON.stringify(stringUrls)}`);
      assert.ok(typedUrls.includes(target), `${name}: expected ${target} for the typed identity in ${JSON.stringify(typedUrls)}`);
    }
  }
});

/**
 * Invalid, wrong-scope or missing task identities must fail closed: no task
 * request, no task navigation, and never a stringified object in a request.
 */
test('invalid or wrong-scope task identities fail closed before any task request or stop', async () => {
  assertResolverAvailable();
  const invalidTaskIds = [
    ['wrong scope', { scope: 'operation', value: 'operation-contract' }],
    ['missing value', { scope: 'task' }],
    ['non-string value', { scope: 'task', value: 42 }],
    ['invalid value', { scope: 'task', value: 'not a valid id!' }],
    ['missing id', null],
    ['empty string', ''],
  ];
  for (const [label, taskId] of invalidTaskIds) {
    const page = recordingPage();
    const { auth, calls } = recordingAuth();
    const binding = { serveBaseUrl: 'http://127.0.0.1:1', taskId, browser: { page }, auth };
    await assert.rejects(() => readDashboardProbe(binding), label);
    await assert.rejects(() => openTaskDashboard(binding, { waitNonterminal: false }), label);
    assert.equal(calls.length, 0, `${label}: no task request may be issued`);
    assert.equal(page.gotos.length, 0, `${label}: no task navigation may be issued`);
  }

  // A wrong-scope identity whose value equals the journal task must still not
  // reach the stop POST: the URL projection fails closed before the request.
  const controlRoot = await makeTempRoot('invalid-task-stop');
  const owned = spawnIdle();
  const calls = [];
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  const auth = {
    async fetch(url, init = {}) {
      calls.push({ target: String(url), method: String(init.method ?? 'GET').toUpperCase() });
      return response({ state: 'running', operationId: CONTRACT_OPERATION.value, executionEpoch: CONTRACT_EPOCH });
    },
  };
  try {
    const binding = bindCandidate(REPO, { scenario: 'local-file-search', outcome: 'cancel', attemptIdSuffix: 'invalid-task-stop' });
    await resolveAttemptPaths(binding, { resolvePaths: resolveRuntimePaths, controlRoot });
    binding.serveBaseUrl = 'http://127.0.0.1:1';
    binding.servePid = owned.pid;
    binding.auth = auth;
    binding.taskId = CONTRACT_TASK;
    binding.operationId = CONTRACT_OPERATION;
    binding.cycleId = CONTRACT_CYCLE;
    binding.executionEpoch = CONTRACT_EPOCH;
    await writeCancelRunningJournal(binding);
    const settle = await stopTaskAndSettle(binding, { scope: 'operation', value: CONTRACT_TASK.value }, { expectedOutcome: 'cancel' });
    assert.equal(settle.stopped, false, 'an invalid task identity must not stop the task');
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0, 'an invalid task identity must not POST a stop');
  } finally {
    await stopChild(owned);
  }
});

/**
 * The cleanup owner builds the identity Dashboard probe, the stop POST and the
 * post-settlement poll URL. Both a string target and a typed TaskId must reach
 * the exact task URL while the binding keeps the typed identity.
 */
test('cleanup stop/settle projects string and typed task identities to the same exact stop and poll URLs', async () => {
  assertResolverAvailable();
  const task = CONTRACT_TASK.value;
  for (const [label, target] of [['string', task], ['typed', CONTRACT_TASK]]) {
    const controlRoot = await makeTempRoot(`stop-url-${label}`);
    const owned = spawnIdle();
    const calls = [];
    let stopPosts = 0;
    const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    const auth = {
      async fetch(url, init = {}) {
        const requestUrl = String(url);
        const method = String(init.method ?? 'GET').toUpperCase();
        calls.push({ target: requestUrl, method });
        if (method === 'POST') { stopPosts += 1; return response({ ok: true }); }
        if (requestUrl.includes('/dashboard')) {
          return response({ state: 'stopped', operationId: CONTRACT_OPERATION.value, executionEpoch: CONTRACT_EPOCH });
        }
        return response({});
      },
    };
    try {
      const binding = bindCandidate(REPO, { scenario: 'local-file-search', outcome: 'cancel', attemptIdSuffix: `stop-url-${label}` });
      await resolveAttemptPaths(binding, { resolvePaths: resolveRuntimePaths, controlRoot });
      binding.serveBaseUrl = 'http://127.0.0.1:1';
      binding.servePid = owned.pid;
      binding.auth = auth;
      binding.taskId = CONTRACT_TASK;
      binding.operationId = CONTRACT_OPERATION;
      binding.cycleId = CONTRACT_CYCLE;
      binding.executionEpoch = CONTRACT_EPOCH;
      await writeCancelRunningJournal(binding);
      await stopTaskAndSettle(binding, target, { expectedOutcome: 'cancel' });
      assert.equal(stopPosts, 1, `${label}: exactly one stop POST`);
      assert.ok(
        calls.some((call) => call.method === 'POST' && call.target === `http://127.0.0.1:1/api/tasks/${task}/stop`),
        `${label}: the stop POST must target the exact task value`,
      );
      assert.ok(
        calls.some((call) => call.target === `http://127.0.0.1:1/api/tasks/${task}/dashboard`),
        `${label}: the identity/poll Dashboard probe must target the exact task value`,
      );
      assert.deepEqual(binding.taskId, CONTRACT_TASK, `${label}: the typed identity must be preserved in the binding`);
    } finally {
      await stopChild(owned);
    }
  }
});
