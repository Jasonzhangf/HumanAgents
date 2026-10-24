#!/usr/bin/env node
/**
 * Real-browser proof that the dashboard page is usable again.
 *
 * What is real here:
 *   - the serve process that owns the canonical project runtime, its HTTP
 *     routes and its board read;
 *   - a real headless Chromium page load of `dashboard.html` from that serve;
 *   - wall time: the poll interval and the artificial board delay are real
 *     durations, not shortened.
 * What is injected, and only this:
 *   - the board response delay. A real 50MB-journal read cannot be made slow on
 *     demand without touching production journals, so the slow case delays the
 *     HTTP response. The page, its fetch, its poll timer and its in-flight
 *     guard are untouched.
 *   - the unguarded page variant (last scenario): the served `dashboard.js` is
 *     re-served with the single-flight guard bypassed, to prove this harness
 *     can catch stacked polling at all.
 *
 * Scenarios:
 *   page                  five boards, visible task rows, a refresh after the
 *                         poll interval, and a serve that answers
 *                         `/api/runtime/status` with 200 throughout.
 *   slow-poll             the board read is slowed past the poll interval; the
 *                         page must keep at most one board read in flight.
 *   slow-poll-unguarded   negative control: the unguarded page must stack reads,
 *                         otherwise `slow-poll` proves nothing.
 *
 * Env:
 *   DASHBOARD_E2E_EVIDENCE    required: evidence directory for receipt + shots
 *   DASHBOARD_E2E_BASE_URL    default http://127.0.0.1:10086
 *   DASHBOARD_E2E_PLAYWRIGHT  default /opt/homebrew/lib/node_modules/playwright/index.js
 *   DASHBOARD_E2E_SCENARIOS   default "page,slow-poll,slow-poll-unguarded"
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidenceRoot = process.env.DASHBOARD_E2E_EVIDENCE?.trim();
if (!evidenceRoot) throw new Error('DASHBOARD_E2E_EVIDENCE is required; point it at an execution-owned directory');
const baseUrl = (process.env.DASHBOARD_E2E_BASE_URL ?? 'http://127.0.0.1:10086').replace(/\/$/, '');
const scenarios = (process.env.DASHBOARD_E2E_SCENARIOS ?? 'page,slow-poll,slow-poll-unguarded')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const pollIntervalMs = 4000;
const slowBoardDelayMs = 6000;
const slowObservationMs = 13000;
const expectedBoards = ['interaction', 'orchestration', 'inspection', 'execution', 'memory'];

const playwrightModule = await import(
  process.env.DASHBOARD_E2E_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js',
);
const playwright = playwrightModule.default ?? playwrightModule;

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function sleep(ms) {
  return new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });
}

function assertThat(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? '' : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function record(result, message, details) {
  result.assertions.push({ ok: true, message, ...(details === undefined ? {} : { details }) });
  process.stdout.write(`  ok ${message}${details === undefined ? '' : ` ${JSON.stringify(details)}`}\n`);
}

/**
 * Watches every request the page makes to the board endpoint and to the runtime
 * status endpoint. In-flight counts are what the page actually experiences: a
 * request counts until its promise settles in the page.
 */
function watchRequests(page) {
  const boards = { started: 0, finished: 0, inFlight: 0, maxInFlight: 0, concurrencyAtStart: [] };
  const statuses = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/product/board')) {
      boards.started += 1;
      boards.inFlight += 1;
      boards.concurrencyAtStart.push(boards.inFlight);
      if (boards.inFlight > boards.maxInFlight) boards.maxInFlight = boards.inFlight;
    }
  });
  page.on('requestfinished', (request) => {
    if (request.url().includes('/api/product/board')) {
      boards.finished += 1;
      boards.inFlight -= 1;
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/product/board')) {
      boards.finished += 1;
      boards.inFlight -= 1;
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/runtime/status')) statuses.push(response.status());
  });
  return { boards, statuses };
}

/** Serve `dashboard.js` with the page-level in-flight guard removed. */
function unguardedDashboardScript(source) {
  const guarded = 'const refreshPageOnce = createSingleFlightRefresh(refreshPage)';
  assertThat(source.includes(guarded), 'the served dashboard.js still declares the single-flight refresh');
  return source.replace(guarded, 'const refreshPageOnce = refreshPage');
}

async function readServedDashboardScript() {
  const response = await fetch(`${baseUrl}/dashboard.js`);
  assertThat(response.ok, 'the serve must deliver dashboard.js', { status: response.status });
  return response.text();
}

