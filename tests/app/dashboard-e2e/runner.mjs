#!/usr/bin/env node
/**
 * Dashboard E2E runner entry — real implementation.
 *
 * Design:   docs/ui/dashboard-e2e-runner-design.md
 * Contract: docs/ui/dashboard-e2e-acceptance.md
 * Graphs:   docs/dagpipe/dashboard-e2e-web-search.graph.json
 *           docs/dagpipe/dashboard-e2e-local-file-search.graph.json
 *           docs/dagpipe/dashboard-e2e-aitest.graph.json
 *
 * Single entry for the three acceptance commands:
 *   pnpm e2e:dashboard:web-search
 *   pnpm e2e:dashboard:local-file-search
 *   pnpm e2e:dashboard:aitest
 *
 * Follows the single chain each per-command graph declares:
 *   candidate_binding -> browser_session -> <cmd>_entry -> ... ->
 *   attempt_failure_detect -> attempt_outcome_select -> attempt_stop_settle ->
 *   <cmd>_cleanup -> attempt_receipt   (the single sink, written last)
 *
 * Options (parsed by parseOptions):
 *   --scenario <web-search|local-file-search|aitest>
 *   --entry <homepage|dashboard>                 default dashboard
 *   --outcome <success|failure|cancel>           default success
 *   --service-mode <candidate|installed-attach>  default candidate
 *
 * Unsupported option combinations are rejected up front: a request for a mode
 * the runner cannot really exercise never silently becomes a new service or a
 * success. Persistent state derives from the product config owner
 * (`resolveRuntimePaths`); the runner never sets a temporary HOME/HUMANAGENT_HOME
 * and never roots a persistent control root inside its ephemeral attempt tmp.
 *
 * Fail closed: any error, missing evidence, or unverifiable terminal leaves the
 * attempt INCOMPLETE with the first deviation and the raw error recorded in the
 * receipt, and the process exits non-zero.
 */

import { pathToFileURL } from 'node:url';

import {
  attachToInstalledService,
  launchBrowserSession,
  probeProvider,
  startServeForAttempt,
} from './lib/browser.mjs';
import {
  bindCandidate,
  prepareAttemptRoots,
  registerAttemptResources,
  resolveAttemptPaths,
  resolveFormalAttachPaths,
} from './lib/binding.mjs';
import {
  closeSettledAttempt,
  registerCleanupInventory,
  retainUnsettledRecovery,
  stopTaskAndSettle,
} from './lib/cleanup.mjs';
import { countTurnEvidenceFor, journalPathFor } from './lib/journal.mjs';
import { buildReceipt, writeReceipt } from './lib/receipt.mjs';
import { runAitestScenario } from './scenarios/aitest.mjs';
import { runLocalFileSearchScenario } from './scenarios/local-file-search.mjs';
import { runWebSearchScenario } from './scenarios/web-search.mjs';

export const SCENARIOS = Object.freeze(['web-search', 'local-file-search', 'aitest']);
export const ENTRIES = Object.freeze(['homepage', 'dashboard']);
export const OUTCOMES = Object.freeze(['success', 'failure', 'cancel']);
export const SERVICE_MODES = Object.freeze(['candidate', 'installed-attach']);

/**
 * Which real outcomes each scenario can exercise through its public entrances.
 * A scenario with no wired non-success path is reported unsupported here
 * instead of downgrading the request.
 */
const SCENARIO_OUTCOME_SUPPORT = Object.freeze({
  'web-search': Object.freeze(['success']),
  'local-file-search': Object.freeze(['success', 'failure', 'cancel']),
  aitest: Object.freeze(['success']),
});

export const USAGE = [
  'Usage: node tests/app/dashboard-e2e/runner.mjs --scenario <name> [options]',
  '',
  'Options:',
  '  --scenario <web-search|local-file-search|aitest>  required',
  '  --entry <homepage|dashboard>                      default dashboard',
  '  --outcome <success|failure|cancel>                default success',
  '  --service-mode <candidate|installed-attach>       default candidate',
  '  --help                                            print this help',
].join('\n');

