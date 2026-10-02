/**
 * Receipt builder + writer — real implementation.
 *
 * Owns graph node: attempt_receipt (the single sink in every per-command graph).
 *
 * The receipt is written AFTER cleanup, so the persisted evidence always carries
 * the cleanup and verification conclusion: serve PID exit, port closed, temp root
 * removed. A cleanup failure cannot be hidden behind a receipt that was already
 * written.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RESULT_SUCCESS = 'SUCCESS';
const RESULT_INCOMPLETE = 'INCOMPLETE';

export function buildReceipt(binding, evidence = {}) {
  const result = evidence.result === RESULT_SUCCESS ? RESULT_SUCCESS : RESULT_INCOMPLETE;
  return {
    schema: 'humanagent.dashboard-e2e.receipt.v1',
    result,
    scenario: binding.scenario,
    attemptId: binding.attemptId,
    startedAt: binding.startedAt,
    finishedAt: evidence.finishedAt ?? new Date().toISOString(),
    candidate: {
      repoPath: binding.repoPath,
      sha: binding.candidateSha,
      releaseVersion: binding.candidateVersion ?? null,
      treeDigest: binding.treeDigest ?? null,
    },
    runtime: {
      mode: 'rcc',
      protocol: 'responses',
      servePid: binding.servePid ?? null,
      servePort: binding.servePort ?? null,
      serveBaseUrl: binding.serveBaseUrl ?? null,
      controlRoot: binding.serveControlRoot ?? binding.controlRoot,
      workspace: binding.workspace,
      rccBaseUrl: process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444',
      model: process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5',
    },
    task: {
      taskId: binding.taskId ?? null,
      terminalState: evidence.terminalState ?? binding.terminalState ?? null,
      dashboardState: evidence.dashboardState ?? null,
    },
    evidence: {
      toolRounds: evidence.toolRounds ?? 0,
      requestStartTurns: evidence.requestStartTurns ?? 0,
      checkpointCommitted: evidence.checkpointCommitted ?? 0,
      journalPath: binding.journalPath ?? null,
      journalPaths: binding.journalPaths ?? [],
      evidenceRefs: evidence.evidenceRefs ?? [],
      terminalRecord: evidence.terminalRecord ?? null,
      scenarioEvidence: evidence.scenarioEvidence ?? null,
    },
    ui: {
      draft: evidence.draft ?? binding.draft ?? null,
      confirmStatus: evidence.confirmStatus ?? binding.confirmStatus ?? null,
      draftRowsBeforeConfirm: evidence.draftRowsBeforeConfirm ?? binding.draftRowsBeforeConfirm ?? null,
    },
    screenshots: evidence.screenshots ?? [],
    cleanup: evidence.cleanup ?? null,
    deviation: evidence.deviation ?? null,
    missingEvidence: evidence.missingEvidence ?? null,
  };
}

function renderReceiptMarkdown(receipt) {
  const lines = [];
  lines.push(`# Dashboard E2E receipt — ${receipt.scenario}`);
  lines.push('');
  lines.push(`- Result: **${receipt.result}**`);
  lines.push(`- Attempt: \`${receipt.attemptId}\``);
  lines.push(`- Scenario: \`${receipt.scenario}\``);
  lines.push(`- Started: ${receipt.startedAt}`);
  lines.push(`- Finished: ${receipt.finishedAt}`);
  lines.push('');
  lines.push('## Candidate');
  lines.push('');
  lines.push(`- Repo: \`${receipt.candidate.repoPath}\``);
  lines.push(`- SHA: \`${receipt.candidate.sha}\``);
  lines.push(`- Release version: \`${receipt.candidate.releaseVersion ?? 'n/a'}\``);
  lines.push(`- Tree digest: \`${receipt.candidate.treeDigest ?? 'n/a'}\``);
  lines.push('');
  lines.push('## Runtime');
  lines.push('');
  lines.push(`- Mode/protocol: \`${receipt.runtime.mode}/${receipt.runtime.protocol}\``);
  lines.push(`- RCC: \`${receipt.runtime.rccBaseUrl}\` (model \`${receipt.runtime.model}\`)`);
  lines.push(`- Serve: \`${receipt.runtime.serveBaseUrl ?? 'n/a'}\` (pid \`${receipt.runtime.servePid ?? 'n/a'}\`, port \`${receipt.runtime.servePort ?? 'n/a'}\`)`);
  lines.push(`- Control root: \`${receipt.runtime.controlRoot}\``);
  lines.push(`- Workspace: \`${receipt.runtime.workspace}\``);
  lines.push('');
  lines.push('## Task');
  lines.push('');
  lines.push(`- Task id: \`${receipt.task.taskId ?? 'n/a'}\``);
  lines.push(`- Runtime terminal state: \`${receipt.task.terminalState ?? 'n/a'}\``);
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push(`- Provider tool rounds (authoritative journal): ${receipt.evidence.toolRounds}`);
  lines.push(`- Provider request-start turns (authoritative journal): ${receipt.evidence.requestStartTurns}`);
  lines.push(`- Committed checkpoints: ${receipt.evidence.checkpointCommitted}`);
  lines.push(`- Journal: \`${receipt.evidence.journalPath ?? 'n/a'}\``);
  if (receipt.evidence.journalPaths.length > 1) {
    lines.push(`- Additional journal files: ${receipt.evidence.journalPaths.map((path) => `\`${path}\``).join(', ')}`);
  }
  lines.push(`- Evidence refs: ${receipt.evidence.evidenceRefs.length}`);
  if (receipt.evidence.terminalRecord) {
    lines.push(`- Terminal record: \`${JSON.stringify(receipt.evidence.terminalRecord).slice(0, 400)}\``);
  }
  lines.push('');
  if (receipt.scenarioEvidence) {
    lines.push('## Scenario evidence');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(receipt.scenarioEvidence, null, 2).slice(0, 6000));
    lines.push('```');
    lines.push('');
  }
  lines.push('## UI');
  lines.push('');
  lines.push(`- Confirm POST status: ${receipt.ui.confirmStatus ?? 'n/a'}`);
  lines.push(`- Draft rows before confirm: ${receipt.ui.draftRowsBeforeConfirm ?? 'n/a'}`);
  if (receipt.ui.draft) {
    lines.push(`- Draft intent: \`${receipt.ui.draft.intent || 'n/a'}\``);
    lines.push('');
    lines.push('```');
    lines.push(String(receipt.ui.draft.proposal ?? '').slice(0, 1200));
    lines.push('```');
  }
  lines.push('');
  if (receipt.screenshots.length) {
    lines.push('## Screenshots');
    lines.push('');
    for (const shot of receipt.screenshots) lines.push(`- ${shot}`);
    lines.push('');
  }
  lines.push('## Cleanup');
  lines.push('');
  if (receipt.cleanup) {
    for (const [key, value] of Object.entries(receipt.cleanup)) {
      lines.push(`- ${key}: \`${String(value)}\``);
    }
  } else {
    lines.push('- not recorded');
  }
  lines.push('');
  if (receipt.deviation || receipt.missingEvidence) {
    lines.push('## Deviation');
    lines.push('');
    if (receipt.deviation) {
      lines.push(`- First deviation: ${receipt.deviation.stage ?? 'n/a'}`);
      lines.push(`- Error: \`${String(receipt.deviation.error ?? '').slice(0, 2000)}\``);
    }
    if (receipt.missingEvidence) {
      lines.push('- Missing evidence:');
      for (const item of receipt.missingEvidence) lines.push(`  - ${item}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`Generated by tests/app/dashboard-e2e/runner.mjs against candidate \`${receipt.candidate.sha}\`.`);
  return `${lines.join('\n')}\n`;
}

export function writeReceipt(binding, receipt) {
  const receiptDir = binding.receiptDir;
  const markdownPath = join(receiptDir, 'receipt.md');
  const jsonPath = join(receiptDir, 'evidence.json');
  return Promise.all([
    mkdir(receiptDir, { recursive: true }).then(() => writeFile(markdownPath, renderReceiptMarkdown(receipt), 'utf8')),
    writeFile(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8'),
  ]).then(() => ({ markdownPath, jsonPath }));
}

export function writeIncompleteReceipt(binding, deviation, evidence = {}) {
  const receipt = buildReceipt(binding, {
    ...evidence,
    result: 'INCOMPLETE',
    deviation,
    finishedAt: evidence.finishedAt ?? new Date().toISOString(),
  });
  return writeReceipt(binding, receipt);
}
