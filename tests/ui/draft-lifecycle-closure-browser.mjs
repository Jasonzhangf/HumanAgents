#!/usr/bin/env node

/**
 * Proof for the real draft modify / regenerate / abandon closure in docs/ui.
 *
 * Sections:
 *
 *   0. Node-level unit checks for the three typed client methods
 *      (`refineExplicitDraft`, `regenerateExplicitDraft`, `rejectExplicitDraft`):
 *      the exact frozen request shapes and the typed RuntimeApiError surface.
 *
 *   A. Deterministic real-browser proof over the real served `dashboard.html`
 *      (the product entry that renders the confirmable explicit draft), driven
 *      by a scripted runtime API that implements the real routes:
 *        - the draft panel offers 修改 / 重新整理 / 放弃 next to 确认并执行;
 *        - 放弃 issues a real reject request with a real reason and renders the
 *          returned closure receipt; before the fix the 取消 button issued no
 *          request and the durable interaction stayed open;
 *        - 修改 refines against the displayed revision version + hash;
 *        - 重新整理 regenerates the draft;
 *        - an outdated confirmation renders the typed code/owner/message/
 *          nextAction instead of a generic failure string;
 *        - refined feedback is not written into the task input box.
 *
 *   B. Real composed runtime proof. An isolated `serve --mode rcc` process (the
 *      real entry, never a shared instance) plus real Chromium through the real
 *      served pages. Set `DRAFT_LIFECYCLE_SKIP_REAL=1` to run sections 0/A only.
 *
 * Environment:
 *   DRAFT_LIFECYCLE_EVIDENCE   required; execution-owned evidence root
 *   DRAFT_LIFECYCLE_UI_ROOT    optional; built UI root (default dist/app/ui)
 *   DRAFT_LIFECYCLE_SKIP_REAL  '1' to skip section B
 *   DRAFT_LIFECYCLE_PLAYWRIGHT optional; playwright module path
 */

import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.DRAFT_LIFECYCLE_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.DRAFT_LIFECYCLE_EVIDENCE?.trim();
const skipReal = process.env.DRAFT_LIFECYCLE_SKIP_REAL === '1';

