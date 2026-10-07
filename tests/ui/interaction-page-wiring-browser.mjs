#!/usr/bin/env node

/**
 * Real-browser proof that the three served pages actually mount the shared
 * interaction work card and that page wiring follows F01/F02/F09 semantics:
 *
 * - F01: progress turns are driven by real interaction events; the timer only
 *   shows elapsed wait time and never advances the phase.
 * - F02: conversation/summary/statusbar keep human-readable copy, while
 *   technical identifiers remain in the folded detail region.
 * - F09: card re-render restores focus to the stable trigger node identity
 *   (`data-focus-key`) instead of dropping focus to body.
 *
 * Set INTERACTION_PAGE_EVIDENCE to the execution-owned evidence root and
 * INTERACTION_PAGE_UI_ROOT (optional) to a directory whose layout mirrors
 * `dist/app/ui` (used for red-base reproduction).
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.INTERACTION_PAGE_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.INTERACTION_PAGE_EVIDENCE;

if (!evidenceRoot?.trim()) {
  throw new Error('INTERACTION_PAGE_EVIDENCE is required; point it at an execution-owned directory');
}

const playwrightModule = await import(
  process.env.INTERACTION_CARD_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js',
);
const playwright = playwrightModule.default ?? playwrightModule;

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

async function startServer() {
  const server = createServer(async (request, response) => {
    request.socket.setKeepAlive(false);
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relative || relative.split('/').includes('..')) {
        response.writeHead(400);
        response.end('bad path');
        return;
      }
      const filePath = resolve(uiRoot, relative);
      if (!filePath.startsWith(`${uiRoot}${sep}`)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': mimeType(filePath), 'content-length': body.byteLength });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('static server did not expose a TCP port');
  server.unref();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function waitForCard(page, entry, timeoutMs = 20000) {
  try {
    await page.waitForFunction((targetEntry) => {
      const host = document.querySelector(`[data-interaction-work-card-host][data-entry="${targetEntry}"]`);
      return Boolean(host?.querySelector('.iwc-card'));
    }, entry, { timeout: timeoutMs });
    return true;
  } catch {
    // A red base never mounts the card; record it instead of aborting the run.
    return false;
  }
}

async function readCard(page) {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-interaction-work-card-host]')]
      .find((node) => node.querySelector('.iwc-card'))
      ?? document.querySelector('[data-interaction-work-card-host]');
    const card = host?.querySelector('.iwc-card');
    return {
      mountPointSurvived: Boolean(host),
      cardMounted: Boolean(card),
      statusBarRendered: Boolean(card?.querySelector('.iwc-status')),
      conversationRendered: Boolean(card?.querySelector('.iwc-panel--conversation')),
      traceRendered: Boolean(card?.querySelector('.iwc-panel--trace')),
      conversationText: card?.querySelector('.iwc-panel--conversation')?.innerText ?? '',
      summaryText: card?.querySelector('.iwc-summary')?.innerText ?? '',
      statusbarText: card?.querySelector('.iwc-status')?.innerText ?? '',
      detailText: [...card?.querySelectorAll('details') ?? []].map((node) => node.innerText ?? '').join('\n'),
      markdownElements: {
        headings: card?.querySelectorAll('.iwc-md-heading').length ?? 0,
        strong: card?.querySelectorAll('.iwc-md-paragraph strong').length ?? 0,
        code: card?.querySelectorAll('.iwc-md-code').length ?? 0,
        lists: card?.querySelectorAll('.iwc-md-list').length ?? 0,
      },
      progressTurns: card?.querySelectorAll('.iwc-conversation-turn .iwc-kind-chip')?.length ?? 0,
    };
  });
}

const TECHNICAL_TOKENS = [
  'requestId',
  'turnId',
  'callId',
  'digest',
  'evidence',
  'evidenceRefs',
  'operationId',
  'taskId',
  'executionEpoch',
];

// The folded detail region surfaces technical identity either as typed fact
// labels (`taskId`, `requestId`, ...) or as the compact source-ref line
// (`task=`, `operation=`, `request=`, `turn=`, `epoch=`). Either form proves
// the identifiers stayed in the detail region rather than leaking upstream.
const DETAIL_TOKENS = [
  ...TECHNICAL_TOKENS,
  'task=',
  'operation=',
  'request=',
  'turn=',
  'epoch=',
];

function leaks(text) {
  return TECHNICAL_TOKENS.filter((token) => text.includes(token)).map((token) => ({ token }));
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const checks = [];
const observations = [];
let failures = 0;

function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail });
  if (!pass) failures += 1;
}

function observe(name, value) {
  observations.push({ name, value });
}

const artifactDir = join(evidenceRoot, 'artifacts');
await mkdir(artifactDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
let server;
try {
  server = await startServer();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));

  for (const target of [
    { file: 'dashboard.html', entry: 'dashboard' },
    { file: 'task.html', query: '?task=new', entry: 'task' },
    { file: 'index.html', entry: 'entry' },
  ]) {
    pageErrors.length = 0;
    await page.goto(`${server.url}/${target.file}${target.query ?? ''}`, { waitUntil: 'domcontentloaded' });
    await waitForCard(page, target.entry);
    await page.waitForTimeout(250);
    const card = await readCard(page);
    const humanLeaks = [
      ...leaks(card.conversationText).map((item) => ({ surface: 'conversation', ...item })),
      ...leaks(card.summaryText).map((item) => ({ surface: 'summary', ...item })),
      ...leaks(card.statusbarText).map((item) => ({ surface: 'statusbar', ...item })),
    ];
    observe(`${target.file} card`, card);
    observe(`${target.file} page errors`, [...pageErrors]);
    record(`${target.file} mount point survives real page init`, card.mountPointSurvived, card);
    record(`${target.file} shared work card is mounted`, card.cardMounted, card);
    record(`${target.file} renders statusbar/conversation/trace`, card.statusBarRendered && card.conversationRendered && card.traceRendered, card);
    record(`${target.file} keeps F02 human surfaces free of technical identifiers`, humanLeaks.length === 0, humanLeaks);
    // F02 also requires the identifiers to stay visible in the folded detail
    // region instead of being dropped from the card altogether.
    const detailEvidence = await page.evaluate(() => {
      const cardNode = [...document.querySelectorAll('[data-interaction-work-card-host]')]
        .map((node) => node.querySelector('.iwc-card'))
        .find(Boolean);
      const detailNodes = [...(cardNode?.querySelectorAll('details') ?? [])];
      detailNodes.forEach((node) => { node.open = true; });
      const detailText = detailNodes
        // The trace panel can be hidden behind the conversation tab, so read
        // textContent to prove the identifiers are present in the DOM details.
        .map((node) => node.querySelector('.iwc-trace-detail-body, .iwc-error-details')?.textContent ?? node.textContent ?? '')
        .filter((text) => text.trim())
        .join('\n');
      return { detailNodes: detailNodes.length, detailText };
    });
    const detailTokens = DETAIL_TOKENS.filter((token) => detailEvidence.detailText.includes(token));
    record(`${target.file} keeps technical identifiers in the detail region`,
      detailEvidence.detailNodes > 0 && detailTokens.length > 0,
      { detailNodes: detailEvidence.detailNodes, detailTokens, detailText: detailEvidence.detailText.slice(0, 600) });
    await page.screenshot({ path: join(artifactDir, `${target.file.replace('.html', '')}.png`), fullPage: true });
    if (pageErrors.length) {
      await writeFile(join(evidenceRoot, `${target.file.replace('.html', '')}.errors.txt`), pageErrors.join('\n'), 'utf8');
    }
  }

  // GAP B proof: the bounded original cause the runtime reports must reach the
  // human, not just a status code. The runtime stub answers the real
  // explicit-interaction read with a 500 body shaped exactly like the one
  // `writeError` produces (`boundedErrorCause`), and the page must show that
  // chain in its diagnostics.
  const causePage = await context.newPage();
  const causeErrors = [];
  causePage.on('pageerror', (error) => causeErrors.push(`pageerror: ${error.message}`));
  await causePage.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const fulfill = (payload, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
    if (url.pathname === '/api/runtime/status') {
      return fulfill({ state: 'ready', mode: 'fake', providerState: 'ready', connected: true });
    }
    if (url.pathname === '/api/tasks/task-cause-proof') {
      return fulfill({ taskId: 'task-cause-proof', title: 'cause proof', state: 'running', priorInput: '读取 README' });
    }
    if (url.pathname === '/api/explicit/interactions/interaction-cause-proof') {
      return fulfill({
        error: {
          code: 'ui-runtime.unexpected',
          ownerId: 'humanagent.app',
          message: 'implicit executor failed and settlement also failed: settle timed out',
          nextAction: 'inspect the runtime error and retry from a new operation',
          cause: {
            name: 'Error',
            message: 'executor could not reach its provider',
            cause: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:4444' },
          },
        },
      }, 500);
    }
    return fulfill({ error: { code: 'not-found', message: `unexpected route ${url.pathname}`, ownerId: 'test', nextAction: 'none' } }, 404);
  });
  await causePage.goto(
    `${server.url}/task.html?task=task-cause-proof&interaction=interaction-cause-proof`,
    { waitUntil: 'domcontentloaded' },
  );
  const causeDiagnostics = await causePage.waitForFunction(() => {
    const pre = [...document.querySelectorAll('details pre')]
      .find((node) => (node.textContent ?? '').includes('cause:'));
    if (!pre) return null;
    const status = document.querySelector('[role="status"]')?.textContent ?? '';
    return { diagnostics: pre.textContent, status };
  }, undefined, { timeout: 20000 }).then((handle) => handle.jsonValue()).catch(() => null);
  observe('task.html original cause diagnostics', causeDiagnostics);
  record('the human sees the original executor failure, not only a status code',
    Boolean(causeDiagnostics?.diagnostics)
      && causeDiagnostics.diagnostics.includes('executor could not reach its provider')
      && causeDiagnostics.diagnostics.includes('connect ECONNREFUSED 127.0.0.1:4444')
      && causeDiagnostics.diagnostics.includes('inspect the runtime error'),
    causeDiagnostics);
  // The typed surface the page already showed must not regress either: the
  // status line still names the settlement failure and the next action.
  record('the original-cause path keeps the typed runtime message',
    Boolean(causeDiagnostics?.status?.includes('settlement also failed')),
    causeDiagnostics);
  record('the original-cause path raises no page error', causeErrors.length === 0, [...causeErrors]);
  await causePage.screenshot({ path: join(artifactDir, 'task-original-cause.png'), fullPage: true });
  await causePage.close();

  // F01/F09 proof on the real dashboard entry with a controlled runtime stub.
  const eventPage = await context.newPage();
  const eventErrors = [];
  eventPage.on('pageerror', (error) => eventErrors.push(`pageerror: ${error.message}`));
  let releaseInterpret;
  const interpretGate = new Promise((resolvePromise) => {
    releaseInterpret = resolvePromise;
  });

  await eventPage.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = (payload, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
    if (path === '/api/runtime/status') {
      return body({ state: 'ready', mode: 'fake', providerState: 'ready', connected: true });
    }
    if (path === '/api/dashboard') {
      return body({ hasRunning: false, taskCount: 0, waitingDecisionCount: 0, recentFailures: [] });
    }
    if (path === '/api/tasks') {
      return body({ draft: [], waiting: [], running: [], completed: [], stopped: [] });
    }
    if (path === '/api/explicit/inputs' && request.method() === 'POST') {
      return body({ interactionId: 'interaction-progress-proof' });
    }
    if (path === '/api/explicit/interactions/interaction-progress-proof' && request.method() === 'GET') {
      return body({ state: 'received', rawInput: '读取 README', nextAction: 'interpret' });
    }
    if (path === '/api/explicit/interactions/interaction-progress-proof/interpret' && request.method() === 'POST') {
      await interpretGate;
      return body({
        state: 'awaiting-confirmation',
        rawInput: '读取 README',
        nextAction: 'confirm',
        draft: {
          draftId: 'draft-progress-proof',
          inputRevision: 1,
          proposedIntent: 'create',
          normalizedInput: '读取 README',
          proposal: '读取 README',
          matchedTasks: [],
        },
      });
    }
    return body({ error: { code: 'not-found', message: `unexpected route ${request.method()} ${path}`, ownerId: 'test', nextAction: 'none' } }, 404);
  });

  await eventPage.goto(`${server.url}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await eventPage.waitForSelector('.quick-create-form textarea[name="directive"]');
  await eventPage.fill('.quick-create-form textarea[name="directive"]', '读取 README');
  await eventPage.click('form button[type="submit"]');

  const phaseText = () => eventPage.evaluate(() =>
    document.querySelector('.quick-create-progress .progress-phase')?.textContent ?? '');
  const waitForPhase = (includes) => eventPage.waitForFunction(
    (needle) => (document.querySelector('.quick-create-progress .progress-phase')?.textContent ?? '').includes(needle),
    includes,
    { timeout: 20000 },
  ).then(() => true).catch(() => false);

  // The receive+inspect round trips resolve from real stub events and advance
  // the phase to the step that issues the held interpret request. Wait for
  // that real-event-driven step, then prove the phase stays fixed while the
  // next request is held open and only the elapsed-time timer moves.
  const heldPhaseReached = await waitForPhase('显式大脑正在匹配任务');
  record('dashboard F01 phase reaches the held request from real events', heldPhaseReached, { heldPhaseReached });
  const earlyProgress = await eventPage.evaluate(() => ({
    phase: document.querySelector('.quick-create-progress .progress-phase')?.textContent ?? '',
    timer: document.querySelector('.quick-create-progress .progress-timer')?.textContent ?? '',
  }));
  await sleep(900);
  const lateProgress = await eventPage.evaluate(() => ({
    phase: document.querySelector('.quick-create-progress .progress-phase')?.textContent ?? '',
    timer: document.querySelector('.quick-create-progress .progress-timer')?.textContent ?? '',
  }));
  const earlyCard = await readCard(eventPage);
  observe('dashboard F01 held-response progress', { early: earlyProgress, late: lateProgress, card: earlyCard });
  record('dashboard F01 phase does not advance on a timer while waiting on a real event',
    earlyProgress.phase === lateProgress.phase,
    { early: earlyProgress, late: lateProgress });
  record('dashboard F01 timer only reflects elapsed wait time',
    lateProgress.timer !== earlyProgress.timer,
    { early: earlyProgress, late: lateProgress });

  // Focus a stable card trigger node, then release the event so the card
  // re-renders from the real response. Focus must return to that node.
  await eventPage.evaluate(() => {
    const tab = document.querySelector('[data-focus-key="tab:trace"]');
    if (tab) tab.focus();
  });
  const beforeFocus = await eventPage.evaluate(() => ({
    key: document.activeElement?.dataset?.focusKey ?? null,
  }));
  releaseInterpret();
  await waitForPhase('等待你确认任务草案');
  const afterFocus = await eventPage.evaluate(() => ({
    key: document.activeElement?.dataset?.focusKey ?? null,
  }));
  const eventCard = await readCard(eventPage);
  const latestPhase = await phaseText();
  observe('dashboard F01 post-event card', eventCard);
  observe('dashboard F09 focus before/after event', { before: beforeFocus, after: afterFocus });
  record('dashboard F01 typed progress turn follows the real event',
    latestPhase.includes('等待你确认任务草案') && eventCard.cardMounted,
    { latestPhase, card: eventCard });
  record('dashboard F09 focus returns to the stable trigger node after re-render',
    beforeFocus.key === afterFocus.key && afterFocus.key === 'tab:trace',
    { before: beforeFocus, after: afterFocus });

  await eventPage.screenshot({ path: join(artifactDir, 'dashboard-event-driven.png'), fullPage: true });
  if (eventErrors.length) {
    await writeFile(join(evidenceRoot, 'dashboard-event-driven.errors.txt'), eventErrors.join('\n'), 'utf8');
  }
  await context.close();

  await writeFile(join(evidenceRoot, 'checks.json'), JSON.stringify({ checks, observations }, null, 2), 'utf8');
  if (checks.length === 0) throw new Error('page wiring browser proof recorded no checks');
  if (failures > 0) {
    throw new Error(`${failures}/${checks.length} page wiring browser checks failed:\n${checks.filter((check) => !check.pass).map((check) => `  - ${check.name}: ${JSON.stringify(check.detail)}`).join('\n')}`);
  }
  console.log(`interaction page wiring browser proof: ${checks.length} checks passed`);
} finally {
  await browser.close().catch(() => {});
  await closeServer(server).catch(() => {});
}
