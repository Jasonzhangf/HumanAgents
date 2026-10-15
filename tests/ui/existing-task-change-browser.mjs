#!/usr/bin/env node

/**
 * Existing-task-change UI proof.
 *
 * The interaction page owns the Task Detail existing-change presentation:
 * organize a proposal, edit the exact reviewable revision, and require a
 * separate human confirmation. The runtime keeps the only authorization owner;
 * this proof only verifies the public request/response binding and the visible
 * refusal/retry behavior.
 *
 * Two modes:
 *
 * - fixture (default): real Chromium over the real `docs/ui` modules and a
 *   scripted public API served through Playwright request interception. This
 *   proves page behavior and exact request binding without a listening socket.
 * - real: set `EXISTING_CHANGE_BASE_URL` to a running HumanAgent UI base URL.
 *   No request interception is installed. The same browser-observed request and
 *   response events are checked against the real public server. The real task,
 *   requirement, queue and Journal receipts remain the host acceptance owner's
 *   responsibility.
 *
 * Required env:
 * - `EXISTING_CHANGE_EVIDENCE` (optional; defaults to a run-local directory).
 * - `EXISTING_CHANGE_BASE_URL` (real mode).
 * - `EXISTING_CHANGE_PLAYWRIGHT` (optional Playwright entry override).
 * - `EXISTING_CHANGE_UI_ROOT` (fixture static root override).
 * - `EXISTING_CHANGE_BROWSER_ARGS` (optional comma-separated Chromium args).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.EXISTING_CHANGE_UI_ROOT ?? join(repoRoot, 'docs', 'ui'));
const evidenceRoot = resolve(process.env.EXISTING_CHANGE_EVIDENCE ?? join(repoRoot, 'tests', 'ui', '.evidence', 'existing-task-change'));
const realBase = process.env.EXISTING_CHANGE_BASE_URL?.trim();
const proofOrigin = 'http://humanagent.existing-change.test';
const launchArgs = (process.env.EXISTING_CHANGE_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const playwrightModule = await import(
  process.env.EXISTING_CHANGE_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js',
);
const playwright = playwrightModule.default ?? playwrightModule;

const S = {
  taskRef: '[data-existing-change-intake] input[name="taskRef"]',
  changeInput: '[data-existing-change-intake] textarea[name="changeInput"]',
  organize: '[data-action="organize-existing-change"]',
  proposal: '[data-existing-change-proposal]',
  task: '[data-existing-change-task]',
  revision: '[data-existing-change-revision]',
  goal: '[data-existing-change-edit] textarea[name="goal"]',
  scope: '[data-existing-change-edit] textarea[name="scope"]',
  handling: '[data-existing-change-edit] textarea[name="proposal"]',
  save: '[data-action="save-existing-change"]',
  confirm: '[data-action="confirm-existing-change"]',
  confirmation: '[data-existing-change-confirmation]',
  feedback: '[data-existing-change-feedback]',
  error: '[data-existing-change-error]',
};

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

function createScriptedRuntime(options = {}) {
  const state = {
    interactionId: 'interaction-existing-change-1',
    taskRef: 'task-42',
    rawInput: '把已有任务的目标改为生成周报',
    draftId: 'draft-existing-change-1',
    inputRevision: 1,
    revisionVersion: 1,
    revisionHash: 'sha256:existing-change-r1',
    goal: '生成周报',
    scope: '本周变更与验证结果',
    proposal: '整理成本周周报输入',
    state: 'received',
    receiveBodies: [],
    interpretCount: 0,
    refineBodies: [],
    confirmBodies: [],
    tasks: [],
    idempotency: new Map(),
    failedOnce: false,
  };

  function snapshot() {
    return {
      interactionId: state.interactionId,
      state: state.state,
      rawInput: state.rawInput,
      nextAction: state.state === 'awaiting-confirmation' ? 'confirm' : 'interpret',
      draft: {
        draftId: state.draftId,
        inputRevision: state.inputRevision,
        proposedIntent: 'change',
        normalizedInput: `${state.goal} / ${state.scope}`,
        proposal: state.proposal,
        matchedTasks: [{
          taskId: { scope: 'task', value: state.taskRef },
          relation: 'current',
          status: 'running',
        }],
      },
      revision: {
        draftId: state.draftId,
        inputRevision: state.inputRevision,
        revisionVersion: state.revisionVersion,
        revisionHash: state.revisionHash,
        goal: state.goal,
        scope: state.scope,
        proposal: state.proposal,
        proposedIntent: 'change',
        normalizedInput: `${state.goal} / ${state.scope}`,
      },
    };
  }

  function fail(status, code, message, nextAction, extra = {}) {
    return {
      status,
      body: { error: { code, ownerId: 'test.existing-change', message, nextAction, ...extra } },
    };
  }

  async function handle(url, method, body) {
    const path = url.pathname;
    if (path === '/api/runtime/status') {
      return { status: 200, body: { state: 'ready', mode: 'fake', providerState: 'ready', connected: true } };
    }
    if (path === '/api/tasks' && method === 'GET') {
      return {
        status: 200,
        body: {
          draft: state.tasks.map((task) => ({ ...task, state: 'draft', stateLabel: '已排队', currentState: 'queued' })),
          waiting: [],
          running: [],
          completed: [],
          stopped: [],
          failed: [],
        },
      };
    }
    if (path === '/api/explicit/inputs' && method === 'POST') {
      state.receiveBodies.push(body);
      if (body?.requestKind !== 'existing-task-change') {
        return fail(409, 'unauthorized-final-submit', 'existing change input requires existing-task-change', 'submit the typed existing-task-change input');
      }
      state.state = 'received';
      return { status: 200, body: { interactionId: state.interactionId } };
    }
    if (path === `/api/explicit/interactions/${state.interactionId}` && method === 'GET') {
      return { status: 200, body: snapshot() };
    }
    if (path === `/api/explicit/interactions/${state.interactionId}/interpret` && method === 'POST') {
      state.interpretCount += 1;
      state.state = 'awaiting-confirmation';
      return { status: 200, body: snapshot() };
    }
    if (path === `/api/explicit/interactions/${state.interactionId}/refine` && method === 'POST') {
      state.refineBodies.push(body);
      if (options.staleRefine) {
        return fail(409, 'confirmation-stale', 'draft refinement base revision is stale', 'reload the reviewable revision before editing');
      }
      if (body?.baseRevisionVersion !== state.revisionVersion || body?.requestedRevisionHash !== state.revisionHash) {
        return fail(409, 'confirmation-stale', 'draft refinement base revision does not match the current revision', 'reload the reviewable revision before editing');
      }
      state.revisionVersion += 1;
      state.revisionHash = `sha256:existing-change-r${state.revisionVersion}`;
      state.goal = body.fields?.goal ?? state.goal;
      state.scope = body.fields?.scope ?? state.scope;
      state.proposal = body.fields?.proposal ?? state.proposal;
      state.state = 'awaiting-confirmation';
      return { status: 200, body: snapshot() };
    }
    if (path === `/api/explicit/interactions/${state.interactionId}/confirmation` && method === 'POST') {
      state.confirmBodies.push(body);
      if (options.confirmError) {
        return fail(
          options.confirmError.status ?? 409,
          options.confirmError.code,
          options.confirmError.message,
          options.confirmError.nextAction,
        );
      }
      if (body?.requestKind !== 'existing-task-change') {
        return fail(409, 'unauthorized-final-submit', 'existing change confirmation requires existing-task-change', 'submit the exact existing-task-change confirmation');
      }
      if (body?.taskRef?.value !== state.taskRef) {
        return fail(409, 'explicit-brain.task-target-mismatch', 'existing-task-change target does not match the confirmed draft revision', 'select the task that owns the confirmed draft revision before submitting the change');
      }
      if (body?.draftRevisionVersion !== state.revisionVersion || body?.draftRevisionHash !== state.revisionHash) {
        return fail(409, 'confirmation-stale', 'confirmation is not bound to the current draft revision', 'reload the reviewable revision and confirm the current version and hash');
      }
      const key = body?.idempotencyKey;
      if (key && state.idempotency.has(key)) {
        const requirement = state.idempotency.get(key);
        return {
          status: 200,
          body: {
            requirement: {
              status: 'duplicate',
              requirementId: requirement.requirementId,
              draftId: state.draftId,
              inputRevision: state.inputRevision,
            },
          },
        };
      }
      const requirement = {
        status: 'submitted',
        requirementId: `requirement:${state.draftId}:${state.revisionVersion}`,
        draftId: state.draftId,
        inputRevision: state.inputRevision,
      };
      state.tasks.push({ requirementId: requirement.requirementId, taskRef: state.taskRef });
      if (key) state.idempotency.set(key, requirement);
      if (options.failFirstConfirm && !state.failedOnce) {
        state.failedOnce = true;
        return fail(503, 'explicit-brain.final-submit-response-lost', 'runtime committed the change but the response was lost', 'retry the same submission identity');
      }
      return { status: 200, body: { requirement } };
    }
    return fail(404, 'not-found', `unexpected route ${method} ${path}`, 'none');
  }

  return { state, handle, snapshot };
}

async function installScriptedRoutes(context, runtime) {
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
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = undefined; }
      }
      const result = await runtime.handle(url, request.method(), body);
      await route.fulfill({
        status: result.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(result.body),
      });
      return;
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/interaction.html' : url.pathname).replace(/^\/+/, '');
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

function collectApi(page) {
  const observed = { requests: [], responses: [] };
  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    let body;
    try { body = request.postDataJSON(); } catch { body = undefined; }
    observed.requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body,
    });
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/')) return;
    observed.responses.push({
      path: new URL(response.url()).pathname,
      status: response.status(),
    });
  });
  return observed;
}

async function withPage(runtime, run) {
  const browser = await playwright.chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (!realBase) await installScriptedRoutes(context, runtime);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const observed = collectApi(page);
  try {
    const base = realBase || proofOrigin;
    await page.goto(`${base}/interaction.html?task=task-42`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(S.changeInput);
    return await run(page, observed, pageErrors);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function organize(page, changeInput = '把已有任务的目标改为生成周报') {
  await page.fill(S.changeInput, changeInput);
  await page.click(S.organize);
  await page.waitForSelector(`${S.proposal}:not([hidden])`);
  await page.waitForFunction(() => {
    const feedback = document.querySelector('[data-existing-change-feedback]');
    return Boolean(feedback && feedback.textContent && feedback.textContent.includes('单独确认'));
  }, undefined, { timeout: 10000 });
}

const artifactDir = join(evidenceRoot, 'artifacts');
await mkdir(artifactDir, { recursive: true });

// 1. Organize the change, then confirm it with a separate human action.
{
  const runtime = createScriptedRuntime();
  await withPage(runtime, async (page, observed, pageErrors) => {
    const prefilled = await page.inputValue(S.taskRef);
    record('Task Detail deep link binds the exact existing task', prefilled === 'task-42', prefilled);

    await organize(page);
    const proposal = await page.evaluate(() => ({
      task: document.querySelector('[data-existing-change-task]')?.textContent ?? '',
      revision: document.querySelector('[data-existing-change-revision]')?.textContent ?? '',
      feedback: document.querySelector('[data-existing-change-feedback]')?.textContent ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    observe('existing change proposal', proposal);
    const receive = observed.requests.filter((request) => request.path === '/api/explicit/inputs');
    record('organize sends exactly one typed existing-task-change input on the business channel',
      receive.length === 1 && receive[0].body?.requestKind === 'existing-task-change' && receive[0].body?.channel === 'business',
      receive.map((request) => request.body));
    record('organize does not confirm or enqueue',
      observed.requests.filter((request) => request.path.endsWith('/confirmation')).length === 0
        && (!realBase ? runtime.state.tasks.length === 0 : true),
      observed.requests.map((request) => request.path));
    record('proposal shows the exact target and reviewable revision',
      proposal.task.includes('task-42')
        && proposal.revision.includes('v1')
        && proposal.revision.includes('sha256:existing-change-r1'),
      proposal);
    record('the separate confirmation is available after the proposal is organized', proposal.confirmDisabled === false, proposal);

    await page.click(S.confirm);
    await page.waitForFunction(() => {
      const feedback = document.querySelector('[data-existing-change-feedback]');
      return Boolean(feedback && feedback.textContent && feedback.textContent.includes('变更已提交'));
    }, undefined, { timeout: 10000 });
    const confirmed = await page.evaluate(() => ({
      feedback: document.querySelector('[data-existing-change-feedback]')?.textContent ?? '',
      confirmation: document.querySelector('[data-existing-change-confirmation]')?.textContent ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    observe('existing change confirmation', confirmed);
    const confirmation = observed.requests.find((request) => request.path.endsWith('/confirmation'));
    record('the separate confirmation binds the exact task, revision, and request kind',
      confirmation?.body?.requestKind === 'existing-task-change'
        && confirmation?.body?.taskRef?.scope === 'task'
        && confirmation?.body?.taskRef?.value === 'task-42'
        && confirmation?.body?.draftId === 'draft-existing-change-1'
        && confirmation?.body?.inputRevision === 1
        && confirmation?.body?.draftRevisionVersion === 1
        && confirmation?.body?.draftRevisionHash === 'sha256:existing-change-r1'
        && typeof confirmation?.body?.confirmationRef === 'string'
        && typeof confirmation?.body?.idempotencyKey === 'string',
      confirmation?.body);
    record('the confirmation receipt names the exact requirement, draft, and input revision',
      confirmed.feedback.includes('requirement=requirement:draft-existing-change-1:1')
        && confirmed.feedback.includes('draft=draft-existing-change-1')
        && confirmed.feedback.includes('inputRevision=1'),
      confirmed);
    record('a confirmed change disables further confirmation on the same revision', confirmed.confirmDisabled === true, confirmed);
    if (!realBase) {
      record('one confirmed change is queued exactly once', runtime.state.tasks.length === 1, runtime.state.tasks);
    }
    record('the existing-change organize/confirm page raises no page error', pageErrors.length === 0, pageErrors);
    await page.screenshot({ path: join(artifactDir, 'existing-change-confirmed.png'), fullPage: true });
  });
}

// 2. Editing the proposal mints a new exact revision and invalidates the old confirmation.
{
  const runtime = createScriptedRuntime();
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.fill(S.goal, '生成季度周报');
    await page.click(S.save);
    await page.waitForFunction(() => {
      const revision = document.querySelector('[data-existing-change-revision]');
      return Boolean(revision && revision.textContent && revision.textContent.includes('v2'));
    }, undefined, { timeout: 10000 });
    const edited = await page.evaluate(() => ({
      revision: document.querySelector('[data-existing-change-revision]')?.textContent ?? '',
      confirmation: document.querySelector('[data-existing-change-confirmation]')?.textContent ?? '',
      feedback: document.querySelector('[data-existing-change-feedback]')?.textContent ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    observe('existing change edited revision', edited);
    const refine = observed.requests.find((request) => request.path.endsWith('/refine'));
    record('editing binds the exact displayed base version and hash',
      refine?.body?.baseRevisionVersion === 1
        && refine?.body?.requestedRevisionHash === 'sha256:existing-change-r1'
        && refine?.body?.draftId === 'draft-existing-change-1'
        && refine?.body?.fields?.goal === '生成季度周报',
      refine?.body);
    record('editing mints a new exact revision identity',
      edited.revision.includes('v2') && edited.revision.includes('sha256:existing-change-r2'),
      edited);
    record('editing invalidates the old confirmation before a new confirmation',
      edited.confirmation.includes('旧确认已失效') && edited.confirmDisabled === false,
      edited);

    await page.click(S.confirm);
    await page.waitForFunction(() => {
      const feedback = document.querySelector('[data-existing-change-feedback]');
      return Boolean(feedback && feedback.textContent && feedback.textContent.includes('变更已提交'));
    }, undefined, { timeout: 10000 });
    const confirmations = observed.requests.filter((request) => request.path.endsWith('/confirmation'));
    record('confirmation after editing binds the new revision version and hash',
      confirmations.length === 1
        && confirmations[0].body?.draftRevisionVersion === 2
        && confirmations[0].body?.draftRevisionHash === 'sha256:existing-change-r2',
      confirmations.map((request) => request.body));
    if (!realBase) {
      record('the edited change still queues exactly one change', runtime.state.tasks.length === 1, runtime.state.tasks);
    }
    await page.screenshot({ path: join(artifactDir, 'existing-change-edited.png'), fullPage: true });
  });
}

// 3. A wrong target fails closed and preserves the human's input.
{
  const runtime = createScriptedRuntime();
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.fill(S.taskRef, 'task-99');
    await page.click(S.confirm);
    await page.waitForSelector(`${S.error}:not([hidden])`, { timeout: 10000 });
    const state = await page.evaluate(() => ({
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
      changeInput: document.querySelector('[data-existing-change-intake] textarea[name="changeInput"]')?.value ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    observe('existing change wrong target', state);
    record('a wrong target is refused with the typed mismatch code',
      state.error.includes('explicit-brain.task-target-mismatch'),
      state.error.slice(0, 300));
    record('a wrong target preserves the human input',
      state.changeInput === '把已有任务的目标改为生成周报',
      state.changeInput);
    record('a wrong target adds no confirmation and no queued change',
      observed.requests.filter((request) => request.path.endsWith('/confirmation')).length === 0
        && (!realBase ? runtime.state.tasks.length === 0 : true),
      observed.requests.map((request) => request.path));
    record('a wrong target leaves the confirmation unavailable until the target is corrected',
      state.confirmDisabled === true,
      state);
  });
}

// 4. A lost confirmation response stays visible and a same-revision retry dedupes.
{
  const runtime = createScriptedRuntime({ failFirstConfirm: true });
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.click(S.confirm);
    await page.waitForSelector(`${S.error}:not([hidden])`, { timeout: 10000 });
    const lost = await page.evaluate(() => ({
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
      feedback: document.querySelector('[data-existing-change-feedback]')?.textContent ?? '',
    }));
    observe('existing change lost response', lost);
    record('a lost confirmation response is shown as a failure, not a success',
      lost.error.includes('explicit-brain.final-submit-response-lost')
        && !lost.feedback.includes('变更已提交'),
      lost);
    if (!realBase) {
      record('the runtime may already have committed exactly one change while the page reports failure',
        runtime.state.tasks.length === 1,
        runtime.state.tasks);
    }

    await page.click(S.confirm);
    await page.waitForFunction(() => {
      const feedback = document.querySelector('[data-existing-change-feedback]');
      return Boolean(feedback && feedback.textContent && feedback.textContent.includes('变更已提交'));
    }, undefined, { timeout: 10000 });
    const confirmations = observed.requests.filter((request) => request.path.endsWith('/confirmation'));
    record('a same-revision retry reuses the exact confirmation and idempotency identity',
      confirmations.length === 2
        && confirmations[0].body?.confirmationRef === confirmations[1].body?.confirmationRef
        && confirmations[0].body?.idempotencyKey === confirmations[1].body?.idempotencyKey,
      confirmations.map((request) => request.body));
    if (!realBase) {
      record('a same-revision retry does not append a second queued change',
        runtime.state.tasks.length === 1,
        runtime.state.tasks);
    }
  });
}

// 5. A stale edit is rejected with the typed runtime code and preserves the edit.
{
  const runtime = createScriptedRuntime({ staleRefine: true });
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.fill(S.goal, '生成季度周报');
    await page.click(S.save);
    await page.waitForSelector(`${S.error}:not([hidden])`, { timeout: 10000 });
    const stale = await page.evaluate(() => ({
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
      goal: document.querySelector('[data-existing-change-edit] textarea[name="goal"]')?.value ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    observe('existing change stale edit', stale);
    record('a stale edit is refused with the typed stale code',
      stale.error.includes('confirmation-stale'),
      stale.error.slice(0, 300));
    record('a stale edit preserves the edited input',
      stale.goal === '生成季度周报',
      stale.goal);
    record('a stale edit leaves confirmation unavailable and adds no change',
      stale.confirmDisabled === true
        && observed.requests.filter((request) => request.path.endsWith('/confirmation')).length === 0
        && (!realBase ? runtime.state.tasks.length === 0 : true),
      { confirmDisabled: stale.confirmDisabled, requests: observed.requests.map((request) => request.path) });
  });
}

// 6. A server-side wrong-kind rejection is visible and preserves the input.
{
  const runtime = createScriptedRuntime({
    confirmError: {
      status: 409,
      code: 'unauthorized-final-submit',
      message: 'existing change cannot be submitted as a new task',
      nextAction: 'submit the exact existing-task-change confirmation',
    },
  });
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.click(S.confirm);
    await page.waitForSelector(`${S.error}:not([hidden])`, { timeout: 10000 });
    const wrongKind = await page.evaluate(() => ({
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
      changeInput: document.querySelector('[data-existing-change-intake] textarea[name="changeInput"]')?.value ?? '',
    }));
    observe('existing change wrong-kind rejection', wrongKind);
    record('a wrong-kind server rejection is readable with its typed code',
      wrongKind.error.includes('unauthorized-final-submit')
        && wrongKind.error.includes('submit the exact existing-task-change confirmation'),
      wrongKind.error.slice(0, 300));
    record('a wrong-kind rejection preserves the human input and queues no change',
      wrongKind.changeInput === '把已有任务的目标改为生成周报'
        && (!realBase ? runtime.state.tasks.length === 0 : true),
      { changeInput: wrongKind.changeInput, tasks: runtime.state.tasks.length });
  });
}

// 7. An unsaved editor change cannot be confirmed, even if the control is re-enabled.
{
  const runtime = createScriptedRuntime();
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.fill(S.goal, '生成季度周报');
    const dirty = await page.evaluate(() => ({
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
      confirmation: document.querySelector('[data-existing-change-confirmation]')?.textContent ?? '',
      feedback: document.querySelector('[data-existing-change-feedback]')?.textContent ?? '',
    }));
    observe('existing change unsaved edit gate', dirty);
    record('an unsaved editor change immediately disables the confirmation',
      dirty.confirmDisabled === true && dirty.confirmation.includes('编辑尚未保存'),
      dirty);

    // Re-enabling the control by hand must not let the confirmation authorize
    // text that no server revision owns.
    await page.evaluate(() => {
      document.querySelector('[data-action="confirm-existing-change"]').disabled = false;
    });
    await page.click(S.confirm);
    // A refusal is synchronous in the page, while a wrong implementation issues
    // a real request. Wait a bounded time so the negative assertions observe
    // whichever behavior actually happened.
    await page.waitForTimeout(750);
    const refused = await page.evaluate(() => ({
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
      feedback: document.querySelector('[data-existing-change-feedback]')?.textContent ?? '',
    }));
    observe('existing change unsaved edit refusal', refused);
    record('the confirmation action itself refuses an unsaved editor change',
      refused.error.includes('ui.existing-change.unsaved-edit') && refused.confirmDisabled === true,
      refused);
    record('an unsaved editor change sends no confirmation and queues no change',
      observed.requests.filter((request) => request.path.endsWith('/confirmation')).length === 0
        && (!realBase ? runtime.state.tasks.length === 0 : true),
      { requests: observed.requests.map((request) => request.path), tasks: runtime.state.tasks });
    await page.screenshot({ path: join(artifactDir, 'existing-change-unsaved-edit.png'), fullPage: true });
  });
}

// 8. A rejected stale save cannot be cleared by correcting the target.
{
  const runtime = createScriptedRuntime({ staleRefine: true });
  await withPage(runtime, async (page, observed) => {
    await organize(page);
    await page.fill(S.goal, '生成季度周报');
    await page.click(S.save);
    await page.waitForSelector(`${S.error}:not([hidden])`, { timeout: 10000 });
    const blocked = await page.evaluate(() => ({
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    // The intake target is corrected back to the draft's own task. That clears
    // only a target mismatch: the rejected save still owns the gate, because no
    // server revision owns the edited text.
    await page.evaluate(() => {
      const input = document.querySelector('[data-existing-change-intake] input[name="taskRef"]');
      input.value = 'task-42';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const afterTargetInput = await page.evaluate(() => ({
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
      confirmation: document.querySelector('[data-existing-change-confirmation]')?.textContent ?? '',
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
    }));
    observe('existing change rejected save after target input', afterTargetInput);
    record('a rejected stale save leaves the confirmation unavailable',
      blocked.confirmDisabled === true,
      blocked);
    record('correcting the target does not re-enable a confirmation blocked by a rejected save',
      afterTargetInput.confirmDisabled === true,
      afterTargetInput);

    await page.evaluate(() => {
      document.querySelector('[data-action="confirm-existing-change"]').disabled = false;
    });
    await page.click(S.confirm);
    // See block 7: bounded wait for the negative assertion.
    await page.waitForTimeout(750);
    const refused = await page.evaluate(() => ({
      error: document.querySelector('[data-existing-change-error]')?.textContent ?? '',
      confirmDisabled: document.querySelector('[data-action="confirm-existing-change"]')?.disabled ?? null,
    }));
    observe('existing change rejected save refusal', refused);
    record('the confirmation action refuses a revision whose save was rejected',
      refused.error.includes('ui.existing-change.stale-edit') && refused.confirmDisabled === true,
      refused);
    record('a rejected stale save sends no confirmation and queues no change',
      observed.requests.filter((request) => request.path.endsWith('/confirmation')).length === 0
        && (!realBase ? runtime.state.tasks.length === 0 : true),
      { requests: observed.requests.map((request) => request.path), tasks: runtime.state.tasks });
    await page.screenshot({ path: join(artifactDir, 'existing-change-rejected-save.png'), fullPage: true });
  });
}

// 9. The new-task pages keep one submit and expose no second confirmation control.
{
  const dashboard = await readFile('docs/ui/dashboard.js', 'utf8');
  const entry = await readFile('docs/ui/entry.js', 'utf8');
  record('dashboard new-task form exposes no second confirmation control',
    !dashboard.includes('dashboard-confirm-button') && !dashboard.includes('autoConfirm'),
    { dashboardConfirmButton: dashboard.includes('dashboard-confirm-button'), autoConfirm: dashboard.includes('autoConfirm') });
  record('homepage new-task form exposes no second confirmation control',
    !entry.includes('entry-confirm-button') && !entry.includes('确认并进入队列'),
    { entryConfirmButton: entry.includes('entry-confirm-button'), confirmCopy: entry.includes('确认并进入队列') });
}

await writeFile(join(evidenceRoot, 'checks.json'), JSON.stringify({ mode: realBase ? 'real' : 'fixture', checks, observations }, null, 2), 'utf8');
if (checks.length === 0) throw new Error('existing-task-change browser proof recorded no checks');
if (failures > 0) {
  throw new Error(`${failures}/${checks.length} existing-task-change checks failed:\n${checks.filter((check) => !check.pass).map((check) => `  - ${check.name}: ${JSON.stringify(check.detail)}`).join('\n')}`);
}
console.log(`existing-task-change browser proof (${realBase ? 'real' : 'fixture'}): ${checks.length} checks passed`);
