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
 * Default mode is the full page proof above. `--task-identity-only` runs only
 * the controlled Task identity fixture below (real Task dashboard read model,
 * no fabricated Operation, queued label, no page error) plus the shared
 * evidence/assertion/cleanup path, so the accepted public consumer can be
 * selected without the obsolete full-page fixtures.
 * `--raw-focus-title-only` selects the bounded raw-reference/title fixture at
 * desktop and mobile sizes. It uses controlled API projections, no live Task.
 * `--project-breadcrumb-only` selects one controlled project task-list read
 * that proves the last breadcrumb names the current scope in human terms: it
 * starts as 当前项目, becomes the published DTO label, keeps the full
 * projectKey in 工作范围, and never issues a business write.
 * `--i2-scoped-only` selects the controlled System -> Project -> Task I2
 * history path at desktop and mobile sizes. It proves scope propagation,
 * foreign-scope rejection, exact comparison-pair rejection and drawer focus
 * recovery without running any other fixture.
 * `--plan-history-only` selects one controlled Task Dashboard read whose
 * `taskPlanHistory` is available ([v1,v2,v3] with accepted current v2). It
 * proves the real page shows only v2 as current and, after switching to
 * semantic, keeps returned order [v1,v2,v3] with the reason, predecessor and
 * typed change visible, without issuing any business write.
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

