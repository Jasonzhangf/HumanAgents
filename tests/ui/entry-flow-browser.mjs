#!/usr/bin/env node

/**
 * T22c real-browser proof for the new-task entry flow.
 *
 * Two independent sections:
 *
 *   A. Deterministic DOM proof. A scripted runtime API implements the public
 *      explicit-brain contract (`/api/explicit/inputs`,
 *      `/api/explicit/interactions/:id/{interpret,clarification,confirmation}`,
 *      `/api/tasks`, `/api/tasks/:id/observation`) and serves the built UI over
 *      real HTTP. It proves:
 *        - read-only brain feedback is never written into an editable control;
 *        - one submit authorizes the task and stays on the entry index with the
 *          committed task row (`#entry-live a.task-row-link[data-task-id]`);
 *        - the second confirmation panel and `#entry-confirm-button` are gone;
 *        - the clarification loop survives;
 *        - a failed submit keeps the input and shows a readable error;
 *        - a rapid double click still creates exactly one task.
 *
 *   B. Real RCC proof. An isolated `serve --mode rcc` process (never the shared
 *      10086 instance) drives the served entry page against the live RCC
 *      endpoint on 127.0.0.1:4444 and records:
 *        - a real once execution that stays on the entry index with a live
 *          progress card, mirrored execution steps, total and per-step timers,
 *          and an in-place detail layer with the explicit full-dashboard link;
 *        - a scheduled plan persisted as a real subscription;
 *        - a recurring plan persisted with real time/zone/period parameters.
 *
 * Set `T22C_EVIDENCE` to the execution-owned evidence root. Optional:
 *   T22C_UI_ROOT            override the built UI root (red-base reproduction)
 *   T22C_RCC_MODEL          default goaichat.glm-5.3
 *   T22C_RCC_BASE_URL       default http://127.0.0.1:4444
 *   T22C_SKIP_RCC=1         run only section A
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.T22C_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.T22C_EVIDENCE?.trim();
const rccBaseUrl = (process.env.T22C_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const rccModel = process.env.T22C_RCC_MODEL ?? 'goaichat.glm-5.3';
const skipRcc = process.env.T22C_SKIP_RCC === '1';
const cliPath = resolve(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js');

if (!evidenceRoot) {
  throw new Error('T22C_EVIDENCE is required; point it at an execution-owned directory');
}

const playwrightModule = await import(
  process.env.T22C_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;

// Section A serves the real `docs/ui` modules and the scripted public runtime
// API through Playwright request interception against a synthetic origin. That
// needs no listening socket, so the deterministic browser proof still runs in a
// sandbox that denies TCP/UDP bind. Section B (real RCC) still needs real ports.
const proofOrigin = 'http://humanagent.entry-flow.test';
const browserArgs = (process.env.T22C_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

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

// The real error surface for a failed submission is the shell status region,
// not `#entry-error`. `#entry-error` is only the empty-field validation panel,
// so waiting for it would never observe a runtime rejection. `handleSubmissionError`
// writes `data-tone="danger"` into `[role="status"]`.
function readEntryFailure(page) {
  return page.evaluate(() => {
    const banner = document.querySelector('[role="status"]');
    const textarea = document.querySelector('#entry-form textarea[name="rawInput"]');
    const buttons = [...document.querySelectorAll('#entry-form button[type="submit"]')];
    return {
      tone: banner?.dataset?.tone ?? null,
      text: (banner?.textContent || '').trim(),
      inputValue: textarea?.value ?? null,
      inputReadOnly: textarea?.readOnly ?? null,
      retryLabel: buttons.map((button) => (button.textContent || '').trim()),
      hasVisibleRetry: buttons.some((button) => {
        if (button.getClientRects().length === 0) return false;
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }),
    };
  });
}

// The runtime's own `message` is published by the technical-detail control,
// not by the short visible summary. Click it like a human would, read the
// typed detail, then close the layer so the page is usable again.
async function readTechnicalDetailReason(page) {
  const trigger = page.locator('[role="status"] [data-technical-detail-trigger="true"]').first();
  await trigger.click();
  const dialog = page.locator('dialog[data-technical-detail="true"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  const message = ((await dialog.locator('[data-detail-message]').first().textContent()) || '').trim();
  const code = ((await dialog.locator('[data-detail-code]').first().textContent()) || '').trim();
  await dialog.locator('button.shell-layer-close').first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  return { message, code };
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
// Section A: scripted runtime API + static UI server
// ---------------------------------------------------------------------------

const scripted = {
  interactions: new Map(),
  tasks: [],
  interactionSeq: 0,
  taskSeq: 0,
  confirmFails: false,
  confirmationCount: 0,
  clarificationCount: 0,
  receiveCount: 0,
};

function draftFor(interaction) {
  const normalizedInput = `${interaction.rawInput.replace(/^CLARIFY\s*/, '').trim()} (规范化)`;
  return {
    draftId: `draft-${interaction.id}`,
    inputRevision: 1,
    normalizedInput,
    proposedIntent: 'create',
    proposal: `提交后执行：${normalizedInput}`,
    knownFacts: ['用户提供了一条业务输入', '显式大脑已完成整理'],
    matchedTasks: [],
    decisionRefs: [],
  };
}

function semanticTitleFor(rawInput) {
  return String(rawInput).replace(/^CLARIFY\s*/, '').trim();
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
    ...(interaction.clarifications.length ? { clarifications: interaction.clarifications } : {}),
  };
}

function observationProjection(taskId, providerScope) {
  if (providerScope) {
    return {
      surface: 'observation',
      state: 'running',
      data: { state: 'running', label: '运行中', detail: '脚本样本' },
      scope: {
        scopeRef: `task://${taskId}/observation/pipeline.execute`,
        title: '流水线执行事件',
        projectionSeq: '3',
        nodes: [
          { nodeId: 'event-1', title: 'provider.tool #1', kind: 'provider.event', state: 'succeeded', summary: '调用工具：file.read' },
          { nodeId: 'event-2', title: 'provider.output #2', kind: 'provider.event', state: 'succeeded', summary: '输出完成' },
        ],
      },
      nodes: [],
    };
  }
  const pipeline = ['sensory.inbox', 'explicit.normalize', 'implicit.classify', 'interactive.queue', 'execution.queue', 'pipeline.execute', 'settle', 'task.output'];
  return {
    surface: 'observation',
    state: 'running',
    data: { state: 'running', label: '运行中', detail: '脚本样本' },
    scope: {
      scopeRef: `task://${taskId}/observation`,
      title: '任务处理流水',
      projectionSeq: '3',
      nodes: pipeline.map((nodeId) => ({
        nodeId,
        title: nodeId,
        state: nodeId === 'pipeline.execute' ? 'succeeded' : 'created',
        stateDisplay: nodeId === 'pipeline.execute' ? '已完成' : '待处理',
      })),
    },
    nodes: pipeline.map((nodeId) => ({
      nodeId,
      title: nodeId,
      stateDisplay: nodeId === 'pipeline.execute' ? '已完成' : '待处理',
      kindDisplay: '执行',
      owner: 'agent-execution',
      roleDisplay: '执行',
      iteration: 1,
      summary: '脚本样本',
      toolSteps: [],
      activity: [],
    })),
  };
}

