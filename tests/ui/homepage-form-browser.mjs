#!/usr/bin/env node

/**
 * Real-browser proof for the homepage task-entry form (`docs/ui/index.html` +
 * `docs/ui/entry.js`).
 *
 * The user rejected the shipped homepage because the default form exposed the
 * timezone, start/end time, max occurrences, recurrence rule, interval, daily
 * time and weekday controls before any execution type was chosen. This harness
 * loads the real page in Chromium and asserts the rendered visibility (not the
 * `hidden` attribute) of every scheduling control:
 *
 *   - the default `单次` form renders exactly the task input, the execution type
 *     and the submit button;
 *   - `定时` reveals only the scheduled fields;
 *   - `周期` reveals the recurrence rule plus the fields the chosen rule needs;
 *   - returning to `单次` hides every scheduling field again;
 *   - the submitted execution policy is validated by the real typed contract
 *     (`validateExecutionPolicyDefinition`) and carries no empty optional key.
 *
 * Run:  pnpm build:contracts && node tests/ui/homepage-form-browser.mjs
 *
 * Environment:
 *   HOMEPAGE_UI_ROOT      UI root to serve (default `<repo>/docs/ui`)
 *   HOMEPAGE_EVIDENCE     evidence directory; when set, `checks.json` is written
 *   HOMEPAGE_PLAYWRIGHT   playwright entry point override
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.HOMEPAGE_UI_ROOT ?? join(repoRoot, 'docs', 'ui'));
const evidenceRoot = process.env.HOMEPAGE_EVIDENCE?.trim();
const contractPath = join(repoRoot, 'packages', 'contracts', 'dist', 'explicit-brain.js');

const playwrightModule = await import(
  process.env.HOMEPAGE_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;

const { validateExecutionPolicyDefinition } = await import(contractPath);

const SCHEDULING_FIELDS = [
  'timezone',
  'scheduledStartAt',
  'scheduledEndAt',
  'maxOccurrences',
  'recurringFrequency',
  'intervalMinutes',
  'timeOfDay',
  'weekDays',
];

const checks = [];
const observations = [];
let failures = 0;

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail });
  if (!pass) failures += 1;
}

function observe(name, value) {
  observations.push({ name, value });
}

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// Scripted runtime API (public explicit-brain contract only)
// ---------------------------------------------------------------------------

const scripted = {
  interactions: new Map(),
  interactionSeq: 0,
  tasks: [],
  confirmationBodies: [],
};

function draftFor(interaction) {
  const normalizedInput = `${interaction.rawInput} (规范化)`;
  return {
    draftId: `draft-${interaction.id}`,
    inputRevision: 1,
    normalizedInput,
    proposedIntent: 'create',
    proposal: `提交后执行：${normalizedInput}`,
    knownFacts: ['用户提供了一条业务输入'],
    matchedTasks: [],
    decisionRefs: [],
  };
}

function snapshotFor(interaction) {
  return {
    interactionId: interaction.id,
    state: interaction.state,
    sourceRef: 'ui:entry',
    rawInput: interaction.rawInput,
    owner: 'explicit-intake',
    nextAction: interaction.state === 'received' ? 'start-matching' : 'confirm-or-revise',
    ...(interaction.draft ? { draft: interaction.draft } : {}),
  };
}

async function handleScriptedApi(url, method, body) {
  if (url.pathname === '/api/runtime/status') {
    return { status: 200, body: { mode: 'scripted', state: 'ready', providerState: 'ready', connected: true } };
  }
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return {
      status: 200,
      body: { draft: [], waiting: [], running: [], completed: scripted.tasks, stopped: [], failed: [] },
    };
  }
  if (url.pathname === '/api/explicit/inputs' && method === 'POST') {
    scripted.interactionSeq += 1;
    const id = `interaction-${scripted.interactionSeq}`;
    scripted.interactions.set(id, {
      id,
      rawInput: String(body?.rawInput ?? ''),
      state: 'received',
      draft: null,
    });
    return { status: 201, body: { interactionId: id } };
  }
  const interactionMatch = /^\/api\/explicit\/interactions\/([^/]+)$/.exec(url.pathname);
  if (interactionMatch && method === 'GET') {
    const interaction = scripted.interactions.get(decodeURIComponent(interactionMatch[1]));
    if (!interaction) return { status: 404, body: { error: { code: 'interaction.not-found' } } };
    return { status: 200, body: snapshotFor(interaction) };
  }
  const interpretMatch = /^\/api\/explicit\/interactions\/([^/]+)\/interpret$/.exec(url.pathname);
  if (interpretMatch && method === 'POST') {
    const interaction = scripted.interactions.get(decodeURIComponent(interpretMatch[1]));
    if (!interaction) return { status: 404, body: { error: { code: 'interaction.not-found' } } };
    interaction.state = 'awaiting-confirmation';
    interaction.draft = draftFor(interaction);
    return { status: 200, body: snapshotFor(interaction) };
  }
  const confirmationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(url.pathname);
  if (confirmationMatch && method === 'POST') {
    const interaction = scripted.interactions.get(decodeURIComponent(confirmationMatch[1]));
    if (!interaction) return { status: 404, body: { error: { code: 'interaction.not-found' } } };
    scripted.confirmationBodies.push(body);
    interaction.state = 'confirmed';
    scripted.tasks.push({
      taskId: { value: `task-${scripted.tasks.length + 1}` },
      title: interaction.draft?.normalizedInput ?? interaction.rawInput,
      currentState: 'created',
      nextStep: 'execute',
      stateLabel: '已创建',
      updatedAt: new Date().toISOString(),
    });
    return { status: 200, body: { requirement: { requirementId: 'requirement-1', taskId: 'task-1' } } };
  }
  return { status: 404, body: { error: { code: 'scripted.route.missing', message: url.pathname } } };
}

async function startScriptedServer() {
  const server = createServer(async (request, response) => {
    request.socket.setKeepAlive(false);
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        let body;
        if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
        const result = await handleScriptedApi(url, request.method ?? 'GET', body);
        const payload = Buffer.from(JSON.stringify(result.body));
        response.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': payload.byteLength,
        });
        response.end(payload);
        return;
      }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
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
      const file = await readFile(filePath);
      response.writeHead(200, { 'content-type': mimeType(filePath), 'content-length': file.byteLength });
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((settle, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', settle);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('scripted server did not expose a port');
  server.unref();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((settle, fail) => server.close((error) => (error ? fail(error) : settle())));
}

// ---------------------------------------------------------------------------
// Page probes
// ---------------------------------------------------------------------------

function probeForm() {
  const form = document.querySelector('#entry-form');
  const isRendered = (node) => {
    if (!node) return false;
    if (node.getClientRects().length === 0) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const fields = {};
  for (const name of [
    'timezone',
    'scheduledStartAt',
    'scheduledEndAt',
    'maxOccurrences',
    'recurringFrequency',
    'intervalMinutes',
    'timeOfDay',
    'weekDays',
  ]) {
    const control = form?.elements?.namedItem(name) ?? null;
    fields[name] = {
      present: Boolean(control),
      visible: isRendered(control),
      required: Boolean(control?.required),
    };
  }
  const controls = form ? [...form.querySelectorAll('textarea, input, select, button')] : [];
  const errorPanel = document.querySelector('#entry-error');
  return {
    hasForm: Boolean(form),
    fields,
    visibleControls: controls.filter(isRendered).map((control) => control.name || 'button'),
    visibleSchedulingFields: Object.keys(fields).filter((name) => fields[name].visible),
    submitLabel: form?.querySelector('button[type="submit"]')?.textContent?.trim() ?? null,
    errorPanelHidden: errorPanel ? Boolean(errorPanel.hidden) : null,
  };
}

async function openEntryPage(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.__base = base;
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entry-form textarea[name="rawInput"]');
  return { context, page };
}

async function selectMode(page, mode, frequency) {
  await page.selectOption('#entry-form select[name="executionMode"]', mode);
  if (frequency) await page.selectOption('#entry-form select[name="recurringFrequency"]', frequency);
  await page.waitForTimeout(50);
}

async function capture(page, name) {
  if (!evidenceRoot) return;
  await mkdir(join(evidenceRoot, 'screenshots'), { recursive: true });
  await page.screenshot({ path: join(evidenceRoot, 'screenshots', `${name}.png`), fullPage: true });
}

async function submitAndCapturePolicy(page, { rawInput, mode, frequency, startAt, timeOfDay, weekDays }) {
  await page.fill('#entry-form textarea[name="rawInput"]', rawInput);
  if (mode) await page.selectOption('#entry-form select[name="executionMode"]', mode);
  if (frequency) await page.selectOption('#entry-form select[name="recurringFrequency"]', frequency);
  if (startAt) await page.fill('#entry-form input[name="scheduledStartAt"]', startAt);
  if (timeOfDay) await page.fill('#entry-form input[name="timeOfDay"]', timeOfDay);
  if (weekDays) await page.fill('#entry-form input[name="weekDays"]', weekDays);
  let captured;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/confirmation')) {
      captured = request.postDataJSON();
    }
  });
  await page.click('#entry-form button[type="submit"]');
  const deadline = Date.now() + 15_000;
  while (!captured && Date.now() < deadline) await page.waitForTimeout(100);
  if (!captured) {
    const state = await page.evaluate(() => ({
      status: (document.querySelector('[role="status"]')?.textContent || '').trim(),
      error: (document.querySelector('#entry-error')?.textContent || '').trim(),
    }));
    throw new Error(`entry form never posted a confirmation: ${JSON.stringify(state)}`);
  }
  return captured.executionPolicy;
}

function keysOf(policy) {
  return Object.keys(policy).sort();
}

function assertPolicy(name, policy, expectedKeys) {
  const keys = keysOf(policy);
  check(`${name}: execution policy carries exactly the expected typed keys`, JSON.stringify(keys) === JSON.stringify(expectedKeys), keys);
  check(
    `${name}: execution policy has no empty optional value`,
    JSON.stringify(policy).includes('""') === false,
    JSON.stringify(policy),
  );
  let contractError = null;
  try {
    validateExecutionPolicyDefinition(policy);
  } catch (error) {
    contractError = error.message;
  }
  check(`${name}: typed execution policy contract accepts the submission`, contractError === null, contractError);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function visibilityScenario(browser, base) {
  const { context, page } = await openEntryPage(browser, base);
  try {
    const once = await page.evaluate(probeForm);
    await capture(page, 'default-once');
    observe('default once form', once);
    check('default form renders the task input, execution type and submit only',
      once.hasForm
      && JSON.stringify(once.visibleControls) === JSON.stringify(['rawInput', 'executionMode', 'button']),
      once.visibleControls);
    check('default once form renders no scheduling field', once.visibleSchedulingFields.length === 0, once.visibleSchedulingFields);
    for (const name of SCHEDULING_FIELDS) {
      const field = once.fields[name];
      check(`default once form keeps ${name} present but not rendered`, field.present && !field.visible, field);
      check(`default once form does not require the hidden ${name}`, field.present && !field.required, field);
    }
    check('default once form keeps the existing submit label', once.submitLabel === '创建并执行', once.submitLabel);
    check('default once form keeps the error panel hidden', once.errorPanelHidden === true, once.errorPanelHidden);

    await selectMode(page, 'scheduled');
    const scheduled = await page.evaluate(probeForm);
    await capture(page, 'scheduled');
    observe('scheduled form', scheduled);
    check('scheduled renders timezone, start, end and max occurrences',
      ['timezone', 'scheduledStartAt', 'scheduledEndAt', 'maxOccurrences'].every((name) => scheduled.fields[name].visible),
      scheduled.visibleSchedulingFields);
    check('scheduled renders no recurrence field',
      ['recurringFrequency', 'intervalMinutes', 'timeOfDay', 'weekDays'].every((name) => !scheduled.fields[name].visible),
      scheduled.visibleSchedulingFields);
    check('scheduled keeps the visible start time required', scheduled.fields.scheduledStartAt.required === true, scheduled.fields.scheduledStartAt);
    check('scheduled keeps the visible timezone required', scheduled.fields.timezone.required === true, scheduled.fields.timezone);
    check('scheduled keeps the optional end/max fields optional',
      scheduled.fields.scheduledEndAt.required === false && scheduled.fields.maxOccurrences.required === false,
      scheduled.fields);
    check('scheduled keeps the existing submit label', scheduled.submitLabel === '保存执行计划', scheduled.submitLabel);

    await selectMode(page, 'recurring', 'interval');
    const interval = await page.evaluate(probeForm);
    await capture(page, 'recurring-interval');
    observe('recurring interval form', interval);
    check('recurring interval renders the recurrence rule and the interval only',
      interval.fields.recurringFrequency.visible
      && interval.fields.intervalMinutes.visible
      && !interval.fields.timeOfDay.visible
      && !interval.fields.weekDays.visible,
      interval.visibleSchedulingFields);

    await selectMode(page, 'recurring', 'daily');
    const daily = await page.evaluate(probeForm);
    await capture(page, 'recurring-daily');
    observe('recurring daily form', daily);
    check('recurring daily renders the daily time and hides the interval/weekdays',
      daily.fields.timeOfDay.visible
      && !daily.fields.weekDays.visible
      && !daily.fields.intervalMinutes.visible,
      daily.visibleSchedulingFields);

    await selectMode(page, 'recurring', 'weekly');
    const weekly = await page.evaluate(probeForm);
    await capture(page, 'recurring-weekly');
    observe('recurring weekly form', weekly);
    check('recurring weekly renders the daily time and the weekdays',
      weekly.fields.timeOfDay.visible && weekly.fields.weekDays.visible && !weekly.fields.intervalMinutes.visible,
      weekly.visibleSchedulingFields);

    await selectMode(page, 'once');
    const backToOnce = await page.evaluate(probeForm);
    await capture(page, 'once-after-switch');
    observe('once form after mode switch', backToOnce);
    check('switching back to once hides every scheduling field again',
      backToOnce.visibleSchedulingFields.length === 0
      && JSON.stringify(backToOnce.visibleControls) === JSON.stringify(['rawInput', 'executionMode', 'button']),
      backToOnce);
    check('switching back to once drops the hidden required flags',
      SCHEDULING_FIELDS.every((name) => backToOnce.fields[name].required === false),
      backToOnce.fields);
  } finally {
    await context.close();
  }
}

async function submissionScenario(browser, base) {
  {
    const { context, page } = await openEntryPage(browser, base);
    try {
      const policy = await submitAndCapturePolicy(page, { rawInput: '读取 workspace 里的 marker.txt 并汇报内容' });
      observe('once submitted policy', policy);
      check('once submission keeps executionMode once', policy.executionMode === 'once', policy);
      check('once submission keeps the real browser timezone', typeof policy.timezone === 'string' && policy.timezone.length > 0, policy.timezone);
      assertPolicy('once submission', policy, [
        'busyPolicy', 'canonicalInstant', 'dstAmbiguousPolicy', 'dstMissedPolicy', 'dstMode', 'dueAt',
        'executionMode', 'latePolicy', 'policyId', 'policyRevision', 'timezone',
      ]);
    } finally {
      await context.close();
    }
  }
  {
    const { context, page } = await openEntryPage(browser, base);
    try {
      const policy = await submitAndCapturePolicy(page, {
        rawInput: '2030 年检查一次发布状态',
        mode: 'scheduled',
        startAt: '2030-01-02T03:04',
      });
      observe('scheduled submitted policy', policy);
      check('scheduled submission keeps executionMode scheduled', policy.executionMode === 'scheduled', policy);
      check('scheduled submission keeps startAt', typeof policy.startAt === 'string' && Number.isFinite(Date.parse(policy.startAt)), policy.startAt);
      assertPolicy('scheduled submission', policy, [
        'busyPolicy', 'canonicalInstant', 'dstAmbiguousPolicy', 'dstMissedPolicy', 'dstMode',
        'executionMode', 'latePolicy', 'policyId', 'policyRevision', 'startAt', 'timezone',
      ]);
    } finally {
      await context.close();
    }
  }
  {
    const { context, page } = await openEntryPage(browser, base);
    try {
      const policy = await submitAndCapturePolicy(page, {
        rawInput: '每周一和周三整理一次发布说明',
        mode: 'recurring',
        frequency: 'weekly',
        startAt: '2030-01-02T03:04',
        timeOfDay: '09:30',
        weekDays: '1,3',
      });
      observe('recurring weekly submitted policy', policy);
      check('recurring weekly submission keeps frequency weekly', policy.frequency === 'weekly', policy);
      check('recurring weekly submission keeps the typed weekDays array',
        Array.isArray(policy.weekDays) && policy.weekDays.length === 2 && policy.weekDays.every((day) => Number.isInteger(day)),
        policy.weekDays);
      check('recurring weekly submission keeps the daily time', policy.timeOfDay === '09:30', policy.timeOfDay);
      assertPolicy('recurring weekly submission', policy, [
        'busyPolicy', 'canonicalInstant', 'dstAmbiguousPolicy', 'dstMissedPolicy', 'dstMode',
        'executionMode', 'frequency', 'latePolicy', 'policyId', 'policyRevision', 'startAt',
        'timeOfDay', 'timezone', 'weekDays',
      ]);
    } finally {
      await context.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const { server, url: base } = await startScriptedServer();
const browser = await playwright.chromium.launch({ headless: true });
let crashed = null;
try {
  await visibilityScenario(browser, base);
  await submissionScenario(browser, base);
} catch (error) {
  crashed = error.stack ?? String(error);
} finally {
  await browser.close();
  await closeServer(server);
}

const result = {
  uiRoot,
  contractPath,
  checks,
  observations,
  failures,
  crashed,
  ok: failures === 0 && crashed === null,
};

if (evidenceRoot) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(join(evidenceRoot, 'checks.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

for (const entry of checks) {
  process.stdout.write(`${entry.pass ? 'ok  ' : 'FAIL'} ${entry.name}${entry.pass ? '' : ` :: ${JSON.stringify(entry.detail)}`}\n`);
}
process.stdout.write(`\n# checks ${checks.length}\n# pass ${checks.length - failures}\n# fail ${failures}\n`);
if (crashed) process.stdout.write(`\n# crashed\n${crashed}\n`);
process.exit(result.ok ? 0 : 1);
