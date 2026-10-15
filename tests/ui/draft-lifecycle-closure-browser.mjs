#!/usr/bin/env node

/**
 * Real-browser proof for the Dashboard **new-task** single-submit closure in
 * `docs/ui`.
 *
 * Project contract (HumanAgent AGENTS.md): submitting a new-task form *is* the
 * user confirmation for that new task. The Dashboard used to render a second
 * `确认并执行` panel (plus an `autoConfirm` checkbox that only auto-clicked that
 * same button). That was a second authorization of a brand-new task. This proof
 * pins the corrected behavior:
 *
 *   0. Node-level checks that the typed client methods
 *      (`refineExplicitDraft`, `regenerateExplicitDraft`, `rejectExplicitDraft`)
 *      survive unchanged: the modify/regenerate/abandon lifecycle is *not* the
 *      new-task path, and the client still exposes the frozen request shapes and
 *      the typed `RuntimeApiError` surface used by the existing-change owner.
 *
 *   A. Deterministic real-browser proof over the real served `dashboard.html`,
 *      driven by a scripted runtime API that implements the real routes:
 *        - one submit issues exactly one receive + one interpret + one
 *          confirmation and lands the task in the FIFO queue;
 *        - there is no second confirmation control (`确认并执行`,
 *          `#dashboard-confirm-button`, `auto-confirm`, `draft-area`) and no
 *          implicit auto-confirm;
 *        - the accepted submit clears the input and shows read-only feedback;
 *        - a clarification round continues the *same* submission;
 *        - an `append`/`change` organizing result is refused visibly and the
 *          queue stays unchanged (existing-task change is a separate owner);
 *        - a runtime refusal shows the typed code/owner/message/nextAction, keeps
 *          the input and does not enqueue or retry;
 *        - a rapid double submit still creates exactly one task;
 *        - a control sourceRef is never sent as a business requirement.
 *
 *   B. Real composed runtime proof (`dashboard.html` against this attempt's own
 *      isolated `serve` process). It owns no second task lifecycle: candidate
 *      binding, serve/browser startup, exact-task binding, settle and the
 *      release-or-retain cleanup are all the official `tests/app/dashboard-e2e`
 *      runner branches, and its receipt is the official receipt sink. A task
 *      that cannot be proven settled keeps its service PID/port, control root,
 *      workspace and evidence and is reported INCOMPLETE with the recovery
 *      owner. Requires a real provider + real ports, so it is opportunistic:
 *      sections 0/A always run. Set `DRAFT_LIFECYCLE_SKIP_REAL=1` to run 0/A
 *      only. The existing-task material-change closure belongs to I1-A and is
 *      deliberately *not* asserted here.
 *
 * Environment:
 *   DRAFT_LIFECYCLE_EVIDENCE   required; execution-owned evidence root
 *   DRAFT_LIFECYCLE_UI_ROOT    optional; built UI root (default docs/ui)
 *   DRAFT_LIFECYCLE_SKIP_REAL  '1' to skip section B
 *   DRAFT_LIFECYCLE_PLAYWRIGHT optional; playwright module path
 *   DRAFT_LIFECYCLE_BROWSER_ARGS optional; comma-separated Chromium args
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.DRAFT_LIFECYCLE_UI_ROOT ?? join(repoRoot, 'docs', 'ui'));
const evidenceRoot = process.env.DRAFT_LIFECYCLE_EVIDENCE?.trim();
const skipReal = process.env.DRAFT_LIFECYCLE_SKIP_REAL === '1';

if (!evidenceRoot) {
  throw new Error('DRAFT_LIFECYCLE_EVIDENCE is required; point it at an execution-owned directory');
}

// The UI is served through Playwright request interception against a synthetic
// origin, so this proof needs no listening socket and still runs the real
// `docs/ui` modules over real Chromium.
const proofOrigin = 'http://humanagent.dashboard.test';
const browserArgs = (process.env.DRAFT_LIFECYCLE_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const playwrightModule = await import(
  process.env.DRAFT_LIFECYCLE_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;

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

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

// ---------------------------------------------------------------------------
// Section 0: typed client methods (node, no browser)
// ---------------------------------------------------------------------------

async function sectionClientUnit() {
  const { createRuntimeApi, RuntimeApiError } = await import(pathToFileURL(join(uiRoot, 'runtime-api.js')).href);
  const baseApi = createRuntimeApi({ baseUrl: 'http://runtime.test', fetchImpl: async () => jsonResponse({}) });
  for (const method of ['refineExplicitDraft', 'regenerateExplicitDraft', 'rejectExplicitDraft']) {
    record(`runtime api exposes ${method}`, typeof baseApi[method] === 'function', { type: typeof baseApi[method] });
  }
  if (typeof baseApi.refineExplicitDraft !== 'function') return;

  const calls = [];
  const api = createRuntimeApi({
    baseUrl: 'http://runtime.test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ interactionId: 'interaction-1', state: 'awaiting-confirmation' });
    },
  });

  const refineInput = {
    draftId: 'draft-1',
    baseRevisionVersion: 2,
    requestedRevisionHash: 'hash-2',
    fields: { goal: '新目标' },
    instructionRef: 'user-edit',
  };
  await api.refineExplicitDraft('interaction-1', refineInput);
  const refineCall = calls.at(-1);
  observe('refine request', { url: refineCall.url, method: refineCall.init.method, body: refineCall.init.body });
  record('refine posts the frozen typed edit to the interaction refine route',
    new URL(refineCall.url).pathname === '/api/explicit/interactions/interaction-1/refine'
      && refineCall.init.method === 'POST'
      && JSON.stringify(JSON.parse(refineCall.init.body)) === JSON.stringify(refineInput),
    { url: refineCall.url, body: refineCall.init.body });

  await api.regenerateExplicitDraft('interaction-1', { instruction: '改成每周一' });
  const regenerateCall = calls.at(-1);
  record('regenerate posts the optional instruction to the interaction regenerate route',
    new URL(regenerateCall.url).pathname === '/api/explicit/interactions/interaction-1/regenerate'
      && regenerateCall.init.method === 'POST'
      && JSON.parse(regenerateCall.init.body).instruction === '改成每周一',
    { url: regenerateCall.url, body: regenerateCall.init.body });

  calls.length = 0;
  await api.regenerateExplicitDraft('interaction-1');
  record('regenerate without an instruction still posts a JSON body',
    JSON.parse(calls.at(-1).init.body) !== null && typeof JSON.parse(calls.at(-1).init.body) === 'object',
    calls.at(-1).init.body);

  const rejectInput = { reason: '范围不对，先不做了' };
  await api.rejectExplicitDraft('interaction-1', rejectInput);
  const rejectCall = calls.at(-1);
  record('reject posts the real reason to the interaction reject route',
    new URL(rejectCall.url).pathname === '/api/explicit/interactions/interaction-1/reject'
      && rejectCall.init.method === 'POST'
      && JSON.parse(rejectCall.init.body).reason === '范围不对，先不做了',
    { url: rejectCall.url, body: rejectCall.init.body });

  const rejecting = createRuntimeApi({
    baseUrl: 'http://runtime.test',
    fetchImpl: async () => jsonResponse({
      error: {
        code: 'explicit-draft.confirmation-stale',
        ownerId: 'humanagent.core.draft-revision',
        message: 'confirmation is not bound to the current draft revision',
        nextAction: 'reload the current draft revision and confirm the exact version',
      },
    }, 409),
  });
  let rejection;
  try {
    await rejecting.refineExplicitDraft('interaction-1', refineInput);
  } catch (error) {
    rejection = error;
  }
  record('a typed draft-revision rejection surfaces as RuntimeApiError with code/owner/message/nextAction',
    rejection instanceof RuntimeApiError
      && rejection.code === 'explicit-draft.confirmation-stale'
      && rejection.ownerId === 'humanagent.core.draft-revision'
      && rejection.message === 'confirmation is not bound to the current draft revision'
      && rejection.nextAction === 'reload the current draft revision and confirm the exact version'
      && rejection.status === 409,
    rejection && { code: rejection.code, ownerId: rejection.ownerId, status: rejection.status });

  // The shared new-task engine must never route a control command onto the
  // business requirement path. It always submits through `receiveExplicitInput`,
  // which forces `channel: 'business'`; the runtime refuses `channel: 'control'`.
  const engineSource = await readFile(join(uiRoot, 'requirement-submission.js'), 'utf8');
  const engineCode = engineSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  record('the submission engine submits only business channel inputs, never a control command',
    engineCode.includes('receiveExplicitInput')
      && engineCode.includes('confirmExplicitRequirement')
      && !engineCode.includes("'control'")
      && !/\bsteer\b/.test(engineCode)
      && !/\bstop\b/.test(engineCode),
    null);
}

// ---------------------------------------------------------------------------
// Section A: deterministic browser proof over the served dashboard
// ---------------------------------------------------------------------------

async function installRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== proofOrigin) {
      await route.continue();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const raw = request.postData();
      let body;
      if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
      const result = await scriptedHandle(url, request.method(), body);
      await route.fulfill({ status: result.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(result.body) });
      return;
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    if (!relative || relative.split('/').includes('..')) {
      await route.fulfill({ status: 400, body: 'bad path' });
      return;
    }
    const filePath = resolve(uiRoot, relative);
    if (!filePath.startsWith(`${uiRoot}${sep}`)) {
      await route.fulfill({ status: 403, body: 'forbidden' });
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

// The scripted runtime API implements the real public routes the Dashboard
// uses. Its state is reset per case so a check can assert an exact request
// count.
function createScriptedRuntime() {
  return {
    interactions: new Map(),
    taskSeq: 0,
    receiveBodies: [],
    interpretCount: 0,
    clarificationCount: 0,
    confirmationBodies: [],
    confirmationCount: 0,
    failConfirmation: null,
    intent: 'create',
    clarification: false,
    clarifyAnswered: false,
    tasks: [],
  };
}

function scriptedDraft(runtime, interaction) {
  return {
    draftId: `draft-${interaction.id}`,
    inputRevision: 1,
    normalizedInput: `${interaction.rawInput} (规范化)`,
    proposedIntent: runtime.intent,
    proposal: `提交后执行：${interaction.rawInput}`,
    matchedTasks: [],
    knownFacts: ['用户提供了一条业务输入'],
    decisionRefs: [],
  };
}

function scriptedSnapshot(runtime, interaction) {
  return {
    interactionId: interaction.id,
    state: interaction.state,
    sourceRef: 'ui:dashboard',
    rawInput: interaction.rawInput,
    owner: 'explicit-intake',
    nextAction: interaction.state === 'received' ? 'start-matching' : 'confirm-or-revise',
    ...(interaction.draft ? { draft: interaction.draft } : {}),
    ...(interaction.clarifications?.length ? { clarifications: interaction.clarifications } : {}),
  };
}

async function scriptedHandle(url, method, body) {
  const runtime = globalThis.__scriptedRuntime;
  if (url.pathname === '/api/runtime/status') {
    return { status: 200, body: { mode: 'scripted', state: 'ready', providerState: 'ready', connected: true } };
  }
  if (url.pathname === '/api/dashboard') {
    return { status: 200, body: { hasRunning: false, taskCount: runtime.tasks.length, waitingDecisionCount: 0, recentFailures: [] } };
  }
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return { status: 200, body: { draft: [], waiting: [...runtime.tasks], running: [], completed: [], stopped: [], failed: [] } };
  }
  if (url.pathname === '/api/runtime/scheduler') {
    return { status: 200, body: { plans: [] } };
  }
  if (url.pathname === '/api/explicit/inputs' && method === 'POST') {
    runtime.receiveBodies.push(body);
    const id = `interaction-${runtime.interactions.size + 1}`;
    runtime.interactions.set(id, { id, rawInput: String(body?.rawInput ?? ''), state: 'received', draft: null, clarifications: [] });
    return { status: 201, body: { interactionId: id } };
  }
  const interactionMatch = /^\/api\/explicit\/interactions\/([^/]+)$/.exec(url.pathname);
  if (interactionMatch && method === 'GET') {
    const interaction = runtime.interactions.get(decodeURIComponent(interactionMatch[1]));
    if (!interaction) return { status: 404, body: { error: { code: 'interaction.not-found' } } };
    return { status: 200, body: scriptedSnapshot(runtime, interaction) };
  }
  const interpretMatch = /^\/api\/explicit\/interactions\/([^/]+)\/interpret$/.exec(url.pathname);
  if (interpretMatch && method === 'POST') {
    runtime.interpretCount += 1;
    const interaction = runtime.interactions.get(decodeURIComponent(interpretMatch[1]));
    if (runtime.clarification && !runtime.clarifyAnswered) {
      interaction.state = 'awaiting-clarification';
      interaction.clarifications = [{ question: '请补充验收范围。' }];
    } else {
      interaction.state = 'awaiting-confirmation';
      interaction.draft = scriptedDraft(runtime, interaction);
    }
    return { status: 200, body: scriptedSnapshot(runtime, interaction) };
  }
  const clarificationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/clarification$/.exec(url.pathname);
  if (clarificationMatch && method === 'POST') {
    runtime.clarificationCount += 1;
    runtime.clarifyAnswered = true;
    const interaction = runtime.interactions.get(decodeURIComponent(clarificationMatch[1]));
    interaction.state = 'matching';
    interaction.clarifications = [{ question: '请补充验收范围。', answer: String(body?.answer ?? '') }];
    return { status: 200, body: scriptedSnapshot(runtime, interaction) };
  }
  const confirmationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(url.pathname);
  if (confirmationMatch && method === 'POST') {
    runtime.confirmationCount += 1;
    runtime.confirmationBodies.push(body);
    if (runtime.failConfirmation) return { status: runtime.failConfirmation.status, body: { error: runtime.failConfirmation.error } };
    const interaction = runtime.interactions.get(decodeURIComponent(confirmationMatch[1]));
    interaction.state = 'confirmed';
    runtime.taskSeq += 1;
    const taskId = `ui-task-${runtime.taskSeq}`;
    runtime.tasks.push({
      taskId: { scope: 'task', value: taskId },
      title: interaction.draft.normalizedInput,
      currentState: '排队中',
      stateLabel: '排队中',
      state: 'waiting',
      nextStep: '等待执行',
      updatedAt: new Date().toISOString(),
    });
    return {
      status: 200,
      body: {
        requirement: {
          status: 'submitted',
          requirementId: `requirement:${interaction.draft.draftId}:1`,
          draftId: interaction.draft.draftId,
          inputRevision: 1,
        },
      },
    };
  }
  return { status: 404, body: { error: { code: 'scripted.route.missing', message: url.pathname } } };
}

function readDashboardForm(page) {
  return page.evaluate(() => {
    const form = document.querySelector('#dashboard-create-form');
    const textarea = document.querySelector('.quick-create-form textarea[name="directive"]');
    const feedback = document.querySelector('#dashboard-create-feedback');
    const error = document.querySelector('#dashboard-create-error');
    return {
      hasForm: Boolean(form),
      textareaValue: textarea?.value ?? null,
      textareaReadOnly: textarea?.readOnly ?? null,
      submitLabel: form?.querySelector('button[type="submit"]')?.textContent?.trim() ?? null,
      hasConfirmPanel: document.querySelectorAll('#dashboard-confirm-button, .draft-area, [data-draft-action]').length > 0,
      hasAutoConfirm: document.querySelectorAll('[data-testid="auto-confirm"], input[name="autoConfirm"]').length > 0,
      feedbackText: feedback && feedback.hidden === false ? (feedback.textContent || '') : '',
      feedbackPresent: Boolean(feedback) && feedback.hidden === false,
      errorText: error && error.hidden === false ? (error.textContent || '') : '',
      errorPresent: Boolean(error) && error.hidden === false,
      clarifyFormPresent: Boolean(document.querySelector('#dashboard-create-clarification')),
    };
  });
}

async function withDashboardPage(runtime, run) {
  globalThis.__scriptedRuntime = runtime;
  const browser = await playwright.chromium.launch({ headless: true, args: browserArgs });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installRoutes(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${proofOrigin}/dashboard.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dashboard-create-form textarea[name="directive"]', { timeout: 15_000 });
    return await run(page, pageErrors);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function waitForAccepted(page) {
  await page.waitForFunction(() => {
    const feedback = document.querySelector('#dashboard-create-feedback');
    const text = feedback && !feedback.hidden ? (feedback.textContent || '') : '';
    return text.includes('显式大脑整理结果');
  }, undefined, { timeout: 15_000 });
}

async function sectionDeterministic(artifactDir) {
  // --- one submit == one authorization, no second confirmation ------------
  {
    const runtime = createScriptedRuntime();
    await withDashboardPage(runtime, async (page, pageErrors) => {
      const initial = await readDashboardForm(page);
      observe('dashboard initial form', initial);
      record('the dashboard new-task form renders with no second-confirmation control',
        initial.hasForm && initial.hasConfirmPanel === false && initial.hasAutoConfirm === false,
        initial);
      record('the dashboard submit is labelled 创建并执行', initial.submitLabel === '创建并执行', initial.submitLabel);

      await page.fill('.quick-create-form textarea[name="directive"]', '读取 README 并汇报');
      await page.click('#dashboard-create-submit');
      await waitForAccepted(page);
      const accepted = await readDashboardForm(page);
      observe('dashboard accepted submit', { accepted, receive: runtime.receiveBodies, confirmations: runtime.confirmationBodies });
      record('one submit issues exactly one explicit input on the business channel',
        runtime.receiveBodies.length === 1 && runtime.receiveBodies[0]?.channel === 'business',
        runtime.receiveBodies);
      record('one submit issues exactly one exact-revision confirmation',
        runtime.confirmationCount === 1 && runtime.confirmationBodies.length === 1,
        runtime.confirmationBodies.length);
      record('the confirmation binds the draft and input revision the runtime produced',
        runtime.confirmationBodies[0]?.draftId === 'draft-interaction-1'
          && runtime.confirmationBodies[0]?.inputRevision === 1
          && typeof runtime.confirmationBodies[0]?.confirmationRef === 'string'
          && typeof runtime.confirmationBodies[0]?.idempotencyKey === 'string',
        runtime.confirmationBodies[0]);
      record('one submit enqueues exactly one task and shows the organizing result',
        runtime.tasks.length === 1 && accepted.feedbackPresent,
        { tasks: runtime.tasks.length, feedbackPresent: accepted.feedbackPresent });
      record('the accepted submit clears the input for the next task',
        accepted.textareaValue === '' && accepted.textareaReadOnly === false,
        { value: accepted.textareaValue, readOnly: accepted.textareaReadOnly });
      record('no second confirmation panel, auto-confirm or draft area is ever rendered',
        !accepted.hasConfirmPanel && !accepted.hasAutoConfirm,
        accepted);
      record('the dashboard new-task page raises no uncaught script error', pageErrors.length === 0, pageErrors);
      await page.screenshot({ path: join(artifactDir, 'dashboard-single-submit.png'), fullPage: true });
    });
  }

  // --- a clarification round continues the same submission ----------------
  {
    const runtime = createScriptedRuntime();
    runtime.clarification = true;
    await withDashboardPage(runtime, async (page) => {
      await page.fill('.quick-create-form textarea[name="directive"]', '处理这份需求');
      await page.click('#dashboard-create-submit');
      await page.waitForSelector('#dashboard-create-clarification input[name="answer"]', { timeout: 10_000 });
      const question = (await page.textContent('#dashboard-create-feedback')) ?? '';
      await page.fill('#dashboard-create-clarification input[name="answer"]', '验收范围就是 README 的前 10 行');
      await page.click('#dashboard-create-clarification button[type="submit"]');
      await waitForAccepted(page);
      const accepted = await readDashboardForm(page);
      observe('dashboard clarification round', { receive: runtime.receiveBodies.length, clarification: runtime.clarificationCount, confirmations: runtime.confirmationCount });
      record('a clarification question is rendered before authorization', question.includes('请补充验收范围'), question.slice(0, 200));
      record('answering continues the same submission with one input and one confirmation',
        runtime.receiveBodies.length === 1 && runtime.clarificationCount === 1 && runtime.confirmationCount === 1,
        { receive: runtime.receiveBodies.length, clarification: runtime.clarificationCount, confirmations: runtime.confirmationCount });
      record('the clarified submission enqueues exactly one task', runtime.tasks.length === 1 && accepted.feedbackPresent, runtime.tasks.length);
    });
  }

  // --- an existing-task material change is refused visibly ----------------
  {
    const runtime = createScriptedRuntime();
    runtime.intent = 'change';
    await withDashboardPage(runtime, async (page) => {
      await page.fill('.quick-create-form textarea[name="directive"]', '把已有任务的目标改成 X');
      await page.click('#dashboard-create-submit');
      await page.waitForSelector('#dashboard-create-error:not([hidden])', { timeout: 10_000 });
      const refused = await readDashboardForm(page);
      observe('dashboard existing-task refusal', { refused, confirmations: runtime.confirmationCount });
      record('an append/change intent on the new-task form is refused, not smuggled through new-task authorization',
        refused.errorPresent && refused.errorText.includes('requirement-submission.existing-task-change-separate-confirmation'),
        refused.errorText.slice(0, 300));
      record('the refused existing-task change is not enqueued and not confirmed',
        runtime.tasks.length === 0 && runtime.confirmationCount === 0,
        { tasks: runtime.tasks.length, confirmations: runtime.confirmationCount });
      record('the refused input stays visible for correction',
        refused.textareaValue === '把已有任务的目标改成 X',
        refused.textareaValue);
      await page.screenshot({ path: join(artifactDir, 'dashboard-existing-change-refused.png'), fullPage: true });
    });
  }

  // --- a runtime refusal is visible, not a success ------------------------
  {
    const runtime = createScriptedRuntime();
    await withDashboardPage(runtime, async (page) => {
      // An empty input must be refused by the form's own validation and must
      // never reach the runtime as a submission.
      const invalid = await page.evaluate(() => {
        const textarea = document.querySelector('.quick-create-form textarea[name="directive"]');
        return { required: textarea?.required ?? false };
      });
      await page.fill('.quick-create-form textarea[name="directive"]', '   ');
      await page.click('#dashboard-create-submit');
      await sleep(300);
      observe('dashboard invalid submit', { invalid, receive: runtime.receiveBodies.length });
      record('the new-task input is required so an empty submit is refused before any request',
        invalid.required === true && runtime.receiveBodies.length === 0 && runtime.confirmationCount === 0,
        { required: invalid.required, receive: runtime.receiveBodies.length });
    });
  }

  {
    const runtime = createScriptedRuntime();
    runtime.failConfirmation = {
      status: 500,
      error: {
        code: 'explicit-brain.final-submit-rejected',
        ownerId: 'humanagent.runtime.explicit-brain',
        message: 'final submit rejected by the scripted runtime',
        nextAction: 'inspect the runtime error and retry the same submission',
      },
    };
    await withDashboardPage(runtime, async (page) => {
      await page.fill('.quick-create-form textarea[name="directive"]', '这条提交会被运行时拒绝');
      await page.click('#dashboard-create-submit');
      await page.waitForSelector('#dashboard-create-error:not([hidden])', { timeout: 10_000 });
      const failed = await readDashboardForm(page);
      observe('dashboard refused submit', { failed, confirmations: runtime.confirmationCount });
      record('a runtime refusal renders the typed code, owner and next action instead of success',
        failed.errorText.includes('explicit-brain.final-submit-rejected')
          && failed.errorText.includes('humanagent.runtime.explicit-brain')
          && failed.errorText.includes('final submit rejected by the scripted runtime'),
        failed.errorText.slice(0, 300));
      record('the refused submit keeps the input and never enqueues a task',
        failed.textareaValue === '这条提交会被运行时拒绝' && runtime.tasks.length === 0,
        { value: failed.textareaValue, tasks: runtime.tasks.length });
      record('the refused submit is not retried automatically', runtime.confirmationCount === 1, runtime.confirmationCount);
    });
  }

  // --- a rapid double submit still creates exactly one task --------------
  {
    const runtime = createScriptedRuntime();
    await withDashboardPage(runtime, async (page) => {
      await page.fill('.quick-create-form textarea[name="directive"]', '只允许创建一次的任务');
      await page.evaluate(() => {
        const button = document.querySelector('#dashboard-create-submit');
        button.click();
        button.click();
      });
      await waitForAccepted(page);
      await sleep(400);
      observe('dashboard double submit', { receive: runtime.receiveBodies.length, confirmations: runtime.confirmationCount, tasks: runtime.tasks.length });
      record('a rapid double submit issues exactly one explicit input', runtime.receiveBodies.length === 1, runtime.receiveBodies.length);
      record('a rapid double submit issues exactly one confirmation', runtime.confirmationCount === 1, runtime.confirmationCount);
      record('a rapid double submit creates exactly one task', runtime.tasks.length === 1, runtime.tasks.length);
    });
  }
}

// ---------------------------------------------------------------------------
// Section B: real composed runtime
// ---------------------------------------------------------------------------

/**
 * Real composed-runtime proof of the single-submit closure.
 *
 * This section owns no task lifecycle of its own. It reuses the official
 * dashboard-e2e runner branches for every lifecycle step:
 *
 *   candidate_binding  `bindCandidate` + `registerAttemptResources` +
 *                      `resolveAttemptPaths` + `prepareAttemptRoots`
 *   browser_session    `probeProvider` + `startServeForAttempt` +
 *                      `launchBrowserSession` + `registerCleanupInventory`
 *   <cmd>_entry        the official `submitDirectiveAndConfirmDraft`, which
 *                      binds the exact created task from the confirmation
 *                      receipt and the unique new task, never `rows >= 1`
 *   stop_settle        the official `stopTaskAndSettle`
 *   cleanup            the official `closeSettledAttempt` (settled) or
 *                      `retainUnsettledRecovery` (unsettled)
 *   receipt            the official `buildReceipt` + `writeReceipt` sink
 *
 * A task that cannot be proven settled keeps its service PID/port, control
 * root, workspace and evidence paths alive for the named recovery owner, writes
 * an INCOMPLETE receipt and releases nothing. Only a settled task releases and
 * verifies its exact resources. Screenshot and browser-close failures are
 * recorded explicitly.
 */
