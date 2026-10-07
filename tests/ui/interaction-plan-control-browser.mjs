#!/usr/bin/env node

/**
 * Proof for the docs/ui plan-control surface (frozen plan-control interface).
 *
 * Three sections:
 *
 *   0. Node-level unit checks for the typed client method
 *      (`docs/ui/runtime-api.js` `planControl`): the exact frozen request shape,
 *      that a caller cannot smuggle a `subscriptionId`, and that a typed
 *      rejection becomes a `RuntimeApiError` carrying code/owner/nextAction.
 *
 *   A. Deterministic real-browser proof over the real served
 *      `task-dashboard.html`, driven by a scripted runtime API that implements
 *      the frozen `dashboard.plan` read and `POST .../control`:
 *        - the plan state, execution mode and next due time are the facts of the
 *          read, not an inference;
 *        - only the controls the read says are available are rendered;
 *        - one click issues exactly one control request with no extra
 *          confirmation step, and the card then shows the re-read state;
 *        - a typed control rejection renders code/owner/message/nextAction;
 *        - a 200 `stale` result is not presented as an applied control;
 *        - a task whose dashboard read has no `plan` renders no plan section.
 *
 *   B. Real composed runtime proof. An isolated `serve --mode rcc` process
 *      (never the shared instance) persists a real scheduled plan through the
 *      real public explicit-flow routes, and the real `task-dashboard.html` then
 *      pauses, resumes and cancels it while a real subscription file records the
 *      truth. This section needs the runtime/HTTP half of the frozen interface.
 *      Set `PLAN_CONTROL_SKIP_REAL=1` to run sections 0/A only.
 *
 *      Seeding is deliberately done over the public HTTP routes and not through
 *      the browser entry form. The entry form's first submit calls the live
 *      provider `/interpret`, so its wall-clock latency is provider-bound and
 *      the earlier 180_000ms dispatch wait here was measuring provider tail, not
 *      the plan-control contract under test. The explicit-flow routes
 *      (`/matching` → `/match` → `/proposal` → `/confirmation`) are the same
 *      seeded entry the production RCC scheduler acceptance uses, so the plan
 *      that gets controlled here is the same kind of plan a real confirmation
 *      produces.
 *
 *      The plan is confirmed with a PAST `startAt`. A scheduled confirmation
 *      only exists in `/api/runtime/scheduler`; the occurrence task it claims is
 *      what links a task's `dashboard.plan` back to the subscription, and the
 *      scheduler only claims a due occurrence. Waiting out a future `startAt`
 *      would push this proof onto provider execution latency for no additional
 *      assertion, so the occurrence is claimed immediately and the control edge
 *      is exercised against a plan that is already durable and active.
 *
 * Environment:
 *   PLAN_CONTROL_EVIDENCE   required; execution-owned evidence root
 *   PLAN_CONTROL_UI_ROOT    optional; built UI root (default dist/app/ui)
 *   PLAN_CONTROL_SKIP_REAL  '1' to skip section B
 *   PLAN_CONTROL_RCC_BASE_URL  default http://127.0.0.1:4444
 *   PLAN_CONTROL_RCC_MODEL     default gpt-5.5
 *   PLAN_CONTROL_PLAYWRIGHT    default /opt/homebrew/lib/node_modules/playwright/index.js
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAttemptAuth } from '../app/dashboard-e2e/lib/auth.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.PLAN_CONTROL_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.PLAN_CONTROL_EVIDENCE?.trim();
const skipReal = process.env.PLAN_CONTROL_SKIP_REAL === '1';
const rccBaseUrl = (process.env.PLAN_CONTROL_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const rccModel = process.env.PLAN_CONTROL_RCC_MODEL ?? 'gpt-5.5';
const cliPath = resolve(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js');

if (!evidenceRoot) {
  throw new Error('PLAN_CONTROL_EVIDENCE is required; point it at an execution-owned directory');
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

function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

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

// ---------------------------------------------------------------------------
// Section 0: typed client method (node, no browser)
// ---------------------------------------------------------------------------

const FROZEN_ACTIONS = Object.freeze(['pause', 'resume', 'cancel-future']);

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

async function sectionClientUnit() {
  const { createRuntimeApi, RuntimeApiError } = await import(
    pathToFileURL(join(uiRoot, 'runtime-api.js')).href
  );

  const baseApi = createRuntimeApi({ baseUrl: 'http://runtime.test', fetchImpl: async () => jsonResponse({}) });
  record('runtime api exposes the plan-control client method', typeof baseApi.planControl === 'function', {
    type: typeof baseApi.planControl,
  });
  if (typeof baseApi.planControl !== 'function') return;

  const requestedAt = '2026-10-06T10:00:00.000Z';
  const subscriptionId = 'subscription:a';
  const idempotencyKey = 'plan-control:subscription-a:pause:1';
  const calls = [];
  const api = createRuntimeApi({
    baseUrl: 'http://runtime.test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (new URL(url).pathname === '/api/runtime/scheduler') {
        return jsonResponse({ plans: [{ subscriptionId, goalId: 'goal:a', scheduleRevision: 3, state: 'active', currentOccurrenceOrdinal: 0 }] });
      }
      return jsonResponse({
        subscriptionId,
        action: 'pause',
        status: 'applied',
        policyRevision: 1,
        scheduleRevision: 4,
        idempotencyKey,
        requestHash: 'sha256:request',
        supersededUnclaimedOccurrences: [],
        controlRef: 'control://subscription-a/pause/1',
      });
    },
  });

  const planList = await api.scheduler();
  const result = await api.planControl(subscriptionId, { action: 'pause', idempotencyKey, requestedAt });
  const call = calls.at(-1);
  const url = new URL(call.url);
  const body = JSON.parse(call.init.body);
  observe('plan-control request', { url: call.url, method: call.init.method, body });
  record('scheduler read exposes plan list',
    planList.plans?.[0]?.subscriptionId === subscriptionId && planList.plans?.[0]?.scheduleRevision === 3,
    planList);
  record('plan-control posts to the frozen plan-scoped route',
    url.pathname === `/api/plans/${encodeURIComponent(subscriptionId)}/control` && call.init.method === 'POST',
    { pathname: url.pathname, method: call.init.method });
  record('plan-control sends exactly the frozen body fields',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['action', 'idempotencyKey', 'requestedAt'])
      && body.action === 'pause'
      && body.idempotencyKey === idempotencyKey
      && body.requestedAt === requestedAt
      && !('subscriptionId' in body),
    body);
  record('plan-control returns numeric durable revisions verbatim',
    result.status === 'applied'
      && result.subscriptionId === subscriptionId
      && result.policyRevision === 1
      && result.scheduleRevision === 4
      && Array.isArray(result.supersededUnclaimedOccurrences),
    result);

  // The subscription id is path-encoded and cannot be injected into the body.
  calls.length = 0;
  await api.planControl('subscription/a b', {
    action: 'resume',
    idempotencyKey: 'plan-control:subscription-encoded:resume:1',
    requestedAt,
    subscriptionId: 'subscription-smuggled',
  });
  const encodedCall = calls.at(-1);
  const encodedBody = JSON.parse(encodedCall.init.body);
  record('plan-control path-encodes the subscription id and strips body injection',
    new URL(encodedCall.url).pathname === '/api/plans/subscription%2Fa%20b/control'
      && !('subscriptionId' in encodedBody)
      && !encodedCall.init.body.includes('subscription-smuggled'),
    { url: encodedCall.url, body: encodedBody });

  // Typed rejection keeps code/owner/message/nextAction.
  const rejecting = createRuntimeApi({
    baseUrl: 'http://runtime.test',
    fetchImpl: async () => jsonResponse({
      error: {
        code: 'execution-plan.control.conflict',
        ownerId: 'humanagent.runtime.scheduler',
        message: 'the plan already changed',
        nextAction: 're-read the plan and choose again',
      },
    }, 409),
  });
  let rejection;
  try {
    await rejecting.planControl(subscriptionId, { action: 'cancel-future', idempotencyKey: 'k2', requestedAt });
  } catch (error) {
    rejection = error;
  }
  record('plan-control surfaces a typed rejection as RuntimeApiError',
    rejection instanceof RuntimeApiError
      && rejection.code === 'execution-plan.control.conflict'
      && rejection.ownerId === 'humanagent.runtime.scheduler'
      && rejection.message === 'the plan already changed'
      && rejection.nextAction === 're-read the plan and choose again'
      && rejection.status === 409,
    rejection && {
      name: rejection.name,
      code: rejection.code,
      ownerId: rejection.ownerId,
      message: rejection.message,
      nextAction: rejection.nextAction,
      status: rejection.status,
    });
}

// ---------------------------------------------------------------------------
// Static UI server
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Section A: deterministic browser proof over the served task dashboard
// ---------------------------------------------------------------------------

function dashboardBody({ taskId, plan }) {
  return {
    taskId,
    taskTitle: '读取授权来源并交付摘要',
    state: 'running',
    stateLabel: '运行中',
    statusSections: { business: '运行中', waiting: '等待 provider' },
    currentNode: 'pipeline.execute',
    mode: 'interaction',
    nextStep: '等待下一次到期',
    input: '读取授权来源',
    output: '尚无输出',
    error: null,
    checkpoint: null,
    allowedActions: ['stop'],
    recentEvents: [],
    ...(plan === undefined ? {} : { plan }),
  };
}

function readPlanSurface(page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-plan-section]');
    const control = (action) => document.querySelector(`[data-plan-action="${action}"]`);
    return {
      sectionPresent: Boolean(section),
      subscriptionId: section?.dataset.planSubscription ?? '',
      stateText: section?.querySelector('[data-plan-state]')?.textContent ?? '',
      stateValue: section?.querySelector('[data-plan-state]')?.dataset.planState ?? '',
      modeText: section?.querySelector('[data-plan-mode]')?.textContent ?? '',
      modeValue: section?.querySelector('[data-plan-mode]')?.dataset.planMode ?? '',
      nextDueText: section?.querySelector('[data-plan-next-due]')?.textContent ?? '',
      nextDueValue: section?.querySelector('[data-plan-next-due]')?.dataset.planNextDue ?? '',
      statusText: section?.querySelector('[data-plan-status]')?.textContent ?? '',
      controls: {
        pause: Boolean(control('pause')),
        resume: Boolean(control('resume')),
        'cancel-future': Boolean(control('cancel-future')),
      },
      controlLabels: {
        pause: control('pause')?.textContent ?? '',
        resume: control('resume')?.textContent ?? '',
        'cancel-future': control('cancel-future')?.textContent ?? '',
      },
      disabled: {
        pause: control('pause')?.disabled ?? null,
        resume: control('resume')?.disabled ?? null,
        'cancel-future': control('cancel-future')?.disabled ?? null,
      },
      pageText: document.body.innerText,
    };
  });
}

async function clickControl(page, action) {
  const locator = page.locator(`[data-plan-action="${action}"]`);
  if (await locator.count() === 0) return false;
  await locator.first().click();
  return true;
}

async function sectionDeterministic(browser, baseUrl, artifactDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('dialog', (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.dismiss();
  });

  const NEXT_DUE_AT = '2026-10-07T09:30:00.000Z';
  const planState = {
    taskId: 'task-plan-proof',
    plan: {
      subscriptionId: 'subscription-plan-proof',
      state: 'active',
      executionMode: 'scheduled',
      nextDueAt: NEXT_DUE_AT,
      canPause: true,
      canResume: false,
      canCancelFuture: true,
    },
    controlFails: false,
    controlStale: false,
  };
  const controlRequests = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (payload, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
    if (path === '/api/runtime/status') {
      return body({ state: 'ready', mode: 'fake', providerState: 'ready', connected: true });
    }
    if (path === '/api/dashboard') {
      return body({ hasRunning: true, taskCount: 1, waitingDecisionCount: 0, recentFailures: [] });
    }
    if (path === '/api/tasks') {
      return body({ draft: [], waiting: [], running: [], completed: [], stopped: [] });
    }
    if (path === '/api/tasks/task-plan-proof/dashboard') {
      return body(dashboardBody({ taskId: planState.taskId, plan: planState.plan }));
    }
    if (path === '/api/tasks/task-plan-less/dashboard') {
      return body(dashboardBody({ taskId: 'task-plan-less' }));
    }
    if (path === `/api/plans/${encodeURIComponent(planState.plan.subscriptionId)}/control` && request.method() === 'POST') {
      const payload = request.postDataJSON();
      controlRequests.push(payload);
      if (planState.controlFails) {
        return body({
          error: {
            code: 'execution-plan.control.conflict',
            ownerId: 'humanagent.runtime.scheduler',
            message: '计划已被其他控制改变',
            nextAction: '重新读取计划后再选择控制',
          },
        }, 409);
      }
      // The runtime applied the control and the next read reports the new fact.
      if (planState.controlStale) {
        return body({
          subscriptionId: planState.plan.subscriptionId,
          action: payload.action,
          status: 'stale',
          policyRevision: 1,
          scheduleRevision: 1,
          idempotencyKey: payload.idempotencyKey,
          requestHash: 'sha256:request',
          supersededUnclaimedOccurrences: [],
          controlRef: `control://${planState.plan.subscriptionId}/${payload.action}/0`,
        });
      }
      if (payload.action === 'pause') {
        planState.plan = { ...planState.plan, state: 'suspended', canPause: false, canResume: true, canCancelFuture: true };
      }
      if (payload.action === 'resume') {
        planState.plan = { ...planState.plan, state: 'active', canPause: true, canResume: false, canCancelFuture: true };
      }
      if (payload.action === 'cancel-future') {
        planState.plan = { ...planState.plan, state: 'cancelled', canPause: false, canResume: false, canCancelFuture: false };
      }
      return body({
        subscriptionId: planState.plan.subscriptionId,
        action: payload.action,
        status: 'applied',
        policyRevision: 2,
        scheduleRevision: 2,
        idempotencyKey: payload.idempotencyKey,
        requestHash: 'sha256:request',
        supersededUnclaimedOccurrences: payload.action === 'cancel-future' ? ['occurrence:c-1', 'occurrence:c-2', 'occurrence:c-3'] : [],
        controlRef: `control://${planState.plan.subscriptionId}/${payload.action}/1`,
      });
    }
    return body({ error: { code: 'not-found', message: `unexpected route ${request.method()} ${path}`, ownerId: 'test', nextAction: 'none' } }, 404);
  });

  // --- real plan: facts from the read, only the available controls ---------
  await page.goto(`${baseUrl}/task-dashboard.html?task=task-plan-proof`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-plan-section]', { timeout: 15_000 }).catch(() => {});
  const active = await readPlanSurface(page);
  observe('deterministic active plan surface', active);
  record('plan section renders the real read facts',
    active.sectionPresent
      && active.stateValue === 'active'
      && active.modeValue === 'scheduled'
      && active.nextDueValue === NEXT_DUE_AT
      && active.nextDueText !== ''
      && active.nextDueText !== '未提供',
    active);
  record('plan section renders only the controls the read marks available',
    active.controls.pause === true
      && active.controls.resume === false
      && active.controls['cancel-future'] === true
      && active.disabled.pause === false
      && active.disabled['cancel-future'] === false,
    active);
  record('plan section keeps the technical subscription identity out of the human summary',
    active.subscriptionId === 'subscription-plan-proof' && !active.pageText.includes('subscription-plan-proof'),
    { subscriptionId: active.subscriptionId, pageText: active.pageText.slice(0, 400) });

  // --- one click, one control request, then the re-read state --------------
  // A red base renders no control, so the click is attempted only when the read
  // says it is available and the missing control is recorded as a failure.
  controlRequests.length = 0;
  const pauseClicked = await clickControl(page, 'pause');
  await page.waitForFunction(() => {
    const section = document.querySelector('[data-plan-section]');
    return section?.querySelector('[data-plan-state]')?.dataset.planState === 'suspended';
  }, undefined, { timeout: 15_000 }).catch(() => {});
  const paused = await readPlanSurface(page);
  observe('deterministic pause', { clicked: pauseClicked, requests: [...controlRequests], surface: paused });
  const pauseRequest = controlRequests[0];
  record('one pause click issues exactly one frozen control request',
    pauseClicked
      && controlRequests.length === 1
      && pauseRequest?.action === 'pause'
      && typeof pauseRequest?.idempotencyKey === 'string'
      && pauseRequest.idempotencyKey.length > 0
      && !Number.isNaN(Date.parse(pauseRequest?.requestedAt ?? ''))
      && !('subscriptionId' in (pauseRequest ?? {})),
    controlRequests);
  record('pause needs no extra confirmation step', dialogs.length === 0, dialogs);
  record('plan surface shows the re-read suspended state and re-arms resume',
    paused.stateValue === 'suspended'
      && paused.controls.pause === false
      && paused.controls.resume === true
      && paused.statusText.includes('已生效'),
    paused);

  // --- typed rejection renders code/owner/message/nextAction ---------------
  planState.controlFails = true;
  controlRequests.length = 0;
  const cancelClicked = await clickControl(page, 'cancel-future');
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-plan-status]')?.textContent ?? '';
    return status.includes('execution-plan.');
  }, undefined, { timeout: 15_000 }).catch(() => {});
  const rejected = await readPlanSurface(page);
  observe('deterministic typed rejection', { clicked: cancelClicked, requests: [...controlRequests], surface: rejected });
  record('typed control rejection renders code, owner, message and next action',
    cancelClicked
      && rejected.statusText.includes('execution-plan.control.conflict')
      && rejected.statusText.includes('humanagent.runtime.scheduler')
      && rejected.statusText.includes('计划已被其他控制改变')
      && rejected.statusText.includes('重新读取计划后再选择控制'),
    rejected.statusText);
  record('a rejected control does not claim the plan changed',
    rejected.stateValue === 'suspended' && rejected.controls.resume === true,
    rejected);

  // --- a 200 `stale` result must not be presented as success --------------
  planState.controlFails = false;
  planState.controlStale = true;
  controlRequests.length = 0;
  const resumeClicked = await clickControl(page, 'resume');
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-plan-status]')?.textContent ?? '';
    return status.includes('未生效');
  }, undefined, { timeout: 15_000 }).catch(() => {});
  const stale = await readPlanSurface(page);
  observe('deterministic stale control', { clicked: resumeClicked, requests: [...controlRequests], surface: stale });
  record('a stale control result is not presented as an applied control',
    resumeClicked
      && stale.statusText.includes('未生效')
      && !stale.statusText.includes('已生效')
      && stale.statusText.includes('policy=1')
      && stale.statusText.includes('schedule=1')
      && stale.stateValue === 'suspended',
    stale.statusText);

  // --- a plan-less task renders no plan section ----------------------------
  await page.goto(`${baseUrl}/task-dashboard.html?task=task-plan-less`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.page-heading', { timeout: 15_000 }).catch(() => {});
  await sleep(250);
  const planLess = await readPlanSurface(page);
  observe('deterministic plan-less surface', planLess);
  record('a task without a persisted plan renders no plan section',
    planLess.sectionPresent === false
      && !planLess.pageText.includes('执行计划')
      && !planLess.pageText.includes('暂停计划'),
    planLess);

  await page.screenshot({ path: join(artifactDir, 'plan-control-deterministic.png'), fullPage: true });
  observe('deterministic page errors', [...pageErrors]);
  record('plan-control pages raise no page errors', pageErrors.length === 0, pageErrors);
  await context.close();
}

// ---------------------------------------------------------------------------
// Section B: real composed runtime
// ---------------------------------------------------------------------------

function startServe(binding) {
  const env = { ...process.env };
  const userHome = env.HOME;
  delete env.HOME;
  env.HOME = binding.attemptRoot;
  if ((env.XDG_CONFIG_HOME ?? '') === '' && userHome) {
    env.XDG_CONFIG_HOME = join(userHome, '.config');
  }

  const child = spawn(process.execPath, [
    cliPath, 'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'plan-control-proof',
    '--provider', 'rcc',
    '--model', rccModel,
    '--route', 'rcc/plan-control',
    '--rcc-base-url', rccBaseUrl,
    '--workspace', binding.workspace,
    '--control-root', binding.controlRoot,
    '--port', '0',
  ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr.slice(-2000)}`)), 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/\{[\s\S]*?\n\}/);
      if (!match) return;
      try {
        const parsed = JSON.parse(match[0]);
        clearTimeout(timer);
        settle(parsed);
      } catch {
        // keep buffering until the JSON object is complete
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr.slice(-2000)}`)));
  });

  return {
    ready,
    pid: child.pid,
    stderr: () => stderr.slice(-4000),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

async function schedulerPlans(auth) {
  const scheduler = await auth.json('/api/runtime/scheduler');
  return scheduler.plans ?? [];
}

async function waitForSchedulerPlan(auth, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const plans = await schedulerPlans(auth);
    last = plans;
    const plan = plans.find(predicate);
    if (plan) return plan;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for scheduler plan; last=${JSON.stringify(last).slice(0, 1200)}`);
    }
    await sleep(500);
  }
}

/**
 * Confirm one `scheduled` execution policy through the real public explicit-flow
 * routes. These are the seeded routes the production RCC scheduler acceptance
 * uses: no live provider call, so the plan is durable within a bounded time.
 */