const RUNNERS = {
  'web-search': runWebSearchScenario,
  'local-file-search': runLocalFileSearchScenario,
  aitest: runAitestScenario,
};

export function parseOptions(argv) {
  const take = (name) => {
    const index = argv.indexOf(name);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  const first = argv[0];
  const options = {
    scenario: take('--scenario') ?? (first && !first.startsWith('--') ? first : null),
    entry: take('--entry') ?? 'dashboard',
    outcome: take('--outcome') ?? 'success',
    serviceMode: take('--service-mode') ?? 'candidate',
  };
  assertSupportedCombination(options.scenario, options);
  return options;
}

/** Reject any option combination the runner cannot really exercise. */
export function assertSupportedCombination(scenario, options = {}) {
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`unknown scenario ${JSON.stringify(scenario)}; expected one of ${SCENARIOS.join(', ')}`);
  }
  if (!ENTRIES.includes(options.entry)) {
    throw new Error(`unsupported --entry ${JSON.stringify(options.entry)}; expected one of ${ENTRIES.join(', ')}`);
  }
  if (!OUTCOMES.includes(options.outcome)) {
    throw new Error(`unsupported --outcome ${JSON.stringify(options.outcome)}; expected one of ${OUTCOMES.join(', ')}`);
  }
  if (!SERVICE_MODES.includes(options.serviceMode)) {
    throw new Error(`unsupported --service-mode ${JSON.stringify(options.serviceMode)}; expected one of ${SERVICE_MODES.join(', ')}`);
  }
  const supported = SCENARIO_OUTCOME_SUPPORT[scenario] ?? ['success'];
  if (!supported.includes(options.outcome)) {
    throw new Error(
      `scenario ${scenario} cannot exercise a real ${options.outcome} outcome (supported: ${supported.join(', ')}); `
      + 'this combination is unsupported and is not downgraded',
    );
  }
  if (options.serviceMode === 'installed-attach' && options.entry === 'homepage') {
    throw new Error(
      'installed-attach attaches to an existing owned task, so --entry homepage (which creates a new task) is unsupported',
    );
  }
  if (options.serviceMode === 'installed-attach' && scenario !== 'local-file-search') {
    throw new Error(
      `scenario ${scenario} does not implement installed-attach existing-task observation`,
    );
  }
  return options;
}

/** Map a real Journal dashboard terminal to the outcome it represents. */
export function classifyOutcome(terminalState) {
  if (terminalState === 'succeeded') return 'success';
  if (terminalState === 'failed') return 'failure';
  if (terminalState === 'stopped' || terminalState === 'cancelled' || terminalState === 'canceled') return 'cancel';
  return null;
}

/** Summarize released / persistent-retained / recovery-retained / N/A resources. */
export function summarizeResources(binding) {
  const cleanup = binding.cleanup ?? {};
  const attached = binding.serviceMode === 'installed-attach';
  const persistentRetained = cleanup.persistentRetained ?? binding.persistentRoots ?? [];
  const recoveryRetained = cleanup.recoveryRetained ?? [];
  const notApplicable = [];
  const released = [];
  if (cleanup.branch === 'unsettled-recovery-retained') {
    if (attached) {
      for (const entry of cleanup.released ?? []) released.push(entry);
      if (binding.attachedOwner) {
        notApplicable.push('candidate serve PID exit: the attached formal owner is retained');
        notApplicable.push('owned listener closure: the attached formal owner owns the port');
      } else {
        // The attempt was refused before a formal owner was verified, so there is
        // no retained owner and no formal stop/port closure to report.
        notApplicable.push('unverified attachment: no formal owner was verified, so formal stop/port cleanup does not apply');
      }
    }
    return { released, persistentRetained, recoveryRetained, notApplicable };
  }
  for (const root of binding.tempRoots ?? []) {
    released.push({ kind: 'attempt-root', path: root, removed: cleanup.tempRootsRemoved ?? null });
  }
  if (attached) {
    notApplicable.push('candidate serve PID exit: the attached formal owner is retained');
    notApplicable.push('owned listener closure: the attached formal owner owns the port');
    if (binding.attachedOwner) notApplicable.push(`attached owner retained: ${JSON.stringify(binding.attachedOwner)}`);
  } else {
    released.push({ kind: 'serve-pid', pid: cleanup.servePid ?? null, exited: cleanup.serveExited ?? null });
    if (cleanup.portClosed !== null && cleanup.portClosed !== undefined) {
      released.push({ kind: 'listener', port: binding.servePort ?? null, closed: cleanup.portClosed, reason: cleanup.portReason ?? null });
    }
  }
  return { released, persistentRetained, recoveryRetained, notApplicable };
}