const taskIdentityOnly = process.argv.includes('--task-identity-only');
const checkpointAssetsOnly = process.argv.includes('--checkpoint-assets-only');
const rawFocusTitleOnly = process.argv.includes('--raw-focus-title-only');
const projectBreadcrumbOnly = process.argv.includes('--project-breadcrumb-only');
const i2ScopedOnly = process.argv.includes('--i2-scoped-only');
const planHistoryOnly = process.argv.includes('--plan-history-only');

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

  for (const target of (taskIdentityOnly || checkpointAssetsOnly || rawFocusTitleOnly || projectBreadcrumbOnly || i2ScopedOnly || planHistoryOnly ? [] : [
    { file: 'dashboard.html', entry: 'dashboard' },
    { file: 'task.html', query: '?task=new', entry: 'task' },
    { file: 'index.html', entry: 'entry' },
  ])) {
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

  // --- task.js forwards the real dashboard identity, never a fabricated one ---
  // The Task page is the product caller that turns the runtime dashboard read
  // into the shared card. This proves the real dashboard TaskId reaches the
  // card's technical source reference with no invented Operation, so an admitted
  // Task is not mislabelled as a running execution and no `pending-input` scope
  // is minted.
  if (!checkpointAssetsOnly && !rawFocusTitleOnly && !projectBreadcrumbOnly && !i2ScopedOnly && !planHistoryOnly) {
  const TASK_WIRING_ID = 'task-wiring-proof';
  const taskPage = await context.newPage();
  const taskPageErrors = [];
  taskPage.on('pageerror', (error) => taskPageErrors.push(`pageerror: ${error.message}`));
  await taskPage.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = (payload, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
    if (path === '/api/runtime/status') {
      return body({ state: 'ready', mode: 'fake', providerState: 'ready', connected: true });
    }
    if (path === `/api/tasks/${TASK_WIRING_ID}`) {
      // `renderTask` reads `detail.data.updatedAt`, so the read model must carry
      // its `data` object; the real task-detail surface always does.
      return body({
        taskId: TASK_WIRING_ID,
        title: 'identity forwarding proof',
        state: 'waiting',
        priorInput: '读取 README',
        data: { updatedAt: '2026-10-15T12:00:00Z' },
      });
    }
    if (path === `/api/tasks/${TASK_WIRING_ID}/dashboard`) {
      return body({
        taskId: { scope: 'task', value: TASK_WIRING_ID },
        title: 'identity forwarding proof',
        state: 'waiting',
        stateLabel: '已入队，等待执行',
        currentNode: 'runtime.queue',
        input: '读取 README',
        output: '',
        nextStep: '等待隐式大脑调度',
        updatedAt: '2026-10-15T12:00:00Z',
        allowedActions: [],
        recentEvents: [],
        publicOutput: { state: 'absent', commits: [] },
      });
    }
    if (path === `/api/tasks/${TASK_WIRING_ID}/history`) {
      return body({ ok: true, page: { items: [], hasMore: false } });
    }
    return body({ error: { code: 'not-found', message: `unexpected route ${path}`, ownerId: 'test', nextAction: 'none' } }, 404);
  });
  await taskPage.goto(`${server.url}/task.html?task=${TASK_WIRING_ID}`, { waitUntil: 'domcontentloaded' });
  const taskForwarding = await taskPage.waitForFunction(() => {
    const card = document.querySelector('[data-interaction-work-card-host][data-entry="task"] .iwc-card');
    if (!card) return null;
    const sourceRef = card.querySelector('.iwc-source-ref')?.textContent ?? '';
    if (!sourceRef) return null;
    const chip = [...card.querySelectorAll('.iwc-state-chip')]
      .find((node) => /^(交互|任务|节点) /.test(node.textContent ?? ''))?.textContent ?? '';
    return { chip, sourceRef, statusText: card.querySelector('.iwc-status')?.innerText ?? '' };
  }, undefined, { timeout: 20000 }).then((handle) => handle.jsonValue()).catch(() => null);
  observe('task.html dashboard identity forwarding', taskForwarding);
  record('task.js forwards the real dashboard TaskId into the card source',
    Boolean(taskForwarding?.sourceRef?.includes(`task=task:${TASK_WIRING_ID}`)),
    taskForwarding);
  record('task.js forwards no fabricated Operation for an admitted Task',
    Boolean(taskForwarding?.sourceRef?.includes('operation=未提供'))
      && !taskForwarding.sourceRef.includes('pending-input'),
    taskForwarding);
  record('admitted Task card is labelled as a waiting task, not running',
    taskForwarding?.chip === '任务 已入队，等待执行' && !taskForwarding.statusText.includes('运行中'),
    taskForwarding);
  record('task.html identity forwarding raises no page error', taskPageErrors.length === 0, [...taskPageErrors]);
  await taskPage.screenshot({ path: join(artifactDir, 'task-identity-forwarding.png'), fullPage: true });
  await taskPage.close();
  }

  if (!taskIdentityOnly && !checkpointAssetsOnly && !rawFocusTitleOnly && !projectBreadcrumbOnly && !i2ScopedOnly && !planHistoryOnly) {
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
  let markInterpretRequestStarted;
  const interpretRequestStarted = new Promise((resolvePromise) => {
    markInterpretRequestStarted = resolvePromise;
  });
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
      markInterpretRequestStarted({ method: request.method(), path, body: request.postDataJSON() });
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
    if (path === '/api/explicit/interactions/interaction-progress-proof/confirmation' && request.method() === 'POST') {
      return body({
        requirement: {
          status: 'submitted',
          requirementId: 'requirement:progress-proof',
          draftId: 'draft-progress-proof',
          inputRevision: 1,
        },
      });
    }
    return body({ error: { code: 'not-found', message: `unexpected route ${request.method()} ${path}`, ownerId: 'test', nextAction: 'none' } }, 404);
  });

  await eventPage.goto(`${server.url}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await eventPage.waitForSelector('.quick-create-form textarea[name="directive"]');
  await eventPage.fill('.quick-create-form textarea[name="directive"]', '读取 README');
  await eventPage.click('form button[type="submit"]');

  const interpretStarted = await Promise.race([
    interpretRequestStarted,
    sleep(5000).then(() => null),
  ]);
  record('dashboard F01 reaches the held real interpret POST',
    interpretStarted?.method === 'POST'
      && interpretStarted.path === '/api/explicit/interactions/interaction-progress-proof/interpret',
    interpretStarted);

  const phaseText = () => eventPage.evaluate(() =>
    document.querySelector('.quick-create-progress .progress-phase')?.textContent ?? '');
  const waitForPhase = (includes) => eventPage.waitForFunction(
    (needle) => (document.querySelector('.quick-create-progress .progress-phase')?.textContent ?? '').includes(needle),
    includes,
    { timeout: 20000 },
  ).then(() => true).catch(() => false);

  // The generic submit progress is expected to remain visible while the
  // confirmed interpret POST is held. The request-start signal above, rather
  // than a phase label, identifies the actual asynchronous boundary.
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
  record('dashboard F01 keeps generic submit progress during the held interpret request',
    earlyProgress.phase === '显式大脑正在整理并提交',
    { interpretStarted, early: earlyProgress });
  record('dashboard F01 phase does not advance on a timer while waiting on a real event',
    earlyProgress.phase === lateProgress.phase,
    { early: earlyProgress, late: lateProgress });
  record('dashboard F01 timer only reflects elapsed wait time',
    lateProgress.timer !== earlyProgress.timer,
    { early: earlyProgress, late: lateProgress });

  // Record the card's own focus restoration separately from the Dashboard's
  // intentional post-success focus migration to the next-task input.
  await eventPage.evaluate(() => {
    window.__dashboardFocusTrace = [];
    document.addEventListener('focus', (event) => {
      const target = event.target;
      window.__dashboardFocusTrace.push({
        key: target?.dataset?.focusKey ?? null,
        tag: target?.tagName ?? null,
        name: target?.getAttribute?.('name') ?? null,
      });
    }, true);
    const tab = document.querySelector('[data-focus-key="tab:trace"]');
    if (tab) tab.focus();
  });
  const beforeFocus = await eventPage.evaluate(() => ({
    key: document.activeElement?.dataset?.focusKey ?? null,
  }));
  releaseInterpret();
  await waitForPhase('已入队 · 隐式大脑将消费');
  const focusEvidence = await eventPage.evaluate(() => ({
    trace: window.__dashboardFocusTrace,
    active: {
      key: document.activeElement?.dataset?.focusKey ?? null,
      tag: document.activeElement?.tagName ?? null,
      name: document.activeElement?.getAttribute?.('name') ?? null,
    },
  }));
  const eventCard = await readCard(eventPage);
  const latestPhase = await phaseText();
  observe('dashboard F01 post-event card', eventCard);
  observe('dashboard F09 focus timeline', { before: beforeFocus, ...focusEvidence });
  record('dashboard F01 typed progress turn follows the real event through final submit',
    latestPhase.includes('已入队 · 隐式大脑将消费') && eventCard.cardMounted,
    { latestPhase, card: eventCard });
  const cardRestoreEvents = focusEvidence.trace.filter((entry) => entry.key === 'tab:trace').length - 1;
  record('dashboard F09 card re-render restores its focused trigger',
    beforeFocus.key === 'tab:trace' && cardRestoreEvents >= 1,
    { before: beforeFocus, focusTrace: focusEvidence.trace, cardRestoreEvents });
  record('dashboard F09 successful submit focuses the next-task input',
    focusEvidence.active.tag === 'TEXTAREA' && focusEvidence.active.name === 'directive',
    { active: focusEvidence.active, focusTrace: focusEvidence.trace });

  await eventPage.screenshot({ path: join(artifactDir, 'dashboard-event-driven.png'), fullPage: true });
  if (eventErrors.length) {
    await writeFile(join(evidenceRoot, 'dashboard-event-driven.errors.txt'), eventErrors.join('\n'), 'utf8');
  }
  }
  if (checkpointAssetsOnly) {
    // Raw external projections exercise the real page controller. The known
    // raw/envelope mismatch loses readable bodies (observed source defect);
    // this bounded browser case also protects return navigation at low cost.
    const fixtureRoot = process.env.INTERACTION_PAGE_CHECKPOINT_FIXTURE_ROOT;
    if (!fixtureRoot?.trim()) {
      throw new Error('INTERACTION_PAGE_CHECKPOINT_FIXTURE_ROOT is required; point it at the checkpoint fixture directory');
    }
    const history = JSON.parse(await readFile(join(fixtureRoot, 'history.json'), 'utf8'));
    const capture = JSON.parse(await readFile(join(fixtureRoot, 'capture.json'), 'utf8'));
    capture.text += 'W'.repeat(2048);
    const children = JSON.parse(await readFile(join(fixtureRoot, 'children.json'), 'utf8'));
    observe('fixture provenance', JSON.parse(await readFile(join(fixtureRoot, 'provenance.json'), 'utf8')));
    const scope = history.scope;
    const task = scope.taskId.value;
    const selected = history.viewed.identity;
    const prefix = `/api/tasks/${task}`;
    const receipt = {
      checkpointId: selected.checkpointId.value,
      checkpointCommitId: selected.commitRef.commitId,
      checkpointJournalSeq: String(selected.commitRef.journalSeq),
      checkpointRecordDigest: selected.commitRef.recordDigest,
    };
    const fixturePage = await context.newPage();
    const viewport = process.env.INTERACTION_PAGE_VIEWPORT === 'mobile'
      ? { width: 390, height: 844 } : { width: 1280, height: 800 };
    await fixturePage.setViewportSize(viewport);
    observe('viewport', viewport);
    const requests = [];
    const errors = [];
    fixturePage.on('pageerror', (error) => errors.push(error.message));
    let captureErrorOnce = false;
    let held = false;
    let releaseBody;
    let heldRequest;
    let heldStarted = new Promise((resolveHeld) => { heldRequest = resolveHeld; });
    await fixturePage.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const query = Object.fromEntries(url.searchParams);
      requests.push({ method: request.method(), pathname: url.pathname, query });
      const scoped = query.projectKey === scope.projectKey && query.mode === scope.mode;
      const exact = Object.entries(receipt).every(([key, value]) => query[key] === value);
      let body;
      if (request.method() === 'GET') {
        if (url.pathname === '/api/runtime/status') body = { state: 'ready', mode: 'fake', connected: true };
        if (url.pathname === '/api/ui/display-preference') body = { preference: { mode: 'current' }, defaultMode: 'current' };
        if (url.pathname === `${prefix}/dashboard` && scoped) body = {
          taskId: scope.taskId, taskTitle: 'checkpoint asset body fixture', semanticTitle: 'checkpoint asset body fixture', state: 'waiting', stateLabel: '等待中',
          statusSections: { business: '等待中', waiting: '无待收拢操作' }, allowedActions: [], recentEvents: [],
        };
        if (url.pathname === `${prefix}/checkpoints` && scoped
          && (exact || (!query.checkpointId && query.limit === '20'))) body = history;
        if (url.pathname === `${prefix}/checkpoints/assets/capture` && scoped && exact) {
          if (captureErrorOnce) {
            captureErrorOnce = false;
            await route.fulfill({ status: 404, contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'fixture.capture-read-failed', ownerId: 'fixture', message: 'capture read failed once', nextAction: 'retry' } }) });
            return;
          }
          body = capture;
        }
        for (const child of children) {
          const selector = child.selector;
          if (url.pathname === `${prefix}/checkpoints/assets/adopted-child/${encodeURIComponent(selector.invocationId)}/${encodeURIComponent(selector.childTurnId)}/${selector.deliverySeq}`
            && scoped && exact) body = child;
        }
      }
      if (body && held && url.pathname.includes('/checkpoints/assets/')) {
        held = false;
        await new Promise((resolveBody) => { releaseBody = resolveBody; heldRequest(); });
      }
      await route.fulfill({ status: body ? 200 : 404, contentType: 'application/json',
        body: JSON.stringify(body ?? { error: { code: 'fixture.unexpected-request', message: 'Unexpected fixture request' } }) });
    });
    const dialog = fixturePage.locator('dialog[data-technical-detail="true"][open]');
    const bodySelector = 'dialog[data-technical-detail="true"][open] [data-checkpoint-role="asset-body-text"]';
    let stage = 'boot';
    try {
      const preference = fixturePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/ui/display-preference');
      await fixturePage.goto(`${server.url}/task-dashboard.html?${new URLSearchParams({ task, projectKey: scope.projectKey, mode: scope.mode })}`, { waitUntil: 'domcontentloaded' });
      await preference;
      await fixturePage.getByRole('heading', { name: 'checkpoint asset body fixture', exact: true }).waitFor();
      stage = 'history navigation';
      await fixturePage.locator('button[data-shell-section="view"]').click();
      await fixturePage.locator('button[data-history-view="checkpoints"]').click();
      const entry = fixturePage.locator('[data-shell-records-host] [data-checkpoint-role="history-entry"][data-checkpoint-journal-seq="9"]');
      const exactHistory = fixturePage.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === `${prefix}/checkpoints` && url.searchParams.get('checkpointJournalSeq') === '9';
      });
      await entry.getByRole('button', { name: '查看此检查点', exact: true }).click();
      await exactHistory;
      await fixturePage.locator('[data-shell-records-host] .history-actions').getByRole('button', { name: '技术详情', exact: true }).click();
      const trigger = (kind) => dialog.locator(`button[data-checkpoint-role="asset-body-trigger"][data-asset-body-selector="${kind}"]`);
      const readBody = async (projection, index, retry = false) => {
        const kind = projection.selector.kind;
        stage = `${kind} body`;
        const responsePromise = fixturePage.waitForResponse((response) => response.request().method() === 'GET'
          && new URL(response.url()).pathname.includes('/checkpoints/assets/'));
        if (retry) await dialog.getByRole('button', { name: '重试这次读取', exact: true }).click();
        else await trigger(kind).nth(index).click();
        const response = await responsePromise;
        const actual = await response.json();
        const query = Object.fromEntries(new URL(response.url()).searchParams);
        record(`${kind} raw HTTP receipt ${index}`, response.status() === 200
          && JSON.stringify(actual) === JSON.stringify(projection) && !('ok' in actual)
          && query.projectKey === scope.projectKey && query.mode === scope.mode
          && Object.entries(receipt).every(([key, value]) => query[key] === value),
        { status: response.status(), query, projection: actual });
        const rendered = await fixturePage.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent === expected,
          { selector: bodySelector, expected: projection.text }, { timeout: 5000 }).then(() => true).catch(() => false);
        const observation = await dialog.evaluate((node) => ({
          text: node.querySelector('[data-checkpoint-role="asset-body-text"]')?.textContent ?? null,
          failure: node.querySelector('[data-checkpoint-role="asset-body-failure"]')?.textContent ?? null,
          identity: Object.fromEntries(Array.from(node.querySelectorAll('[data-checkpoint-role="asset-body-provenance"] .detail-cell'),
            (cell) => [cell.querySelector('dt')?.textContent, cell.querySelector('dd')?.textContent])),
        }));
        record(`task-dashboard renders exact ${kind} body ${index}`, rendered, { expectedText: projection.text, ...observation });
        const layout = await dialog.evaluate((node) => {
          const body = node.querySelector('[data-checkpoint-role="asset-body-text"]');
          const host = body?.parentElement;
          if (!body || !host) return null;
          const dialogRect = node.getBoundingClientRect();
          const dialogStyle = getComputedStyle(node);
          const bodyRect = body.getBoundingClientRect();
          return {
            contentLeft: dialogRect.left + parseFloat(dialogStyle.borderLeftWidth) + parseFloat(dialogStyle.paddingLeft),
            contentRight: dialogRect.right - parseFloat(dialogStyle.borderRightWidth) - parseFloat(dialogStyle.paddingRight),
            bodyLeft: bodyRect.left,
            bodyRight: bodyRect.right,
            bodyOverflow: body.scrollWidth <= body.clientWidth + 1,
            hostOverflow: host.scrollWidth <= host.clientWidth + 1,
          };
        });
        record(`task-dashboard keeps ${kind} body within the open drawer ${index}`,
          Boolean(layout) && layout.bodyLeft >= layout.contentLeft - 1 && layout.bodyRight <= layout.contentRight + 1
            && layout.bodyOverflow && layout.hostOverflow, layout);
        const expectedIdentity = {
          '检查点 ID': selected.checkpointId.value,
          '物理 Journal 序号': String(selected.commitRef.journalSeq),
          '提交 ID': selected.commitRef.commitId,
          '记录摘要': selected.commitRef.recordDigest,
          '资产角色': kind,
          '资产证据 ID': projection.asset.ref.evidenceId.value,
          '资产定位': projection.asset.ref.locator,
          '资产摘要': projection.asset.ref.digest,
          ...(kind === 'adopted-child' ? {
            '调用 ID': projection.selector.invocationId,
            '子回合 ID': projection.selector.childTurnId,
            '交付序号': String(projection.selector.deliverySeq),
          } : {}),
        };
        record(`task-dashboard renders exact ${kind} identity ${index}`,
          Object.entries(expectedIdentity).every(([key, value]) => observation.identity[key] === value),
          { expected: expectedIdentity, actual: observation.identity });
        await fixturePage.screenshot({ path: join(artifactDir, `${kind}-${index}.png`), fullPage: true });
        await dialog.getByRole('button', { name: '返回检查点详情', exact: true }).click();
        await trigger('capture').waitFor();
        record(`return from ${kind} body ${index} to checkpoint detail`, await trigger('capture').isVisible());
        return rendered;
      };
      // The first positive assertion is the RED endpoint. Keep the same path
      // for GREEN, then exercise only the two prepared distinct children.
      if (await readBody(capture, 0)) {
        record('checkpoint fixture contains two distinct child bodies', children.length === 2
          && children[0].text !== children[1].text
          && JSON.stringify(children[0].selector) !== JSON.stringify(children[1].selector));
        for (let index = 0; index < children.length; index += 1) await readBody(children[index], index);
        stage = 'capture failure and retry';
        captureErrorOnce = true;
        const failureResponsePromise = fixturePage.waitForResponse((response) => response.request().method() === 'GET'
          && new URL(response.url()).pathname === `${prefix}/checkpoints/assets/capture`);
        await trigger('capture').click();
        const failureResponse = await failureResponsePromise;
        const failureBody = await failureResponse.json();
        record('capture read returns exact typed failure', failureResponse.status() === 404
          && JSON.stringify(failureBody) === JSON.stringify({ error: { code: 'fixture.capture-read-failed', ownerId: 'fixture', message: 'capture read failed once', nextAction: 'retry' } }),
        { status: failureResponse.status(), body: failureBody });
        const failure = dialog.locator('[data-checkpoint-role="asset-body-failure"]');
        await failure.waitFor();
        record('capture read failure is visible', (await failure.innerText()).includes('capture read failed once'),
          { text: await failure.innerText() });
        await readBody(capture, 0, true);
        stage = 'held body return';
        held = true;
        const responsePromise = fixturePage.waitForResponse((response) => new URL(response.url()).pathname === `${prefix}/checkpoints/assets/capture`);
        await trigger('capture').click();
        await heldStarted;
        await dialog.locator('[data-checkpoint-role="asset-body-loading"]').waitFor();
        await dialog.getByRole('button', { name: '返回检查点详情', exact: true }).click();
        await trigger('capture').waitFor();
        const before = await dialog.innerText();
        releaseBody();
        await (await responsePromise).finished();
        // Drain the browser fetch continuation before checking retained detail.
        await fixturePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        record('late body response preserves returned checkpoint detail',
          await trigger('capture').isVisible() && await dialog.innerText() === before
          && await dialog.locator('[data-checkpoint-role="asset-body-text"]').count() === 0,
          { before, after: await dialog.innerText() });
        await fixturePage.screenshot({ path: join(artifactDir, 'late-response-return.png'), fullPage: true });
        stage = 'held body close';
        heldStarted = new Promise((resolveHeld) => { heldRequest = resolveHeld; });
        held = true;
        const closedResponsePromise = fixturePage.waitForResponse((response) => new URL(response.url()).pathname === `${prefix}/checkpoints/assets/capture`);
        await trigger('capture').click();
        await heldStarted;
        await dialog.locator('[data-checkpoint-role="asset-body-loading"]').waitFor();
        await dialog.locator('.shell-layer-close').click();
        await dialog.waitFor({ state: 'hidden' });
        releaseBody();
        await (await closedResponsePromise).finished();
        await fixturePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        record('late body response preserves closed checkpoint detail',
          await dialog.count() === 0 && await fixturePage.locator(bodySelector).count() === 0,
          { openDetails: await dialog.count(), visibleAssetBodies: await fixturePage.locator(bodySelector).count() });
      }
      record('checkpoint fixture raises no page error', errors.length === 0, errors);
    } catch (error) {
      record(`checkpoint fixture ${stage}`, false, { message: error.message, errors, pageText: await fixturePage.locator('body').innerText() });
      await fixturePage.screenshot({ path: join(artifactDir, 'fixture-failure.png'), fullPage: true });
    } finally {
      releaseBody?.();
      await writeFile(join(evidenceRoot, 'requests.json'), JSON.stringify(requests, null, 2), 'utf8');
      observe('checkpoint fixture stage', stage);
      await fixturePage.close();
    }
  }
  if (rawFocusTitleOnly) {
    // Observed RED: raw137 was 46225px below the viewport, with actions URL
    // and no selection; the title exceeded 900px. These two small fixtures
    // cover evidence identity/navigation and both layouts without live writes.
    const scope = { kind: 'task', projectKey: 'raw-focus-fixture', mode: 'fake', taskId: { scope: 'task', value: 'raw-focus-title' } };
    const title = '原始需求标题，保留全文与换行。\n' + '读取并核对任务执行记录，不改变任务内容。'.repeat(100);
    const targetRef = { projectKey: scope.projectKey, mode: scope.mode, taskId: scope.taskId,
      source: 'task-journal', ordinal: 137, operationId: 'operation-target', executionEpoch: 2 };
    const semanticScope = { organId: { scope: 'organ', value: 'organ-raw-focus' },
      taskId: scope.taskId, operationId: { scope: 'operation', value: targetRef.operationId } };
    const semanticSummary = '已核对来源动作，等待查看权威记录';
    const semanticEnvelope = {
      scope: semanticScope, projectionVersion: 'runtime-semantic-v1', sourceWatermark: 1,
      events: [{ eventId: 'semantic-raw-focus-1', sourceId: 'source-raw-focus-1', type: 'task.created',
        scope: semanticScope, occurredAt: '2026-10-16T00:00:00Z', status: 'completed',
        summary: semanticSummary, payloadRef: 'asset://raw-focus-1', dataDigest: 'fixture-raw-focus-1', evidenceRefs: [] }],
      coverageIssues: [],
      pairing: [{ groupId: 'raw-focus-operation', kind: 'operation', scope: semanticScope,
        executionEpoch: 2, state: 'closed', eventRefs: [] }],
      capabilities: [{ capability: 'runtime-task-events', state: 'available' }],
    };
    const rawRecord = (ref, body = 'record') => ({ ref, occurredAt: '2026-10-16T00:00:00Z', body: { kind: 'fixture', text: body } });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const fixturePage = await context.newPage();
      await fixturePage.setViewportSize(viewport);
      const errors = [];
      const requests = [];
      let behavior = 'found';
      let releaseRead;
      let signalHeld;
      let heldStarted;
      const label = `${viewport.width}px`;
      fixturePage.on('pageerror', (error) => errors.push(error.message));
      await fixturePage.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const query = Object.fromEntries(url.searchParams);
        requests.push({ method: request.method(), path: url.pathname, query });
        let body;
        let status = 200;
        if (url.pathname === '/api/runtime/status') body = { state: 'ready', mode: 'fake', connected: true };
        if (url.pathname === '/api/ui/display-preference') body = { preference: { mode: 'follow-last', lastManual: 'current' }, defaultMode: 'current' };
        if (url.pathname.endsWith('/dashboard')) body = {
          taskId: scope.taskId, taskTitle: title, state: 'waiting', stateLabel: '等待中',
          statusSections: { business: '等待中', waiting: '无待收拢操作' }, allowedActions: [], recentEvents: [],
        };
        if (url.pathname === `/api/tasks/${scope.taskId.value}/semantic`) body = semanticEnvelope;
        if (url.pathname.endsWith('/records')) {
          const cursor = query.cursor;
          if (query.view === 'actions') body = { scope, actions: [{ entry: { seq: cursor ? 135 : 1, kind: 'fixture', summary: cursor ? '来源动作页' : '第一页' }, rawRef: targetRef }], hasMore: !cursor, nextCursor: cursor ? undefined : 'actions-page-2' };
          else {
            if (behavior === 'held' && !cursor) {
              await new Promise((done) => { releaseRead = done; signalHeld(); });
            }
            if (behavior === 'failed') {
              status = 503;
              body = { error: { code: 'fixture.read-failed', message: '原始记录读取失败', ownerId: 'test', nextAction: '重试读取' } };
            } else {
              const raw = !cursor ? [rawRecord({ ...targetRef, ordinal: 1 })]
                : cursor === 'raw-page-2' ? [rawRecord({ ...targetRef, ordinal: 101 })]
                : [rawRecord({ ...targetRef, source: 'operation-journal' }), rawRecord({ ...targetRef, operationId: 'other-operation' }),
                  ...Array.from({ length: 8 }, (_, index) => rawRecord({ ...targetRef, ordinal: 120 + index }, 'long record\n'.repeat(150))),
                  ...(behavior === 'missing' ? [] : [rawRecord(targetRef, 'EXACT TARGET')])];
              body = { scope, raw, hasMore: cursor !== 'raw-page-3', nextCursor: !cursor ? 'raw-page-2' : cursor === 'raw-page-2' ? 'raw-page-3' : undefined };
            }
          }
        }
        await route.fulfill({ status: body ? status : 404, contentType: 'application/json', body: JSON.stringify(body ?? { error: { code: 'fixture.unexpected', message: url.pathname } }) });
      });
      const settle = () => fixturePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const selectMode = async (mode) => {
        await fixturePage.locator('button[data-shell-section="view"]').click();
        const manualSave = fixturePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/ui/display-preference' && response.request().method() === 'PUT');
        await fixturePage.locator(`button[data-display-mode="${mode}"]`).click();
        await fixturePage.locator(`button[data-display-mode="${mode}"][aria-pressed="true"]`).waitFor();
        await manualSave;
        await fixturePage.locator('.shell-layer-close:visible').click();
      };
      const panel = fixturePage.locator('.semantic-observation');
      const actionsDetail = fixturePage.locator('[data-records-detail="open"]').filter({ has: fixturePage.locator('[data-records-detail-toggle="actions"]') });
      const source = actionsDetail.getByRole('button', { name: '查看这条原始记录', exact: true });
      try {
        const preferenceRead = fixturePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/ui/display-preference');
        await fixturePage.goto(`${server.url}/task-dashboard.html?${new URLSearchParams({ task: scope.taskId.value, projectKey: scope.projectKey, mode: scope.mode, display: 'current' })}`);
        await preferenceRead;
        await fixturePage.locator('main h1').waitFor();
        await panel.locator('[data-section-id="stable"]').getByText(semanticSummary, { exact: true }).waitFor();
        const layout = () => fixturePage.locator('main h1').evaluate((node) => ({
          text: node.textContent, height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight),
          fits: document.documentElement.scrollWidth <= innerWidth,
        }));
        const folded = await layout();
        record(`${label} title preserves text and clamps to three lines`, folded.text === title && folded.height <= folded.lineHeight * 3 + 1 && folded.fits, folded);
        if (await fixturePage.getByText('查看完整标题', { exact: true }).count()) {
          await fixturePage.getByText('查看完整标题', { exact: true }).click();
          const full = await fixturePage.locator('.task-title-full-text').evaluate((node) => ({ text: node.textContent, size: parseFloat(getComputedStyle(node).fontSize), visible: node.getBoundingClientRect().height > 0 }));
          record(`${label} native details exposes exact full title in body size`, full.text === title && full.size <= 18 && full.visible, full);
          await fixturePage.getByText('查看完整标题', { exact: true }).click();
          record(`${label} title folds again`, (await layout()).height <= folded.lineHeight * 3 + 1);
        } else record(`${label} native full-title details exists`, false);
        const modeGetBaseline = requests.filter((request) => request.method === 'GET').length;
        await panel.evaluate((node) => { window.__semanticPanel = node; });
        for (const [mode, section, text] of [['semantic', 'semantic', semanticSummary], ['raw', 'raw', 'source-raw-focus-1'], ['actions', 'actions', semanticSummary]]) {
          await selectMode(mode);
          const body = panel.locator(`[data-section-id="${section}"]`);
          await body.getByText(text, { exact: true }).waitFor();
          record(`${label} ${mode} switches the retained panel and actual body without GET`,
            await panel.getAttribute('data-mode') === mode
            && await panel.evaluate((node) => node === window.__semanticPanel)
            && new URL(fixturePage.url()).searchParams.get('display') === mode
            && await body.isVisible()
            && requests.filter((request) => request.method === 'GET').length === modeGetBaseline
            && requests.filter((request) => request.path.endsWith('/records')).length === 0,
            { mode, requests: requests.slice(modeGetBaseline) });
        }
        await fixturePage.locator('[data-records-detail-toggle="actions"]').click();
        await actionsDetail.getByText('第一页', { exact: true }).waitFor();
        await actionsDetail.getByRole('button', { name: '继续读取下一页', exact: true }).click();
        await actionsDetail.getByText('来源动作页', { exact: true }).waitFor();
        await source.evaluate((node) => { window.__rawSource = node; });
        const writesBefore = requests.filter((request) => request.method !== 'GET').length;
        const actionsReads = () => requests.filter((request) => request.query.view === 'actions').length;
        const readsBefore = actionsReads();
        await source.click();
        await fixturePage.locator('[data-record-selected="true"]').waitFor({ timeout: 5000 }).catch(() => {});
        const selected = await fixturePage.evaluate(() => {
          const nodes = [...document.querySelectorAll('[data-record-selected="true"]')];
          const node = nodes[0];
          const rect = node?.getBoundingClientRect();
          return { count: nodes.length, text: node?.textContent, current: node?.getAttribute('aria-current'), focused: document.activeElement === node,
            top: rect?.top, visible: rect?.top >= 0 && rect.top < innerHeight,
            heading: document.querySelector('main h1')?.textContent,
            detailHeading: document.querySelector('[data-records-detail="open"] h2')?.textContent,
            rawDetailOpen: document.querySelector('[data-records-detail-toggle="raw"]')?.getAttribute('aria-expanded'),
            panelMode: document.querySelector('.semantic-observation')?.dataset.mode,
            display: new URL(location.href).searchParams.get('display') };
        });
        record(`${label} exact raw137 uniquely selected, focused and visible with synced mode`, selected.count === 1 && selected.text.includes('EXACT TARGET') && selected.current === 'true' && selected.focused && selected.visible && selected.display === 'raw' && selected.heading === '原始记录' && selected.detailHeading === '权威原始记录' && selected.rawDetailOpen === 'true' && selected.panelMode === 'raw' && await panel.isVisible(), selected);
        // A baseline can fail both independent defects in this same run.
        // Return/error/race assertions require the corrected raw navigation.
        if (selected.count !== 1 || selected.display !== 'raw') continue;
        await fixturePage.locator('button[data-shell-section="view"]').click();
        record(`${label} chooser agrees with raw URL and headings`, await fixturePage.locator('[data-display-mode="raw"][aria-pressed="true"]').count() === 1);
        await fixturePage.locator('.shell-layer-close:visible').click();
        await fixturePage.screenshot({ path: join(artifactDir, `raw-focus-${viewport.width}.png`) });
        await fixturePage.getByRole('button', { name: '返回动作轨迹', exact: true }).click();
        const returned = await fixturePage.evaluate(() => ({ same: window.__rawSource === document.activeElement, connected: window.__rawSource.isConnected, display: new URL(location.href).searchParams.get('display') }));
        record(`${label} return preserves action page and trigger without reread or preference write`, returned.same && returned.connected && returned.display === 'actions' && await actionsDetail.getByText('来源动作页', { exact: true }).isVisible() && actionsReads() === readsBefore && requests.filter((request) => request.method !== 'GET').length === writesBefore, returned);
        for (const failure of ['missing', 'failed']) {
          behavior = failure;
          await source.click();
          const notice = fixturePage.locator('[data-records-navigation-failure]');
          await notice.waitFor();
          record(`${label} ${failure} shows a recoverable read failure`, await notice.isVisible());
          await notice.getByRole('button', { name: '技术详情', exact: true }).click();
          await fixturePage.getByText(failure === 'missing' ? '所选原始记录不在返回的记录页中。' : '原始记录读取失败', { exact: true }).first().waitFor();
          record(`${label} ${failure} keeps confirmed actions and URL with visible failure`, new URL(fixturePage.url()).searchParams.get('display') === 'actions' && await actionsDetail.getByText('来源动作页', { exact: true }).isVisible());
          await fixturePage.locator('.shell-layer-close:visible').click();
          await fixturePage.locator('.shell-layer-close:visible').waitFor({ state: 'hidden' });
        }
        behavior = 'held';
        heldStarted = new Promise((done) => { signalHeld = done; });
        await source.click();
        await heldStarted;
        await selectMode('current');
        await panel.locator('[data-section-id="stable"]').getByText(semanticSummary, { exact: true }).waitFor();
        const rawRequests = requests.filter((request) => request.query.view === 'raw').length;
        const lateResponse = fixturePage.waitForResponse((response) => new URL(response.url()).searchParams.get('view') === 'raw');
        releaseRead();
        await (await lateResponse).finished();
        await settle();
        record(`${label} late raw read cannot paginate or overwrite current`, new URL(fixturePage.url()).searchParams.get('display') === 'current' && await fixturePage.locator('main h1').textContent() === title && await panel.getAttribute('data-mode') === 'current' && await fixturePage.locator('[data-record-selected="true"]').count() === 0 && requests.filter((request) => request.query.view === 'raw').length === rawRequests);
        record(`${label} record reads preserve scope and never mutate Task`, requests.filter((request) => request.path.endsWith('/records')).every((request) => request.method === 'GET' && request.path === `/api/tasks/${scope.taskId.value}/records` && request.query.projectKey === scope.projectKey && request.query.mode === scope.mode)
          && requests.filter((request) => request.method !== 'GET').every((request) => request.path === '/api/ui/display-preference'));
        record(`${label} no page error`, errors.length === 0, errors);
      } catch (error) {
        record(`${label} raw/title fixture completed`, false, { message: error.message, errors });
        await fixturePage.screenshot({ path: join(artifactDir, `raw-title-failure-${viewport.width}.png`) });
      } finally {
        releaseRead?.();
        observe(`${label} requests`, requests);
        await fixturePage.close();
      }
    }
  }
  if (projectBreadcrumbOnly) {
    // Failure evidence: the pre-fix project breadcrumb used the mechanical
    // projectKey as its last label and never replaced it after publication.
    // Impact: the primary scope navigation exposes an identifier and disagrees
    // with the project name in the body. Probability is unknown. Cost: reuse
    // this consumer's controlled GET and the shared page shell only.
    const projectKey = 'project/workspace-20261016';
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const fixturePage = await context.newPage();
      await fixturePage.setViewportSize(viewport);
      const label = `${viewport.width}px`;
      const requests = [];
      const errors = [];
      let releaseProjectRead;
      let signalProjectReadStarted;
      const projectReadStarted = new Promise((resolveStarted) => {
        signalProjectReadStarted = resolveStarted;
      });
      fixturePage.on('pageerror', (error) => errors.push(error.message));
      await fixturePage.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const query = Object.fromEntries(url.searchParams);
        requests.push({ method: request.method(), path: url.pathname, query });
        const fulfill = (payload, status = 200) => route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
        if (request.method() === 'GET' && url.pathname === '/api/runtime/status') {
          return fulfill({ state: 'ready', mode: 'fake', providerState: 'ready', connected: true });
        }
        if (request.method() === 'GET'
          && url.pathname === '/api/dashboard'
          && query.scope === 'project'
          && query.projectKey === projectKey) {
          signalProjectReadStarted();
          await new Promise((resolveRelease) => { releaseProjectRead = resolveRelease; });
          return fulfill({
            surface: 'runtime-project',
            scope: { kind: 'project', projectKey },
            label: 'workspace',
            observedAt: '2026-10-16T00:00:00Z',
            tasks: [],
            taskCount: 0,
            complete: true,
            failures: [],
          });
        }
        return fulfill({
          error: {
            code: 'fixture.unexpected-request',
            ownerId: 'test',
            message: `unexpected ${request.method()} ${url.pathname}`,
            nextAction: 'use the controlled project read',
          },
        }, 404);
      });
      const breadcrumbState = () => fixturePage.locator('.breadcrumbs').evaluate((nav) => ({
        labels: [...nav.children].map((child) => child.textContent.trim()),
        hrefs: [...nav.querySelectorAll('a')].map((link) => link.getAttribute('href')),
        last: nav.lastElementChild?.textContent?.trim() ?? null,
      }));
      const settle = () => fixturePage.evaluate(() => new Promise((done) => {
        requestAnimationFrame(() => requestAnimationFrame(done));
      }));
      const pageUrl = `${server.url}/tasks.html?${new URLSearchParams({ projectKey })}`;
      try {
        await fixturePage.goto(pageUrl, { waitUntil: 'domcontentloaded' });
        const started = await Promise.race([
          projectReadStarted.then(() => true),
          sleep(5000).then(() => false),
        ]);
        if (!started) throw new Error('project dashboard GET did not start');
        await fixturePage.locator('.breadcrumbs').waitFor();
        const initial = await breadcrumbState();
        record(`${label} initial last breadcrumb names the current project`, initial.last === '当前项目', initial);
        await fixturePage.screenshot({
          path: join(artifactDir, `project-breadcrumb-initial-${viewport.width}.png`),
          fullPage: true,
        });

        const projectRead = fixturePage.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === '/api/dashboard'
            && url.searchParams.get('scope') === 'project'
            && url.searchParams.get('projectKey') === projectKey;
        });
        releaseProjectRead();
        await (await projectRead).finished();
        await fixturePage.locator('main h2').waitFor();
        await settle();

        const published = await breadcrumbState();
        const bodyTitle = (await fixturePage.locator('main h2').first().textContent())?.trim() ?? null;
        record(`${label} published DTO label names the last breadcrumb and body`,
          published.last === 'workspace' && bodyTitle === 'workspace',
          { published, bodyTitle });
        const currentUrl = new URL(fixturePage.url());
        record(`${label} breadcrumb navigation keeps the system/project links and URL scope`,
          published.labels[0] === '系统'
            && published.labels[1] === '项目'
            && published.hrefs[0] === './dashboard.html'
            && published.hrefs[1] === './tasks.html'
            && currentUrl.pathname.endsWith('/tasks.html')
            && currentUrl.searchParams.get('projectKey') === projectKey,
          { published, currentUrl: currentUrl.href });

        const scopeTrigger = fixturePage.locator('button[data-shell-section="scope"]');
        await scopeTrigger.click();
        const scopePanel = fixturePage.locator('[data-shell-panel="scope"]');
        await scopePanel.waitFor({ state: 'visible' });
        const scopeText = await scopePanel.innerText();
        await fixturePage.locator('.shell-layer-close:visible').click();
        const focusRestored = await fixturePage.waitForFunction(
          () => document.activeElement?.dataset?.shellSection === 'scope',
          undefined,
          { timeout: 5000 },
        ).then(() => true).catch(() => false);
        record(`${label} work scope keeps the full project identity and restores focus`,
          scopeText.includes(`项目 ${projectKey}`) && focusRestored,
          { projectKey, scopeText, focusRestored });

        const dashboardReads = requests.filter((request) => request.path === '/api/dashboard');
        record(`${label} project breadcrumb read issues only the scoped GET`,
          dashboardReads.length === 1
            && dashboardReads[0].method === 'GET'
            && dashboardReads[0].query.scope === 'project'
            && dashboardReads[0].query.projectKey === projectKey
            && requests.every((request) => request.method === 'GET'),
          { requests });
        record(`${label} project breadcrumb fixture raises no page error`, errors.length === 0, errors);
        await fixturePage.screenshot({
          path: join(artifactDir, `project-breadcrumb-published-${viewport.width}.png`),
          fullPage: true,
        });
      } catch (error) {
        record(`${label} project breadcrumb fixture completed`, false, {
          message: error.message,
          errors,
          pageText: await fixturePage.locator('body').innerText().catch(() => ''),
        });
        await fixturePage.screenshot({
          path: join(artifactDir, `project-breadcrumb-failure-${viewport.width}.png`),
          fullPage: true,
        }).catch(() => {});
      } finally {
        releaseProjectRead?.();
        observe(`${label} project breadcrumb requests`, requests);
        await fixturePage.close();
      }
    }
  }
  if (i2ScopedOnly) {
    // Two independent scoped-read invariants are exercised through the real
    // page modules and the existing Chromium/static-server consumer:
    //   1. every I2 GET carries the exact project/mode pair;
    //   2. a projection or comparison pair from another scope/target is refused.
    // The unknown-scope response is a controlled public projection, not a
    // legacy dashboard body, and every other unexpected route stays a 404.
    const projectKey = 'proj-alpha'
    const mode = 'fake'
    const taskId = { scope: 'task', value: 'task-shared-i2' }
    const scope = { kind: 'task', projectKey, mode, taskId }
    const taskScope = { organId: { scope: 'organ', value: 'organ-i2-proof' }, taskId }
    const current = { state: 'unknown', reason: 'scope is not bound to live runtime' }

    const systemRead = {
      surface: 'runtime-system',
      scope: { kind: 'system' },
      observedAt: '2026-10-17T00:00:00Z',
      runtime: {
        surface: 'runtime-status', mode, state: 'ready', connected: true,
        providerState: 'ready', modes: [{ mode, enabled: true, state: 'ready' }],
      },
      coverage: 'configured-projects-in-current-control-root',
      projects: [],
      taskCount: 1,
      complete: true,
      failures: [],
    }
    systemRead.projects.push({
      surface: 'runtime-project',
      scope: { kind: 'project', projectKey },
      label: 'Alpha workspace',
      observedAt: '2026-10-17T00:00:00Z',
      tasks: [{
        scope,
        basis: 'durable-history',
        task: {
          taskId,
          semanticTitle: 'Scoped I2 history proof',
          title: 'Scoped I2 history proof',
          state: 'waiting',
          stateLabel: '等待中',
          taskFlow: { kind: 'long-running', definitionVersion: 1 },
          currentState: '等待人工核对',
          nextStep: '查看 I2 历史',
          updatedAt: '2026-10-17T00:00:00Z',
          entry: 'task-dashboard',
        },
      }],
      taskCount: 1,
      complete: true,
      failures: [],
    })
    const projectRead = {
      surface: 'runtime-project',
      scope: { kind: 'project', projectKey },
      label: 'Alpha workspace',
      observedAt: '2026-10-17T00:00:00Z',
      tasks: [{
        scope,
        basis: 'durable-history',
        task: {
          taskId,
          semanticTitle: 'Scoped I2 history proof',
          title: 'Scoped I2 history proof',
          state: 'waiting',
          stateLabel: '等待中',
          taskFlow: { kind: 'long-running', definitionVersion: 1 },
          currentState: '等待人工核对',
          nextStep: '查看 I2 历史',
          updatedAt: '2026-10-17T00:00:00Z',
          entry: 'task-dashboard',
        },
      }],
      taskCount: 1,
      complete: true,
      failures: [],
    }
    const taskRead = {
      surface: 'runtime-task-dashboard',
      mode,
      taskId,
      semanticTitle: 'Scoped I2 history proof',
      taskTitle: 'Scoped I2 history proof',
      state: 'waiting',
      stateLabel: '等待中',
      statusSections: { business: '等待人工核对', waiting: '尚无执行等待信息' },
      currentNode: 'runtime.waiting',
      observationRef: `task://${taskId.value}/observation`,
      nextStep: '打开查看方式并核对历史',
      input: '核对作用域历史',
      output: '尚无输出',
      allowedActions: [],
      recentEvents: [],
      taskPlanHistory: {
        ok: false,
        failure: {
          code: 'task-plan-history.fixture-unavailable',
          ownerId: 'test',
          message: 'controlled scoped browser fixture has no plan history',
          nextAction: 'none',
        },
      },
    }
    const taskGrantRead = {
      targetScope: { projectKey, mode },
      readback: { taskId, grant: null, commit: null },
      authority: null,
    }
    const semanticRead = {
      scope: { organId: taskScope.organId, taskId },
      projectionVersion: 'runtime-semantic-v1',
      sourceWatermark: 0,
      events: [],
      coverageIssues: [],
      pairing: [],
      capabilities: [],
    }
    const cyclesRead = {
      surface: 'runtime-business-cycles',
      taskScope,
      scope,
      current,
      viewed: null,
      entries: [{
        cycleId: 'cycle-1', state: 'waiting', directiveRevision: 1, executionEpoch: 1,
        taskFlow: { kind: 'long-running', definitionVersion: 1 },
        openedAt: '2026-10-17T00:00:00Z', openingReason: '核对作用域边界',
        openedCommitRef: { commitId: 'commit-cycle-open', journalSeq: 1, recordDigest: 'digest-cycle-open' },
        planRevisionCommitRef: { commitId: 'commit-plan', journalSeq: 2, recordDigest: 'digest-plan' },
        previousCycleCommitRef: null,
        scheduleOccurrenceRef: null,
        inspectionOccurrenceId: null,
        progress: 'open', outcome: null, next: null, closedAt: null,
        closureCommitRef: null, checkpointCommitRef: null, inspectionSettlementCommitRef: null,
        reviews: [], alignmentPending: 0,
      }],
    }
    const reviewsRead = {
      surface: 'runtime-milestone-reviews',
      taskScope,
      scope,
      current,
      entries: [{
        milestoneId: 'milestone-1', cycleId: 'cycle-1', status: 'passed',
        reviewKind: 'milestone', findings: [], outputText: '范围核对通过',
        artifactRef: null, artifactDigest: null,
        reviewer: {
          runtimeId: 'reviewer-1', generation: 1, agentInstanceId: 'agent-reviewer-1',
          roleId: 'role-reviewer', assignmentId: 'assignment-reviewer-1', executionEpoch: 1,
        },
        completedAt: '2026-10-17T00:00:00Z',
        reviewCommitRef: { commitId: 'commit-review', journalSeq: 3, recordDigest: 'digest-review' },
        planRevisionCommitRef: { commitId: 'commit-plan', journalSeq: 2, recordDigest: 'digest-plan' },
        alignment: 'aligned',
        alignmentCommitRef: { commitId: 'commit-alignment', journalSeq: 4, recordDigest: 'digest-alignment' },
        alignedPlanRevisionCommitRef: { commitId: 'commit-plan', journalSeq: 2, recordDigest: 'digest-plan' },
        checkpointCommitRef: null, evidenceRefs: [],
      }],
    }
    const occurrence = (occurrenceId, judgment) => ({
      occurrenceId,
      cycleId: 'cycle-1',
      executionEpoch: 1,
      definitionId: 'definition-inspection',
      definitionVersion: '1',
      definitionDigest: 'digest-inspection-definition',
      definitionCommitRef: { commitId: 'commit-definition', journalSeq: 5, recordDigest: 'digest-definition' },
      openingCommitRef: { commitId: `commit-${occurrenceId}-open`, journalSeq: 6, recordDigest: `digest-${occurrenceId}-open` },
      settlementCommitRef: null,
      openedAt: '2026-10-17T00:00:00Z',
      settledAt: null,
      state: 'open',
      outcome: 'pending',
      outcomeReason: null,
      scheduleOccurrenceRef: null,
      items: [{
        checkId: 'check-1', criterion: '核对任务只读取当前项目',
        state: 'completed', outcome: 'completed', judgment,
        reason: null, resultRef: null, completedAt: '2026-10-17T00:00:00Z', evidenceRefs: [],
      }],
      evidenceRefs: [],
    })
    const occurrencesRead = {
      surface: 'runtime-inspection-occurrences',
      taskScope,
      scope,
      current,
      viewed: { occurrenceId: 'occ-1' },
      entries: [occurrence('occ-1', '项目范围一致'), occurrence('occ-2', '范围仍一致')],
    }
    const comparisonRead = {
      surface: 'runtime-inspection-comparison',
      taskScope,
      scope,
      current,
      left: { occurrenceId: 'occ-1' },
      right: { occurrenceId: 'occ-2' },
      comparable: true,
      reason: null,
      definition: { definitionId: 'definition-inspection', definitionVersion: '1' },
      items: [
        {
          checkId: 'check-changed', criterion: '项目范围保持一致',
          change: 'changed',
          before: { checkId: 'check-changed', criterion: '项目范围保持一致', state: 'completed', outcome: 'completed', judgment: '旧结果', reason: null, resultRef: null, completedAt: '2026-10-17T00:00:00Z', evidenceRefs: [] },
          after: { checkId: 'check-changed', criterion: '项目范围保持一致', state: 'completed', outcome: 'completed', judgment: '新结果', reason: null, resultRef: null, completedAt: '2026-10-17T00:00:00Z', evidenceRefs: [] },
        },
        {
          checkId: 'check-unchanged', criterion: '模式保持一致',
          change: 'unchanged',
          before: { checkId: 'check-unchanged', criterion: '模式保持一致', state: 'completed', outcome: 'completed', judgment: '一致', reason: null, resultRef: null, completedAt: '2026-10-17T00:00:00Z', evidenceRefs: [] },
          after: { checkId: 'check-unchanged', criterion: '模式保持一致', state: 'completed', outcome: 'completed', judgment: '一致', reason: null, resultRef: null, completedAt: '2026-10-17T00:00:00Z', evidenceRefs: [] },
        },
        {
          checkId: 'check-not-compared', criterion: '定义版本可比较',
          change: 'not-compared',
          before: { checkId: 'check-not-compared', criterion: '定义版本可比较', state: 'completed', outcome: 'completed', judgment: '旧定义', reason: null, resultRef: null, completedAt: '2026-10-17T00:00:00Z', evidenceRefs: [] },
          after: { checkId: 'check-not-compared', criterion: '定义版本可比较', state: 'missing', outcome: 'missing', judgment: null, reason: '定义版本不同', resultRef: null, completedAt: null, evidenceRefs: [] },
        },
      ],
    }

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const fixturePage = await context.newPage();
      await fixturePage.setViewportSize(viewport);
      const label = `${viewport.width}px`
      const requests = []
      const errors = []
      let foreignCycleResponse = false
      let wrongPairResponse = false
      let nextCycleResponse = null
      let nextComparisonResponse = null
      fixturePage.on('pageerror', (error) => errors.push(error.message))
      await fixturePage.route('**/api/**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const query = Object.fromEntries(url.searchParams)
        requests.push({ method: request.method(), path: url.pathname, query })
        const fulfill = (payload, statusCode = 200) => route.fulfill({
          status: statusCode,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        })
        if (request.method() !== 'GET') return fulfill({
          error: { code: 'fixture.unexpected-write', ownerId: 'test', message: `unexpected ${request.method()} ${url.pathname}`, nextAction: 'none' },
        }, 405)
        if (url.pathname === '/api/runtime/status') return fulfill({
          surface: 'runtime-status', mode, state: 'ready', connected: true,
          providerState: 'ready', modes: [{ mode, enabled: true, state: 'ready' }],
        })
        if (url.pathname === '/api/dashboard' && query.scope === 'system') return fulfill(systemRead)
        if (url.pathname === '/api/dashboard' && query.scope === 'project' && query.projectKey === projectKey) return fulfill(projectRead)
        if (url.pathname === '/api/runtime/scheduler') return fulfill({ plans: [] })
        if (url.pathname === '/api/ui/display-preference') return fulfill({ preference: { mode: 'current' }, defaultMode: 'current' })
        if (url.pathname === `/api/tasks/${taskId.value}/dashboard`
          && query.projectKey === projectKey && query.mode === mode) return fulfill(taskRead)
        if (url.pathname === `/api/tasks/${taskId.value}/control/grant`
          && query.projectKey === projectKey && query.mode === mode) return fulfill(taskGrantRead)
        if (url.pathname === `/api/tasks/${taskId.value}/semantic`) return fulfill(semanticRead)
        if (url.pathname === `/api/tasks/${taskId.value}/records`) return fulfill({
          surface: 'runtime-task-records', scope, observedAt: '2026-10-17T00:00:00Z',
          actions: [], raw: [], hasMore: false,
        })
        if (url.pathname === `/api/tasks/${taskId.value}/cycles`) {
          if (foreignCycleResponse) {
            const response = await fulfill({ ...cyclesRead, scope: { ...scope, projectKey: 'proj-beta' }, entries: [{ ...cyclesRead.entries[0], cycleId: 'cycle-foreign' }] })
            nextCycleResponse?.()
            return response
          }
          const response = await fulfill(cyclesRead)
          nextCycleResponse?.()
          return response
        }
        if (url.pathname === `/api/tasks/${taskId.value}/reviews`) return fulfill(reviewsRead)
        if (url.pathname === `/api/tasks/${taskId.value}/inspection-occurrences`) return fulfill(occurrencesRead)
        if (url.pathname === `/api/tasks/${taskId.value}/inspection-comparison`) {
          if (wrongPairResponse) {
            const response = await fulfill({ ...comparisonRead, right: { occurrenceId: 'occ-stale' } })
            nextComparisonResponse?.()
            return response
          }
          const response = await fulfill(comparisonRead)
          nextComparisonResponse?.()
          return response
        }
        return fulfill({
          error: { code: 'fixture.unexpected-request', ownerId: 'test', message: `unexpected GET ${url.pathname}`, nextAction: 'keep this route explicit' },
        }, 404)
      })

      const viewButton = fixturePage.locator('button[data-shell-section="view"]')
      const waitForShellLayersClosed = async () => {
        await fixturePage.waitForFunction(() => document.querySelectorAll('dialog.shell-layer[open]').length === 0)
      }
      const openHistory = async (view) => {
        const activeDrawer = fixturePage.locator('dialog.shell-layer[open]:not([data-technical-detail])')
        if (!(await activeDrawer.count())) await viewButton.click()
        await activeDrawer.locator(`button[data-history-view="${view}"]`).click()
      }
      const backToView = async () => {
        const activeDrawer = fixturePage.locator('dialog.shell-layer[open]:not([data-technical-detail])')
        const back = activeDrawer.getByRole('button', { name: '返回查看方式', exact: true })
        if (await back.isVisible()) {
          await back.click()
          await activeDrawer.locator('button[data-history-view]').first().waitFor()
          return
        }
        if (!(await activeDrawer.count())) {
          await viewButton.click()
          await activeDrawer.waitFor({ state: 'visible' })
        }
      }
      const expandDetail = async (root, summary) => {
        const summaryNode = root.locator('details.history-detail > summary')
          .filter({ hasText: new RegExp(`^${summary}$`) }).first()
        const details = summaryNode.locator('..')
        const visible = details.locator('dl')
        if (!(await visible.isVisible())) await summaryNode.click()
        await visible.waitFor()
        return visible.innerText()
      }
      const expandInspectionItems = async () => {
        const details = fixturePage.locator('[data-i2-history="inspections"] [data-occurrence="occ-1"] details.history-detail')
          .filter({ hasText: '检查明细' }).first()
        const rows = details.locator('[data-check-item="check-1"]')
        if (!(await rows.isVisible())) await details.locator('summary').filter({ hasText: /^检查明细$/ }).click()
        await rows.waitFor()
        return rows.innerText()
      }
      const waitForResponse = (setSignal) => new Promise((resolveResponse) => {
        setSignal(resolveResponse)
      })
      const waitForCycleRead = async () => {
        await waitForResponse((resolveResponse) => { nextCycleResponse = resolveResponse })
      }
      const closeDrawer = async () => {
        await fixturePage.locator('dialog.shell-layer[open]:not([data-technical-detail]) .shell-layer-close').click()
        await waitForShellLayersClosed()
      }
      const scopedI2Reads = () => requests.filter((request) => request.path.includes('/api/tasks/')
        && (request.path.endsWith('/cycles') || request.path.endsWith('/reviews')
          || request.path.endsWith('/inspection-occurrences') || request.path.endsWith('/inspection-comparison')))

      try {
        const settle = () => fixturePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        await fixturePage.goto(`${server.url}/dashboard.html`, { waitUntil: 'domcontentloaded' })
        await fixturePage.getByRole('link', { name: 'Alpha workspace', exact: true }).click()
        await fixturePage.waitForURL((url) => url.pathname.endsWith('/tasks.html') && url.searchParams.get('projectKey') === projectKey)
        const taskLink = fixturePage.locator('a.task-item-main').filter({
          has: fixturePage.getByRole('heading', { name: 'Scoped I2 history proof', exact: true }),
        })
        await taskLink.waitFor()
        const taskHref = new URL(await taskLink.getAttribute('href'), fixturePage.url())
        if (taskHref.pathname !== '/task-dashboard.html'
          || taskHref.searchParams.get('task') !== taskId.value
          || taskHref.searchParams.get('projectKey') !== projectKey
          || taskHref.searchParams.get('mode') !== mode) {
          throw new Error(`task row does not carry the formal scoped href: ${taskHref.href}`)
        }
        await taskLink.click()
        await fixturePage.waitForURL((url) => url.pathname.endsWith('/task-dashboard.html')
          && url.searchParams.get('task') === taskId.value
          && url.searchParams.get('projectKey') === projectKey
          && url.searchParams.get('mode') === mode)
        await fixturePage.getByRole('heading', { name: 'Scoped I2 history proof', exact: true }).waitFor()
        await settle()

        await openHistory('cycles')
        await fixturePage.locator('[data-i2-history="cycles"]').waitFor()
        const cycleRequest = scopedI2Reads().find((request) => request.path.endsWith('/cycles'))
        record(`${label} cycle read carries the exact project and mode`, cycleRequest?.query.projectKey === projectKey
          && cycleRequest?.query.mode === mode, cycleRequest)
        const cycleText = await fixturePage.locator('[data-i2-history="cycles"]').innerText()
        const cycleDetails = await expandDetail(fixturePage.locator('[data-i2-history="cycles"]'), '证据详情')
        record(`${label} cycle main copy leads with human history and keeps scope machine fields in details`,
          cycleText.includes('核对作用域边界') && cycleText.includes('当前执行位置未知')
            && !cycleText.includes('digest-cycle-open') && cycleDetails.includes(projectKey)
            && cycleDetails.includes('projectKey') && cycleDetails.includes(mode)
            && cycleDetails.includes('mode'), { cycleText, cycleDetails })
        record(`${label} unknown current never marks the latest historical cycle as viewed`,
          await fixturePage.locator('[data-business-cycle="cycle-1"] .history-viewed-tag').count() === 0)

        foreignCycleResponse = true
        const cycleResponse = waitForCycleRead()
        await fixturePage.getByRole('button', { name: '重新读取历史', exact: true }).click()
        await cycleResponse
        const foreignDrawer = fixturePage.locator('dialog.shell-layer[open]:not([data-technical-detail])')
        await foreignDrawer.getByText('历史读取范围不匹配', { exact: true }).waitFor()
        const foreignDrawerText = await foreignDrawer.innerText()
        record(`${label} foreign project response is refused before rendering`,
          foreignDrawerText.includes('历史读取范围不匹配')
          && foreignDrawerText.includes('请从所属项目重新打开任务历史')
          && !foreignDrawerText.includes('具体原因尚未确认')
          && await fixturePage.locator('[data-business-cycle="cycle-foreign"]').count() === 0,
          foreignDrawerText)

        foreignCycleResponse = false
        await backToView()
        await openHistory('reviews')
        await fixturePage.locator('[data-i2-history="reviews"]').waitFor()
        const reviewRequest = scopedI2Reads().find((request) => request.path.endsWith('/reviews'))
        record(`${label} review read carries the exact project and mode`, reviewRequest?.query.projectKey === projectKey && reviewRequest?.query.mode === mode, reviewRequest)

        await backToView()
        await openHistory('inspections')
        await fixturePage.locator('[data-i2-history="inspections"]').waitFor()
        const inspectionRequest = scopedI2Reads().find((request) => request.path.endsWith('/inspection-occurrences'))
        record(`${label} inspection read carries the exact project and mode`, inspectionRequest?.query.projectKey === projectKey && inspectionRequest?.query.mode === mode, inspectionRequest)
        const inspectionText = await fixturePage.locator('[data-i2-history="inspections"]').innerText()
        const inspectionItemText = await expandInspectionItems()
        record(`${label} inspection main layer shows criterion, judged result and unknown current`,
          inspectionItemText.includes('核对任务只读取当前项目') && inspectionItemText.includes('项目范围一致')
            && inspectionText.includes('当前执行位置未知') && !inspectionItemText.includes('digest-inspection-definition'),
          inspectionItemText)
        const inspectionDetails = await expandDetail(fixturePage.locator('[data-i2-history="inspections"]'), '证据详情')
        const inspectionCheckDetails = await expandDetail(
          fixturePage.locator('[data-i2-history="inspections"] [data-occurrence="occ-1"]'),
          '证据详情',
        )
        record(`${label} inspection details expose project and mode`,
          inspectionDetails.includes(projectKey) && inspectionDetails.includes('projectKey')
            && inspectionDetails.includes(mode) && inspectionDetails.includes('mode'), inspectionDetails)
        record(`${label} inspection item details expose check identity after opening`,
          inspectionCheckDetails.includes('check-1') && inspectionCheckDetails.includes('checkId')
            && inspectionCheckDetails.includes('项目范围一致') && inspectionCheckDetails.includes('judgment'),
          inspectionCheckDetails)
        record(`${label} viewed inspection remains distinct from the unknown current`,
          await fixturePage.locator('[data-i2-history="inspections"] .history-viewed-tag').count() === 1
            && (await fixturePage.locator('[data-i2-history="inspections"] .history-viewed-tag').innerText()).includes('正在查看'))

        await fixturePage.locator('[data-occurrence="occ-1"]').getByRole('button', { name: '选择为对比基准', exact: true }).click()
        await fixturePage.locator('[data-occurrence="occ-2"]').getByRole('button', { name: '作为右侧对比', exact: true }).click()
        await fixturePage.locator('[data-i2-history="comparison"]').waitFor()
        const comparisonRequest = scopedI2Reads().find((request) => request.path.endsWith('/inspection-comparison'))
        record(`${label} comparison read carries exact scope and occurrence pair`, comparisonRequest?.query.projectKey === projectKey
          && comparisonRequest?.query.mode === mode && comparisonRequest?.query.left === 'occ-1'
          && comparisonRequest?.query.right === 'occ-2', comparisonRequest)
        const comparisonText = await fixturePage.locator('[data-i2-history="comparison"]').innerText()
        record(`${label} comparison changes stay human readable`,
          comparisonText.includes('有变化') && comparisonText.includes('无变化') && comparisonText.includes('未可比对'), comparisonText)

        await fixturePage.getByRole('button', { name: '返回巡检历史', exact: true }).click()
        await fixturePage.locator('[data-occurrence="occ-2"]').waitFor()
        wrongPairResponse = true
        const comparisonResponse = waitForResponse((resolveResponse) => { nextComparisonResponse = resolveResponse })
        await fixturePage.locator('[data-occurrence="occ-1"]').getByRole('button', { name: '选择为对比基准', exact: true }).click()
        await fixturePage.locator('[data-occurrence="occ-2"]').getByRole('button', { name: '作为右侧对比', exact: true }).click()
        await comparisonResponse
        const pairDrawer = fixturePage.locator('dialog.shell-layer[open]:not([data-technical-detail])')
        await pairDrawer.getByText('巡检对比记录与所选轮次不一致', { exact: true }).waitFor()
        const pairDrawerText = await pairDrawer.innerText()
        record(`${label} mismatched requested occurrence pair is refused`,
          pairDrawerText.includes('巡检对比记录与所选轮次不一致')
          && pairDrawerText.includes('请重新选择两次记录比较')
          && !pairDrawerText.includes('具体原因尚未确认'), pairDrawerText)
        record(`${label} mismatched pair never mounts foreign comparison rows`,
          await fixturePage.locator('[data-comparison-item="check-changed"]').count() === 0)

        await backToView()
        await openHistory('inspections')
        await fixturePage.locator('[data-i2-history="inspections"]').waitFor()
        const layout = await fixturePage.locator('dialog.shell-layer[open]:not([data-technical-detail])').evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        })
        if (viewport.width === 1280) {
          record(`${label} drawer opens beside the main content`, layout.right >= viewport.width - 20 && layout.left > viewport.width / 2, layout)
        } else {
          record(`${label} drawer opens from the mobile bottom edge`, layout.bottom >= viewport.height - 1
            && layout.left <= 1 && layout.right >= viewport.width - 1 && layout.top > 0, layout)
        }

        await closeDrawer()
        await fixturePage.waitForFunction(() => document.activeElement?.dataset?.shellSection === 'view')
        const focused = await fixturePage.evaluate(() => document.activeElement?.dataset?.shellSection)
        record(`${label} closing the history drawer restores focus to 查看方式`, focused === 'view', focused)

        record(`${label} scoped I2 flow issues only GETs`,
          requests.length > 0 && requests.every((request) => request.method === 'GET'), requests.filter((request) => request.method !== 'GET'))
        record(`${label} scoped I2 flow raises no page error`, errors.length === 0, errors)
        await fixturePage.screenshot({ path: join(artifactDir, `i2-scoped-${viewport.width}.png`), fullPage: true })
      } catch (error) {
        record(`${label} scoped I2 browser fixture completed`, false, {
          message: error.message,
          errors,
          pageText: await fixturePage.locator('body').innerText().catch(() => ''),
        })
        await fixturePage.screenshot({ path: join(artifactDir, `i2-scoped-failure-${viewport.width}.png`), fullPage: true }).catch(() => {})
      } finally {
        observe(`${label} scoped I2 requests`, requests)
        await fixturePage.close()
      }
    }
  }
  if (planHistoryOnly) {
    // Failure mode: the formal Task Dashboard may ignore the available
    // multi-revision plan history, show a later published revision as current,
    // or fail to switch to the semantic order. Impact: false plan orientation
    // (empty plan, wrong current version, missing retained history) while the
    // backend and renderer consumer still pass. Probability is unknown; the
    // existing browser fixtures only ever served an unavailable history. Cost:
    // one controlled dashboard GET plus the shared drawer/mode path.
    const projectKey = 'proj-plan-history'
    const mode = 'fake'
    const taskId = { scope: 'task', value: 'task-plan-history' }
    const scope = { kind: 'task', projectKey, mode, taskId }
    // Data construction mirrors the production renderer consumer's fixture
    // shape. The real page imports the renderer; this file never copies it and
    // never imports the consumer test that registers its own DOM.
    const evidenceRef = (id) => ({
      evidenceId: { scope: 'evidence', value: id },
      kind: 'execution',
      source: 'task-plan-history-fixture',
      locator: `fixture://${id}`,
      scope: { organId: { scope: 'organ', value: 'organ-plan-history' }, taskId },
    })
    const snapshot = (label, { nodes, phases, relations } = {}) => ({
      title: `Plan ${label}`,
      summary: `Reasoning plan ${label}.`,
      completeness: { scope: 'whole-task', status: 'complete' },
      acceptanceCriteria: [{ criterionId: `${label}-criterion`, description: `Verify ${label}.` }],
      nodes: nodes ?? [
        { nodeId: `${label}-build`, kind: 'work', title: `Build ${label}`, intent: `Implement ${label}`, definition: { owner: 'runtime' }, phaseId: `${label}-phase` },
        { nodeId: `${label}-verify`, kind: 'check', title: `Verify ${label}`, intent: `Verify ${label}`, definition: { owner: 'runtime' }, phaseId: `${label}-phase` },
      ],
      phases: phases ?? [{ phaseId: `${label}-phase`, title: `Phase ${label}`, memberNodeIds: [`${label}-build`, `${label}-verify`] }],
      relations: relations ?? [{ fromNodeId: `${label}-build`, toNodeId: `${label}-verify`, kind: 'depends-on' }],
    })
    const revision = (sequence, id, { reason, snapshot: snap, coverage = 'complete-from-task-start', publishedAt = '2026-10-18T00:00:00.000Z' } = {}) => ({
      revisionId: id,
      sequence,
      journalCommitRef: `jsonl:commit-${sequence}`,
      predecessor: sequence === 1 ? null : { revisionId: `v${sequence - 1}`, sequence: sequence - 1 },
      snapshot: snap ?? snapshot(id),
      reason: reason ?? { kind: sequence === 1 ? 'initial' : 'adjustment', text: `reason ${id}`, basisRefs: [evidenceRef(`basis-${id}`)] },
      evidenceRefs: [evidenceRef(`source-${id}`)],
      historyCoverage: coverage,
      publishedAt,
    })
    const v1 = revision(1, 'v1', { coverage: 'prior-history-unavailable' })
    const v2 = revision(2, 'v2')
    const v3 = revision(3, 'v3', {
      snapshot: snapshot('v3', {
        nodes: [
          { nodeId: 'v3-build', kind: 'work', title: 'Build v3', intent: 'Implement v3', definition: { owner: 'runtime' }, phaseId: 'v3-phase' },
          { nodeId: 'v3-verify', kind: 'check', title: 'Verify v3', intent: 'Verify v3', definition: { owner: 'runtime' }, phaseId: 'v3-phase' },
          { nodeId: 'v3-ship', kind: 'work', title: 'Ship v3', intent: 'Ship v3', definition: { owner: 'runtime' }, phaseId: 'v3-phase' },
        ],
        phases: [{ phaseId: 'v3-phase', title: 'Phase v3', memberNodeIds: ['v3-build', 'v3-verify', 'v3-ship'] }],
        relations: [
          { fromNodeId: 'v3-build', toNodeId: 'v3-verify', kind: 'depends-on' },
          { fromNodeId: 'v3-verify', toNodeId: 'v3-ship', kind: 'sequence' },
        ],
      }),
    })
    const planHistory = {
      surface: 'runtime-task-plan-history',
      scope,
      current: {
        state: 'known',
        value: {
          revisionId: 'v2',
          revisionCommitRef: { commitId: 'commit-2', journalSeq: 12, recordDigest: `sha256:${'a'.repeat(64)}` },
        },
      },
      revisions: [v1, v2, v3],
    }
    const taskRead = {
      surface: 'runtime-task-dashboard',
      mode,
      taskId,
      taskTitle: 'Available plan history proof',
      state: 'waiting',
      stateLabel: '等待中',
      statusSections: { business: '等待人工核对', waiting: '尚无执行等待信息' },
      currentNode: 'runtime.waiting',
      observationRef: `task://${taskId.value}/observation`,
      nextStep: '核对当前计划与保留历史',
      input: '核对可用计划历史',
      output: '尚无输出',
      allowedActions: [],
      recentEvents: [],
      taskPlanHistory: { ok: true, value: planHistory },
    }
    const taskGrantRead = {
      targetScope: { projectKey, mode },
      readback: { taskId, grant: null, commit: null },
      authority: null,
    }
    // A closed operation pairing keeps the shared semantic panel from opening a
    // stream. This fixture only exercises the plan-history surface.
    const operationScope = {
      organId: { scope: 'organ', value: 'organ-plan-history' },
      taskId,
      operationId: { scope: 'operation', value: 'operation-plan-history' },
    }
    const semanticEnvelope = {
      scope: operationScope,
      projectionVersion: 'runtime-semantic-v1',
      sourceWatermark: 0,
      events: [],
      coverageIssues: [],
      pairing: [{
        groupId: 'plan-history-operation', kind: 'operation', scope: operationScope,
        executionEpoch: 1, state: 'closed', eventRefs: [],
      }],
      capabilities: [],
    }

    const fixturePage = await context.newPage()
    await fixturePage.setViewportSize({ width: 1280, height: 900 })
    const requests = []
    const errors = []
    fixturePage.on('pageerror', (error) => errors.push(error.message))
    await fixturePage.route('**/api/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const query = Object.fromEntries(url.searchParams)
      requests.push({ method: request.method(), path: url.pathname, query })
      const fulfill = (payload, statusCode = 200) => route.fulfill({
        status: statusCode,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      })
      if (request.method() !== 'GET') return fulfill({
        error: { code: 'fixture.unexpected-write', ownerId: 'test', message: `unexpected ${request.method()} ${url.pathname}`, nextAction: 'none' },
      }, 405)
      if (url.pathname === '/api/runtime/status') return fulfill({
        surface: 'runtime-status', mode, state: 'ready', connected: true,
        providerState: 'ready', modes: [{ mode, enabled: true, state: 'ready' }],
      })
      if (url.pathname === '/api/ui/display-preference') return fulfill({ preference: { mode: 'current' }, defaultMode: 'current' })
      if (url.pathname === `/api/tasks/${taskId.value}/dashboard`
        && query.projectKey === projectKey && query.mode === mode) return fulfill(taskRead)
      if (url.pathname === `/api/tasks/${taskId.value}/control/grant`
        && query.projectKey === projectKey && query.mode === mode) return fulfill(taskGrantRead)
      if (url.pathname === `/api/tasks/${taskId.value}/semantic`) return fulfill(semanticEnvelope)
      return fulfill({
        error: { code: 'fixture.unexpected-request', ownerId: 'test', message: `unexpected GET ${url.pathname}`, nextAction: 'keep this route explicit' },
      }, 404)
    })
    const settle = () => fixturePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    try {
      const preferenceRead = fixturePage.waitForResponse((response) => new URL(response.url()).pathname === '/api/ui/display-preference')
      await fixturePage.goto(`${server.url}/task-dashboard.html?${new URLSearchParams({
        task: taskId.value, projectKey, mode, display: 'current',
      })}`, { waitUntil: 'domcontentloaded' })
      await preferenceRead
      // The current plan lives inside the collapsed native 任务计划 fold, so
      // open that exact details before waiting on the visible current section.
      const planSummary = fixturePage.locator('details.display-detail-fold > summary')
        .filter({ hasText: /^任务计划$/ }).first()
      const planFold = planSummary.locator('..')
      if (!(await planFold.evaluate((node) => node.open === true))) {
        await planSummary.click()
      }
      const currentSection = fixturePage.locator('[data-plan-history="current"]')
      await currentSection.waitFor({ timeout: 20000 })
      await settle()
      const currentText = await currentSection.innerText()
      record('current plan shows only the accepted revision',
        currentText.includes('Plan v2') && currentText.includes('当前权威版本 · 版本 2')
          && !currentText.includes('Plan v1') && !currentText.includes('Plan v3'), currentText)
      record('current plan does not mount the retained revision list',
        await currentSection.locator('[data-plan-revision]').count() === 0
          && await fixturePage.locator('[data-plan-history="semantic"]').count() === 0)

      // Switch to semantic through the existing shell drawer chooser. The saved
      // preference is `current`, so a manual switch must not persist (no PUT).
      await fixturePage.locator('button[data-shell-section="view"]').click()
      await fixturePage.locator('button[data-display-mode="current"][aria-pressed="true"]').waitFor()
      const semanticButton = fixturePage.locator('button[data-display-mode="semantic"]')
      await semanticButton.click()
      await fixturePage.locator('button[data-display-mode="semantic"][aria-pressed="true"]').waitFor()
      await fixturePage.locator('.shell-layer-close:visible').click()
      await fixturePage.waitForFunction(() => document.querySelectorAll('dialog.shell-layer[open]').length === 0)

      const fold = fixturePage.locator('[data-plan-history-fold]')
      await fold.waitFor({ timeout: 20000 })
      if (!(await fold.evaluate((node) => node.open === true))) {
        await fold.locator('summary').click()
      }
      const semanticSection = fixturePage.locator('[data-plan-history="semantic"]')
      await semanticSection.waitFor()
      await settle()

      const order = await fixturePage.$$eval('[data-plan-history="semantic"] [data-plan-revision]',
        (nodes) => nodes.map((node) => node.dataset.planRevision))
      record('semantic keeps the returned revision order',
        JSON.stringify(order) === JSON.stringify(['v1', 'v2', 'v3']), order)

      const revisionText = (id) => fixturePage.locator(`[data-plan-history="semantic"] [data-plan-revision="${id}"]`).innerText()
      const v1Text = await revisionText('v1')
      const v2Text = await revisionText('v2')
      const v3Text = await revisionText('v3')
      record('semantic shows the accepted current reason',
        v2Text.includes('计划调整') && v2Text.includes('reason v2'), v2Text)
      record('semantic shows the previous-version relation',
        v2Text.includes('上一版本：序列 1 · v1'), v2Text)
      record('semantic shows the typed change for the later revision',
        v3Text.includes('新增节点：Ship v3'), v3Text)
      record('semantic keeps current distinct from the later published revision',
        v2Text.includes('当前权威版本') && !v3Text.includes('当前权威版本')
          && v3Text.includes('上一版本：序列 2 · v2'), { v1Text, v2Text, v3Text })

      record('plan history flow issues only GETs',
        requests.length > 0 && requests.every((request) => request.method === 'GET'),
        requests.filter((request) => request.method !== 'GET'))
      record('plan history flow raises no page error', errors.length === 0, errors)
      await fixturePage.screenshot({ path: join(artifactDir, 'plan-history.png'), fullPage: true })
    } catch (error) {
      record('plan history browser fixture completed', false, {
        message: error.message,
        errors,
        pageText: await fixturePage.locator('body').innerText().catch(() => ''),
      })
      await fixturePage.screenshot({ path: join(artifactDir, 'plan-history-failure.png'), fullPage: true }).catch(() => {})
    } finally {
      observe('plan history requests', requests)
      await fixturePage.close()
    }
  }
  await context.close();

  await writeFile(join(evidenceRoot, 'checks.json'), JSON.stringify({ checks, observations }, null, 2), 'utf8');
  if (checks.length === 0) throw new Error('page wiring browser proof recorded no checks');
  if (failures > 0) {
    throw new Error(`${failures}/${checks.length} page wiring browser checks failed:\n${checks.filter((check) => !check.pass).map((check) => `  - ${check.name}: ${JSON.stringify(check.detail)}`).join('\n')}`);
  }
  console.log(
    taskIdentityOnly
      ? `interaction page wiring browser proof (task-identity-only): ${checks.length} checks passed`
      : planHistoryOnly
        ? `interaction page wiring browser proof (plan-history-only): ${checks.length} checks passed`
        : `interaction page wiring browser proof: ${checks.length} checks passed`,
  );
} finally {
  await browser.close().catch(() => {});
  await closeServer(server).catch(() => {});
}