if (!evidenceRoot) {
  throw new Error('DRAFT_LIFECYCLE_EVIDENCE is required; point it at an execution-owned directory');
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

async function startStaticServer(root) {
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
      const filePath = resolve(root, relative);
      if (!filePath.startsWith(`${root}${sep}`)) {
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
  await new Promise((settle, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', settle);
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
  await new Promise((settle, fail) => server.close((error) => (error ? fail(error) : settle())));
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
}

// ---------------------------------------------------------------------------
// Section A: deterministic browser proof over the served dashboard
// ---------------------------------------------------------------------------

function draftSnapshot(state, revisionVersion) {
  const revision = {
    draftId: 'draft-1',
    revisionVersion,
    inputRevision: 1,
    goal: `目标 v${revisionVersion}`,
    scope: `范围 v${revisionVersion}`,
    constraints: ['约束 A'],
    deliverables: ['交付 A'],
    normalizedInput: `标准输入 v${revisionVersion}`,
    proposedIntent: 'create',
    proposal: `建议 v${revisionVersion}`,
    matchedTasks: [],
    knownFacts: [],
    decisionRefs: [],
    state: 'draft',
    history: [],
    revisionHash: `hash-${revisionVersion}`,
    immutableOriginalRef: 'original-1',
  };
  return {
    interactionId: 'interaction-1',
    state,
    sourceRef: 'ui:dashboard',
    rawInput: '写一份报告',
    owner: 'explicit-intake',
    nextAction: 'confirm-the-current-draft',
    history: ['received', 'matching', state],
    draft: {
      draftId: 'draft-1',
      inputRevision: 1,
      sourceRef: 'ui:dashboard',
      normalizedInput: revision.normalizedInput,
      matchedTasks: [],
      knownFacts: [],
      proposedIntent: 'create',
      proposal: revision.proposal,
      decisionRefs: [],
      state,
    },
    revision,
  };
}

function readDraftSurface(page) {
  return page.evaluate(() => {
    const area = document.querySelector('.draft-area');
    const action = (name) => area?.querySelector(`[data-draft-action="${name}"]`) ?? null;
    const revisionNode = area?.querySelector('[data-draft-revision]') ?? null;
    const receipt = area?.querySelector('[data-draft-receipt]') ?? null;
    const editor = (kind) => area?.querySelector(`[data-draft-editor="${kind}"]`) ?? null;
    return {
      areaPresent: Boolean(area) && area.hidden === false,
      actions: {
        confirm: Boolean(action('confirm')),
        refine: Boolean(action('refine')),
        regenerate: Boolean(action('regenerate')),
        reject: Boolean(action('reject')),
      },
      revisionText: revisionNode?.textContent ?? '',
      revisionVersion: revisionNode?.dataset.draftRevisionVersion ?? '',
      revisionHash: revisionNode?.dataset.draftRevisionHash ?? '',
      statusText: area?.querySelector('[data-draft-status]')?.textContent ?? '',
      receiptText: receipt && receipt.hidden === false ? receipt.textContent ?? '' : '',
      receiptPresent: Boolean(receipt) && receipt.hidden === false,
      editors: {
        refine: Boolean(editor('refine')) && editor('refine').hidden === false,
        regenerate: Boolean(editor('regenerate')) && editor('regenerate').hidden === false,
        reject: Boolean(editor('reject')) && editor('reject').hidden === false,
      },
      areaText: area?.textContent ?? '',
      directiveValue: document.querySelector('.quick-create-form textarea[name="directive"]')?.value ?? null,
    };
  });
}

async function sectionDeterministic(browser, baseUrl, artifactDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const dialogs = [];
  const navigations = [];
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('dialog', (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.dismiss();
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  const state = {
    revisionVersion: 1,
    interactionState: 'awaiting-confirmation',
    staleConfirmation: false,
    confirmationBodies: [],
    refineBodies: [],
    regenerateBodies: [],
    rejectBodies: [],
    snapshotReads: 0,
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
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
      return body({ draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] });
    }
    if (path === '/api/explicit/inputs' && method === 'POST') {
      return body({ interactionId: 'interaction-1' }, 201);
    }
    if (path === '/api/explicit/interactions/interaction-1' && method === 'GET') {
      state.snapshotReads += 1;
      return body(draftSnapshot(state.interactionState, state.revisionVersion));
    }
    if (path === '/api/explicit/interactions/interaction-1/interpret' && method === 'POST') {
      state.interactionState = 'awaiting-confirmation';
      return body(draftSnapshot(state.interactionState, state.revisionVersion));
    }
    if (path === '/api/explicit/interactions/interaction-1/refine' && method === 'POST') {
      const payload = request.postDataJSON();
      state.refineBodies.push(payload);
      state.revisionVersion += 1;
      return body(draftSnapshot(state.interactionState, state.revisionVersion));
    }
    if (path === '/api/explicit/interactions/interaction-1/regenerate' && method === 'POST') {
      const payload = request.postDataJSON();
      state.regenerateBodies.push(payload);
      state.revisionVersion += 1;
      return body(draftSnapshot(state.interactionState, state.revisionVersion));
    }
    if (path === '/api/explicit/interactions/interaction-1/reject' && method === 'POST') {
      const payload = request.postDataJSON();
      state.rejectBodies.push(payload);
      state.interactionState = 'rejected';
      return body({
        interactionId: 'interaction-1',
        state: 'rejected',
        closure: {
          rejectionId: 'rejection:draft-1:1',
          reason: payload.reason,
          closedAt: '2026-10-06T12:00:00.000Z',
          durable: true,
          draftId: 'draft-1',
          draftRevisionVersion: state.revisionVersion,
          draftRevisionHash: `hash-${state.revisionVersion}`,
        },
      });
    }
    if (path === '/api/explicit/interactions/interaction-1/confirmation' && method === 'POST') {
      const payload = request.postDataJSON();
      state.confirmationBodies.push(payload);
      if (state.staleConfirmation) {
        return body({
          error: {
            code: 'explicit-draft.confirmation-stale',
            ownerId: 'humanagent.core.draft-revision',
            message: 'confirmation is not bound to the current draft revision',
            nextAction: 'reload the current draft revision and confirm the exact version',
          },
        }, 409);
      }
      return body({ requirement: { requirementId: 'requirement-1' } });
    }
    return body({ error: { code: 'not-found', message: `unexpected route ${method} ${path}`, ownerId: 'test', nextAction: 'none' } }, 404);
  });

  const clickDraftAction = async (name) => {
    const locator = page.locator(`[data-draft-action="${name}"]`);
    if (await locator.count() === 0) return false;
    await locator.first().click();
    return true;
  };

  // --- the real dashboard entry must reach a confirmable draft ------------
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.quick-create-form textarea[name="directive"]', { timeout: 15_000 });
  await page.fill('.quick-create-form textarea[name="directive"]', '写一份报告');
  await page.click('.quick-create-form button[type="submit"]');
  await page.waitForSelector('.draft-area .draft-proposal', { timeout: 15_000 }).catch(() => {});
  const draft = await readDraftSurface(page);
  observe('deterministic draft surface', draft);
  record('draft panel renders 修改 / 重新整理 / 放弃 next to 确认并执行',
    draft.areaPresent
      && draft.actions.confirm
      && draft.actions.refine
      && draft.actions.regenerate
      && draft.actions.reject,
    draft.actions);
  record('draft panel shows the revision identity it will confirm',
    draft.revisionVersion === '1' && draft.revisionHash === 'hash-1',
    { version: draft.revisionVersion, hash: draft.revisionHash, text: draft.revisionText });

  // --- 放弃 must issue a real reject and surface the durable receipt ------
  const navigationsBeforeAbandon = navigations.length
  const rejectClicked = await clickDraftAction('reject');
  await sleep(150);
  const rejectEditor = await readDraftSurface(page);
  record('放弃 opens an inline reason editor in the same panel',
    rejectClicked
      && rejectEditor.editors.reject
      && navigations.length === navigationsBeforeAbandon
      && dialogs.length === 0,
    { editors: rejectEditor.editors, navigations, dialogs });
  if (rejectEditor.editors.reject) {
    await page.fill('[data-draft-editor="reject"] textarea[name="reason"]', '范围不对，先不做了');
    await page.click('[data-draft-submit="reject"]');
    await page.waitForFunction(() => {
      const receipt = document.querySelector('[data-draft-receipt]');
      return Boolean(receipt) && receipt.hidden === false;
    }, undefined, { timeout: 10_000 }).catch(() => {});
  }
  const abandoned = await readDraftSurface(page);
  observe('deterministic abandon', { requests: [...state.rejectBodies], surface: abandoned, interactionState: state.interactionState });
  record('放弃 issues exactly one real reject request with the real reason',
    state.rejectBodies.length === 1 && state.rejectBodies[0]?.reason === '范围不对，先不做了',
    state.rejectBodies);
  record('the abandoned interaction is durably rejected, not just hidden',
    state.interactionState === 'rejected',
    state.interactionState);
  record('the abandon receipt renders the closure facts the runtime returned',
    abandoned.receiptPresent
      && abandoned.receiptText.includes('rejection:draft-1:1')
      && abandoned.receiptText.includes('2026-10-06T12:00:00.000Z')
      && abandoned.receiptText.includes('范围不对，先不做了'),
    abandoned.receiptText);
  record('a rejected draft no longer offers 确认并执行',
    abandoned.actions.confirm === false && abandoned.actions.refine === false && abandoned.actions.regenerate === false,
    abandoned.actions);
  record('放弃 does not add a confirmation page or navigation',
    navigations.length === navigationsBeforeAbandon && dialogs.length === 0,
    { navigations, dialogs });

  // --- 修改 must refine against the displayed revision version + hash -----
  state.interactionState = 'awaiting-confirmation';
  state.revisionVersion = 1;
  state.refineBodies.length = 0;
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.quick-create-form textarea[name="directive"]', { timeout: 15_000 });
  await page.fill('.quick-create-form textarea[name="directive"]', '写一份报告');
  await page.click('.quick-create-form button[type="submit"]');
  await page.waitForSelector('.draft-area .draft-proposal', { timeout: 15_000 }).catch(() => {});
  const beforeRefine = await readDraftSurface(page);
  const refineClicked = await clickDraftAction('refine');
  await sleep(150);
  const refineEditor = await readDraftSurface(page);
  record('修改 opens an inline typed editor in the same panel',
    refineClicked && refineEditor.editors.refine && dialogs.length === 0,
    { editors: refineEditor.editors, dialogs });
  if (refineEditor.editors.refine) {
    await page.fill('[data-draft-editor="refine"] input[name="goal"]', '修改后的目标');
    await page.click('[data-draft-submit="refine"]');
    await page.waitForFunction((expected) => {
      const node = document.querySelector('[data-draft-revision]');
      return node?.dataset.draftRevisionVersion === expected;
    }, '2', { timeout: 10_000 }).catch(() => {});
  }
  const refined = await readDraftSurface(page);
  const refineRequest = state.refineBodies[0];
  observe('deterministic refine', { requests: [...state.refineBodies], surface: refined });
  record('修改 refines against the exact displayed revision version and hash',
    state.refineBodies.length === 1
      && refineRequest?.draftId === 'draft-1'
      && refineRequest?.baseRevisionVersion === 1
      && refineRequest?.requestedRevisionHash === 'hash-1'
      && refineRequest?.fields?.goal === '修改后的目标',
    refineRequest);
  record('the refined draft is re-read and the new revision identity is rendered',
    refined.revisionVersion === '2' && refined.revisionHash === 'hash-2',
    { version: refined.revisionVersion, hash: refined.revisionHash });
  record('refined feedback is not written into the task input box',
    refined.directiveValue === '写一份报告',
    { directiveValue: refined.directiveValue });

  // --- 重新整理 must regenerate the draft ---------------------------------
  const regenerateClicked = await clickDraftAction('regenerate');
  await sleep(150);
  const regenerateEditor = await readDraftSurface(page);
  record('重新整理 opens an inline correction editor in the same panel',
    regenerateClicked && regenerateEditor.editors.regenerate && dialogs.length === 0,
    { editors: regenerateEditor.editors, dialogs });
  if (regenerateEditor.editors.regenerate) {
    await page.fill('[data-draft-editor="regenerate"] textarea[name="instruction"]', '把交付物改成两份');
    await page.click('[data-draft-submit="regenerate"]');
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-draft-revision]');
      return node?.dataset.draftRevisionVersion === '3';
    }, undefined, { timeout: 10_000 }).catch(() => {});
  }
  const regenerated = await readDraftSurface(page);
  observe('deterministic regenerate', { requests: [...state.regenerateBodies], surface: regenerated });
  record('重新整理 regenerates with the human correction and renders the new revision',
    state.regenerateBodies.length === 1
      && state.regenerateBodies[0]?.instruction === '把交付物改成两份'
      && regenerated.revisionVersion === '3',
    { requests: state.regenerateBodies, version: regenerated.revisionVersion });

  // --- an outdated confirmation must render the typed runtime error -------
  const beforeStale = await readDraftSurface(page);
  state.staleConfirmation = true;
  state.confirmationBodies.length = 0;
  const confirmClicked = await clickDraftAction('confirm');
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-draft-status]')?.textContent ?? '';
    return status.includes('explicit-draft.');
  }, undefined, { timeout: 10_000 }).catch(() => {});
  const stale = await readDraftSurface(page);
  observe('deterministic stale confirmation', { requests: [...state.confirmationBodies], surface: stale });
  record('确认并执行 binds the displayed revision identity into the confirmation',
    confirmClicked
      && state.confirmationBodies.length === 1
      && state.confirmationBodies[0]?.draftRevisionVersion === 3
      && state.confirmationBodies[0]?.draftRevisionHash === 'hash-3',
    state.confirmationBodies);
  record('an outdated confirmation renders the typed code, owner, message and next action',
    stale.statusText.includes('explicit-draft.confirmation-stale')
      && stale.statusText.includes('humanagent.core.draft-revision')
      && stale.statusText.includes('confirmation is not bound to the current draft revision')
      && stale.statusText.includes('reload the current draft revision and confirm the exact version'),
    stale.statusText);
  record('a stale confirmation does not silently confirm a newer revision',
    state.confirmationBodies.length === 1 && stale.actions.confirm === true,
    { requests: state.confirmationBodies.length, actions: stale.actions });

  observe('deterministic page errors', [...pageErrors]);
  record('the draft lifecycle page raises no page errors', pageErrors.length === 0, pageErrors);
  await page.screenshot({ path: join(artifactDir, 'draft-lifecycle-deterministic.png'), fullPage: true });
  await context.close();
}

