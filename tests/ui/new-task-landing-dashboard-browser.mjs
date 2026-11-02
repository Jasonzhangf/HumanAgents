#!/usr/bin/env node

/**
 * D20 real-browser proof: a confirmed new-task submission stays on the single
 * entry interface with the live execution progress card. It never navigates to
 * task-dashboard.html and never shows the static task.html?interaction=...
 * confirm page.
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
 *   4. entry.js landOnSubmittedTask resolves scope via /api/dashboard?scope=system,
 *      refreshes the committed task row, and reads the exact task dashboard.
 *   5. The entry page subscribes to the execution stream and renders the real
 *      step, total timer, per-step timer, and clickable detail layer in place.
 *
 * Assertions:
 *   - submission stays on index.html with no interaction parameter;
 *   - the live card shows a real execution step and both timers;
 *   - the card opens and closes the detail layer without leaving the entry;
 *   - the submission drives the explicit.step stream (stream attached);
 *   - the exact scoped dashboard and execution streams are read;
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
    taskDashboardReads: 0,
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
        `event: execution.started\ndata: ${JSON.stringify({ operationId: 'operation-new-task-1', seq: 1, summary: '执行开始', occurredAt: OCCURRED_AT })}\n\n`,
        `event: provider.tool\ndata: ${JSON.stringify({ seq: 2, summary: '调用工具：file.read', occurredAt: OCCURRED_AT })}\n\n`,
        `event: execution.terminal\ndata: ${JSON.stringify({ seq: 3, summary: '执行完成', status: 'succeeded', terminalPhase: 'final', occurredAt: OCCURRED_AT })}\n\n`,
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
    state.taskDashboardReads += 1;
    // The first committed read is admitted but has no operation yet. The entry
    // page must observe again, then connect the real stream once it appears.
    const operationReady = state.taskDashboardReads >= 2;
    return {
      status: 200,
      body: {
        taskId: { scope: 'task', value: taskIdValue },
        title: 'submission',
        state: operationReady ? 'running' : 'created',
        stateLabel: operationReady ? '执行中' : '等待调度',
        currentNode: 'runtime.queue',
        input: 'submission',
        output: '',
        nextStep: operationReady ? '执行步骤：runtime.queue（已收到执行事件）' : '等待执行',
        updatedAt: new Date().toISOString(),
        ...(operationReady ? { operationId: 'operation-new-task-1' } : {}),
        statusSections: { business: operationReady ? '执行中' : '等待调度', waiting: operationReady ? '执行步骤·已收到执行事件' : '等待执行' },
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

  const live = await waitForCondition(() =>
    page.evaluate(() => {
      const block = document.querySelector('.status-banner .progress.progress--live');
      const phase = block?.querySelector('.progress-phase')?.textContent ?? '';
      return block !== null && /^步骤 \d+$/.test(phase);
    }).catch(() => false),
  );
  if (!live) {
    await page.screenshot({ path: join(evidenceRoot, `entry-live-failure-${viewport.width}x${viewport.height}.png`), fullPage: true });
    record(`${viewport.width}x${viewport.height} submission shows the entry live progress card`, false, { url: page.url(), errors: pageErrors.slice(0, 5) });
    await browser.close();
    return;
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: join(evidenceRoot, `entry-live-${viewport.width}x${viewport.height}.png`), fullPage: true });

  const url = new URL(page.url());
  const card = await page.evaluate(() => {
    const block = document.querySelector('.status-banner .progress.progress--live');
    const timers = [...block.querySelectorAll('.progress-timer')].map((node) => node.textContent);
    const rect = block.getBoundingClientRect();
    return {
      phase: block.querySelector('.progress-phase')?.textContent ?? null,
      summary: block.querySelector('.progress-detail')?.textContent ?? null,
      timers,
      interactive: block.dataset.interactive === 'true',
      intersectsViewport: rect.bottom > 0 && rect.top < window.innerHeight,
      overflowX: block.scrollWidth > block.clientWidth + 1,
    };
  });
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  record(`${viewport.width}x${viewport.height} submission stays on the entry index`, url.pathname.endsWith('/index.html'), { url: page.url(), errors: pageErrors.slice(0, 5) });
  record(`${viewport.width}x${viewport.height} entry URL carries NO interaction param`, url.searchParams.get('interaction') === null, url.search);
  record(`${viewport.width}x${viewport.height} live card shows a real execution step`, /^步骤 \d+$/.test(card.phase ?? ''), card.phase);
  record(`${viewport.width}x${viewport.height} live card shows the runtime summary`, card.summary === '执行完成' || card.summary === '调用工具：file.read', card.summary);
  record(`${viewport.width}x${viewport.height} live card shows total and per-step timers`, card.timers.length === 2 && card.timers.every((timer) => /总耗时|本步/.test(timer)), card.timers);
  record(`${viewport.width}x${viewport.height} live card is interactive`, card.interactive === true, card.interactive);
  record(`${viewport.width}x${viewport.height} live card is visible in the viewport`, card.intersectsViewport === true, card);
  record(`${viewport.width}x${viewport.height} live card has no horizontal overflow`, card.overflowX === false, card.overflowX);
  record(`${viewport.width}x${viewport.height} submission drives the explicit.step stream`, state.stepStreamRequests.length > 0, { stepStreamRequests: state.stepStreamRequests });
  record(`${viewport.width}x${viewport.height} submission reads the exact task dashboard`, state.executionStreamRequests.length > 0, { executionStreamRequests: state.executionStreamRequests });
  record(`${viewport.width}x${viewport.height} entry observes until the execution operation appears`, state.taskDashboardReads >= 2, { taskDashboardReads: state.taskDashboardReads });
  record(`${viewport.width}x${viewport.height} entry shows no second confirmation control`, !/确认提交|二次确认|审批/.test(bodyText), bodyText.slice(0, 400));
  record(`${viewport.width}x${viewport.height} no uncaught pageerror`, pageErrors.length === 0, pageErrors);

  await page.locator('.status-banner .progress.progress--live').click();
  const dialog = page.locator('dialog.shell-layer[open]');
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  const drawerText = ((await dialog.innerText()) || '').replace(/\s+/g, ' ').trim();
  record(`${viewport.width}x${viewport.height} live card opens the detail layer`, drawerText.includes('任务执行进度'), drawerText.slice(0, 300));
  record(`${viewport.width}x${viewport.height} detail layer carries the real task identity`, drawerText.includes(state.taskId), drawerText.slice(0, 300));
  record(`${viewport.width}x${viewport.height} detail layer carries real execution steps`, drawerText.includes('调用工具：file.read') && drawerText.includes('执行完成'), drawerText.slice(0, 500));
  await page.screenshot({ path: join(evidenceRoot, `entry-detail-${viewport.width}x${viewport.height}.png`), fullPage: true });
  await dialog.locator('button.shell-layer-close').first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  record(`${viewport.width}x${viewport.height} detail layer closes back to the entry`, await page.locator('dialog.shell-layer[open]').count() === 0 && new URL(page.url()).pathname.endsWith('/index.html'), page.url());
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
