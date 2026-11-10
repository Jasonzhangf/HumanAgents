#!/usr/bin/env node

/**
 * D20 real-browser proof: a confirmed new-task submission stays on the single
 * entry interface and keeps the live progress card instead of being forced onto
 * the task dashboard through `window.location.assign`.
 *
 * Serves the built UI (`dist/app/ui`) through Playwright route interception
 * against a synthetic origin (`index.html` + a scripted explicit-brain runtime
 * API). The confirmed task's real execution event stream is a loopback SSE
 * server, because `route.fulfill` cannot keep a stream open.
 *
 * Flow:
 *   1. Entry submit -> /api/explicit/inputs (201 receipt).
 *   2. /interpret is gated, then returns awaiting-confirmation + draft.
 *   3. Confirm -> /confirmation -> confirmed task.
 *   4. entry.js landOnSubmittedTask resolves the exact scope via
 *      /api/dashboard?scope=system, reads /api/tasks/:id/dashboard to discover
 *      the operation, and subscribes to /api/executions/:id/events.
 *   5. The entry page must stay on index.html and the live progress card must
 *      show a real semantic execution phase with total and per-step timers.
 *   6. Clicking the card opens the detail layer with the real execution steps
 *      and closing it returns to the same entry surface. No second confirm.
 *
 * Red on the pre-D20 base: `landOnSubmittedTask` navigates to
 * task-dashboard.html, so the entry URL and live card checks fail.
 *
 * Requires `pnpm build:app` (serves `dist/app/ui`). Optional env:
 *   T22C_PLAYWRIGHT   playwright module path
 *   T22C_BROWSER_ARGS chromium launch args
 *   T22C_UI_ROOT      built UI root (default: dist/app/ui) for a red base run
 *   T22C_EVIDENCE     artifact directory
 */

import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.T22C_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.T22C_EVIDENCE?.trim()
  ? resolve(process.env.T22C_EVIDENCE)
  : resolve(tmpdir(), `entry-submit-stays-${Date.now()}`);
await mkdir(evidenceRoot, { recursive: true });

