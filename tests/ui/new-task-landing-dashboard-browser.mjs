#!/usr/bin/env node

/**
 * G1.4 real-browser proof: a confirmed new-task submission lands on the live
 * task dashboard with the execution state rendered, never on the static
 * task.html?interaction=... confirm page.
 *
 * Serves the built UI (`dist/app/ui`) through Playwright route interception
 * against a synthetic origin. No listening socket; runs wherever headless
 * Chromium launches.
 *
 * Flow:
 *   1. Entry submit → /api/explicit/inputs (201 receipt).
 *   2. /interpret → awaiting-confirmation + draft, while the explicit.step SSE
 *      stream at /api/explicit/interactions/:id/events delivers real steps.
 *   3. Confirm → /api/explicit/interactions/:id/confirmation → confirmed task.
 *   4. entry.js landOnSubmittedTask resolves scope via /api/dashboard?scope=system
 *      and navigates to task-dashboard.html?task=...&projectKey=...&mode=...
 *   5. The dashboard page renders the live execution projection (执行中).
 *
 * Assertions:
 *   - submission navigates to task-dashboard.html carrying task/projectKey/mode
 *     and NO interaction parameter;
 *   - the submission drives the explicit.step stream (stream attached);
 *   - the dashboard page renders the live execution state;
 *   - no uncaught pageerror;
 *   - screenshots captured at 1280x720 and 390x844.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.T22C_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.T22C_EVIDENCE?.trim()
  ? resolve(process.env.T22C_EVIDENCE)
  : resolve('/tmp', `new-task-landing-${Date.now()}`);
await mkdir(evidenceRoot, { recursive: true });

const playwrightModule = await import(
  process.env.T22C_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;
const browserArgs = (process.env.T22C_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const proofOrigin = 'http://humanagent.new-task-landing.test';
const OCCURRED_AT = '2026-11-01T00:00:00.000Z';

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
function freshScripted() {
  return {
    interactionId: `interaction-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    taskId: 'ui-new-task-1',
    projectKey: 'humanagent',
    mode: 'rcc',
    inspected: 0,
    stepStreamRequests: [],
    executionStreamRequests: [],
    confirmationCount: 0,
  };
}

function taskRow(state) {
  return {
    taskId: { scope: 'task', value: state.taskId },
    title: 'submission',
    currentState: '执行中',
    stateLabel: '执行中',
    state: 'running',
    nextStep: '等待执行',
    updatedAt: new Date().toISOString(),
    identitySource: { requirementId: 'requirement:new-task-1', draftId: 'draft-1', inputRevision: 1 },
  };
}

function handleScriptedApi(state, url, method, body) {
  if (url.pathname === '/api/runtime/status') {
    return { status: 200, body: { mode: 'fake', state: 'ready', providerState: 'ready', connected: true } };
  }
  if (url.pathname === '/api/ui/display-preference') {
    return { status: 200, body: { preference: { mode: 'follow-last', lastManual: 'current' }, defaultMode: 'current' } };
  }
  if (url.pathname === '/api/explicit/inputs' && method === 'POST') {
    return { status: 201, body: { interactionId: state.interactionId, occurredAt: OCCURRED_AT } };
  }
  const selfMatch = /^\/api\/explicit\/interactions\/([^/]+)$/.exec(url.pathname);
  if (selfMatch && method === 'GET') {
    state.inspected += 1;
    // First inspect returns `received` so entry.js runs the real interpret pass;
    // after interpret it returns the awaiting-confirmation draft.
    const snapshot = state.inspected >= 2
      ? { interactionId: state.interactionId, state: 'awaiting-confirmation', rawInput: 'submission', nextAction: 'confirm-or-revise', draft: { draftId: 'draft-1', inputRevision: 1, proposal: '提交后执行：submission' }, occurredAt: OCCURRED_AT }
      : { interactionId: state.interactionId, state: 'received', rawInput: 'submission', nextAction: 'interpret', occurredAt: OCCURRED_AT };
    return { status: 200, body: snapshot };
  }
  const interpretMatch = /^\/api\/explicit\/interactions\/([^/]+)\/interpret$/.exec(url.pathname);
  if (interpretMatch && method === 'POST') {
    state.inspected = 2;
    return { status: 200, body: { interactionId: state.interactionId, state: 'awaiting-confirmation', draft: { draftId: 'draft-1', inputRevision: 1, proposal: '提交后执行：submission' }, occurredAt: OCCURRED_AT } };
  }
  // The explicit.step stream entry.js opens while the brain interprets.
  if (url.pathname === `/api/explicit/interactions/${encodeURIComponent(state.interactionId)}/events` && method === 'GET') {
    state.stepStreamRequests.push(state.interactionId);
    return {
      status: 200,
      sse: true,
      messages: [
        `event: explicit.step\ndata: ${JSON.stringify({ step: 1, seq: 1, summary: '正在整理任务输入' })}\n\n`,
        `event: explicit.step\ndata: ${JSON.stringify({ step: 2, seq: 2, summary: '整理完成，等待确认' })}\n\n`,
      ],
    };
  }
  // The execution event stream the landed dashboard subscribes to.
  const execMatch = /^\/api\/executions\/([^/]+)\/events$/.exec(url.pathname);
  if (execMatch && method === 'GET') {
    state.executionStreamRequests.push(execMatch[1]);
    return {
      status: 200,
      sse: true,
      messages: [
        `event: execution.started\ndata: ${JSON.stringify({ operationId: 'operation-new-task-1', step: 1, summary: '执行开始', occurredAt: OCCURRED_AT })}\n\n`,
        `event: execution.step\ndata: ${JSON.stringify({ step: 1, seq: 1, summary: '执行步骤：runtime.queue', occurredAt: OCCURRED_AT })}\n\n`,
      ],
    };
  }
  const confirmMatch = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(url.pathname);
  if (confirmMatch && method === 'POST') {
    state.confirmationCount += 1;
    return { status: 200, body: { requirement: { status: 'submitted', requirementId: 'requirement:new-task-1', draftId: 'draft-1', inputRevision: 1 } } };
  }
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return { status: 200, body: { draft: [], waiting: [taskRow(state)], running: [], completed: [], stopped: [], failed: [] } };
  }
  // The system dashboard read that entry.js uses to resolve the exact scope.
  if (url.pathname === '/api/dashboard' && url.searchParams.get('scope') === 'system') {
    return {
      status: 200,
      body: {
        surface: 'runtime-project',
        projects: [{
          projectKey: state.projectKey,
          mode: state.mode,
          tasks: [{
            scope: { kind: 'task', projectKey: state.projectKey, mode: state.mode, taskId: { scope: 'task', value: state.taskId } },
            task: { taskId: { scope: 'task', value: state.taskId } },
          }],
        }],
      },
    };
  }
  // The scoped dashboard read the task-dashboard page performs.
  const taskDashMatch = /^\/api\/tasks\/([^/]+)\/dashboard/.exec(url.pathname);
  if (taskDashMatch && method === 'GET') {
    const taskIdValue = decodeURIComponent(taskDashMatch[1]);
    const streamed = state.executionStreamRequests.length > 0;
    return {
      status: 200,
      body: {
        taskId: { scope: 'task', value: taskIdValue },
        title: 'submission',
        state: 'running',
        stateLabel: '执行中',
        currentNode: 'runtime.queue',
        input: 'submission',
        output: '',
        nextStep: streamed ? '执行步骤：runtime.queue（已收到执行事件）' : '等待执行',
        updatedAt: new Date().toISOString(),
        operationId: 'operation-new-task-1',
        statusSections: { business: '执行中', waiting: streamed ? '执行步骤·已收到执行事件' : '执行步骤' },
        allowedActions: ['stop'],
        recentEvents: [],
        publicOutput: { state: 'absent', commits: [] },
      },
    };
  }
  // Product reads the dashboard focus controller performs; empty but valid so
  // the page renders the live dashboard instead of read-unavailable panels.
  if (url.pathname === '/api/product/session' && method === 'GET') {
    return { status: 200, body: { messages: [], boardIndex: { boards: [] } } };
  }
  if (url.pathname === '/api/product/relations' && method === 'GET') {
    return { status: 200, body: { relations: [] } };
  }
  if (url.pathname === '/api/product/output' && method === 'GET') {
    return { status: 200, body: { commits: [], resultAvailable: false } };
  }
  if (url.pathname === '/api/product/decision' && method === 'GET') {
    return { status: 200, body: null };
  }
  const semanticMatch = /^\/api\/tasks\/([^/]+)\/semantic$/.exec(url.pathname);
  if (semanticMatch && method === 'GET') {
    const taskIdValue = decodeURIComponent(semanticMatch[1]);
    return {
      status: 200,
      body: {
        scope: {
          organId: { scope: 'organ', value: 'organ-1' },
          taskId: { scope: 'task', value: taskIdValue },
          operationId: { scope: 'operation', value: 'operation-new-task-1' },
        },
        projectionVersion: 'runtime-semantic-v1',
        sourceWatermark: 1,
        events: [],
        coverageIssues: [],
        pairing: [],
        capabilities: [{ capability: 'runtime-task-events', state: 'available' }],
      },
    };
  }
  return { status: 404, body: { error: { code: 'scripted.route.missing', path: url.pathname } } };
}

async function installScriptedRoutes(context, state) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== proofOrigin) { await route.continue(); return; }
    if (url.pathname.startsWith('/api/')) {
      let body;
      try { body = request.postData() ? JSON.parse(request.postData()) : undefined; } catch { body = undefined; }
      const result = handleScriptedApi(state, url, request.method(), body);
      if (result.sse) {
        await route.fulfill({
          status: result.status,
          contentType: 'text/event-stream; charset=utf-8',
          headers: { 'cache-control': 'no-cache', connection: 'keep-alive' },
          body: result.messages.join(''),
        });
        return;
      }
      await route.fulfill({
        status: result.status,
        contentType: 'application/json; charset=utf-8',
        body: result.body === undefined ? '{}' : JSON.stringify(result.body),
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

async function waitForCondition(probe, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function capture(viewport) {
  const state = freshScripted();
  const browser = await playwright.chromium.launch({ headless: true, args: browserArgs });
  const context = await browser.newContext({ viewport });
  await installScriptedRoutes(context, state);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));

  await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#entry-form textarea[name="rawInput"]', 'submission');
  await page.click('#entry-form button[type="submit"]');

  const landed = await waitForCondition(() =>
    page.evaluate(() => /task-dashboard\.html/.test(window.location.href)).catch(() => false),
  );
  if (!landed) {
    await page.screenshot({ path: join(evidenceRoot, `landing-failure-${viewport.width}x${viewport.height}.png`), fullPage: true });
    record(`${viewport.width}x${viewport.height} submission lands on task-dashboard.html`, false, { url: page.url(), errors: pageErrors.slice(0, 5) });
    await browser.close();
    return;
  }

  // Let the dashboard refresh render the live execution projection.
  await page.waitForFunction(
    () => /任务投影已同步|执行中/.test(document.body.innerText),
    undefined,
    { timeout: 20000 },
  ).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(evidenceRoot, `landing-${viewport.width}x${viewport.height}.png`), fullPage: true });

  const url = new URL(page.url());
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  record(`${viewport.width}x${viewport.height} submission lands on task-dashboard.html`, url.pathname.endsWith('/task-dashboard.html'), { url: page.url(), errors: pageErrors.slice(0, 5) });
  record(`${viewport.width}x${viewport.height} landing carries task=${state.taskId}`, url.searchParams.get('task') === state.taskId, url.search);
  record(`${viewport.width}x${viewport.height} landing carries projectKey=${state.projectKey}`, url.searchParams.get('projectKey') === state.projectKey, url.search);
  record(`${viewport.width}x${viewport.height} landing carries mode=${state.mode}`, url.searchParams.get('mode') === state.mode, url.search);
  record(`${viewport.width}x${viewport.height} landing carries NO interaction param`, url.searchParams.get('interaction') === null, url.search);
  record(`${viewport.width}x${viewport.height} submission drives the explicit.step stream`, state.stepStreamRequests.length > 0, { stepStreamRequests: state.stepStreamRequests });
  record(`${viewport.width}x${viewport.height} dashboard renders the live execution state`, /任务投影已同步|执行中/.test(bodyText), bodyText.slice(0, 400));
  record(`${viewport.width}x${viewport.height} no uncaught pageerror`, pageErrors.length === 0, pageErrors);

  // The landed dashboard must subscribe to the real execution event stream,
  // and at least one execution event must update the displayed state.
  await waitForCondition(() => state.executionStreamRequests.length > 0, 15000);
  await page.waitForTimeout(500);
  const bodyTextAfterStream = await page.evaluate(() => document.body.innerText).catch(() => '');
  record(`${viewport.width}x${viewport.height} dashboard subscribes to execution event stream`, state.executionStreamRequests.length > 0, { executionStreamRequests: state.executionStreamRequests });
  record(`${viewport.width}x${viewport.height} execution event updates displayed step/progress`, /执行步骤：runtime.queue|已收到执行事件/.test(bodyTextAfterStream), bodyTextAfterStream.slice(0, 400));
  observe(`${viewport.width}x${viewport.height} final URL`, page.url());

  await browser.close();
}

const viewports = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];

for (const viewport of viewports) {
  await capture(viewport);
}

console.log(JSON.stringify({ checks, failures, evidenceRoot }, null, 2));
process.exit(failures === 0 ? 0 : 1);