async function confirmScheduledPlan(auth, rawInput, startAt) {
  // `auth.json` forwards the body to fetch, which needs a string.
  const post = (path, body) => auth.json(path, { method: 'POST', body: JSON.stringify(body) });

  const created = await post('/api/explicit/inputs', {
    sourceRef: 'ui:plan-control-proof',
    rawInput,
    channel: 'business',
    requestKind: 'new-task-preview',
    inputRevision: 1,
  });
  const interactionId = created.interactionId;
  const route = `/api/explicit/interactions/${encodeURIComponent(interactionId)}`;
  await post(`${route}/matching`, {});
  await post(`${route}/match`, { normalizedInput: rawInput, matchedTasks: [], knownFacts: [] });
  await post(`${route}/proposal`, { proposedIntent: 'create', proposal: `create:${rawInput}` });
  const snapshot = await auth.json(route);
  const confirmed = await post(`${route}/confirmation`, {
    draftId: snapshot.draft.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:plan-control-proof',
    confirmedBy: 'human:operator',
    confirmedAt: new Date().toISOString(),
    payloadRef: 'asset://requirements/plan-control-proof',
    executionPolicy: {
      policyId: 'policy-plan-control-proof',
      policyRevision: 1,
      timezone: 'UTC',
      canonicalInstant: new Date().toISOString(),
      dstMode: 'wall',
      dstMissedPolicy: 'shift-forward',
      dstAmbiguousPolicy: 'earlier-offset',
      latePolicy: 'run-once',
      busyPolicy: 'skip',
      executionMode: 'scheduled',
      startAt,
    },
  });
  return { requirementId: confirmed.requirement?.requirementId ?? null, subscriptionId: `subscription:${confirmed.requirement?.requirementId ?? ''}` };
}