async function handleScriptedApi(url, method, body) {
  if (url.pathname === '/api/runtime/status') {
    return { status: 200, body: { mode: 'fake', state: 'ready', providerState: 'ready', connected: true } };
  }
  if (url.pathname === '/api/explicit/inputs' && method === 'POST') {
    scripted.receiveCount += 1;
    scripted.interactionSeq += 1;
    const id = `interaction-${scripted.interactionSeq}`;
    scripted.interactions.set(id, {
      id,
      rawInput: String(body?.rawInput ?? ''),
      state: 'received',
      draft: null,
      clarifications: [],
      answered: false,
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
    if (/CLARIFY_OPTIONS/.test(interaction.rawInput) && !interaction.answered) {
      interaction.state = 'awaiting-clarification';
      interaction.clarifications = [{
        question: '请选择验收范围。',
        options: ['仅检查 README 前 10 行', '检查整个 docs 目录'],
      }];
    } else if (/CLARIFY/.test(interaction.rawInput) && !interaction.answered) {
      interaction.state = 'awaiting-clarification';
      interaction.clarifications = [{ question: '请补充验收范围。' }];
    } else {
      interaction.state = 'awaiting-confirmation';
      interaction.draft = draftFor(interaction);
    }
    return { status: 200, body: snapshotFor(interaction) };
  }
  const matchingMatch = /^\/api\/explicit\/interactions\/([^/]+)\/matching$/.exec(url.pathname);
  if (matchingMatch && method === 'POST') {
    const interaction = scripted.interactions.get(decodeURIComponent(matchingMatch[1]));
    interaction.state = 'matching';
    return { status: 202, body: { interactionId: interaction.id } };
  }
  const recordMatch = /^\/api\/explicit\/interactions\/([^/]+)\/match$/.exec(url.pathname);
  if (recordMatch && method === 'POST') {
    const interaction = scripted.interactions.get(decodeURIComponent(recordMatch[1]));
    interaction.state = 'awaiting-intent';
    interaction.normalizedInput = String(body?.normalizedInput ?? '');
    return { status: 202, body: { interactionId: interaction.id } };
  }
  const proposalMatch = /^\/api\/explicit\/interactions\/([^/]+)\/proposal$/.exec(url.pathname);
  if (proposalMatch && method === 'POST') {
    const interaction = scripted.interactions.get(decodeURIComponent(proposalMatch[1]));
    interaction.state = 'awaiting-confirmation';
    interaction.draft = draftFor(interaction);
    return { status: 202, body: { interactionId: interaction.id } };
  }
  const clarificationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/clarification$/.exec(url.pathname);
  if (clarificationMatch && method === 'POST') {
    scripted.clarificationCount += 1;
    const interaction = scripted.interactions.get(decodeURIComponent(clarificationMatch[1]));
    const prior = interaction.clarifications?.at(-1);
    interaction.answered = true;
    interaction.state = 'matching';
    interaction.clarifications = [{
      question: prior?.question ?? '请补充验收范围。',
      ...(Array.isArray(prior?.options) ? { options: prior.options } : {}),
      answer: String(body?.answer ?? ''),
    }];
    return { status: 200, body: snapshotFor(interaction) };
  }
  const confirmationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(url.pathname);
  if (confirmationMatch && method === 'POST') {
    scripted.confirmationCount += 1;
    if (scripted.confirmFails) {
      return {
        status: 500,
        body: {
          error: {
            code: 'explicit-brain.final-submit-rejected',
            ownerId: 'humanagent.runtime.explicit-brain',
            message: 'final submit rejected by the scripted runtime',
            nextAction: 'inspect the runtime error and retry the same submission',
          },
        },
      };
    }
    const interaction = scripted.interactions.get(decodeURIComponent(confirmationMatch[1]));
    interaction.state = 'confirmed';
    scripted.taskSeq += 1;
    const taskId = `ui-task-${scripted.taskSeq}`;
    // The committed confirmation identity for this requirement. It is the one
    // authoritative source for the published task row and for the receipt the
    // entry page reads back, so a row can never be matched by title alone.
    const requirement = {
      requirementId: `requirement:${interaction.draft.draftId}:1`,
      draftId: interaction.draft.draftId,
      inputRevision: interaction.draft.inputRevision,
    };
    scripted.tasks.push({
      taskId: { scope: 'task', value: taskId },
      title: interaction.draft.normalizedInput,
      semanticTitle: semanticTitleFor(interaction.rawInput),
      currentState: '排队中',
      stateLabel: '排队中',
      state: 'waiting',
      nextStep: '等待执行',
      updatedAt: new Date().toISOString(),
      identitySource: { ...requirement },
    });
    return {
      status: 200,
      body: {
        requirement: { status: 'submitted', ...requirement },
      },
    };
  }
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return { status: 200, body: { draft: [], waiting: [...scripted.tasks], running: [], completed: [], stopped: [], failed: [] } };
  }
  // A confirmed task resolves its exact project/mode scope before the entry
  // page refreshes its committed row and starts the in-place progress card.
  if (url.pathname === '/api/dashboard' && url.searchParams.get('scope') === 'system') {
    return {
      status: 200,
      body: {
        surface: 'runtime-project',
        projects: scripted.tasks.length === 0
          ? []
          : [{
              projectKey: 'humanagent',
              mode: 'rcc',
              tasks: scripted.tasks.map((task) => ({
                scope: {
                  kind: 'task',
                  projectKey: 'humanagent',
                  mode: 'rcc',
                  taskId: task.taskId,
                },
                task: { taskId: task.taskId },
              })),
            }],
      },
    };
  }
  const observationMatch = /^\/api\/tasks\/([^/]+)\/observation$/.exec(url.pathname);
  if (observationMatch && method === 'GET') {
    const taskId = decodeURIComponent(observationMatch[1]);
    const scope = url.searchParams.get('scope') ?? '';
    return { status: 200, body: observationProjection(taskId, scope.endsWith('/pipeline.execute')) };
  }
  const dashboardMatch = /^\/api\/tasks\/([^/]+)\/dashboard$/.exec(url.pathname);
  if (dashboardMatch && method === 'GET') {
    return { status: 200, body: { surface: 'runtime-task-dashboard', state: 'running', taskId: { scope: 'task', value: decodeURIComponent(dashboardMatch[1]) } } };
  }
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
      const raw = request.postData();
      let body;
      if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
      const result = await handleScriptedApi(url, request.method(), body);
      await route.fulfill({
        status: result.status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(result.body),
      });
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

async function readEditableValues(page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll('input, textarea')];
    return {
      values: controls.map((control) => control.value),
      hasNormalizedInputControl: controls.some((control) => control.name === 'normalizedInput'),
    };
  });
}