// ---------------------------------------------------------------------------
// Section B: real composed runtime
// ---------------------------------------------------------------------------

async function sectionReal(browser, artifactDir, attemptRoot) {
  const harness = await import(
    pathToFileURL(join(repoRoot, 'tests', 'app', 'dashboard-e2e', 'lib', 'browser.mjs')).href
  );
  const binding = {
    attemptId: `draft-lifecycle-${Date.now().toString(36)}`,
    attemptRoot,
    repoPath: repoRoot,
    workspace: join(attemptRoot, 'workspace'),
    controlRoot: join(attemptRoot, 'control'),
    screenshotsDir: join(artifactDir, 'real'),
  };
  let serve;
  try {
    await harness.probeProvider(binding);
    observe('rcc provider probed', true);
    await harness.startServeForAttempt(binding, { readyTimeoutMs: 120_000 });
    serve = binding.serve;
    observe('real serve', { url: binding.serveBaseUrl, pid: serve.pid, checkpointRoot: binding.serveCheckpointRoot });
    await harness.launchBrowserSession(binding);
    const { page } = binding.browser;
    const base = binding.serveBaseUrl;
    const apiFetch = async (path, init) => {
      const response = await binding.auth.fetch(`${base}${path}`, init);
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { _raw: text.slice(0, 400) };
      }
      return { status: response.status, body: parsed };
    };
    const post = (path, payload) => apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });

    const snapshotOf = async (interactionId) => (
      await apiFetch(`/api/explicit/interactions/${encodeURIComponent(interactionId)}`)
    ).body;

    // Drive the real served page from the real task input to a rendered draft and
    // keep the interaction identity the runtime minted for it. The readiness
    // predicate stays on the draft itself so a missing closure control is
    // reported as a failing check, not as a hang.
    const openDraft = async (directive) => {
      await page.goto(`${base}/dashboard.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.quick-create-form textarea[name="directive"]', { timeout: 20_000 });
      await page.fill('.quick-create-form textarea[name="directive"]', directive);
      const received = page.waitForResponse((response) =>
        response.url().endsWith('/api/explicit/inputs') && response.request().method() === 'POST');
      await page.click('.quick-create-form button[type="submit"]');
      const receivedBody = await (await received).json();
      await harness.waitForDom(page, 'rendered explicit draft', async () => {
        const surface = await readDraftSurface(page);
        return surface.areaPresent && surface.areaText.includes('显式大脑整理结果') ? surface : null;
      }, 240_000);
      return { interactionId: receivedBody.interactionId, surface: await readDraftSurface(page) };
    };

    const clickDraftControl = async (name) => {
      const locator = page.locator(`[data-draft-action="${name}"]`);
      if (await locator.count() === 0) return false;
      await locator.first().click();
      return true;
    };

    // --- 修改 on a real draft, then a real outdated confirmation -----------
    const first = await openDraft('Do not ask questions. Create exactly one task: report the current date.');
    observe('real draft surface', { interactionId: first.interactionId, surface: first.surface });
    record('the real runtime draft panel offers 修改 / 重新整理 / 放弃',
      first.surface.actions.confirm
        && first.surface.actions.refine
        && first.surface.actions.regenerate
        && first.surface.actions.reject,
      first.surface.actions);
    const firstVersion = Number(first.surface.revisionVersion);
    const firstSnapshot = await snapshotOf(first.interactionId);
    record('the real runtime reports a typed draft revision for the served draft',
      firstSnapshot?.revision?.revisionVersion === firstVersion
        && firstSnapshot?.revision?.revisionHash === first.surface.revisionHash,
      { revision: firstSnapshot?.revision?.revisionVersion, displayed: firstVersion });

    const refineOpened = await clickDraftControl('refine');
    record('the real page opens the 修改 editor',
      refineOpened && await page.locator('[data-draft-editor="refine"]:not([hidden])').count() > 0,
      { refineOpened });
    if (refineOpened) {
      await page.fill('[data-draft-editor="refine"] input[name="goal"]', `报告当前日期、星期与时区（第 ${firstVersion + 1} 修订）`);
      await page.click('[data-draft-submit="refine"]');
      await harness.waitForDom(page, 'refined revision identity', async () => {
        const surface = await readDraftSurface(page);
        return Number(surface.revisionVersion) > firstVersion ? surface : null;
      }, 90_000);
    }
    const refined = await readDraftSurface(page);
    const refinedSnapshot = await snapshotOf(first.interactionId);
    observe('real refine', { surface: refined, revision: refinedSnapshot?.revision?.revisionVersion });
    record('修改 advances both the served page and the durable revision',
      Number(refined.revisionVersion) > firstVersion
        && refinedSnapshot?.revision?.revisionVersion === Number(refined.revisionVersion),
      { displayed: refined.revisionVersion, durable: refinedSnapshot?.revision?.revisionVersion });
    if (Number(refined.revisionVersion) <= firstVersion) {
      record('the real draft-lifecycle section completed', false, 'the served page never advanced past the first revision, so the remaining real edges cannot be exercised');
      observe('real section aborted', { reason: 'no revision advance', served: refined, durable: refinedSnapshot?.state });
      return;
    }

    // The human screen is now outdated: refine out of band, then confirm from
    // the page. The runtime must refuse the outdated revision with a typed code.
    const outOfBand = await post(`/api/explicit/interactions/${encodeURIComponent(first.interactionId)}/refine`, {
      draftId: refinedSnapshot.revision.draftId,
      baseRevisionVersion: refinedSnapshot.revision.revisionVersion,
      requestedRevisionHash: refinedSnapshot.revision.revisionHash,
      fields: { goal: '越权修改：这一修订只存在于页面之外' },
      instructionRef: 'out-of-band-proof-edit',
    });
    record('the out-of-band refine moved the durable revision past the served page',
      outOfBand.status === 200 && outOfBand.body?.revision?.revisionVersion > Number(refined.revisionVersion),
      { status: outOfBand.status, revision: outOfBand.body?.revision?.revisionVersion });

    const confirmClicked = await clickDraftControl('confirm');
    if (confirmClicked) {
      await harness.waitForDom(page, 'typed stale-confirmation rendering', async () => {
        const surface = await readDraftSurface(page);
        return surface.statusText.includes('explicit-draft.') ? surface : null;
      }, 60_000);
    }
    const stale = await readDraftSurface(page);
    observe('real stale confirmation', stale.statusText);
    record('an outdated confirmation on the real runtime renders the typed code, owner, message and next action',
      confirmClicked
        && stale.statusText.includes('explicit-draft.confirmation-stale')
        && stale.statusText.includes('humanagent.core.draft-revision')
        && stale.statusText.includes('not bound to the current draft revision')
        && stale.statusText.includes('reload the current draft revision'),
      stale.statusText);
    const afterStale = await snapshotOf(first.interactionId);
    record('a refused outdated confirmation leaves the interaction unconfirmed',
      afterStale.state !== 'confirmed' && afterStale.state !== 'dispatched',
      afterStale.state);

    // --- 放弃 on the real draft: durable rejection plus the real receipt ----
    const rejectOpened = await clickDraftControl('reject');
    record('the real page opens the 放弃 reason editor',
      rejectOpened && await page.locator('[data-draft-editor="reject"]:not([hidden])').count() > 0,
      { rejectOpened });
    if (rejectOpened) {
      await page.fill('[data-draft-editor="reject"] textarea[name="reason"]', '这个任务先不做，放弃当前草案');
      await page.click('[data-draft-submit="reject"]');
      await harness.waitForDom(page, 'rendered abandon receipt', async () => {
        const surface = await readDraftSurface(page);
        return surface.receiptPresent ? surface : null;
      }, 60_000);
    }
    const abandoned = await readDraftSurface(page);
    const rejectedSnapshot = await snapshotOf(first.interactionId);
    observe('real abandon', { surface: abandoned, interactionState: rejectedSnapshot?.state, rejection: rejectedSnapshot?.rejections?.at(-1) });
    record('放弃 durably rejects the interaction in the runtime',
      rejectedSnapshot?.state === 'rejected',
      rejectedSnapshot?.state);
    const realClosure = rejectedSnapshot?.rejections?.at(-1);
    record('the served page renders the real closure receipt fields',
      Boolean(realClosure)
        && abandoned.receiptText.includes(realClosure.rejectionId)
        && abandoned.receiptText.includes(realClosure.closedAt)
        && abandoned.receiptText.includes('这个任务先不做，放弃当前草案'),
      abandoned.receiptText);
    record('a rejected draft no longer offers a confirm control',
      abandoned.actions.confirm === false,
      abandoned.actions);

    const refused = await post(`/api/explicit/interactions/${encodeURIComponent(first.interactionId)}/confirmation`, {
      draftId: rejectedSnapshot.revision.draftId,
      inputRevision: rejectedSnapshot.revision.inputRevision,
      draftRevisionVersion: rejectedSnapshot.revision.revisionVersion,
      draftRevisionHash: rejectedSnapshot.revision.revisionHash,
      confirmationRef: `confirmation:proof-rejected-${Date.now()}`,
      confirmedBy: 'human:operator',
      confirmedAt: new Date().toISOString(),
      payloadRef: `asset://requirements/proof-rejected-${Date.now()}`,
    });
    observe('rejected draft submission refusal', refused);
    record('the runtime refuses to submit the abandoned draft with a typed code',
      refused.status >= 400
        && typeof refused.body?.error?.code === 'string'
        && refused.body.error.code.length > 0
        && typeof refused.body?.error?.nextAction === 'string',
      refused.body?.error);

    // --- 重新整理 on a second real draft ------------------------------------
    const second = await openDraft('Do not ask questions. Create exactly one task: report the current weekday name.');
    const secondVersion = Number(second.surface.revisionVersion);
    const regenerateOpened = await clickDraftControl('regenerate');
    record('the real page opens the 重新整理 editor',
      regenerateOpened && await page.locator('[data-draft-editor="regenerate"]:not([hidden])').count() > 0,
      { regenerateOpened });
    if (regenerateOpened) {
      await page.fill('[data-draft-editor="regenerate"] textarea[name="instruction"]', '把交付物明确改成两份：一份星期名，一份日期。');
      await page.click('[data-draft-submit="regenerate"]');
      await harness.waitForDom(page, 'regenerated revision identity', async () => {
        const surface = await readDraftSurface(page);
        return Number(surface.revisionVersion) > secondVersion ? surface : null;
      }, 180_000);
    }
    const regenerated = await readDraftSurface(page);
    const regeneratedSnapshot = await snapshotOf(second.interactionId);
    observe('real regenerate', { surface: regenerated, revision: regeneratedSnapshot?.revision?.revisionVersion });
    record('重新整理 mints a new durable revision the served page reports',
      Number(regenerated.revisionVersion) > secondVersion
        && regeneratedSnapshot?.revision?.revisionVersion === Number(regenerated.revisionVersion),
      { before: secondVersion, displayed: regenerated.revisionVersion, durable: regeneratedSnapshot?.revision?.revisionVersion });

    await harness.captureScreenshot(binding, 'draft-lifecycle-real').catch(() => {});
    observe('real console errors', [...binding.browser.consoleErrors]);
    record('the real draft lifecycle page raises no page errors', binding.browser.consoleErrors.length === 0, binding.browser.consoleErrors);
  } finally {
    await binding.browser?.close().catch(() => {});
    if (serve) await serve.stop();
  }
}