/**
 * Every task row the real `/api/tasks` projection exposes. The projection has
 * fixed section keys, so this reads all array sections rather than guessing
 * names.
 */
function taskRowsOf(body) {
  return Object.values(body).filter(Array.isArray).flat();
}

async function findPlanLinkedTask(auth, subscriptionId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const rows = taskRowsOf(await auth.json('/api/tasks'));
    last = rows;
    for (const row of rows) {
      const taskIdValue = row.taskId?.value;
      if (taskIdValue === undefined) continue;
      const dashboard = await auth.json(`/api/tasks/${encodeURIComponent(taskIdValue)}/dashboard`);
      if (dashboard.plan?.subscriptionId === subscriptionId) {
        return { taskId: taskIdValue, plan: dashboard.plan };
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`no task is linked to ${subscriptionId}; rows=${JSON.stringify(last).slice(0, 1200)}`);
    }
    await sleep(500);
  }
}

/**
 * The same link lookup, but absence is a legitimate answer: a plan that has not
 * dispatched anything has no task bound to it, and that is exactly the fact a
 * suspended plan has to prove at its due time.
 */
async function findPlanLinkedTaskOrUndefined(auth, subscriptionId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = taskRowsOf(await auth.json('/api/tasks'));
    for (const row of rows) {
      const taskIdValue = row.taskId?.value;
      if (taskIdValue === undefined) continue;
      const dashboard = await auth.json(`/api/tasks/${encodeURIComponent(taskIdValue)}/dashboard`);
      if (dashboard.plan?.subscriptionId === subscriptionId) return { taskId: taskIdValue, plan: dashboard.plan };
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(250);
  }
}