function boardRequestCounter(page) {
  let count = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/product/board')) count += 1;
  });
  return () => count;
}

async function openDashboard(context, page) {
  const boardPath = `${baseUrl}/api/product/board?projectKey=-Users-fanzhang-.humanagent-workspace&mode=rcc`;
  const board = await fetch(boardPath);
  assertThat(board.ok, 'the board endpoint must answer the page scope', { status: board.status });
  const payload = await board.json();
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-product-board="interaction"]', { timeout: 30000 });
  return payload;
}

async function scenarioPage(browser, result, evidence) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const watch = watchRequests(page);
  const statusPolling = [];
  let statusRunning = true;
  const statusLoop = (async () => {
    while (statusRunning) {
      const response = await fetch(`${baseUrl}/api/runtime/status`).catch(() => null);
      statusPolling.push({ status: response?.status ?? 0, at: new Date().toISOString() });
      await sleep(500);
    }
  })();

  try {
    const payload = await openDashboard(context, page);

    const boards = await page.$$eval('[data-product-board]', (nodes) =>
      nodes.map((node) => node.getAttribute('data-product-board')));
    assertThat(boards.length === 5, 'the page must render the five work boards', { boards });
    assertThat(
      expectedBoards.every((board) => boards.includes(board)),
      'every expected board key must be present',
      { boards },
    );

    const missing = await page.$$eval('[data-product-board-missing="true"]', (nodes) => nodes.length);
    assertThat(missing === 0, 'no board may be rendered as explicitly missing', { missing });

    const rendered = await page.$$eval('.product-board-section', (nodes) =>
      nodes.map((node) => ({
        board: node.getAttribute('data-product-board'),
        live: node.querySelectorAll('[data-product-lane="live"] .product-board-item').length,
        history: node.querySelectorAll('[data-product-lane="history"] .product-board-item').length,
        unknown: node.querySelectorAll('[data-product-lane="unknown"] .product-board-item').length,
      })));
    const expected = (payload.boards ?? []).map((section) => ({
      board: section.board,
      live: (section.live ?? []).length,
      history: (section.history ?? []).length,
      unknown: (section.unknown ?? []).length,
    }));
    assertThat(
      JSON.stringify(rendered) === JSON.stringify(expected),
      'the rendered rows must match the board read row for row',
      { rendered, expected },
    );
    const rows = rendered.reduce((sum, board) => sum + board.live + board.history + board.unknown, 0);
    assertThat(rows > 0, 'the board must show real task rows, not an empty board', { rows });
    record(result, 'five boards render the real board read row for row', { rows, rendered });

    const before = boardRequestCounter(page);
    const firstScreenshot = join(evidence, 'dashboard-page.png');
    await page.screenshot({ path: firstScreenshot, fullPage: false });
    record(result, 'dashboard page screenshot', { path: firstScreenshot });

    // The page polls every 4s. Still refreshing means a second board read goes
    // out after the first one settled, without a page reload.
    const deadline = Date.now() + 15000;
    while (before() < 1 && Date.now() < deadline) await sleep(200);
    while (before() < 2 && Date.now() < deadline) await sleep(200);
    assertThat(before() >= 2, 'the page must refresh the board after the poll interval', {
      boardRequests: before(),
      pollIntervalMs,
    });
    const rowsAfterRefresh = await page.$$eval('.product-board-item', (nodes) => nodes.length);
    assertThat(rowsAfterRefresh === rows, 'a refresh must keep the same rows visible', { rows, rowsAfterRefresh });
    record(result, 'the page keeps refreshing without a reload', { boardRequests: before(), rows: rowsAfterRefresh });

    assertThat(watch.boards.maxInFlight <= 1, 'the interactive page must not stack board reads', {
      maxInFlight: watch.boards.maxInFlight,
    });
    record(result, 'fast board reads stay single-flight', { maxInFlight: watch.boards.maxInFlight });
  } finally {
    statusRunning = false;
    await statusLoop;
    await context.close();
  }

  const bad = statusPolling.filter((entry) => entry.status !== 200);
  assertThat(bad.length === 0, '/api/runtime/status must answer 200 throughout the page session', {
    samples: statusPolling.length,
    bad,
  });
  record(result, '/api/runtime/status stayed 200 while the page was open', { samples: statusPolling.length });
}

