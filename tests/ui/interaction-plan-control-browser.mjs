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
 *      the frozen `dashboard.plan` read and `POST .../plan-control`:
 *        - the plan state, execution mode and next due time are the facts of the
 *          read, not an inference;
 *        - only the controls the read says are available are rendered;
 *        - one click issues exactly one control request with no extra
 *          confirmation step, and the card then shows the re-read state;
 *        - a typed control rejection renders code/owner/message/nextAction;
 *        - a task whose dashboard read has no `plan` renders no plan section.
 *
 *   B. Real composed runtime proof. An isolated `serve --mode rcc` process
 *      (never the shared instance) persists a real scheduled plan through the
 *      real entry page, and the real `task-dashboard.html` then pauses, resumes
 *      and cancels it while a real subscription file records the truth. This
 *      section needs the runtime/HTTP half of the frozen interface. Set
 *      `PLAN_CONTROL_SKIP_REAL=1` to run sections 0/A only.
 *
 * Environment:
 *   PLAN_CONTROL_EVIDENCE   required; execution-owned evidence root
 *   PLAN_CONTROL_UI_ROOT    optional; built UI root (default dist/app/ui)
 *   PLAN_CONTROL_SKIP_REAL  '1' to skip section B
 *   PLAN_CONTROL_RCC_BASE_URL  default http://127.0.0.1:4444
 *   PLAN_CONTROL_RCC_MODEL     default goaichat.glm-5.3
 *   PLAN_CONTROL_PLAYWRIGHT    default /opt/homebrew/lib/node_modules/playwright/index.js
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.PLAN_CONTROL_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.PLAN_CONTROL_EVIDENCE?.trim();
const skipReal = process.env.PLAN_CONTROL_SKIP_REAL === '1';
const rccBaseUrl = (process.env.PLAN_CONTROL_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const rccModel = process.env.PLAN_CONTROL_RCC_MODEL ?? 'goaichat.glm-5.3';
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
  const idempotencyKey = 'plan-control:task-a:pause:1';
  const calls = [];
  const api = createRuntimeApi({
    baseUrl: 'http://runtime.test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        subscriptionId: 'subscription-a',
        action: 'pause',
        status: 'applied',
        policyRevision: 'policy-r1',
        scheduleRevision: 'schedule-r1',
        idempotencyKey,
        requestHash: 'sha256:request',
        supersededUnclaimedOccurrences: 0,
        controlRef: 'control://subscription-a/pause/1',
      });
    },
  });

  const result = await api.planControl('task-a', { action: 'pause', idempotencyKey, requestedAt });
  const call = calls.at(-1);
  const url = new URL(call.url);
  const body = JSON.parse(call.init.body);
  observe('plan-control request', { url: call.url, method: call.init.method, body });
  record('plan-control posts to the frozen task-scoped route',
    url.pathname === '/api/tasks/task-a/plan-control' && call.init.method === 'POST',
    { pathname: url.pathname, method: call.init.method });
  record('plan-control sends exactly the frozen body fields',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['action', 'idempotencyKey', 'requestedAt'])
      && body.action === 'pause'
      && body.idempotencyKey === idempotencyKey
      && body.requestedAt === requestedAt,
    body);
  record('plan-control returns the frozen success body to the caller',
    result.status === 'applied' && result.subscriptionId === 'subscription-a',
    result);

  // A caller that tries to name the subscription must not be able to send it:
  // the runtime owns which plan a task resolves to.
  calls.length = 0;
  await api.planControl('task-a', {
    action: 'resume',
    idempotencyKey: 'plan-control:task-a:resume:1',
    requestedAt,
    subscriptionId: 'subscription-smuggled',
  });
  const smuggledBody = JSON.parse(calls.at(-1).init.body);
  record('plan-control never forwards a subscription id',
    !('subscriptionId' in smuggledBody) && !calls.at(-1).init.body.includes('subscription-smuggled'),
    smuggledBody);

  // The task id is path-encoded.
  calls.length = 0;
  await api.planControl('task/a b', { action: 'pause', idempotencyKey: 'k', requestedAt });
  record('plan-control path-encodes the task id',
    new URL(calls.at(-1).url).pathname === '/api/tasks/task%2Fa%20b/plan-control',
    calls.at(-1).url);

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
    await rejecting.planControl('task-a', { action: 'cancel-future', idempotencyKey: 'k2', requestedAt });
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
    if (path === '/api/tasks/task-plan-proof/plan-control' && request.method() === 'POST') {
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
          policyRevision: 'policy-r1',
          scheduleRevision: 'schedule-r1',
          idempotencyKey: payload.idempotencyKey,
          requestHash: 'sha256:request',
          supersededUnclaimedOccurrences: 0,
          controlRef: `control://${planState.plan.subscriptionId}/${payload.action}/0`,
        });
      }
      if (payload.action === 'pause') {
        planState.plan = { ...planState.plan, state: 'paused', canPause: false, canResume: true, canCancelFuture: true };
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
        policyRevision: 'policy-r2',
        scheduleRevision: 'schedule-r2',
        idempotencyKey: payload.idempotencyKey,
        requestHash: 'sha256:request',
        supersededUnclaimedOccurrences: payload.action === 'cancel-future' ? 3 : 0,
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
    return section?.querySelector('[data-plan-state]')?.dataset.planState === 'paused';
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
  record('plan surface shows the re-read paused state and re-arms resume',
    paused.stateValue === 'paused'
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
    rejected.stateValue === 'paused' && rejected.controls.resume === true,
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
      && stale.stateValue === 'paused',
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

function startServe(root) {
  const child = spawn(process.execPath, [
    cliPath, 'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'plan-control-proof',
    '--provider', 'rcc',
    '--model', rccModel,
    '--route', 'rcc/plan-control',
    '--rcc-base-url', rccBaseUrl,
    '--workspace', join(root, 'workspace'),
    '--control-root', join(root, 'control'),
    '--port', '0',
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr}`)), 30_000);
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
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr}`)));
  });

  return {
    ready,
    pid: child.pid,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

function runCli(args) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', fail);
    child.once('exit', (code) => (code === 0 ? settle(stdout) : fail(new Error(`cli ${args.join(' ')} exited ${String(code)}: ${stderr}`))));
  });
}