async function sectionReal() {
  let harness;
  let bindingLib;
  let cleanupLib;
  let receiptLib;
  let runnerLib;
  let journalLib;
  try {
    const e2eRoot = join(repoRoot, 'tests', 'app', 'dashboard-e2e');
    harness = await import(pathToFileURL(join(e2eRoot, 'lib', 'browser.mjs')).href);
    bindingLib = await import(pathToFileURL(join(e2eRoot, 'lib', 'binding.mjs')).href);
    cleanupLib = await import(pathToFileURL(join(e2eRoot, 'lib', 'cleanup.mjs')).href);
    receiptLib = await import(pathToFileURL(join(e2eRoot, 'lib', 'receipt.mjs')).href);
    journalLib = await import(pathToFileURL(join(e2eRoot, 'lib', 'journal.mjs')).href);
    runnerLib = await import(pathToFileURL(join(e2eRoot, 'runner.mjs')).href);
  } catch (error) {
    record('the real dashboard single-submit section is available', false, `dashboard-e2e harness unavailable: ${error.message}`);
    return;
  }

  let binding = null;
  let deviation = null;
  let evidence = { screenshots: [] };
  let settleResult = { stopped: false, settled: false, reason: 'settlement was not attempted' };
  try {
    binding = bindingLib.bindCandidate(repoRoot, {
      scenario: 'draft-lifecycle-closure',
      entry: 'dashboard',
      outcome: 'success',
      attemptIdSuffix: Math.random().toString(36).slice(2, 8),
    });
    bindingLib.registerAttemptResources(binding);
    await bindingLib.resolveAttemptPaths(binding);
    await bindingLib.prepareAttemptRoots(binding);
    observe('real attempt', {
      attemptId: binding.attemptId,
      attemptRoot: binding.attemptRoot,
      controlRoot: binding.controlRoot,
      workspace: binding.workspace,
      receiptDir: binding.receiptDir,
      candidateSha: binding.candidateSha,
      treeDigest: binding.treeDigest,
    });
    await harness.probeProvider(binding);
    await harness.startServeForAttempt(binding, { readyTimeoutMs: 120_000 });
    observe('real serve', {
      url: binding.serveBaseUrl,
      pid: binding.servePid,
      port: binding.servePort,
      checkpointRoot: binding.serveCheckpointRoot,
    });
    await harness.launchBrowserSession(binding);
    cleanupLib.registerCleanupInventory(binding);
    evidence = await driveRealSingleSubmit(harness, binding, journalLib);
  } catch (error) {
    deviation = {
      stage: 'real_single_submit',
      error: error instanceof Error ? error.message : String(error),
      raw: String(error?.stack ?? error),
    };
  }

  // The real proof's receipt carries the same start/end source identity as the
  // official scenario receipts, so it is bound to this exact candidate revision
  // and proves the source did not move during the run.
  if (binding) {
    try {
      const sourceIdentity = await bindingLib.finalizeSourceIdentity(binding);
      evidence.scenarioEvidence = {
        ...(evidence.scenarioEvidence ?? {}),
        sourceIdentity: {
          stable: sourceIdentity.stable,
          changedPaths: sourceIdentity.changedPaths,
          sidecarPath: binding.sourceIdentityPath ?? null,
          start: bindingLib.compactSourceIdentity(sourceIdentity.start),
          end: bindingLib.compactSourceIdentity(sourceIdentity.end),
        },
      };
      if (sourceIdentity.stable !== true) {
        evidence.missingEvidence = [
          ...(evidence.missingEvidence ?? []),
          `candidate source identity changed during the run: ${sourceIdentity.changedPaths.join(', ') || 'unknown input'}`,
        ];
      }
    } catch (error) {
      if (!deviation) {
        deviation = {
          stage: 'source_identity',
          error: error instanceof Error ? error.message : String(error),
          raw: String(error?.stack ?? error),
        };
      }
    }
  }

  // attempt_stop_settle -> cleanup. The official owner decides settlement from
  // the authoritative journal; the official branch either releases and verifies
  // this attempt's exact resources or retains them for recovery.
  try {
    settleResult = await cleanupLib.stopTaskAndSettle(binding, binding.taskId ?? null, {
      expectedOutcome: 'success',
      terminalState: evidence.terminalState ?? null,
    });
    if (settleResult.settled) {
      await cleanupLib.closeSettledAttempt(binding, settleResult);
    } else {
      await cleanupLib.retainUnsettledRecovery(
        binding,
        settleResult.reason ?? deviation?.error ?? 'attempt did not settle',
        settleResult,
      );
    }
  } catch (error) {
    if (!deviation) {
      deviation = {
        stage: 'real_cleanup',
        error: error instanceof Error ? error.message : String(error),
        raw: String(error?.stack ?? error),
      };
    }
  }

  const cleanup = binding.cleanup ?? null;
  const resources = runnerLib.summarizeResources(binding);
  const settled = settleResult.settled === true;
  // Mirror the official runner: an unsettled attempt is a deviation even when the
  // in-run proof itself raised no error, so INCOMPLETE can never look like PASS.
  if (!deviation && !settled) {
    deviation = {
      stage: 'attempt_stop_settle',
      error: settleResult.reason ?? settleResult.settlementReason ?? 'attempt did not settle',
      raw: JSON.stringify(settleResult).slice(0, 2000),
    };
  }
  const status = !deviation && settled && binding.cleaned === true ? 'SUCCESS' : 'INCOMPLETE';
  // An INCOMPLETE receipt must state why, exactly as the official runner does:
  // the scenario's own missing evidence, the deviation, the strict-settlement
  // reason and the cleanup reason.
  const missingEvidence = [...new Set([
    ...(evidence.missingEvidence ?? []),
    ...(deviation ? [`${deviation.stage}: ${deviation.error}`] : []),
    ...(!settled
      ? [`strict settlement: ${settleResult.reason ?? settleResult.settlementReason ?? 'attempt did not settle'}`]
      : []),
    ...(binding.cleaned === true
      ? []
      : [`cleanup: ${cleanup?.reason ?? settleResult.reason ?? 'cleanup did not complete'}`]),
  ])];
  const receipt = receiptLib.buildReceipt(binding, {
    result: status,
    deviation,
    terminalState: evidence.terminalState ?? null,
    dashboardState: evidence.dashboardState ?? null,
    toolRounds: evidence.toolRounds ?? settleResult.evidence?.toolRounds ?? 0,
    requestStartTurns: evidence.requestStartTurns ?? settleResult.evidence?.requestStartTurns ?? 0,
    checkpointCommitted: evidence.checkpointCommitted ?? settleResult.evidence?.checkpointCommitted ?? 0,
    terminalRecord: evidence.terminalRecord ?? settleResult.terminal ?? null,
    evidenceRefs: evidence.evidenceRefs ?? [],
    scenarioEvidence: evidence.scenarioEvidence ?? null,
    screenshots: evidence.screenshots ?? [],
    missingEvidence,
    settlement: {
      requestedOutcome: 'success',
      settled,
      reason: settleResult.reason ?? settleResult.settlementReason ?? null,
      terminal: settleResult.terminal ?? null,
    },
    resources,
    recoveryOwner: binding.recoveryOwner ?? null,
    cleanup,
    cleaned: binding.cleaned ?? null,
  });
  const written = await receiptLib.writeReceipt(binding, receipt);
  observe('real proof receipt', {
    result: status,
    markdownPath: written.markdownPath,
    jsonPath: written.jsonPath,
    sourceIdentityPath: binding.sourceIdentityPath ?? null,
  });

  record('the real proof is bound to one exact candidate revision',
    /^[0-9a-f]{40}$/.test(String(binding.candidateSha ?? '')),
    { candidateSha: binding.candidateSha, treeDigest: binding.treeDigest });
  record('the real proof wrote its receipt to the candidate receipt root',
    Boolean(written.markdownPath) && Boolean(written.jsonPath),
    written);
  const scenarioEvidence = evidence.scenarioEvidence ?? {};
  record('the real dashboard single submit issued exactly one input and one confirmation',
    (scenarioEvidence.receivedInputs ?? []).length === 1
      && (scenarioEvidence.confirmations ?? []).length === 1
      && scenarioEvidence.secondConfirmationControls === 0,
    {
      received: (scenarioEvidence.receivedInputs ?? []).length,
      confirmations: (scenarioEvidence.confirmations ?? []).length,
      secondConfirmationControls: scenarioEvidence.secondConfirmationControls ?? null,
      taskId: scenarioEvidence.taskId ?? null,
      requirementId: scenarioEvidence.requirementReceipt?.requirementId ?? null,
    });
  record('the real dashboard single submit reached a verifiable succeeded terminal',
    evidence.terminalState === 'succeeded',
    evidence.terminalState ?? deviation?.error ?? null);
  record('the real proof settled from the authoritative journal',
    settled,
    settleResult.reason ?? settleResult.settlementReason ?? null);
  if (settled) {
    record("the settled real proof released exactly this attempt's resources and verified them",
      cleanup?.serveExited === true
        && cleanup?.browserClosed === true
        && cleanup?.portClosed === true
        && cleanup?.tempRootsRemoved === true,
      {
        servePid: cleanup?.servePid ?? null,
        serveExited: cleanup?.serveExited,
        serveExitReason: cleanup?.serveExitReason ?? null,
        browserClosed: cleanup?.browserClosed,
        portClosed: cleanup?.portClosed,
        tempRootsRemoved: cleanup?.tempRootsRemoved,
      });
  } else {
    const recoveryRetained = cleanup?.recoveryRetained ?? [];
    record('the unsettled real proof retained the service/PID/port/paths and named one recovery owner',
      Boolean(cleanup?.recoveryOwner)
        && binding.cleaned === false
        && recoveryRetained.length > 0
        && (binding.servePid === null
          || recoveryRetained.some((entry) => entry.kind === 'serve-pid' && entry.pid === binding.servePid)),
      {
        recoveryOwner: cleanup?.recoveryOwner ?? null,
        recoveryRetained,
        servePid: binding.servePid,
        servePort: binding.servePort,
        controlRoot: binding.controlRoot,
        workspace: binding.workspace,
        receiptDir: binding.receiptDir,
      });
  }
  record('the real proof recorded the browser close outcome',
    typeof cleanup?.browserClosed === 'boolean',
    { browserClosed: cleanup?.browserClosed ?? null, browserReason: cleanup?.browserReason ?? null });
  record('real dashboard single-submit section completed', deviation === null, deviation?.error ?? null);
}

function idValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && value !== null ? value.value : String(value);
}

function sameIdValue(left, right) {
  const a = idValue(left);
  const b = idValue(right);
  return a !== null && b !== null && a === b;
}

/**
 * Drive the real Dashboard single submit and return the runner-shaped evidence
 * bundle. The task identity comes from the official confirmation receipt plus
 * the unique created task; a task list row count is never used as the binding.
 */
async function driveRealSingleSubmit(harness, binding, journalLib) {
  const { page } = binding.browser;
  const missing = [];
  const received = [];
  const confirmations = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    let path = null;
    try {
      path = new URL(request.url()).pathname;
    } catch {
      return;
    }
    const body = (() => {
      try {
        return request.postDataJSON();
      } catch {
        return null;
      }
    })();
    if (path === '/api/explicit/inputs') received.push(body);
    if (path.endsWith('/confirmation')) confirmations.push(body);
  });

  // Strict settlement needs a real provider tool result, so the directive
  // targets a fixture this attempt owns and asks for one file.read round.
  const fixtureDir = 'e2e-fixture';
  const fixtureRel = join(fixtureDir, 'single-submit-probe.txt');
  const marker = `draft-lifecycle-real-${binding.attemptId}`;
  await mkdir(join(binding.workspace, fixtureDir), { recursive: true });
  await writeFile(join(binding.workspace, fixtureRel), `${marker}\n`, 'utf8');
  const directive = [
    `Read the workspace file ${fixtureRel} with the file.read tool and report its exact content in your final answer.`,
    'Do not create, modify, move or delete any file. Do not ask clarifying questions.',
  ].join(' ');

  await harness.submitDirectiveAndConfirmDraft(binding, directive, {
    clarificationAnswer: 'Do not clarify. Read the file with the file.read tool and finish.',
  });

  const secondConfirmationControls = await page.locator(
    '#dashboard-confirm-button, .draft-area, [data-testid="auto-confirm"], input[name="autoConfirm"]',
  ).count();
  const requirement = binding.requirementReceipt ?? null;
  if (received.length !== 1) {
    missing.push(`the real dashboard issued ${received.length} explicit input POSTs (expected exactly 1)`);
  }
  if (confirmations.length !== 1) {
    missing.push(`the real dashboard issued ${confirmations.length} confirmation POSTs (expected exactly 1)`);
  }
  if (secondConfirmationControls !== 0) {
    missing.push(`${secondConfirmationControls} second-confirmation control(s) were rendered after the single submit`);
  }
  if (!requirement?.requirementId
    || typeof requirement.draftId !== 'string'
    || !Number.isInteger(requirement.inputRevision)) {
    missing.push('the real confirmation receipt did not identify one exact requirement (requirementId/draftId/inputRevision)');
  } else {
    const confirmationRequest = binding.confirmationRequest ?? null;
    if (!confirmationRequest) {
      missing.push('the real confirmation request body was not captured');
    } else if (confirmationRequest.draftId !== requirement.draftId
      || confirmationRequest.inputRevision !== requirement.inputRevision) {
      missing.push(
        `the real confirmation request (draft ${JSON.stringify(confirmationRequest.draftId)}, `
        + `revision ${JSON.stringify(confirmationRequest.inputRevision)}) does not match the returned requirement identity`,
      );
    }
  }
  if (typeof binding.taskId !== 'string' || binding.taskId.length === 0) {
    missing.push('the real single submit was not bound to one exact task id');
  } else {
    const probe = await harness.readDashboardProbe(binding).catch((error) => ({ error: error.message }));
    if (probe.error) {
      missing.push(`the exact real task dashboard probe failed: ${probe.error}`);
    } else {
      if (!sameIdValue(probe.taskId, binding.taskId)) {
        missing.push(`the real task dashboard returned ${JSON.stringify(probe.taskId ?? null)} instead of ${binding.taskId}`);
      }
      if (typeof probe.operationId !== 'string' || probe.operationId.length === 0) {
        missing.push('the exact real task dashboard exposed no operationId');
      }
      if (!Number.isSafeInteger(probe.executionEpoch) || probe.executionEpoch <= 0) {
        missing.push('the exact real task dashboard exposed no positive executionEpoch');
      }
    }
  }

  let screenshot = null;
  let screenshotError = null;
  try {
    screenshot = await harness.captureScreenshot(binding, 'dashboard-single-submit-real');
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }
  if (screenshotError) {
    missing.push(`the real proof screenshot failed: ${screenshotError}`);
    record('the real proof captured its dashboard screenshot', false, screenshotError);
  }

  const dashboard = await harness.waitForTerminal(binding, {
    timeoutMs: Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 600_000),
  });
  if (dashboard.state !== 'succeeded') {
    missing.push(`the real task terminal state=${JSON.stringify(dashboard.state)} (expected succeeded)`);
  }
  const turnEvidence = await journalLib.countTurnEvidenceFor(binding).catch(() => null);
  if (!turnEvidence) missing.push('the authoritative journal evidence could not be read');
  else if ((turnEvidence.toolRounds ?? 0) < 1) {
    missing.push(`the authoritative journal recorded ${turnEvidence.toolRounds ?? 0} provider tool rounds (expected >= 1)`);
  }
  if ((turnEvidence?.checkpointCommitted ?? 0) < 1) {
    missing.push('the authoritative journal recorded no committed checkpoint');
  }

  return {
    screenshots: screenshot ? [screenshot] : [],
    terminalState: dashboard.state,
    dashboardState: dashboard.state,
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    checkpointCommitted: turnEvidence?.checkpointCommitted ?? 0,
    terminalRecord: turnEvidence?.terminalRecords?.slice(-1)[0] ?? null,
    evidenceRefs: (turnEvidence?.allEvents ?? [])
      .flatMap((event) => (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []))
      .slice(0, 40),
    scenarioEvidence: {
      directive,
      marker,
      fixtureRel,
      receivedInputs: received,
      confirmations,
      secondConfirmationControls,
      requirementReceipt: requirement,
      confirmationRequest: binding.confirmationRequest ?? null,
      confirmationStatus: binding.confirmStatus ?? null,
      taskId: binding.taskId ?? null,
      operationId: dashboard.operationId ?? null,
      executionEpoch: dashboard.executionEpoch ?? null,
      dashboardState: dashboard.state,
      screenshot,
      screenshotError,
      entryLayout: binding.entryLayout ?? null,
    },
    missingEvidence: missing,
  };
}

// ---------------------------------------------------------------------------

const artifactDir = join(evidenceRoot, 'artifacts');
await mkdir(artifactDir, { recursive: true });

await sectionClientUnit();
try {
  await sectionDeterministic(artifactDir);
} catch (error) {
  record('deterministic dashboard section completed', false, error instanceof Error ? error.message : String(error));
}

if (skipReal) {
  observe('real runtime section', 'skipped via DRAFT_LIFECYCLE_SKIP_REAL=1');
} else {
  try {
    await sectionReal();
  } catch (error) {
    record('real dashboard single-submit section completed', false, error instanceof Error ? error.message : String(error));
  }
}

await writeFile(
  join(evidenceRoot, 'checks.json'),
  `${JSON.stringify({ uiRoot, checks, observations }, null, 2)}\n`,
);

const failed = checks.filter((check) => !check.pass);
console.log(`dashboard single-submit proof: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) {
  for (const check of failed) console.error(`FAIL ${check.name}: ${JSON.stringify(check.detail)}`);
  process.exitCode = 1;
} else {
  console.log('dashboard single-submit proof passed');
}