async function scenarioSlowPoll(browser, result, evidence, { unguarded }) {
  const context = await browser.newContext();
  if (unguarded) {
    const script = unguardedDashboardScript(await readServedDashboardScript());
    await context.route('**/dashboard.js', (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: script,
    }));
  }
  const page = await context.newPage();
  const watch = watchRequests(page);
  const statusPolling = [];
  let statusRunning = true;
  const statusLoop = (async () => {
    while (statusRunning) {
      const response = await fetch(`${baseUrl}/api/runtime/status`).catch(() => null);
      statusPolling.push({ status: response?.status ?? 0, at: new Date().toISOString() });
      await sleep(500);
    }
  })();

  try {
    // Let the page load and run one fast poll first. The dedicated guard only
    // matters once the 4s interval is armed and a read then outlasts it.
    await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-product-board="interaction"]', { timeout: 30000 });
    const loaded = Date.now();
    while (watch.boards.started < 2 && Date.now() - loaded < 20000) await sleep(100);
    assertThat(
      watch.boards.started >= 2,
      'the page must poll at least once before the slow window starts',
      { started: watch.boards.started },
    );
    const baseline = { started: watch.boards.started, finished: watch.boards.finished };
    while (watch.boards.inFlight > 0 && Date.now() - loaded < 25000) await sleep(100);

    await context.route('**/api/product/board**', async (route) => {
      await sleep(slowBoardDelayMs);
      await route.continue();
    });
    watch.boards.started = 0;
    watch.boards.finished = 0;
    watch.boards.maxInFlight = 0;
    watch.boards.concurrencyAtStart = [];

    await sleep(slowObservationMs);
    const boards = watch.boards;
    assertThat(
      boards.started >= 2,
      'the page must keep polling while one slow board read is in flight',
      { started: boards.started, slowBoardDelayMs, pollIntervalMs, baseline },
    );
    if (unguarded) {
      assertThat(
        boards.maxInFlight >= 2,
        'negative control: the unguarded page must stack board reads, otherwise the guard is unproven',
        { maxInFlight: boards.maxInFlight, concurrencyAtStart: boards.concurrencyAtStart },
      );
      record(result, 'negative control stacks reads without the guard', {
        maxInFlight: boards.maxInFlight,
        started: boards.started,
        concurrencyAtStart: boards.concurrencyAtStart,
      });
    } else {
      assertThat(
        boards.maxInFlight === 1,
        'a slow board read must never be followed by a second concurrent read',
        { maxInFlight: boards.maxInFlight, concurrencyAtStart: boards.concurrencyAtStart },
      );
      record(result, 'slow board reads keep exactly one request in flight', {
        maxInFlight: boards.maxInFlight,
        started: boards.started,
        concurrencyAtStart: boards.concurrencyAtStart,
      });
    }
    const screenshot = join(evidence, unguarded ? 'dashboard-slow-unguarded.png' : 'dashboard-slow.png');
    await page.screenshot({ path: screenshot, fullPage: false });
    record(result, 'slow board screenshot', { path: screenshot });
  } finally {
    statusRunning = false;
    await statusLoop;
    await context.close();
  }

  const bad = statusPolling.filter((entry) => entry.status !== 200);
  assertThat(bad.length === 0, '/api/runtime/status must answer 200 while slow reads are in flight', {
    samples: statusPolling.length,
    bad,
  });
  record(result, '/api/runtime/status stayed 200 through the slow-read window', { samples: statusPolling.length });
}

const receipt = {
  harness: 'tests/ui/dashboard-board-latency-browser.mjs',
  baseUrl,
  candidate: {
    sha: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
  },
  pollIntervalMs,
  slowBoardDelayMs,
  slowObservationMs,
  scenarios: [],
};

await mkdir(evidenceRoot, { recursive: true });
let failed = 0;
for (const scenario of scenarios) {
  process.stdout.write(`▶ ${scenario}\n`);
  const result = { scenario, assertions: [] };
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    if (scenario === 'page') await scenarioPage(browser, result, evidenceRoot);
    else if (scenario === 'slow-poll') await scenarioSlowPoll(browser, result, evidenceRoot, { unguarded: false });
    else if (scenario === 'slow-poll-unguarded') {
      await scenarioSlowPoll(browser, result, evidenceRoot, { unguarded: true });
    } else throw new Error(`unknown scenario ${scenario}`);
    result.status = 'PASS';
    process.stdout.write(`  PASS ${result.assertions.length} assertions\n`);
  } catch (error) {
    failed += 1;
    result.status = 'FAIL';
    result.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    process.stdout.write(`  FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await browser?.close().catch(() => {});
    receipt.scenarios.push(result);
  }
}

const receiptPath = join(evidenceRoot, 'dashboard-board-latency-receipt.json');
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`receipt: ${receiptPath}\n`);
process.exit(failed === 0 ? 0 : 1);