/** Name the first real cleanup failure, or the recovery-retention reason. */
function cleanupFailureReason(binding, settlement) {
  const cleanup = binding.cleanup ?? {};
  if (cleanup.branch === 'unsettled-recovery-retained') {
    return `resources retained for recovery: ${cleanup.reason ?? settlement.reason ?? 'attempt did not settle'}`;
  }
  if (cleanup.serveExited === false) return cleanup.serveExitReason ?? 'serve process did not exit';
  if (cleanup.browserClosed === false) return cleanup.browserReason ?? 'browser context did not close';
  if (cleanup.portClosed === false) return cleanup.portReason ?? 'serve port remained open';
  if (cleanup.tempRootsRemoved === false) {
    const failed = (cleanup.tempRootResults ?? []).find((entry) => entry?.removed === false);
    return failed?.reason ?? 'temporary attempt root was not removed';
  }
  return 'cleanup did not complete';
}

/**
 * Run one scenario end to end and return the evidence bundle. Every step that
 * fails records the first deviation with the raw error.
 */
export async function runScenario(scenario, options = {}) {
  const entry = options.entry ?? 'dashboard';
  const outcome = options.outcome ?? 'success';
  const serviceMode = options.serviceMode ?? 'candidate';
  const hooks = options.hooks ?? {};
  assertSupportedCombination(scenario, { entry, outcome, serviceMode });

  const stageErrors = [];
  let deviation = null;
  let binding;
  try {
    binding = bindCandidate(options.repoPath, {
      scenario,
      entry,
      outcome,
      serviceMode,
      attemptIdSuffix: options.attemptIdSuffix,
      recoveryOwner: options.recoveryOwner,
      formalWorkspace: options.formalWorkspace ?? process.env.HUMANAGENT_ATTACH_WORKSPACE ?? null,
      resolvePaths: options.resolvePaths ?? null,
      ...(options.scope ? { scope: options.scope } : {}),
    });
    if (options.scope) {
      binding.scope = options.scope;
      binding.taskId = options.scope.taskId ?? null;
      binding.operationId = options.scope.operationId ?? null;
      binding.cycleId = options.scope.cycleId ?? null;
      binding.executionEpoch = options.scope.executionEpoch ?? null;
    }
    registerAttemptResources(binding);
    await resolveAttemptPaths(binding, { resolvePaths: options.resolvePaths, controlRoot: options.controlRoot });
    if (serviceMode === 'installed-attach') {
      await resolveFormalAttachPaths(binding, {
        formalWorkspace: options.formalWorkspace,
        resolvePaths: options.resolvePaths,
        controlRoot: options.controlRoot,
      });
    }
    await prepareAttemptRoots(binding);
    stageErrors.push({
      stage: 'candidate_binding',
      ok: true,
      controlRoot: binding.controlRoot,
      runNotesRoot: binding.runNotesRoot,
    });
  } catch (error) {
    throw new Error(`candidate_binding failed: ${error.message}`);
  }

  let terminalReached = false;
  let evidence = { screenshots: [] };

  try {
    await (hooks.probeProvider ?? probeProvider)(binding);
    stageErrors.push({ stage: 'provider_probe', ok: true });
    if (serviceMode === 'installed-attach') {
      await (hooks.attachToInstalledService ?? attachToInstalledService)(binding);
      stageErrors.push({ stage: 'installed_attach', ok: true, owner: binding.attachedOwner });
    } else {
      await (hooks.startServeForAttempt ?? startServeForAttempt)(binding);
      stageErrors.push({ stage: 'serve_start', ok: true, pid: binding.servePid, port: binding.servePort });
    }
    await (hooks.launchBrowserSession ?? launchBrowserSession)(binding);
    stageErrors.push({ stage: 'browser_session', ok: true });
    registerCleanupInventory(binding);
    // Each scenario drives its own real chain: browser input -> visible draft ->
    // user confirmation -> run queue -> execution turns with tool steps ->
    // verifiable terminal -> journal evidence.
    evidence = await (hooks.runScenario ?? RUNNERS[scenario])(binding);
    terminalReached = evidence.terminalState !== undefined && evidence.terminalState !== null
      && (outcome === 'success'
        ? evidence.terminalState === 'succeeded' && (evidence.missingEvidence ?? []).length === 0
        : true);
    stageErrors.push({ stage: `${scenario}_entry`, ok: terminalReached, missing: evidence.missingEvidence ?? [] });
  } catch (error) {
    if (!deviation) deviation = { stage: 'attempt', error: error.message, raw: String(error.stack ?? error) };
    stageErrors.push({ stage: deviation.stage, ok: false, error: error.message });
  }

  // attempt_failure_detect -> attempt_outcome_select
  const scenarioMissingEvidence = evidence.missingEvidence ?? [];
  const achievedOutcome = classifyOutcome(evidence.terminalState ?? null);
  const requestedOutcomeReached = outcome === 'success'
    ? achievedOutcome === 'success' && scenarioMissingEvidence.length === 0
    : achievedOutcome === outcome;
  if (!deviation && !requestedOutcomeReached) {
    deviation = {
      stage: scenarioMissingEvidence.length ? 'evidence_missing' : 'outcome_mismatch',
      error: scenarioMissingEvidence.length
        ? scenarioMissingEvidence.join('; ')
        : `requested outcome ${outcome} but the task reached ${JSON.stringify(evidence.terminalState ?? null)}`,
      raw: JSON.stringify({ requested: outcome, achieved: achievedOutcome, missingEvidence: scenarioMissingEvidence }).slice(0, 2000),
    };
  }

  // Locate the authoritative journal before the settlement proof. A journal that
  // cannot be located is recorded as a failed stage, not swallowed.
  binding.taskId = binding.taskId
    ?? evidence.scenarioEvidence?.taskId
    ?? evidence.taskId
    ?? null;
  binding.operationId = binding.operationId
    ?? evidence.scenarioEvidence?.operationId
    ?? evidence.operationId
    ?? null;
  binding.executionEpoch = binding.executionEpoch
    ?? evidence.scenarioEvidence?.executionEpoch
    ?? evidence.executionEpoch
    ?? null;
  binding.cycleId = binding.cycleId ?? evidence.scenarioEvidence?.cycleId ?? null;
  binding.scope = binding.taskId
    ? {
        taskId: binding.taskId,
        ...(binding.operationId ? { operationId: binding.operationId } : {}),
        ...(binding.cycleId ? { cycleId: binding.cycleId } : {}),
        ...(binding.executionEpoch !== null ? { executionEpoch: binding.executionEpoch } : {}),
      }
    : null;
  const journalRoot = binding.journalControlRoot ?? binding.formalPaths?.controlRoot ?? binding.controlRoot;
  if (!binding.journalPath && journalRoot) {
    try {
      await journalPathFor(binding);
      stageErrors.push({ stage: 'journal_locate', ok: true, journalPath: binding.journalPath });
    } catch (error) {
      stageErrors.push({ stage: 'journal_locate', ok: false, error: error.message });
    }
  }

  // attempt_stop_settle. Candidate mode stops its own task then proves settlement
  // from the authoritative journal; installed-attach never stops the attached
  // owner and proves settlement from the owner's domain state/journal.
  let settleResult;
  let settlement;
  if (serviceMode === 'installed-attach') {
    // The same single owner handles attached mode: it never stops the formal
    // owner and only assesses settlement (read-only).
    settleResult = await stopTaskAndSettle(binding, binding.taskId ?? null, {
      expectedOutcome: outcome,
      terminalState: evidence.terminalState ?? null,
    }).catch((error) => ({ stopped: false, attached: true, settled: false, reason: `attached settlement probe failed: ${error.message}` }));
    settlement = {
      settled: settleResult.settled,
      reason: settleResult.settlementReason ?? settleResult.reason ?? null,
      terminal: settleResult.terminal ?? null,
      evidence: settleResult.evidence ?? null,
    };
  } else {
    // The single stop/settle owner. A task the scenario already drove to a legal
    // terminal is assessed read-only (no stop); a still-running task gets one
    // formal stop; a cancel that already used this helper is reused verbatim via
    // its attempt-scoped control record.
    settleResult = await stopTaskAndSettle(binding, binding.taskId ?? null, {
      expectedOutcome: outcome,
      terminalState: evidence.terminalState ?? null,
    })
      .catch((error) => ({ stopped: false, settled: false, reason: `stop/settle probe failed: ${error.message}` }));
    settlement = {
      settled: settleResult.settled,
      reason: settleResult.settlementReason ?? settleResult.reason ?? null,
      terminal: settleResult.terminal ?? null,
      evidence: settleResult.evidence ?? null,
    };
  }
  stageErrors.push({
    stage: 'attempt_stop_settle',
    ok: settlement.settled,
    state: settleResult.state ?? null,
    reason: settlement.reason ?? null,
  });

  // <cmd>_cleanup, before the receipt sink. An unsettled attempt retains its
  // service, workspace, control root and evidence instead of being torn down.
  let resources = null;
  let cleanupCompleted = false;
  let cleanupReason = null;
  try {
    if (settlement.settled) {
      await closeSettledAttempt(binding, settleResult);
    } else {
      await retainUnsettledRecovery(binding, settlement.reason ?? deviation?.error ?? 'attempt did not settle', settleResult);
    }
    resources = summarizeResources(binding);
    cleanupCompleted = binding.cleaned === true;
    cleanupReason = cleanupCompleted ? null : cleanupFailureReason(binding, settlement);
    stageErrors.push({
      stage: `${scenario}_cleanup`,
      ok: cleanupCompleted,
      branch: binding.cleanup?.branch ?? null,
      reason: cleanupReason,
    });
  } catch (error) {
    cleanupReason = error.message;
    if (!deviation) deviation = { stage: `${scenario}_cleanup`, error: error.message, raw: String(error.stack ?? error) };
    stageErrors.push({ stage: `${scenario}_cleanup`, ok: false, error: error.message });
  }

  // attempt_receipt: the single sink, written after cleanup.
  let terminalRecord = evidence.terminalRecord ?? settlement.terminal ?? null;
  let evidenceRefs = evidence.evidenceRefs ?? [];
  let journalEvidence = settlement.evidence ?? null;
  if (!journalEvidence && binding.journalPaths?.length) {
    journalEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  }
  if (journalEvidence) {
    if (!evidence.toolRounds) evidence.toolRounds = journalEvidence.toolRounds;
    if (!evidence.requestStartTurns) evidence.requestStartTurns = journalEvidence.requestStartTurns;
    if (!evidence.checkpointCommitted) evidence.checkpointCommitted = journalEvidence.checkpointCommitted;
    terminalRecord = evidence.terminalRecord ?? journalEvidence.terminalRecords?.slice(-1)[0] ?? terminalRecord;
    if (!evidenceRefs.length) {
      evidenceRefs = (journalEvidence.allEvents ?? [])
        .flatMap((event) => (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []))
        .slice(0, 40);
    }
  }

  const missingEvidence = [...scenarioMissingEvidence];
  if (outcome === 'success' && !settlement.settled) {
    missingEvidence.push(`strict settlement: ${settlement.reason ?? 'attempt did not settle'}`);
  }
  if (!cleanupCompleted) {
    missingEvidence.push(`cleanup: ${cleanupReason ?? 'cleanup did not complete'}`);
  }
  const visibleMissingEvidence = [...new Set(missingEvidence)];

  if (!deviation && !settlement.settled) {
    deviation = {
      stage: 'attempt_stop_settle',
      error: settlement.reason ?? 'attempt did not settle',
      raw: JSON.stringify(settlement).slice(0, 2000),
    };
  } else if (!deviation && !cleanupCompleted) {
    deviation = {
      stage: `${scenario}_cleanup`,
      error: cleanupReason ?? 'cleanup did not complete',
      raw: JSON.stringify(binding.cleanup ?? null).slice(0, 2000),
    };
  }

  const status = !deviation && requestedOutcomeReached && settlement.settled && cleanupCompleted && outcome === 'success'
    ? 'SUCCESS'
    : 'INCOMPLETE';
  const receipt = buildReceipt(binding, {
    // The final result is derived only after strict settlement and cleanup.
    result: status,
    deviation,
    terminalState: evidence.terminalState ?? binding.terminalState ?? null,
    dashboardState: evidence.dashboardState ?? null,
    toolRounds: evidence.toolRounds ?? 0,
    requestStartTurns: evidence.requestStartTurns ?? 0,
    checkpointCommitted: evidence.checkpointCommitted ?? 0,
    terminalRecord,
    evidenceRefs,
    scenarioEvidence: evidence.scenarioEvidence ?? null,
    screenshots: evidence.screenshots ?? [],
    missingEvidence: visibleMissingEvidence,
    draft: evidence.draft ?? binding.draft ?? null,
    confirmStatus: evidence.confirmStatus ?? binding.confirmStatus ?? null,
    draftRowsBeforeConfirm: evidence.draftRowsBeforeConfirm ?? binding.draftRowsBeforeConfirm ?? null,
    settlement: {
      requestedOutcome: outcome,
      requestedOutcomeReached,
      achievedOutcome,
      settled: settlement.settled,
      reason: settlement.reason ?? null,
      terminal: settlement.terminal ?? null,
    },
    resources,
    recoveryOwner: binding.cleanup?.recoveryOwner ?? null,
    // The cleanup stage ran above; carry its real recorded outcome into the
    // receipt. When it did not record one, this stays null and the receipt says
    // so instead of implying success.
    cleanup: binding.cleanup ?? null,
    cleaned: binding.cleaned ?? null,
  });
  const written = await writeReceipt(binding, receipt);

  return {
    receipt,
    receiptPaths: written,
    stageErrors,
    options: { scenario, entry, outcome, serviceMode },
    outcome: status,
    requestedOutcomeReached,
    settled: settlement.settled,
    terminalReached,
    deviation,
  };
}