/**
 * The plan list renders one section per persisted plan, so a read or a click
 * has to name the plan it belongs to. Plan A's result must never be read as
 * plan B's.
 */
function readScopedPlanSurface(page, subscriptionId) {
  return page.evaluate((id) => {
    const section = [...document.querySelectorAll('[data-plan-section]')]
      .find((node) => node.dataset.planSubscription === id);
    const control = (action) => section?.querySelector(`[data-plan-action="${action}"]`);
    return {
      sectionPresent: Boolean(section),
      subscriptionId: section?.dataset.planSubscription ?? '',
      stateText: section?.querySelector('[data-plan-state]')?.textContent ?? '',
      stateValue: section?.querySelector('[data-plan-state]')?.dataset.planState ?? '',
      modeText: section?.querySelector('[data-plan-mode]')?.textContent ?? '',
      modeValue: section?.querySelector('[data-plan-mode]')?.dataset.planMode ?? '',
      nextDueText: section?.querySelector('[data-plan-next-due]')?.textContent ?? '',
      nextDueValue: section?.querySelector('[data-plan-next-due]')?.dataset.planNextDue ?? '',
      statusText: section?.querySelector('[data-plan-status]')?.textContent ?? '',
      controls: {
        pause: Boolean(control('pause')),
        resume: Boolean(control('resume')),
        'cancel-future': Boolean(control('cancel-future')),
      },
      pageText: document.body.innerText,
    };
  }, subscriptionId);
}

