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
 * Fail closed: any error, missing evidence, or unverifiable terminal leaves the
 * attempt INCOMPLETE with the first deviation and the raw error recorded in the
 * receipt, and the process exits non-zero.
 */

import { pathToFileURL } from 'node:url';

import {
  captureScreenshot,
  jsonRequest,
  launchBrowserSession,
  openTaskDashboard,
  probeProvider,
  startServeForAttempt,
  submitDirectiveAndConfirmDraft,
} from './lib/browser.mjs';
import { bindCandidate, prepareAttemptRoots, registerAttemptResources } from './lib/binding.mjs';
import {
  attemptJournalEvidence,
  closeSettledAttempt,
  registerCleanupInventory,
  retainUnsettledRecovery,
  stopTaskAndSettle,
} from './lib/cleanup.mjs';
import { assertTerminalFor, countTurnEvidenceFor, journalPathFor } from './lib/journal.mjs';
import { buildReceipt, writeIncompleteReceipt, writeReceipt } from './lib/receipt.mjs';
import { runAitestScenario } from './scenarios/aitest.mjs';
import { runLocalFileSearchScenario } from './scenarios/local-file-search.mjs';
import { runWebSearchScenario } from './scenarios/web-search.mjs';

export const SCENARIOS = Object.freeze(['web-search', 'local-file-search', 'aitest']);

const RUNNERS = {
  'web-search': runWebSearchScenario,
  'local-file-search': runLocalFileSearchScenario,
  aitest: runAitestScenario,
};

export function parseScenario(argv) {
  const index = argv.indexOf('--scenario');
  const value = index >= 0 ? argv[index + 1] : argv[0];
  if (!SCENARIOS.includes(value)) {
    throw new Error(`unknown scenario ${JSON.stringify(value)}; expected one of ${SCENARIOS.join(', ')}`);
  }
  return value;
}

/**
 * Run one scenario end to end and return the evidence bundle. Every step that
 * fails records the first deviation with the raw error.
 */