const playwrightModule = await import(
  process.env.T22C_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;
const browserArgs = (process.env.T22C_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const proofOrigin = 'http://humanagent.entry-submit-stays.test';
const OCCURRED_AT = '2026-11-01T08:00:00.000Z';
const TASK_ID = 'ui-stays-task-1';
const PROJECT_KEY = 'humanagent';
const MODE = 'rcc';

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

function mimeType(path) {
  switch (path.slice(path.lastIndexOf('.'))) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

// ── scripted explicit-brain runtime API ─────────────────────────────────────
const scripted = {
  interactionId: 'interaction-stays-1',
  interpretation: 0,
  confirmationCount: 0,
  taskDashboardReads: 0,
  systemDashboardReads: 0,
};
let interpretGate = null;

function setInterpretGate() {
  let release;
  const promise = new Promise((settle) => { release = settle; });
  interpretGate = { promise, release };
}

function releaseInterpretGate() {
  const gate = interpretGate;
  interpretGate = null;
  gate?.release();
}

function draft() {
  return {
    draftId: 'draft-stays-1',
    inputRevision: 1,
    normalizedInput: '读取 README（规范化）',
    proposal: '提交后执行：读取 README',
    knownFacts: ['用户提供了一条业务输入', '显式大脑已完成整理'],
  };
}

function taskRow() {
  return {
    taskId: { scope: 'task', value: TASK_ID },
    title: '读取 README（规范化）',
    semanticTitle: '读取 README',
    currentState: '执行中',
    stateLabel: '执行中',
    state: 'running',
    nextStep: '等待执行',
    updatedAt: new Date().toISOString(),
    identitySource: { requirementId: 'requirement:stays-1', draftId: 'draft-stays-1', inputRevision: 1 },
  };
}

async function handleScriptedApi(url, method, body) {
  if (url.pathname === '/api/runtime/status') {
    return { status: 200, body: { mode: 'rcc', state: 'ready', providerState: 'ready', connected: true } };
  }
  if (url.pathname === '/api/explicit/inputs' && method === 'POST') {
    return { status: 201, body: { interactionId: scripted.interactionId, occurredAt: OCCURRED_AT } };
  }
  const selfMatch = /^\/api\/explicit\/interactions\/([^/]+)$/.exec(url.pathname);
  if (selfMatch && method === 'GET') {
    const state = scripted.interpretation > 0 ? 'awaiting-confirmation' : 'received';
    return {
      status: 200,
      body: {
        interactionId: scripted.interactionId,
        state,
        rawInput: '读取 README',
        nextAction: state === 'received' ? 'interpret' : 'confirm-or-revise',
        occurredAt: OCCURRED_AT,
        ...(state === 'awaiting-confirmation' ? { draft: draft() } : {}),
      },
    };
  }
  const interpretMatch = /^\/api\/explicit\/interactions\/([^/]+)\/interpret$/.exec(url.pathname);
  if (interpretMatch && method === 'POST') {
    if (interpretGate) await interpretGate.promise;
    scripted.interpretation += 1;
    return {
      status: 200,
      body: {
        interactionId: scripted.interactionId,
        state: 'awaiting-confirmation',
        rawInput: '读取 README',
        nextAction: 'confirm-or-revise',
        occurredAt: OCCURRED_AT,
        draft: draft(),
      },
    };
  }
  const confirmationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(url.pathname);
  if (confirmationMatch && method === 'POST') {
    scripted.confirmationCount += 1;
    return {
      status: 200,
      body: {
        requirement: {
          status: 'submitted',
          requirementId: 'requirement:stays-1',
          draftId: 'draft-stays-1',
          inputRevision: 1,
        },
      },
    };
  }
  // The explicit.step stream is not the subject of this proof; keep it quiet.
  if (/^\/api\/explicit\/interactions\/[^/]+\/events$/.test(url.pathname) && method === 'GET') {
    return { status: 200, sse: true, body: '' };
  }
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return { status: 200, body: { draft: [], waiting: [taskRow()], running: [], completed: [], stopped: [], failed: [] } };
  }
  if (url.pathname === '/api/dashboard' && url.searchParams.get('scope') === 'system') {
    scripted.systemDashboardReads += 1;
    return {
      status: 200,
      body: {
        surface: 'runtime-project',
        projects: [{
          projectKey: PROJECT_KEY,
          mode: MODE,
          tasks: [{
            scope: { kind: 'task', projectKey: PROJECT_KEY, mode: MODE, taskId: { scope: 'task', value: TASK_ID } },
            task: { taskId: { scope: 'task', value: TASK_ID } },
          }],
        }],
      },
    };
  }
  const taskDashMatch = /^\/api\/tasks\/([^/]+)\/dashboard/.exec(url.pathname);
  if (taskDashMatch && method === 'GET') {
    scripted.taskDashboardReads += 1;
    return {
      status: 200,
      body: {
        taskId: { scope: 'task', value: decodeURIComponent(taskDashMatch[1]) },
        title: '读取 README',
        state: 'running',
        stateLabel: '执行中',
        currentNode: 'pipeline.execute',
        nextStep: '执行步骤：runtime.queue',
        updatedAt: new Date().toISOString(),
        operationId: 'operation-stays-1',
        statusSections: { business: '执行中', waiting: '执行步骤' },
        allowedActions: ['stop'],
        recentEvents: [],
        publicOutput: { state: 'absent', commits: [] },
      },
    };
  }
  // The execution event stream is served on a real loopback socket and repointed
  // in the page; routing it here would break the stream.
  return { status: 404, body: { error: { code: 'scripted.route.missing', path: url.pathname } } };
}

async function installScriptedRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== proofOrigin) {
      await route.continue();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      let body;
      try { body = request.postData() ? JSON.parse(request.postData()) : undefined; } catch { body = undefined; }
      const result = await handleScriptedApi(url, request.method(), body);
      if (result.sse) {
        await route.fulfill({ status: result.status, contentType: 'text/event-stream; charset=utf-8', body: result.body ?? '' });
        return;
      }
      await route.fulfill({
        status: result.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(result.body),
      });
      return;
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    const filePath = resolve(uiRoot, relative);
    if (!relative || relative.split('/').includes('..') || !filePath.startsWith(`${uiRoot}/`)) {
      await route.fulfill({ status: 400, body: 'bad path' });
      return;
    }
    try {
      const file = await readFile(filePath);
      await route.fulfill({ status: 200, contentType: mimeType(filePath), body: file });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
}

// ── real loopback execution event stream ────────────────────────────────────
const EXECUTION_STEPS = [
  { seq: 1, kind: 'execution.started', summary: '执行开始', occurredAt: OCCURRED_AT, state: 'running' },
  { seq: 2, kind: 'provider.tool', summary: '调用工具：file.read', occurredAt: OCCURRED_AT, state: 'running' },
  { seq: 3, kind: 'execution.terminal', summary: '执行完成', occurredAt: OCCURRED_AT, state: 'succeeded', status: 'succeeded', terminalPhase: 'final' },
];

function frame(step) {
  return `id: exec-${step.seq}\nevent: ${step.kind}\ndata: ${JSON.stringify(step)}\n\n`;
}

async function startExecutionStreamServer() {
  const sockets = new Set();
  let connections = 0;
  const server = createServer((request, response) => {
    if (!/^\/api\/executions\/[^/]+\/events$/.test(new URL(request.url, 'http://127.0.0.1').pathname)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"stream.route.missing"}}');
      return;
    }
    connections += 1;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    sockets.add(response.socket);
    // Space the frames so the page observes a growing per-step timer before the
    // next step resets it, and so the terminal arrives after both are seen.
    let index = 0;
    const push = () => {
      try { response.write(frame(EXECUTION_STEPS[index])); } catch {}
      index += 1;
      if (index < EXECUTION_STEPS.length) setTimeout(push, 900);
    };
    push();
    response.on('close', () => sockets.delete(response.socket));
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((settle) => server.close(settle));
    },
  };
}

