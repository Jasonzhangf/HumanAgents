/**
 * Execution-retry visual proof — real entry.
 *
 * Drives the real `local-file-search` dashboard E2E through a deterministic,
 * attempt-aware HTTP proxy in front of the real RCC endpoint, so that the
 * merged bounded corrective-retry loop is exercised for real:
 *
 *   attempt 1 → provider transport failure (non-2xx, no tool side effect)
 *   attempt 2 → corrective re-dispatch through the real RCC 4444 → succeeded
 *
 * The proxy only ever fails the first execution turn (file_search/file_read);
 * the explicit-brain interpretation turn and the corrective attempt are
 * forwarded byte-for-byte, so intake and the successful attempt are genuinely
 * served by the real provider. The product retry loop is not modified: this
 * script only makes the provider-side failure deterministic.
 *
 * Deliverable (per board task execution-retry-visual-proof-20261101):
 *   - receipt result=SUCCESS, terminal succeeded, checkpoint committed
 *   - journal/SSE carry `execution.retry` / `retrying` with the attempt-1
 *     failure reason and the attempt-2 corrective summary
 *   - 1280x720 and 390x844 screenshots showing the `execution.retry` step in
 *     the task-dashboard execution trace
 *   - proxy record proving exactly one injection and real forwarding
 *
 * Usage:
 *   node tests/app/dashboard-e2e/retry-visual-proof.mjs
 *   HUMANAGENT_RCC_BASE_URL (unset → real http://127.0.0.1:4444) is the real
 *   upstream; the proxy is always started by this script.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pageBackDashboardHistory, readTaskDashboardDom } from './lib/browser.mjs';
import { countTurnEvidenceFor } from './lib/journal.mjs';
import { startRetryInjectionProxy } from './lib/retry-injection.mjs';
import { runScenario } from './runner.mjs';
import { runLocalFileSearchScenario } from './scenarios/local-file-search.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = join(__dirname, '..', '..', '..');
const UPSTREAM = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
// Isolated control root for this attempt. Persistent state stays outside the
// production `~/.humanagent` and outside the runner's ephemeral attempt root.
const ISOLATED_CONTROL_ROOT = join(tmpdir(), `humanagent-d17-retry-control-${Date.now()}`);

function fail(message) {
  console.error(JSON.stringify({ status: 'FAIL', error: message }, null, 2));
  process.exit(1);
}

function findRetryEvent(events) {
  return (events ?? []).find((event) => event.kind === 'execution.retry' && event.state === 'retrying') ?? null;
}

/**
 * Wrap the real scenario so the retry-specific assertions and the two
 * viewport-sized screenshots are part of the same attempt lifecycle, before the
 * runner stops and settles the serve.
 */
async function runRetryProofScenario(binding) {
  const evidence = await runLocalFileSearchScenario(binding);

  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const events = turnEvidence?.allEvents ?? [];
  const retryEvent = findRetryEvent(events);
  const terminalRecord = turnEvidence?.terminalRecords?.slice(-1)[0] ?? null;

  // The dashboard's execution-trace drawer must render the retry step. Page back
  // through history until the `execution.retry` row is present, then capture the
  // two required viewports with that row visible.
  let retryScreenshots = [];
  try {
    const rowSeen = (rows) => rows.some((row) => String(row.kind ?? '').startsWith('execution.retry'));
    await pageBackDashboardHistory(binding);
    const { page } = binding.browser;
    // The corrective retry step is emitted before the first real tool round, so
    // it lives on the oldest history page. Page back through the whole bounded
    // window until that row is visible or the pager reaches the first page.
    let retryRowVisible = false;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const dom = await readTaskDashboardDom(binding, { navigate: false });
      if (rowSeen(dom.eventRows ?? [])) {
        retryRowVisible = true;
        break;
      }
      const older = page.locator('.history-pager button', { hasText: '更早' }).first();
      if (await older.count() === 0 || await older.isDisabled()) break;
      await older.click();
      await page.waitForTimeout(120);
    }
    const retryRow = page.locator('li.event', { has: page.locator('.event-kind', { hasText: 'execution.retry' }) }).first();
    if (!retryRowVisible || await retryRow.count() === 0) {
      throw new Error('execution.retry row was not found in the dashboard execution trace');
    }
    for (const viewport of [
      { width: 1280, height: 720, name: 'retry-step-1280x720' },
      { width: 390, height: 844, name: 'retry-step-390x844' },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(150);
      // Re-center the row after every resize: the trace drawer rewraps, so a
      // bottom-aligned scroll would clip the retry summary on the wider view.
      await retryRow.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      const path = join(binding.screenshotsDir, `${viewport.name}.png`);
      await page.screenshot({ path });
      retryScreenshots.push(path);
    }
  } catch (error) {
    evidence.retryScreenshotError = error.message;
  }

  const missing = evidence.missingEvidence ?? [];
  if (!retryEvent) {
    missing.push('execution.retry/retrying step was not recorded in the authoritative journal');
  } else {
    if (!String(retryEvent.summary ?? '').includes('第 2 次尝试')) {
      missing.push(`execution.retry summary=${JSON.stringify(retryEvent.summary)} does not name attempt 2`);
    }
    if (!String(retryEvent.summary ?? '').includes('重试原因')) {
      missing.push(`execution.retry summary=${JSON.stringify(retryEvent.summary)} does not carry the retry reason`);
    }
  }
  if (terminalRecord?.state !== 'succeeded') {
    missing.push(`terminal record state=${JSON.stringify(terminalRecord?.state ?? null)} (expected succeeded)`);
  }
  if (retryScreenshots.length !== 2) {
    missing.push(`retry-step screenshots captured=${retryScreenshots.length} (expected 2: 1280x720 and 390x844)`);
  }

  const retryProof = {
    upstream: UPSTREAM,
    retryEvent,
    terminalRecord,
    retryScreenshots,
    journalEventCount: events.length,
  };
  evidence.retryProof = retryProof;
  evidence.scenarioEvidence = {
    ...(evidence.scenarioEvidence ?? {}),
    retryProof,
  };
  evidence.screenshots = [...(evidence.screenshots ?? []), ...retryScreenshots];
  if (missing.length) evidence.missingEvidence = missing;
  return evidence;
}