// The entry task list is not in the primary column: it lives in the shared
// shell-layer drawer, so open it before reading the committed row.
async function openEntryTaskDrawer(page) {
  const trigger = page.locator('button[data-task-list-drawer-trigger="true"]').first();
  await trigger.waitFor({ state: 'visible', timeout: 5_000 });
  if (await page.locator('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]').count() === 0) {
    await trigger.click();
  }
  await page
    .locator('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });
}

// Wait for the exact committed task row, then open the entry task list drawer
// and read its real identity, href and progress. The entry page stays on
// index.html; it never navigates to observation on submit.
async function waitForSubmittedTaskRow(page, expectedTaskId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openEntryTaskDrawer(page).catch(() => {});
    const row = await page.evaluate((taskId) => {
      const link = document.querySelector(
        `dialog[data-technical-detail="true"][open] a.task-row-link[data-task-id="${taskId}"]`,
      );
      if (!link) return null;
      return {
        taskId: link.dataset.taskId,
        href: link.getAttribute('href'),
        heading: (link.querySelector('h3')?.textContent || '').trim(),
        progress: (link.querySelector('p')?.textContent || '').trim(),
        stateChip: (link.querySelector('.state-chip')?.textContent || '').trim(),
      };
    }, expectedTaskId).catch(() => null);
    if (row) return row;
    await sleep(100);
  }
  throw new Error(`submitted task row ${expectedTaskId} did not render in the entry task list drawer within ${timeoutMs} ms`);
}