// Repoint ONLY the runtime execution EventSource at the real SSE server; every
// other request (including the explicit.step stream) stays scripted.
function repointExecutionStream(origin) {
  const Real = window.EventSource;
  window.EventSource = function (url, init) {
    let target = String(url);
    try {
      const resolved = new URL(target, location.href);
      if (/^\/api\/executions\/[^/]+\/events$/.test(resolved.pathname)) {
        target = `${origin}${resolved.pathname}${resolved.search}`;
      }
    } catch {
      // An unresolvable URL is left untouched.
    }
    return new Real(target, init);
  };
}

async function withScriptedPage(run) {
  const browser = await playwright.chromium.launch({ headless: true, args: browserArgs });
  const context = await browser.newContext();
  await installScriptedRoutes(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    return await run(page, pageErrors);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const readProgressCard = () => {
  const block = document.querySelector('.status-banner .progress.progress--live');
  if (!block) return { hasBlock: false };
  const phase = block.querySelector('.progress-phase');
  const detail = block.querySelector('.progress-detail');
  const timers = [...block.querySelectorAll('.progress-timer')].map((node) => node.textContent);
  const rect = block.getBoundingClientRect();
  return {
    hasBlock: true,
    phase: phase ? phase.textContent : null,
    detail: detail ? detail.textContent : null,
    timers,
    timerCount: timers.length,
    interactive: block.dataset.interactive === 'true',
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    intersectsViewport: rect.bottom > 0 && rect.top < window.innerHeight,
    overflowX: block.scrollWidth > block.clientWidth + 1,
  };
}

const readConfirmSurface = () => ({
  secondConfirmButton: document.querySelectorAll('#entry-confirm-button, [data-entry-confirm]').length,
  confirmLabels: [...document.querySelectorAll('button')].map((button) => (button.textContent || '').trim())
    .filter((label) => /确认|审批|二次/.test(label)),
})

async function runStaysProof(page, pageErrors) {
  const server = await startExecutionStreamServer();
  try {
    await page.addInitScript(repointExecutionStream, server.origin);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#entry-form textarea[name="rawInput"]', { timeout: 10_000 });
    await page.fill('#entry-form textarea[name="rawInput"]', '读取 README');
    setInterpretGate();
    await page.click('#entry-form button[type="submit"]');

    // In flight: the live card exists before confirmation.
    await page.waitForSelector('.status-banner .progress.progress--live', { timeout: 15_000 });
    releaseInterpretGate();

    // Post-confirmation: the page must stay on the entry index and the live card
    // must show a real semantic execution phase with two timers.
    let stepReady = true;
    try {
      await page.waitForFunction(
        () => {
          const phase = document.querySelector('.status-banner .progress--live .progress-phase')?.textContent ?? '';
          return /[\u4e00-\u9fff]/u.test(phase) && !/^步骤\s*\d+/u.test(phase);
        },
        undefined,
        { timeout: 25_000 },
      );
    } catch {
      stepReady = false;
    }
    if (!stepReady) {
      // On the pre-D20 base the page has already navigated away, so record the
      // departure URL and the evidence image before failing the proof.
      await page.screenshot({ path: join(evidenceRoot, 'entry-after-submit.png') });
      throw new Error(`the entry page did not show a real execution step; url=${page.url()}`);
    }
    await page.waitForTimeout(1_200);
    const url = page.url();
    const card = await page.evaluate(readProgressCard);
    observe('stayed url', url);
    observe('post-confirmation live card', card);
    record('confirmed submission stays on the entry index', new URL(url).pathname === '/index.html', url);
    record('live progress card is visible after confirmation', card.hasBlock === true, card.hasBlock);
    record(
      'live card shows a semantic execution phase',
      /[\u4e00-\u9fff]/u.test(card.phase ?? '') && !/^步骤\s*\d+/u.test(card.phase ?? ''),
      card.phase,
    );
    record('live card shows the real execution summary', card.detail === '调用工具：file.read' || card.detail === '执行完成', card.detail);
    record('live card shows total and per-step timers', card.timerCount === 2 && card.timers.every((timer) => /总耗时|本步/.test(timer)), card.timers);
    record('live card is interactive', card.interactive === true, card.interactive);
    record('live card has no horizontal overflow', card.overflowX === false, card.overflowX);
    record('task dashboard read happened once', scripted.taskDashboardReads === 1, scripted.taskDashboardReads);
    record('exact scope read happened once', scripted.systemDashboardReads === 1, scripted.systemDashboardReads);
    record('execution stream reached the real SSE server', server.connections >= 1, server.connections);

    const confirm = await page.evaluate(readConfirmSurface);
    record('no second confirmation button exists', confirm.secondConfirmButton === 0, confirm);
    record('no second confirmation label is shown', confirm.confirmLabels.length === 0, confirm.confirmLabels);

    // The pre-D20 defect: the page navigates away from entry. Assert the URL
    // is exactly the single interface at the moment the live card is present.
    record('confirmed submission does not navigate to the task dashboard', new URL(url).pathname !== '/task-dashboard.html', url);

    // Dual-viewport screenshots of the entry page with the live card.
    await page.setViewportSize({ width: 1280, height: 720 });
    const wide = await page.evaluate(readProgressCard);
    record('1280x720 live card intersects the viewport', wide.intersectsViewport === true, wide.rect);
    await page.screenshot({ path: join(evidenceRoot, 'entry-live-card-1280x720.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await page.evaluate(readProgressCard);
    record('390x844 live card intersects the viewport', narrow.intersectsViewport === true, narrow.rect);
    record('390x844 live card has no horizontal overflow', narrow.overflowX === false, narrow.overflowX);
    await page.screenshot({ path: join(evidenceRoot, 'entry-live-card-390x844.png') });

    // The card opens the detail layer on an explicit click and closes back to
    // this same entry context.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.click('.status-banner .progress.progress--live');
    const dialog = page.locator('dialog.shell-layer[open]');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    const drawerText = ((await dialog.innerText()) || '').replace(/\s+/g, ' ').trim();
    observe('detail drawer', drawerText);
    record('clicking the card opens the detail drawer', drawerText.length > 0, drawerText.slice(0, 200));
    record('detail drawer reports the real task identity', drawerText.includes(TASK_ID), drawerText.slice(0, 200));
    record('detail drawer reports real execution steps', drawerText.includes('调用工具：file.read') || drawerText.includes('执行完成'), drawerText.slice(0, 300));
    await page.screenshot({ path: join(evidenceRoot, 'entry-live-card-detail-1280x720.png') });
    await dialog.locator('button.shell-layer-close').first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    record('detail drawer closes back to the entry page', await page.locator('dialog.shell-layer[open]').count() === 0, null);
    record('closing the drawer did not navigate away', new URL(page.url()).pathname === '/index.html', page.url());
    record('entry page produced no runtime errors', pageErrors.length === 0, pageErrors);
  } finally {
    await server.close();
  }
}

await withScriptedPage(async (page, pageErrors) => {
  try {
    await runStaysProof(page, pageErrors);
  } catch (error) {
    record('entry submit-stays proof completed', false, error.message);
  }
});

console.log(JSON.stringify({ checks, failures, evidenceRoot }, null, 2));
process.exit(failures === 0 ? 0 : 1);