async function main() {
  const proxy = await startRetryInjectionProxy({ upstream: UPSTREAM });
  // Point the whole attempt at the proxy: the runner probes `/health` and spawns
  // the serve with `--rcc-base-url`, and both read this env var. The proxy
  // forwards `/health` and every non-execution request to the real upstream.
  const previousBaseUrl = process.env.HUMANAGENT_RCC_BASE_URL;
  process.env.HUMANAGENT_RCC_BASE_URL = proxy.baseUrl;
  const result = await runScenario('local-file-search', {
    repoPath: process.env.E2E_REPO_PATH ?? DEFAULT_REPO_PATH,
    serviceMode: 'candidate',
    entry: 'homepage',
    outcome: 'success',
    controlRoot: ISOLATED_CONTROL_ROOT,
    hooks: {
      runScenario: runRetryProofScenario,
    },
  });
  if (previousBaseUrl === undefined) delete process.env.HUMANAGENT_RCC_BASE_URL;
  else process.env.HUMANAGENT_RCC_BASE_URL = previousBaseUrl;

  const retryProof = result.receipt?.scenarioEvidence?.retryProof ?? null;
  const injected = proxy.record.injectedCount;
  const forwarded = proxy.record.forwardedCount;

  // Persist the proxy record beside the attempt receipts for reviewer access.
  const receiptDir = join(result.receiptPaths.markdownPath, '..');
  try {
    await mkdir(receiptDir, { recursive: true });
    await writeFile(join(receiptDir, 'retry-injection-record.json'), JSON.stringify({
      upstream: UPSTREAM,
      injectedCount: injected,
      injectedPaths: proxy.record.injectedPaths,
      forwardedCount: forwarded,
      forwardedPaths: proxy.record.forwardedPaths,
      errors: proxy.record.errors,
    }, null, 2), 'utf8');
  } catch (error) {
    console.error(JSON.stringify({ warning: 'could not persist proxy record', error: error.message }));
  }

  const summary = {
    outcome: result.outcome,
    settled: result.settled,
    requestedOutcomeReached: result.requestedOutcomeReached,
    terminalState: result.receipt.task.terminalState,
    checkpointCommitted: result.receipt.evidence.checkpointCommitted,
    retryEvent: retryProof?.retryEvent ?? null,
    retryScreenshots: retryProof?.retryScreenshots ?? [],
    injectedCount: injected,
    forwardedCount: forwarded,
    proxyErrors: proxy.record.errors,
    receiptMarkdown: result.receiptPaths.markdownPath,
    receiptJson: result.receiptPaths.jsonPath,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (result.outcome !== 'SUCCESS' || injected !== 1) {
    console.error(JSON.stringify({
      status: 'FAIL',
      reason: result.outcome !== 'SUCCESS' ? 'receipt was not SUCCESS' : `expected exactly 1 injected request, got ${injected}`,
    }, null, 2));
    await proxy.close();
    process.exit(1);
  }
  await proxy.close();
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message, stack: String(error.stack ?? error) }, null, 2));
  process.exit(1);
});