export async function runScenario(scenario, options = {}) {
  const stageErrors = [];
  let deviation = null;
  const bindStep = options.repoPath ? bindCandidate(options.repoPath) : bindCandidate();
  let binding;
  try {
    binding = bindStep;
    registerAttemptResources(binding);
    await prepareAttemptRoots(binding);
    stageErrors.push({ stage: 'candidate_binding', ok: true });
  } catch (error) {
    throw new Error(`candidate_binding failed: ${error.message}`);
  }
  binding.scenario = scenario;

  let terminalReached = false;
  let evidence = { screenshots: [] };

  try {
    await probeProvider(binding);
    stageErrors.push({ stage: 'provider_probe', ok: true });
    await startServeForAttempt(binding);
    stageErrors.push({ stage: 'serve_start', ok: true, pid: binding.servePid, port: binding.servePort });
    await launchBrowserSession(binding);
    stageErrors.push({ stage: 'browser_session', ok: true });
    registerCleanupInventory(binding);
    // Each scenario drives its own real chain: browser input -> visible draft ->
    // user confirmation -> run queue -> execution turns with tool steps ->
    // verifiable terminal -> journal evidence.
    evidence = await RUNNERS[scenario](binding);
    terminalReached = evidence.terminalState === 'succeeded' && (evidence.missingEvidence ?? []).length === 0;
    stageErrors.push({ stage: `${scenario}_entry`, ok: terminalReached, missing: evidence.missingEvidence ?? [] });
  } catch (error) {
    if (!deviation) deviation = { stage: 'attempt', error: error.message, raw: String(error.stack ?? error) };
    stageErrors.push({ stage: deviation.stage, ok: false, error: error.message });
  }

  // attempt_failure_detect -> attempt_outcome_select
  const outcome = deviation
    ? 'INCOMPLETE'
    : (evidence.missingEvidence && evidence.missingEvidence.length > 0)
      ? 'INCOMPLETE'
      : 'SUCCESS';
  if (outcome === 'INCOMPLETE' && !deviation) {
    deviation = {
      stage: 'evidence_missing',
      error: (evidence.missingEvidence ?? []).join('; '),
      raw: JSON.stringify(evidence.missingEvidence ?? []).slice(0, 2000),
    };
  }

  // attempt_stop_settle
  let settleResult = null;
  try {
    settleResult = await stopTaskAndSettle(binding, binding.taskId ?? null);
    stageErrors.push({ stage: 'attempt_stop_settle', ok: settleResult.settled, state: settleResult.state, reason: settleResult.reason ?? null });
  } catch (error) {
    if (!deviation) deviation = { stage: 'attempt_stop_settle', error: error.message, raw: String(error.stack ?? error) };
    stageErrors.push({ stage: 'attempt_stop_settle', ok: false, error: error.message });
  }

  // <cmd>_cleanup, before the receipt sink.
  try {
    if (settleResult?.settled) {
      await closeSettledAttempt(binding, settleResult);
    } else {
      await retainUnsettledRecovery(binding, settleResult?.reason ?? deviation?.error ?? 'attempt did not settle');
    }
    stageErrors.push({ stage: `${scenario}_cleanup`, ok: Boolean(binding.cleaned), branch: binding.cleanup?.branch ?? null });
  } catch (error) {
    if (!deviation) deviation = { stage: `${scenario}_cleanup`, error: error.message, raw: String(error.stack ?? error) };
    stageErrors.push({ stage: `${scenario}_cleanup`, ok: false, error: error.message });
  }

  // attempt_receipt: the single sink, written after cleanup.
  let terminalRecord = evidence.terminalRecord ?? null;
  let evidenceRefs = evidence.evidenceRefs ?? [];
  try {
    if (!binding.journalPath && binding.controlRoot) {
      await journalPathFor(binding);
    }
    if (binding.journalPath) {
      const terminal = await assertTerminalFor(binding, {
        minToolRounds: 0,
        minCheckpoints: 0,
      }).catch(() => null);
      if (terminal) {
        terminalRecord = terminalRecord ?? terminal.terminal;
        evidenceRefs = evidenceRefs.length ? evidenceRefs : terminal.evidenceRefs;
      }
      const journal = await countTurnEvidenceFor(binding).catch(() => null);
      if (journal) {
        if (!evidence.toolRounds) evidence.toolRounds = journal.toolRounds;
        if (!evidence.requestStartTurns) evidence.requestStartTurns = journal.requestStartTurns;
        if (!evidence.checkpointCommitted) evidence.checkpointCommitted = journal.checkpointCommitted;
      }
    }
  } catch (error) {
    if (!deviation) deviation = { stage: 'journal_evidence', error: error.message, raw: String(error.stack ?? error) };
  }

  const receipt = buildReceipt(binding, {
    result: outcome === 'SUCCESS' ? 'SUCCESS' : 'INCOMPLETE',
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
    missingEvidence: evidence.missingEvidence ?? null,
    draft: evidence.draft ?? binding.draft ?? null,
    confirmStatus: evidence.confirmStatus ?? binding.confirmStatus ?? null,
    draftRowsBeforeConfirm: evidence.draftRowsBeforeConfirm ?? binding.draftRowsBeforeConfirm ?? null,
  });
  const written = await writeReceipt(binding, receipt);

  return {
    receipt,
    receiptPaths: written,
    stageErrors,
    outcome,
    terminalReached,
    deviation,
  };
}

export async function main(argv) {
  const scenario = parseScenario(argv);
  process.env.E2E_SCENARIO = scenario;
  const result = await runScenario(scenario);
  console.log(JSON.stringify({
    scenario,
    outcome: result.outcome,
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
    stages: result.stageErrors,
  }, null, 2));
  if (result.outcome !== 'SUCCESS') process.exitCode = 1;
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