export async function main(argv, runOptions = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return { help: true };
  }
  const parsed = parseOptions(argv);
  process.env.E2E_SCENARIO = parsed.scenario;
  const result = await runScenario(parsed.scenario, { ...parsed, ...runOptions });
  console.log(JSON.stringify({
    scenario: parsed.scenario,
    entry: parsed.entry,
    requestedOutcome: parsed.outcome,
    serviceMode: parsed.serviceMode,
    outcome: result.outcome,
    settled: result.settled,
    requestedOutcomeReached: result.requestedOutcomeReached,
    candidateSha: result.receipt.candidate.sha,
    attemptId: result.receipt.attemptId,
    taskId: result.receipt.task.taskId,
    terminalState: result.receipt.task.terminalState,
    toolRounds: result.receipt.evidence.toolRounds,
    requestStartTurns: result.receipt.evidence.requestStartTurns,
    checkpointCommitted: result.receipt.evidence.checkpointCommitted,
    screenshots: result.receipt.screenshots,
    receiptMarkdown: result.receiptPaths.markdownPath,
    receiptJson: result.receiptPaths.jsonPath,
    cleanup: result.receipt.cleanup,
    resources: result.receipt.resources,
    stages: result.stageErrors,
  }, null, 2));
  if (result.receipt.result !== 'SUCCESS') process.exitCode = 1;
  return result;
}

// Fail closed: a direct `node runner.mjs --scenario <name>` invocation must exit
// non-zero whenever the attempt is not SUCCESS.
const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