async function clickScopedControl(page, subscriptionId, action) {
  const locator = page.locator(`[data-plan-section][data-plan-subscription="${subscriptionId}"] [data-plan-action="${action}"]`);
  if (await locator.count() === 0) return false;
  await locator.first().click();
  return true;
}

async function sectionReal(browser, artifactDir, root) {
  const binding = {
    attemptId: 'plan-control-proof',
    attemptRoot: root,
    workspace: join(root, 'workspace'),
    controlRoot: join(root, 'control'),
    repoPath: repoRoot,
  };
  await mkdir(binding.workspace, { recursive: true });
  await mkdir(binding.controlRoot, { recursive: true });
  let serve;
  try {
    serve = startServe(binding);
    const launched = await serve.ready;
    const base = launched.url ?? launched.baseUrl;
    if (!base) throw new Error(`serve banner did not include a URL: ${JSON.stringify(launched).slice(0, 800)}`);
    binding.serveBaseUrl = base;
    binding.serveControlRoot = launched.controlRoot ?? null;
    binding.serveCheckpointRoot = launched.checkpointRoot ?? null;
    observe('serve', { url: base, pid: serve.pid, checkpointRoot: launched.checkpointRoot, controlRoot: launched.controlRoot });

    const auth = createAttemptAuth(binding);
    await auth.pair();
    await auth.json('/api/liveness');
    record('real serve accepts the attempt pairing session', auth.paired === true, { url: base });

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await auth.installBrowserContext(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
    });

    // Persist a real scheduled plan through the real public explicit-flow routes,
    // with a past startAt so the scheduler claims the occurrence immediately.
    const requirement = await confirmScheduledPlan(
      auth,
      'report the current date',
      new Date(Date.now() - 60_000).toISOString(),
    );
    // Wait for the claim as well as the subscription. The scheduler lists the
    // plan as soon as it exists, but the occurrence record only appears once the
    // patrol has claimed the due slot; that claim is what binds a task to the
    // plan, so asserting on the earlier read would race the scheduler.
    const scheduled = await waitForSchedulerPlan(auth, (plan) => plan.subscriptionId === requirement.subscriptionId && plan.occurrences?.length > 0);
    const linked = await findPlanLinkedTask(auth, scheduled.subscriptionId);
    const scheduledSubscriptionId = scheduled.subscriptionId;
    const dashboardTaskId = linked.taskId;
    const dashboardPlan = linked.plan;
    observe('real scheduled plan', { requirement, scheduled, taskId: dashboardTaskId, dashboardPlan });
    record('real scheduled plan is persisted before the control run',
      scheduledSubscriptionId !== '' && scheduled.state === 'active' && scheduled.occurrences?.length > 0,
      scheduled);
    record('real task dashboard read is linked to the persisted plan',
      scheduledSubscriptionId !== ''
        && dashboardTaskId !== undefined
        && dashboardPlan.subscriptionId === scheduledSubscriptionId
        && dashboardPlan.state === 'active'
        && dashboardPlan.executionMode === 'scheduled'
        && dashboardPlan.nextDueAt !== undefined,
      dashboardPlan);

    // The real dashboard page must report the persisted plan and offer pause.
    await page.goto(`${base}/task-dashboard.html?task=${encodeURIComponent(dashboardTaskId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-plan-section]', { timeout: 30_000 });
    const read = await readPlanSurface(page);
    observe('real plan read', read);
    record('real dashboard read reports the persisted plan state and due time',
      read.sectionPresent
        && read.stateValue === 'active'
        && read.modeValue === 'scheduled'
        && read.nextDueValue !== ''
        && read.subscriptionId === scheduled.subscriptionId,
      read);
    record('real dashboard read offers pause for an active plan', read.controls.pause === true, read);

    // Pause: the real plan must become suspended and stop dispatching.
    const realPauseClicked = await clickControl(page, 'pause');
    await page.waitForFunction(() => document.querySelector('[data-plan-section] [data-plan-state]')?.dataset.planState === 'suspended', undefined, { timeout: 30_000 });
    const paused = await readPlanSurface(page);
    const pausedPlan = await waitForSchedulerPlan(auth, (plan) => plan.subscriptionId === scheduled.subscriptionId && plan.state === 'suspended');
    observe('real pause', { clicked: realPauseClicked, surface: paused, plan: pausedPlan });
    record('real pause reports suspended on the served page',
      realPauseClicked
        && paused.stateValue === 'suspended' && paused.controls.pause === false && paused.controls.resume === true,
      paused);
    record('real pause is durable in the runtime plan state',
      pausedPlan.subscriptionId === scheduled.subscriptionId && pausedPlan.state === 'suspended',
      pausedPlan);

    // Resume: the plan re-arms.
    const realResumeClicked = await clickControl(page, 'resume');
    await page.waitForFunction(() => document.querySelector('[data-plan-section] [data-plan-state]')?.dataset.planState === 'active', undefined, { timeout: 30_000 });
    const resumed = await readPlanSurface(page);
    const resumedPlan = await waitForSchedulerPlan(auth, (plan) => plan.subscriptionId === scheduled.subscriptionId && plan.state === 'active');
    observe('real resume', { clicked: realResumeClicked, surface: resumed, plan: resumedPlan });
    record('real resume re-arms the served page and the runtime plan',
      realResumeClicked
        && resumed.stateValue === 'active' && resumed.controls.pause === true && resumed.controls['cancel-future'] === true
        && resumedPlan.subscriptionId === scheduled.subscriptionId && resumedPlan.state === 'active',
      { surface: resumed, plan: resumedPlan });

    // Cancel future: the plan is cancelled.
    const realCancelClicked = await clickControl(page, 'cancel-future');
    await page.waitForFunction(() => document.querySelector('[data-plan-section] [data-plan-state]')?.dataset.planState === 'cancelled', undefined, { timeout: 30_000 });
    const cancelled = await readPlanSurface(page);
    const cancelledPlan = await waitForSchedulerPlan(auth, (plan) => plan.subscriptionId === scheduled.subscriptionId && plan.state === 'cancelled');
    observe('real cancel-future', { clicked: realCancelClicked, surface: cancelled, plan: cancelledPlan });
    record('real cancel-future reports cancelled on the served page and in the runtime plan',
      realCancelClicked
        && cancelled.stateValue === 'cancelled'
        && cancelled.controls.pause === false
        && cancelled.controls.resume === false
        && cancelled.controls['cancel-future'] === false
        && cancelledPlan.subscriptionId === scheduled.subscriptionId
        && cancelledPlan.state === 'cancelled',
      { surface: cancelled, plan: cancelledPlan });

    // The served pages raise no error of their own across the whole real
    // pause/resume/cancel-future sequence. This is evaluated here, before the
    // deliberate rejection below, because that rejection is a real 409 and the
    // browser logs every non-2xx response as a console error.
    observe('real page errors', [...pageErrors]);
    record('real plan-control page raises no page errors', pageErrors.length === 0, pageErrors);

    // The already-claimed in-flight execution the control cancelled must still
    // reach its durable terminal and settle: `cancel-future` destroys the future
    // schedule, it does not revoke an execution that was already authorized for
    // the claimed epoch.
    const inFlightSettled = await waitForSchedulerPlan(
      auth,
      (plan) => plan.subscriptionId === scheduledSubscriptionId && (plan.settlements ?? []).length > 0,
      180_000,
    );
    observe('real cancel-future in-flight settlement', inFlightSettled);
    record('real cancel-future leaves the already-claimed in-flight execution settling',
      inFlightSettled.state === 'cancelled' && (inFlightSettled.settlements ?? []).length >= 1,
      inFlightSettled);

    // --- a real task with no persisted plan renders no plan section ----------
    const planLessCreated = await auth.json('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'plan-control-proof plan-less task', directive: 'report the current date' }),
    });
    const planLessTaskId = planLessCreated.taskId?.value ?? planLessCreated.taskId;
    const planLessRead = await auth.json(`/api/tasks/${encodeURIComponent(planLessTaskId)}/dashboard`);
    observe('real plan-less task read', { taskId: planLessTaskId, plan: planLessRead.plan });
    record('a real task with no persisted plan has no plan in its dashboard read',
      typeof planLessTaskId === 'string' && planLessTaskId !== '' && planLessRead.plan === undefined,
      { taskId: planLessTaskId, plan: planLessRead.plan });
    await page.goto(`${base}/task-dashboard.html?task=${encodeURIComponent(planLessTaskId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-heading', { timeout: 30_000 });
    await sleep(500);
    const planLessSurface = await readPlanSurface(page);
    observe('real plan-less surface', planLessSurface);
    record('a real plan-less task renders no plan section on the served page',
      planLessSurface.sectionPresent === false && !planLessSurface.pageText.includes('执行计划'),
      planLessSurface);

    // --- a real plan with no task yet: the scheduler plan list, the dispatch
    //     gating of a suspended plan, and the typed rejection a stale control
    //     earns from the production edge --------------------------------------
    const futureStartAt = new Date(Date.now() + 15_000).toISOString();
    const pending = await confirmScheduledPlan(auth, 'report the current date', futureStartAt);
    const pendingPlan = await waitForSchedulerPlan(
      auth,
      (plan) => plan.subscriptionId === pending.subscriptionId && plan.state === 'active',
      30_000,
    );
    observe('real task-less plan', pendingPlan);
    record('a real plan with no claimed task yet is listed by the scheduler',
      pendingPlan.subscriptionId === pending.subscriptionId && pendingPlan.state === 'active',
      pendingPlan);

    await page.goto(`${base}/dashboard.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (id) => [...document.querySelectorAll('[data-plan-section]')].some((node) => node.dataset.planSubscription === id),
      pending.subscriptionId,
      { timeout: 30_000 },
    );
    const listed = await readScopedPlanSurface(page, pending.subscriptionId);
    observe('real plan list surface', listed);
    record('the real scheduler plan list shows a plan that has no task yet and offers pause',
      listed.sectionPresent
        && listed.stateValue === 'active'
        && listed.controls.pause === true
        && listed.controls['cancel-future'] === true,
      listed);

    // The list polls on a fixed interval. Let one poll land first, so the stale
    // read below is measured against a freshly rendered section instead of
    // racing the page's own refresh.
    await sleep(4_200);

    // Pause the plan out of band through the same production edge, then click the
    // control the page still renders from its stale read. The port re-checks
    // inside its transaction, so the click is a real rejection and the page has
    // to render it instead of hiding it.
    await auth.json(`/api/plans/${encodeURIComponent(pending.subscriptionId)}/control`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'pause',
        idempotencyKey: `plan-control:proof:stale:${Date.now()}`,
        requestedAt: new Date().toISOString(),
      }),
    });
    const stalePauseClicked = await clickScopedControl(page, pending.subscriptionId, 'pause');
    await page.waitForFunction(
      (id) => {
        const section = [...document.querySelectorAll('[data-plan-section]')]
          .find((node) => node.dataset.planSubscription === id);
        return (section?.querySelector('[data-plan-status]')?.textContent ?? '').includes('execution-plan.');
      },
      pending.subscriptionId,
      { timeout: 30_000 },
    ).catch(() => {});
    const rejected = await readScopedPlanSurface(page, pending.subscriptionId);
    observe('real typed rejection', { clicked: stalePauseClicked, surface: rejected });
    record('a real stale control renders the typed rejection with code, owner, message and next action',
      stalePauseClicked === true
        && rejected.statusText.includes('execution-plan.invalid-state')
        && rejected.statusText.includes('humanagent.runtime')
        && rejected.statusText.includes('only active subscriptions can pause')
        && rejected.statusText.includes('next='),
      rejected.statusText);

    // Nothing may be dispatched at the due time of a suspended plan.
    await sleep(Math.max(0, Date.parse(futureStartAt) - Date.now()) + 2_000);
    const duringDue = await waitForSchedulerPlan(auth, (plan) => plan.subscriptionId === pending.subscriptionId, 30_000);
    const duringLinked = await findPlanLinkedTaskOrUndefined(auth, pending.subscriptionId, 2_000);
    observe('real suspended plan at its due time', { plan: duringDue, linkedTask: duringLinked });
    record('a suspended real plan dispatches nothing at its due time',
      duringDue.state === 'suspended'
        && (duringDue.occurrences ?? []).length === 0
        && (duringDue.settlements ?? []).length === 0
        && duringLinked === undefined,
      { plan: duringDue, linkedTask: duringLinked });

    // Resume re-arms the slot: the assertion is a real dispatch that settles, not
    // a state move back to active.
    await page.waitForFunction(
      (id) => {
        const section = [...document.querySelectorAll('[data-plan-section]')]
          .find((node) => node.dataset.planSubscription === id);
        return Boolean(section?.querySelector('[data-plan-action="resume"]'));
      },
      pending.subscriptionId,
      { timeout: 30_000 },
    ).catch(() => {});
    const resumeClicked = await clickScopedControl(page, pending.subscriptionId, 'resume');
    const dispatched = await waitForSchedulerPlan(
      auth,
      (plan) => plan.subscriptionId === pending.subscriptionId && (plan.settlements ?? []).length > 0,
      180_000,
    );
    const dispatchedTask = await findPlanLinkedTask(auth, pending.subscriptionId, 60_000);
    observe('real resumed dispatch', { clicked: resumeClicked, plan: dispatched, task: dispatchedTask });
    record('resuming a real plan dispatches a real occurrence that settles',
      resumeClicked === true
        && dispatched.state === 'active'
        && (dispatched.settlements ?? []).length === 1
        && dispatchedTask.plan.subscriptionId === pending.subscriptionId,
      { plan: dispatched, task: dispatchedTask });

    // The deliberate rejection is the only additional browser log: the page
    // itself still raises no error of its own.
    observe('real page errors after the deliberate rejection', [...pageErrors]);
    record('the deliberate rejection adds no page error beyond the browser log of its own 409',
      pageErrors.every((entry) => entry.includes('409')),
      pageErrors);
    await page.screenshot({ path: join(artifactDir, 'plan-control-real.png'), fullPage: true });
    await context.close();
  } finally {
    if (serve) await serve.stop();
  }
}

// ---------------------------------------------------------------------------

const artifactDir = join(evidenceRoot, 'artifacts');
await mkdir(artifactDir, { recursive: true });

await sectionClientUnit();

const playwrightModule = await import(
  process.env.PLAN_CONTROL_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;

const browser = await playwright.chromium.launch({ headless: true });
let server;
try {
  server = await startServer();
  await sectionDeterministic(browser, server.url, artifactDir);
} finally {
  await closeServer(server);
  if (skipReal) {
    observe('real runtime section', 'skipped via PLAN_CONTROL_SKIP_REAL=1');
  } else {
    const root = await mkdtemp(join(tmpdir(), 'plan-control-proof-'));
    await mkdir(join(root, 'workspace'), { recursive: true });
    try {
      await sectionReal(browser, artifactDir, root);
    } catch (error) {
      record('real plan-control section completed', false, error instanceof Error ? error.message : String(error));
    }
  }
  await browser.close();
}

await writeFile(
  join(evidenceRoot, 'checks.json'),
  `${JSON.stringify({ uiRoot, rccBaseUrl, rccModel, frozenActions: FROZEN_ACTIONS, checks, observations }, null, 2)}\n`,
);

const failed = checks.filter((check) => !check.pass);
console.log(`plan control browser proof: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) {
  for (const check of failed) console.error(`FAIL ${check.name}: ${JSON.stringify(check.detail)}`);
  process.exitCode = 1;
} else {
  console.log('plan control browser proof passed');
}