// Launch one fresh browser+context for a deterministic case. A constrained
// sandbox restarts Chromium after a context close under `--single-process`, so
// each case owns and closes its own browser.
async function withScriptedPage(run, { viewport, reducedMotion } = {}) {
  const browser = await playwright.chromium.launch({ headless: true, args: browserArgs });
  const context = await browser.newContext({
    viewport,
    ...(reducedMotion === undefined ? {} : { reducedMotion }),
  });
  await installScriptedRoutes(context);
  const page = await context.newPage();
  try {
    return await run(page);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function sectionA(artifactDir) {
  const runs = [
    { label: 'desktop', viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' },
    { label: 'mobile', viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' },
    { label: 'reduced-motion', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' },
  ];

  // Defect A: the brain feedback is read-only and never lands in an editable control.
  await withScriptedPage(async (page) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${proofOrigin}/interaction.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('form[data-explicit-input] textarea[name="rawInput"]');
    await page.fill('form[data-explicit-input] textarea[name="rawInput"]', '整理这条需求并生成草稿');
    await page.click('form[data-explicit-input] button[type="submit"]');
    await page.waitForFunction(() => {
      const button = document.querySelector('form[data-explicit-match] button[type="submit"]');
      return Boolean(button && !button.disabled);
    }, undefined, { timeout: 10_000 });
    await page.fill('form[data-explicit-match] textarea[name="matchedTasks"]', '[]');
    await page.click('form[data-explicit-match] button[type="submit"]');
    await page.waitForFunction(() => {
      const button = document.querySelector('form[data-explicit-proposal] button[type="submit"]');
      return Boolean(button && !button.disabled);
    }, undefined, { timeout: 10_000 });
    await page.fill('form[data-explicit-proposal] textarea[name="proposal"]', '提交后执行整理好的需求');
    await page.click('form[data-explicit-proposal] button[type="submit"]');
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-draft-feedback]');
      return Boolean(node && node.textContent && node.textContent.includes('规范化'));
    }, undefined, { timeout: 10_000 });
    const feedbackText = (await page.textContent('[data-draft-feedback]')) ?? '';
    const editable = await readEditableValues(page);
    observe('defectA feedback text', feedbackText);
    observe('defectA editable values', editable.values);
    record('defectA feedback is readable in the read-only region', feedbackText.includes('规范化输入') && feedbackText.includes('意图'), feedbackText.slice(0, 300));
    record('defectA no editable normalizedInput control exists', editable.hasNormalizedInputControl === false, editable.hasNormalizedInputControl);
    record('defectA feedback text never appears in an editable value', editable.values.every((value) => !value.includes('(规范化)')), editable.values);
    record('defectA interaction page has no page errors', pageErrors.length === 0, pageErrors);
    await page.screenshot({ path: join(artifactDir, 'defect-a-feedback-desktop.png') });
  }, { viewport: runs[0].viewport });

  // Defect B: one submit authorizes the task and renders its committed row in place.
  for (const run of runs) {
    await withScriptedPage(async (page) => {
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#entry-form textarea[name="rawInput"]');
      const confirmButtonCount = await page.locator('#entry-confirm-button').count();
      record(`${run.label} no second confirmation button exists`, confirmButtonCount === 0, confirmButtonCount);
      const rawInput = '读取 README 并汇报';
      const receiveBefore = scripted.receiveCount;
      const confirmBefore = scripted.confirmationCount;
      const expectedTaskId = `ui-task-${scripted.taskSeq + 1}`;
      await page.fill('#entry-form textarea[name="rawInput"]', rawInput);
      await page.click('#entry-form button[type="submit"]');
      const row = await waitForSubmittedTaskRow(page, expectedTaskId);
      const href = new URL(row.href, page.url());
      record(`${run.label} one submit stays on the entry index`, new URL(page.url()).pathname === '/index.html', page.url());
      record(`${run.label} one submit renders the exact committed task id`, row.taskId === expectedTaskId, { taskId: row.taskId, expectedTaskId });
      record(`${run.label} one submit task row links to the task dashboard`, href.pathname.endsWith('/task-dashboard.html') && href.searchParams.get('task') === expectedTaskId, row.href);
      record(`${run.label} one submit task row shows in-place waiting progress`, row.progress === '排队中' && row.stateChip === '排队中', { progress: row.progress, stateChip: row.stateChip });
      record(`${run.label} one submit task row uses the controlled semanticTitle`, row.heading === semanticTitleFor(rawInput), row.heading);
      record(`${run.label} one submit issues exactly one receive`, scripted.receiveCount - receiveBefore === 1, scripted.receiveCount - receiveBefore);
      record(`${run.label} one submit issues exactly one confirmation`, scripted.confirmationCount - confirmBefore === 1, scripted.confirmationCount - confirmBefore);
      record(`${run.label} entry page has no page errors`, pageErrors.length === 0, pageErrors);
      await page.screenshot({ path: join(artifactDir, `defect-b-task-row-${run.label}.png`) });
    }, { viewport: run.viewport, reducedMotion: run.reducedMotion });
  }

  // Clarification loop survives.
  await withScriptedPage(async (page) => {
    const rawInput = 'CLARIFY 处理这份需求';
    const expectedTaskId = `ui-task-${scripted.taskSeq + 1}`;
    await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#entry-form textarea[name="rawInput"]', rawInput);
    await page.click('#entry-form button[type="submit"]');
    await page.waitForSelector('#entry-draft input[name="answer"]', { timeout: 10_000 });
    const question = (await page.textContent('#entry-draft')) ?? '';
    const optionCountWithoutOptions = await page.locator('#entry-draft [data-clarification-option]').count();
    record('clarification without options does not fabricate option buttons', optionCountWithoutOptions === 0, optionCountWithoutOptions);
    await page.fill('#entry-draft input[name="answer"]', '验收范围就是 README 的前 10 行');
    await page.click('#entry-draft button[type="submit"]');
    const row = await waitForSubmittedTaskRow(page, expectedTaskId);
    const href = new URL(row.href, page.url());
    record('clarification question is rendered before authorization', question.includes('请补充验收范围'), question.slice(0, 200));
    record(
      'clarification answer renders the committed task row on the entry index',
      row.taskId === expectedTaskId
      && new URL(page.url()).pathname === '/index.html'
      && href.pathname.endsWith('/task-dashboard.html')
      && href.searchParams.get('task') === expectedTaskId
      && row.heading === semanticTitleFor(rawInput),
      { row, url: page.url() },
    );
  }, { viewport: runs[0].viewport });

  // Clarification with candidate options renders clickable option buttons across
  // desktop and mobile viewports and submits immediately when an option is clicked.
  for (const run of runs) {
    await withScriptedPage(async (page) => {
      const rawInput = `CLARIFY_OPTIONS 处理这份需求 (${run.label})`;
      const expectedTaskId = `ui-task-${scripted.taskSeq + 1}`;
      const clarifyBefore = scripted.clarificationCount;
      await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.fill('#entry-form textarea[name="rawInput"]', rawInput);
      await page.click('#entry-form button[type="submit"]');
      await page.waitForSelector('#entry-draft [data-clarification-option="0"]', { timeout: 10_000 });
      const optionTexts = await page.locator('#entry-draft [data-clarification-option]').allTextContents();
      record(
        `${run.label} clarification renders candidate option buttons`,
        optionTexts.length === 2
        && optionTexts[0]?.trim() === '仅检查 README 前 10 行'
        && optionTexts[1]?.trim() === '检查整个 docs 目录',
        optionTexts,
      );
      await page.click('#entry-draft [data-clarification-option="0"]');
      const row = await waitForSubmittedTaskRow(page, expectedTaskId);
      const href = new URL(row.href, page.url());
      record(
        `${run.label} clicking a clarification option submits immediately and renders the committed task row`,
        scripted.clarificationCount - clarifyBefore === 1
        && row.taskId === expectedTaskId
        && new URL(page.url()).pathname === '/index.html'
        && href.pathname.endsWith('/task-dashboard.html')
        && href.searchParams.get('task') === expectedTaskId
        && row.heading === semanticTitleFor(rawInput),
        { row, clarificationDelta: scripted.clarificationCount - clarifyBefore, url: page.url() },
      );
    }, { viewport: run.viewport, reducedMotion: run.reducedMotion });
  }

  // A failed submission keeps the goal text, reports the real reason in the
  // shell status region and leaves a usable retry. The retry must reuse the
  // same interaction: one more confirmation only, no second receive and no
  // resent clarification answer, then the same committed task row on index.
  //
  // The reason is read from the technical-detail trigger, because that is the
  // control that publishes the runtime's own `message`; the visible summary is
  // intentionally short. A click proves the reason is reachable by a human.
  for (const variant of [
    { label: 'plain', rawInput: '这条提交会被运行时拒绝', clarification: false },
    { label: 'clarification', rawInput: 'CLARIFY 这条提交会被运行时拒绝', clarification: true },
  ]) {
    await withScriptedPage(async (page) => {
      scripted.confirmFails = true;
      try {
        const receiveBefore = scripted.receiveCount;
        await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#entry-form textarea[name="rawInput"]');
        await page.fill('#entry-form textarea[name="rawInput"]', variant.rawInput);
        await page.click('#entry-form button[type="submit"]');
        // The clarification round runs before the confirmation, so let it
        // finish first; only then does the confirmation rejection surface.
        if (variant.clarification) {
          await page.waitForSelector('#entry-draft input[name="answer"]', { timeout: 10_000 });
          await page.fill('#entry-draft input[name="answer"]', '验收范围就是 README 的前 10 行');
          await page.click('#entry-draft button[type="submit"]');
        }
        await page.waitForFunction(
          () => document.querySelector('[role="status"]')?.dataset?.tone === 'danger',
          undefined, { timeout: 10_000 },
        );
        const failure = await readEntryFailure(page);
        observe(`${variant.label} failure surface`, failure);
        const detail = await readTechnicalDetailReason(page);
        observe(`${variant.label} technical detail`, detail);
        record(
          `${variant.label} failed submit surfaces the real danger status`,
          failure.tone === 'danger',
          failure.tone,
        );
        record(
          `${variant.label} failed submit reports the real reason through the technical detail`,
          detail.message.includes('final submit rejected by the scripted runtime')
          && detail.code === 'explicit-brain.final-submit-rejected',
          detail,
        );
        record(
          `${variant.label} failed submit keeps the original goal text`,
          failure.inputValue === variant.rawInput,
          failure.inputValue,
        );
        record(
          `${variant.label} failed submit keeps the goal text read-only`,
          failure.inputReadOnly === true,
          failure.inputReadOnly,
        );
        record(
          `${variant.label} failed submit leaves a visible retry on the main action`,
          failure.hasVisibleRetry
          && (variant.clarification || failure.retryLabel.some((label) => label.startsWith('重试'))),
          failure.retryLabel,
        );
        if (variant.clarification) {
          observe(
            `${variant.label} advisory: retry affordance keeps the generic submit label`,
            'After a failed confirmation in the clarification variant, the removed clarification button cannot be relabelled; the main submit button remains visible and usable as the retry. This is a UX label advisory, not a duplicate-submission defect.',
          );
        }

        const beforeRetry = {
          receive: scripted.receiveCount,
          confirm: scripted.confirmationCount,
          clarify: scripted.clarificationCount,
        };
        scripted.confirmFails = false;
        const expectedTaskId = `ui-task-${scripted.taskSeq + 1}`;
        await page.click('#entry-form button[type="submit"]');
        const row = await waitForSubmittedTaskRow(page, expectedTaskId);
        const href = new URL(row.href, page.url());
        record(
          `${variant.label} retry reuses the same interaction and does not resend the input`,
          scripted.receiveCount - beforeRetry.receive === 0,
          { totalReceiveDelta: scripted.receiveCount - receiveBefore, retryReceiveDelta: scripted.receiveCount - beforeRetry.receive },
        );
        record(
          `${variant.label} retry does not resend the clarification answer`,
          scripted.clarificationCount - beforeRetry.clarify === 0,
          scripted.clarificationCount - beforeRetry.clarify,
        );
        record(
          `${variant.label} retry confirms the same submission exactly once`,
          scripted.confirmationCount - beforeRetry.confirm === 1,
          scripted.confirmationCount - beforeRetry.confirm,
        );
        record(
          `${variant.label} retry renders the committed task row on the entry index`,
          row.taskId === expectedTaskId
          && new URL(page.url()).pathname === '/index.html'
          && href.pathname.endsWith('/task-dashboard.html')
          && href.searchParams.get('task') === expectedTaskId
          && row.heading === semanticTitleFor(variant.rawInput),
          { row, url: page.url() },
        );
        await page.screenshot({ path: join(artifactDir, `failure-retains-input-${variant.label}.png`) });
      } finally {
        scripted.confirmFails = false;
      }
    }, { viewport: runs[0].viewport });
  }

  // A rapid double click still produces exactly one task.
  await withScriptedPage(async (page) => {
    const receiveBefore = scripted.receiveCount;
    const confirmBefore = scripted.confirmationCount;
    const tasksBefore = scripted.tasks.length;
    const expectedTaskId = `ui-task-${scripted.taskSeq + 1}`;
    await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#entry-form textarea[name="rawInput"]', '只允许创建一次的任务');
    await page.evaluate(() => {
      const button = document.querySelector('#entry-form button[type="submit"]');
      button.click();
      button.click();
    });
    const row = await waitForSubmittedTaskRow(page, expectedTaskId);
    const href = new URL(row.href, page.url());
    await sleep(1500);
    const receiveDelta = scripted.receiveCount - receiveBefore;
    const confirmDelta = scripted.confirmationCount - confirmBefore;
    const taskDelta = scripted.tasks.length - tasksBefore;
    record('rapid double click issues exactly one explicit input', receiveDelta === 1, receiveDelta);
    record('rapid double click issues exactly one confirmation', confirmDelta === 1, confirmDelta);
    record('rapid double click creates exactly one task', taskDelta === 1, taskDelta);
    record(
      'rapid double click renders the single committed task row on the entry index',
      row.taskId === expectedTaskId
      && new URL(page.url()).pathname === '/index.html'
      && href.pathname.endsWith('/task-dashboard.html')
      && href.searchParams.get('task') === expectedTaskId
      && row.heading === semanticTitleFor('只允许创建一次的任务'),
      { row, url: page.url() },
    );
  }, { viewport: runs[0].viewport });
}

// ---------------------------------------------------------------------------
// Section B: real isolated serve + real RCC
// ---------------------------------------------------------------------------

function startServe(root) {
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const child = spawn(process.execPath, [
    cliPath, 'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 't22c-entry-flow-proof',
    '--provider', 'rcc',
    '--model', rccModel,
    '--route', 'rcc/t22c-entry-flow',
    '--rcc-base-url', rccBaseUrl,
    '--workspace', workspace,
    '--control-root', controlRoot,
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
  const response = await fetch(`${base}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, host: new URL(base).host },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error(`pair failed ${response.status}: ${await response.text()}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, domain: '127.0.0.1', path: '/' }]);
}

// A context close also ends Chromium under `--single-process`, so each real
// RCC case owns a fresh browser just like the deterministic section cases.
async function withRccPage(base, workspace, controlRoot, options, run) {
  const browser = await playwright.chromium.launch({ headless: true, args: browserArgs });
  let context;
  try {
    context = await browser.newContext(options);
    await pairContext(context, base, workspace, controlRoot);
    const page = await context.newPage();
    page.__base = base;
    return await run(page, context);
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function submitThroughEntry(page, { rawInput, mode, startAt }) {
  await page.goto(`${page.__base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entry-form textarea[name="rawInput"]');
  await page.fill('#entry-form textarea[name="rawInput"]', rawInput);
  await page.selectOption('#entry-form select[name="executionMode"]', mode);
  if (startAt) await page.fill('#entry-form input[name="scheduledStartAt"]', startAt);
  await page.click('#entry-form button[type="submit"]');
}

/**
 * Wait until the entry page shows the plan receipt for a scheduled/recurring
 * submission, or fail fast with the status/error the page actually shows. A
 * blind `waitForFunction` timeout turns a `status-only` brain reply or a
 * backend rejection into an opaque 90 s wait.
 */
async function waitForPlanReceipt(page, mode, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = { draftVisible: false, panelText: '', statusText: '' };
  while (Date.now() < deadline) {
    const state = await page.evaluate((expectedMode) => {
      const draftVisible = Boolean(document.querySelector('#entry-draft'));
      const status = document.querySelector('[role="status"]');
      const panel = document.querySelector('#entry-error');
      const panelText = panel && !panel.hidden ? (panel.textContent || '').trim() : '';
      const statusText = (status?.textContent || '').trim();
      return {
        draftVisible,
        panelText,
        statusText,
        liveProgress: Boolean(status?.querySelector('.progress--live')),
        hasReceipt: draftVisible && statusText.includes(expectedMode === 'once' ? '正在打开执行观测' : '执行计划已保存'),
      };
    }, mode).catch(() => ({
      draftVisible: false,
      panelText: '',
      statusText: '',
      liveProgress: false,
      hasReceipt: false,
    }));
    last = state;
    if (state.hasReceipt) return;
    if (state.panelText) throw new Error(`plan receipt was not produced: ${state.panelText}`);
    if (state.statusText && !state.liveProgress && !/等待|保存|正在|整理|提交/.test(state.statusText)) {
      throw new Error(`plan receipt was not produced; page status: ${state.statusText}`);
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `plan receipt was not produced within ${timeoutMs} ms; `
    + `the explicit brain may have answered status-only instead of saving a plan `
    + `(draft visible: ${last.draftVisible}; status: ${last.statusText || 'empty'}; error: ${last.panelText || 'none'})`,
  );
}

/**
 * Wait until the real observation projection reports a terminal
 * `pipeline.execute` node that also carries at least one typed tool step.
 *
 * This must poll from Node. `page.waitForFunction` resolves as soon as the page
 * function returns a Promise, so an `async` predicate resolves on its first call
 * and never observes a later state.
 */
async function waitForObservationTrace(context, base, taskId, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  const timeline = [];
  let last = 'no projection yet';
  while (Date.now() < deadline) {
    const response = await context.request.get(
      `${base}/api/tasks/${encodeURIComponent(taskId)}/observation?node=pipeline.execute`,
    );
    if (response.ok()) {
      const projection = await response.json();
      const node = projection.scope?.nodes?.find((item) => item.nodeId === 'pipeline.execute');
      const toolSteps = projection.selectedNode?.toolSteps ?? [];
      const line = `+${Math.round((Date.now() - started) / 1000)}s ${node?.state ?? 'missing'}/tools=${toolSteps.length}`;
      if (line !== last) { timeline.push(line); last = line; }
      // `blocked` is a real final terminal state (a terminal event with
      // terminalPhase `final`), so a provider failure must not be treated as a
      // missing projection.
      if (node && ['succeeded', 'failed', 'stopped', 'blocked'].includes(node.state) && toolSteps.length > 0) {
        return { timeline: timeline.join(' '), state: node.state, toolSteps };
      }
    } else {
      last = `observation http ${response.status()}`;
      timeline.push(last);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`real observation never projected a terminal tool trace: ${timeline.join(' ')}`);
}

// D20: the confirmed once task stays on the single entry page, so the real
// proof reads the in-place live submit card instead of an observation page.
const readLiveCard = () => {
  const banner = document.querySelector('.status-banner');
  const block = banner?.querySelector('.progress.progress--live') ?? null;
  if (!block) return { hasBlock: false, tone: banner?.dataset?.tone ?? null };
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
    tone: banner?.dataset?.tone ?? null,
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    intersectsViewport: rect.bottom > 0 && rect.top < window.innerHeight,
    overflowX: block.scrollWidth > block.clientWidth + 1,
  };
};

function isSemanticProgressPhase(value) {
  const phase = String(value ?? '').trim();
  return phase !== '' && /[\u4e00-\u9fff]/u.test(phase) && !/^步骤\s*\d+/u.test(phase);
}

const readEntryFailureSurface = () => {
  const banner = document.querySelector('[role="status"]');
  const panel = document.querySelector('#entry-error');
  return {
    tone: banner?.dataset?.tone ?? null,
    panelText: panel && !panel.hidden ? (panel.textContent || '').trim() : '',
    statusText: (banner?.textContent || '').trim(),
  };
};

/**
 * Wait until the in-place live progress card carries a real runtime step
 * (semantic Chinese phase) with the total and per-step timers. This polls from Node so an
 * upstream rejection surfaces the page's own reason instead of an opaque
 * timeout.
 */
async function waitForLiveExecutionCard(page, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let last = { hasBlock: false };
  while (Date.now() < deadline) {
    last = await page.evaluate(readLiveCard).catch(() => ({ hasBlock: false }));
    if (last.hasBlock && isSemanticProgressPhase(last.phase) && last.timerCount === 2) return last;
    const failure = await page.evaluate(readEntryFailureSurface).catch(() => null);
    if (failure && (failure.tone === 'danger' || failure.panelText)) {
      throw new Error(
        `once submit did not reach a live execution step: `
        + `${failure.panelText || failure.statusText} (tone=${failure.tone ?? 'none'})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `once submit never showed a live execution step `
    + `(phase=${last.phase ?? 'none'}, tone=${last.tone ?? 'none'}, url=${page.url()})`,
  );
}

async function waitForCommittedTaskId(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await openEntryTaskDrawer(page).catch(() => {});
    const taskId = await page.evaluate(() => (
      document.querySelector('dialog[data-technical-detail="true"][open] a.task-row-link[data-task-id]')?.dataset?.taskId ?? null
    )).catch(() => null);
    if (taskId) return taskId;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('the committed task row never rendered in the entry task list drawer');
}

/**
 * The committed once task is a queued parent; the real execution runs on the
 * current-execution child the runtime grouped under that row. Resolve the child
 * so the independent observation oracle reads the task that actually carries
 * the operation and the provider tool trace.
 */
async function waitForExecutionChildId(context, base, parentTaskId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await context.request.get(`${base}/api/tasks`);
    if (response.ok()) {
      const body = await response.json();
      const rows = [
        ...(body?.draft ?? []),
        ...(body?.waiting ?? []),
        ...(body?.running ?? []),
        ...(body?.completed ?? []),
        ...(body?.stopped ?? []),
        ...(body?.failed ?? []),
      ];
      const row = rows.find((candidate) => candidate.taskId?.value === parentTaskId);
      const rawChild = row?.currentExecutionTaskId;
      const childId = rawChild && typeof rawChild === 'object' ? rawChild.value : rawChild;
      if (childId && childId !== parentTaskId) return childId;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return parentTaskId;
}

/**
 * Clicking the live card opens the shell detail layer. Read the real task
 * identity, the mirrored execution steps and the explicit full-dashboard link.
 */
async function openLiveCardDetail(page) {
  await page.locator('.status-banner .progress.progress--live').first().click();
  const dialog = page.locator('dialog.shell-layer[open]').first();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const state = await dialog.evaluate((node) => ({
    text: (node.innerText || '').replace(/\s+/g, ' ').trim(),
    facts: [...node.querySelectorAll('.draft-receipt > div')].map((row) => ({
      label: (row.querySelector('dt')?.textContent || '').trim(),
      value: (row.querySelector('dd')?.textContent || '').trim(),
    })),
    steps: [...node.querySelectorAll('.progress-step')].map((item) => ({
      seq: (item.querySelector('.progress-step-seq')?.textContent || '').trim(),
      summary: (item.querySelector('.progress-step-summary')?.textContent || '').trim(),
      time: (item.querySelector('.progress-step-time')?.textContent || '').trim(),
    })),
    links: [...node.querySelectorAll('a[href]')].map((anchor) => ({
      text: (anchor.textContent || '').trim(),
      href: anchor.getAttribute('href'),
    })),
  }));
  return { dialog, state };
}

async function sectionB(artifactDir, root) {
  let serve;
  const run = { ok: false };
  try {
    const health = await fetch(`${rccBaseUrl}/health`);
    record('real RCC endpoint answers /health', health.ok, health.status);
    serve = startServe(root);
    const launched = await serve.ready;
    const base = launched.url;
    observe('serve', { url: base, pid: serve.pid, checkpointRoot: launched.checkpointRoot });
    const workspace = join(root, 'workspace');
    const controlRoot = join(root, 'control');

    // Once: the submit is the single confirmation and the page stays on the
    // single entry interface while the live card mirrors the real execution
    // steps. The runtime observation projection is read only as an independent
    // oracle that the real provider tool execution happened; there is no
    // observation navigation anymore.
    {
      await withRccPage(
        base,
        workspace,
        controlRoot,
        { viewport: { width: 1280, height: 720 } },
        async (page, context) => {
          let confirmationBody;
          page.on('request', (request) => {
            if (request.url().endsWith('/confirmation') && request.method() === 'POST') confirmationBody = request.postDataJSON();
          });
          const pageErrors = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await submitThroughEntry(page, {
            rawInput: 'Do not ask questions. Create exactly one task: read marker.txt in the workspace root and report its contents, then finish with COMPLETE.',
            mode: 'once',
          });
          const taskId = await waitForCommittedTaskId(page);
          await waitForLiveExecutionCard(page);
          await page.waitForTimeout(1_200);
          const card = await page.evaluate(readLiveCard);
          const confirmSurface = await page.evaluate(() => ({
            secondConfirmButton: document.querySelectorAll('#entry-confirm-button, [data-entry-confirm]').length,
            confirmLabels: [...document.querySelectorAll('button')]
              .map((button) => (button.textContent || '').trim())
              .filter((label) => /确认|审批|二次/.test(label)),
          }));
          observe('once task id', taskId);
          observe('once url after submit', page.url());
          observe('once live card', card);
          record('once submit stays on the entry index', new URL(page.url()).pathname === '/index.html', page.url());
          record('once live card is visible after confirmation', card.hasBlock === true, card.hasBlock);
          record('once live card shows a semantic execution phase', isSemanticProgressPhase(card.phase), card.phase);
          record('once live card shows the real runtime summary', (card.detail ?? '').trim().length > 0, card.detail);
          record(
            'once live card shows total and per-step timers',
            card.timerCount === 2 && card.timers.every((timer) => /总耗时|本步/.test(timer ?? '')),
            card.timers,
          );
          record('once live card is interactive', card.interactive === true, card.interactive);
          record(
            'once submit sends a once execution policy',
            confirmationBody?.executionPolicy?.executionMode === 'once'
              && Boolean(confirmationBody?.executionPolicy?.dueAt),
            confirmationBody,
          );
          record(
            'once submit shows no second confirmation control',
            confirmSurface.secondConfirmButton === 0 && confirmSurface.confirmLabels.length === 0,
            confirmSurface,
          );

          // Independent real-RCC oracle: the runtime's own observation projection
          // must settle with a provider tool trace for the task that actually runs
          // the operation (the current-execution child of the committed parent).
          const executionTaskId = await waitForExecutionChildId(context, base, taskId);
          observe('once execution task id', executionTaskId);
          const traceSettlement = await waitForObservationTrace(context, base, executionTaskId);
          observe('once observation settlement timeline', traceSettlement?.timeline);
          observe('once observation pipeline state', traceSettlement?.state);
          observe('once observation provider tool steps', traceSettlement?.toolSteps);
          const historyResponse = await context.request.get(
            `${base}/api/tasks/${encodeURIComponent(executionTaskId)}/history?limit=200`,
          );
          const historyBody = historyResponse.ok() ? await historyResponse.json() : null;
          const reportedTurnIds = [...new Set(
            (historyBody?.page?.items ?? [])
              .map((entry) => entry.turnId)
              .filter((value) => typeof value === 'string' && value.length > 0),
          )];
          observe('once runtime history status', historyResponse.status());
          observe('once reported turn ids', reportedTurnIds);
          record('once real task reported a provider turn id', reportedTurnIds.length > 0, reportedTurnIds);

          // Real-RCC screenshots of the live card with step and timers.
          await page.setViewportSize({ width: 1280, height: 720 });
          const wide = await page.evaluate(readLiveCard);
          record('1280x720 live card intersects the viewport', wide.intersectsViewport === true, wide.rect);
          await page.screenshot({ path: join(proofEvidenceDir, 'real-rcc-live-card-1280x720.png') });
          await page.setViewportSize({ width: 390, height: 844 });
          const narrow = await page.evaluate(readLiveCard);
          record('390x844 live card intersects the viewport', narrow.intersectsViewport === true, narrow.rect);
          record(
            '390x844 live card stays inside the viewport',
            narrow.rect.left >= 0 && narrow.rect.right <= 390,
            narrow.rect,
          );
          record('390x844 live card has no horizontal overflow', narrow.overflowX === false, narrow.overflowX);
          await page.screenshot({ path: join(proofEvidenceDir, 'real-rcc-live-card-390x844.png') });

          // The live card opens the in-place detail layer: real task identity,
          // mirrored real steps and the explicit full-dashboard link.
          await page.setViewportSize({ width: 1280, height: 720 });
          const { dialog, state: detail } = await openLiveCardDetail(page);
          observe('once live card detail', detail);
          const taskFact = detail.facts.find((fact) => fact.label === '任务')?.value ?? '';
          const fullDashboard = detail.links.find((link) => link.text === '打开完整任务看板');
          const fullDashboardHref = fullDashboard ? new URL(fullDashboard.href, page.url()) : null;
          const oracleToolNames = (traceSettlement?.toolSteps ?? [])
            .map((step) => step.name)
            .filter((name) => typeof name === 'string' && name.length > 0);
          const drawerHasOracleToolStep = detail.steps.some((step) => oracleToolNames
            .some((name) => step.summary.includes(`调用工具：${name}`)));
          record('clicking the live card opens the detail layer', detail.text.length > 0, detail.text.slice(0, 200));
          record('detail layer reports the real task identity', taskFact === taskId, { taskFact, taskId });
          record(
            'detail layer lists real execution steps',
            detail.steps.length > 0
              && detail.steps.every((step) => isSemanticProgressPhase(step.seq) && step.summary.length > 0),
            detail.steps,
          );
          record(
            'detail layer mirrors the oracle provider tool steps',
            oracleToolNames.length > 0 && drawerHasOracleToolStep,
            { oracleToolNames, steps: detail.steps.map((step) => step.summary).slice(-8) },
          );
          record(
            'detail layer exposes the explicit full-dashboard link',
            fullDashboardHref !== null
              && fullDashboardHref.pathname.endsWith('/task-dashboard.html')
              && fullDashboardHref.searchParams.get('task') === taskId,
            fullDashboard,
          );
          await page.screenshot({ path: join(proofEvidenceDir, 'real-rcc-live-card-detail-1280x720.png') });
          await dialog.locator('button.shell-layer-close').first().click();
          await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
          record(
            'closing the detail layer returns to the entry page',
            new URL(page.url()).pathname === '/index.html'
              && await page.locator('dialog.shell-layer[open]').count() === 0,
            page.url(),
          );
          record('once entry page has no page errors', pageErrors.length === 0, pageErrors);
          run.ok = true;
        },
      );
    }

    // Scheduled and recurring: real plans persisted as subscriptions. The two
    // plans need distinct requirements: the explicit brain matches an existing
    // task for identical input and answers `status-only`, which would leave the
    // recurring plan unexercised.
    const subscriptionsPath = join(launched.checkpointRoot, 'rcc', 'subscriptions.jsonl');
    for (const plan of [
      { mode: 'scheduled', label: 'scheduled', rawInput: 'Do not ask questions. Create exactly one task: report the current date.' },
      { mode: 'recurring', label: 'recurring', rawInput: 'Do not ask questions. Create exactly one task: report the current weekday name.' },
    ]) {
      await withRccPage(base, workspace, controlRoot, { viewport: { width: 1440, height: 1000 } }, async (page) => {
        let confirmationBody;
        page.on('request', (request) => {
          if (request.url().endsWith('/confirmation') && request.method() === 'POST') confirmationBody = request.postDataJSON();
        });
        await submitThroughEntry(page, { rawInput: plan.rawInput, mode: plan.mode });
        await waitForPlanReceipt(page, plan.mode);
        record(`${plan.label} submit sends its execution policy`, confirmationBody?.executionPolicy?.executionMode === plan.mode && Boolean(confirmationBody?.executionPolicy?.timezone) && Boolean(confirmationBody?.executionPolicy?.startAt), confirmationBody);
      });
    }
    const subscriptionLines = (await readFile(subscriptionsPath, 'utf8')).trim().split('\n').filter(Boolean);
    const latest = JSON.parse(subscriptionLines.at(-1));
    const subscriptions = Object.values(latest.payload.state.subscriptions);
    const scheduled = subscriptions.find((entry) => entry.policy.executionMode === 'scheduled');
    const recurring = subscriptions.find((entry) => entry.policy.executionMode === 'recurring');
    observe('subscriptions', subscriptions.map((entry) => ({ id: entry.subscription.subscriptionId, policy: entry.policy })));
    record('scheduled plan persists a real startAt and timezone', Boolean(scheduled) && Boolean(scheduled.policy.startAt) && Boolean(scheduled.policy.timezone), scheduled?.policy);
    record('recurring plan persists a real period and timezone', Boolean(recurring) && Boolean(recurring.policy.frequency) && Boolean(recurring.policy.timezone), recurring?.policy);
  } finally {
    if (serve) await serve.stop();
  }
  return run;
}

// ---------------------------------------------------------------------------

const artifactDir = join(evidenceRoot, 'artifacts');
await mkdir(artifactDir, { recursive: true });
// The D20 real-RCC screenshots live with the product evidence, not in the
// execution-owned artifact scratch root.
const proofEvidenceDir = join(repoRoot, 'docs', 'evidence', 'd20-single-interface-20261101');
await mkdir(proofEvidenceDir, { recursive: true });
try {
  await sectionA(artifactDir);
} catch (error) {
  record('deterministic entry-flow section completed', false, error instanceof Error ? error.message : String(error));
}
if (skipRcc) {
  observe('rcc', 'skipped via T22C_SKIP_RCC=1');
} else {
  const root = await mkdtemp(join(tmpdir(), 't22c-entry-flow-'));
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'workspace', 'marker.txt'), 'T22C_MARKER\n', 'utf8');
  try {
    await sectionB(artifactDir, root);
  } catch (error) {
    record('real RCC section completed', false, error instanceof Error ? error.message : String(error));
  }
}

await writeFile(
  join(evidenceRoot, 'checks.json'),
  `${JSON.stringify({ uiRoot, rccBaseUrl, rccModel, checks, observations }, null, 2)}\n`,
);
const failed = checks.filter((check) => !check.pass);
console.log(`entry flow browser checks: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) {
  for (const check of failed) console.error(`FAIL ${check.name}: ${JSON.stringify(check.detail)}`);
  process.exitCode = 1;
} else {
  console.log('entry flow browser checks passed');
}