// ---------------------------------------------------------------------------

const artifactDir = join(evidenceRoot, 'artifacts');
await mkdir(artifactDir, { recursive: true });

await sectionClientUnit();

const playwrightModule = await import(
  process.env.DRAFT_LIFECYCLE_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;

const browser = await playwright.chromium.launch({ headless: true });
let server;
try {
  server = await startStaticServer(uiRoot);
  await sectionDeterministic(browser, server.url, artifactDir);
} finally {
  await closeServer(server);
  if (skipReal) {
    observe('real runtime section', 'skipped via DRAFT_LIFECYCLE_SKIP_REAL=1');
  } else {
    const root = await mkdtemp(join(tmpdir(), 'draft-lifecycle-proof-'));
    try {
      await sectionReal(browser, artifactDir, root);
    } catch (error) {
      record('real draft-lifecycle section completed', false, error instanceof Error ? error.message : String(error));
    }
  }
  await browser.close();
}

await writeFile(
  join(evidenceRoot, 'checks.json'),
  `${JSON.stringify({ uiRoot, checks, observations }, null, 2)}\n`,
);

const failed = checks.filter((check) => !check.pass);
console.log(`draft lifecycle closure proof: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) {
  for (const check of failed) console.error(`FAIL ${check.name}: ${JSON.stringify(check.detail)}`);
  process.exitCode = 1;
} else {
  console.log('draft lifecycle closure proof passed');
}