async function pairContext(context, base, workspace, controlRoot) {
  const code = JSON.parse(await runCli(['pair', '--workspace', workspace, '--control-root', controlRoot])).code;
  await context.addCookies([{
    name: 'humanagent.pairing',
    value: code,
    url: base,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

async function sectionReal(browser, artifactDir, root) {
  let serve;
  try {
    const health = await fetch(`${rccBaseUrl}/health`);
    record('real RCC endpoint answers /health', health.ok, health.status);
    serve = startServe(root);
    const launched = await serve.ready;
    const base = launched.url;
    observe('serve', { url: base, pid: serve.pid, checkpointRoot: launched.checkpointRoot });
    const workspace = join(root, 'workspace');
    const controlRoot = join(root, 'control');

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await pairContext(context, base, workspace, controlRoot);
    const page = await context.newPage();
    page.__base = base;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));

    // Persist a real scheduled plan through the real entry page.
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#entry-form textarea[name="rawInput"]');
    await page.fill('#entry-form textarea[name="rawInput"]', 'Do not ask questions. Create exactly one task: report the current date.');
    await page.selectOption('#entry-form select[name="executionMode"]', 'scheduled');
    const startAt = new Date(Date.now() + 120_000).toISOString().slice(0, 16);
    await page.fill('#entry-form input[name="scheduledStartAt"]', startAt);
    await page.click('#entry-form button[type="submit"]');
    await page.waitForFunction(() => (document.querySelector('[role="status"]')?.textContent ?? '').includes('执行计划已保存'), undefined, { timeout: 180_000 });

    const subscriptionsPath = join(launched.checkpointRoot, 'rcc', 'subscriptions.jsonl');
    const lines = (await readFile(subscriptionsPath, 'utf8')).trim().split('\n').filter(Boolean);
    const latest = JSON.parse(lines.at(-1));
    const subscriptions = Object.values(latest.payload.state.subscriptions);
    const scheduled = subscriptions.find((entry) => entry.policy.executionMode === 'scheduled');
    const taskId = scheduled?.subscription?.taskId?.value ?? scheduled?.subscription?.taskId;
    observe('real scheduled plan', { taskId, policy: scheduled?.policy, subscriptionId: scheduled?.subscription?.subscriptionId });
    record('real scheduled plan is persisted before the control run', Boolean(scheduled) && Boolean(taskId), { taskId });

    // The real dashboard page must report the persisted plan and offer pause.
    await page.goto(`${base}/task-dashboard.html?task=${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-plan-section]', { timeout: 30_000 }).catch(() => {});
    const read = await readPlanSurface(page);
    observe('real plan read', read);
    record('real dashboard read reports the persisted plan state and due time',
      read.sectionPresent && read.stateValue === 'active' && read.modeValue === 'scheduled' && read.nextDueValue !== '',
      read);
    record('real dashboard read offers pause for an active plan', read.controls.pause === true, read);

    // Pause: the real plan must become paused and stop dispatching.
    const realPauseClicked = await clickControl(page, 'pause');
    await page.waitForFunction(() => document.querySelector('[data-plan-section] [data-plan-state]')?.dataset.planState === 'paused', undefined, { timeout: 30_000 }).catch(() => {});
    const paused = await readPlanSurface(page);
    const pausedState = JSON.parse((await readFile(subscriptionsPath, 'utf8')).trim().split('\n').filter(Boolean).at(-1));
    const pausedSubscription = Object.values(pausedState.payload.state.subscriptions)
      .find((entry) => entry.policy.executionMode === 'scheduled');
    observe('real pause', { clicked: realPauseClicked, surface: paused, subscription: pausedSubscription?.subscription });
    record('real pause reports paused on the served page',
      realPauseClicked
        && paused.stateValue === 'paused' && paused.controls.pause === false && paused.controls.resume === true,
      paused);
    record('real pause is durable in the runtime plan state',
      pausedSubscription?.subscription?.state === 'paused',
      pausedSubscription?.subscription);

    // Resume: the plan re-arms.
    const realResumeClicked = await clickControl(page, 'resume');
    await page.waitForFunction(() => document.querySelector('[data-plan-section] [data-plan-state]')?.dataset.planState === 'active', undefined, { timeout: 30_000 }).catch(() => {});
    const resumed = await readPlanSurface(page);
    const resumedState = JSON.parse((await readFile(subscriptionsPath, 'utf8')).trim().split('\n').filter(Boolean).at(-1));
    const resumedSubscription = Object.values(resumedState.payload.state.subscriptions)
      .find((entry) => entry.policy.executionMode === 'scheduled');
    observe('real resume', { clicked: realResumeClicked, surface: resumed, subscription: resumedSubscription?.subscription });
    record('real resume re-arms the served page and the runtime plan',
      realResumeClicked
        && resumed.stateValue === 'active' && resumed.controls.pause === true && resumedSubscription?.subscription?.state === 'active',
      { surface: resumed, subscription: resumedSubscription?.subscription });

    // Cancel future: the plan is cancelled.
    const realCancelClicked = await clickControl(page, 'cancel-future');
    await page.waitForFunction(() => document.querySelector('[data-plan-section] [data-plan-state]')?.dataset.planState === 'cancelled', undefined, { timeout: 30_000 }).catch(() => {});
    const cancelled = await readPlanSurface(page);
    const cancelledState = JSON.parse((await readFile(subscriptionsPath, 'utf8')).trim().split('\n').filter(Boolean).at(-1));
    const cancelledSubscription = Object.values(cancelledState.payload.state.subscriptions)
      .find((entry) => entry.policy.executionMode === 'scheduled');
    observe('real cancel-future', { clicked: realCancelClicked, surface: cancelled, subscription: cancelledSubscription?.subscription });
    record('real cancel-future reports cancelled on the served page and in the runtime plan',
      realCancelClicked
        && cancelled.stateValue === 'cancelled'
        && cancelled.controls.pause === false
        && cancelled.controls.resume === false
        && cancelled.controls['cancel-future'] === false
        && cancelledSubscription?.subscription?.state === 'cancelled',
      { surface: cancelled, subscription: cancelledSubscription?.subscription });

    // A plan-less task must render no plan section on the real runtime.
    await page.goto(`${base}/task-dashboard.html?task=task-without-plan`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const planLess = await readPlanSurface(page);
    record('real runtime renders no plan section for a task without a persisted plan',
      planLess.sectionPresent === false,
      planLess);

    observe('real page errors', [...pageErrors]);
    record('real plan-control page raises no page errors', pageErrors.length === 0, pageErrors);
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
