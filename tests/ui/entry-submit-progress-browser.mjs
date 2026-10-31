#!/usr/bin/env node

/**
 * Task-17 real-browser proof: entry submit progress + receipt time on the user turn.
 *
 * Mirrors `tests/ui/entry-flow-browser.mjs` (section A): serves the real built UI
 * through Playwright request interception against a synthetic origin
 * (`index.html` + a scripted explicit-brain runtime API). No listening socket is
 * used, so it runs wherever a headless Chromium can launch.
 *
 * Scope: the two entry gaps fixed by task-17.
 *   1. In-flight: hold the 201 receipt, assert the status banner shows the live
 *      progress block (spinner animating with `progress-spin`, real phase copy).
 *      Release: assert the block is gone once the run settles.
 *   2. Card: the work-card user turn `.iwc-time` shows the real receipt time,
 *      never 「时间未提供」; the decision turn still falls back to 「时间未提供」,
 *      so the explicit-missing path stays correct.
 *
 * A run is held by a scripted gate so the transient state is observable:
 * `receive` for the in-flight banner, `interpret` for the receipt-projected card.
 *
 * The confirmed-task landing navigation is deliberately NOT scripted: `entry.js`
 * resolves it through `/api/dashboard?scope=system`, which this proof returns 404
 * for so the page stays on the entry index and the card stays observable. Landing
 * and its navigation are covered by `tests/ui/entry-flow-browser.mjs`.
 *
 * Requires `pnpm build:app` (serves `dist/app/ui`). Optional env:
 *   T22C_PLAYWRIGHT   playwright module path
 *   T22C_BROWSER_ARGS chromium launch args
 *   T22C_UI_ROOT      built UI root (default: dist/app/ui)
 *   T22C_EVIDENCE     artifact directory
 */

import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.T22C_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.T22C_EVIDENCE?.trim()
  ? resolve(process.env.T22C_EVIDENCE)
  : resolve(tmpdir(), `entry-submit-progress-${Date.now()}`);
await mkdir(evidenceRoot, { recursive: true });

const playwrightModule = await import(
  process.env.T22C_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;
const browserArgs = (process.env.T22C_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const proofOrigin = 'http://humanagent.entry-submit-progress.test';
const OCCURRED_AT = '2026-10-27T07:28:58.639Z';
const PHASE_COPY = '正在整理并提交任务…';

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

// ---------------------------------------------------------------------------
// Scripted explicit-brain runtime API (owned in-process; never the shared 10086)
// ---------------------------------------------------------------------------

const scripted = {
  interactions: new Map(),
  interactionSeq: 0,
  taskSeq: 0,
  tasks: [],
  receiveCount: 0,
  confirmationCount: 0,
};
// The receive gate holds the 201 receipt so the in-flight banner is observable.
let receiveGate = null;
// The interpret gate holds the brain interpretation so the receipt-projected
// user turn stays visible long enough to assert.
let interpretGate = null;

function setGate(kind) {
  let release;
  const promise = new Promise((settle) => { release = settle; });
  if (kind === 'receive') receiveGate = { promise, release };
  else interpretGate = { promise, release };
}

function releaseGate(kind) {
  const gate = kind === 'receive' ? receiveGate : interpretGate;
  if (kind === 'receive') receiveGate = null;
  else interpretGate = null;
  gate?.release();
}

function snapshotFor(interaction) {
  return {
    interactionId: interaction.id,
    state: interaction.state,
    sourceRef: 'ui:entry',
    rawInput: interaction.rawInput,
    owner: 'explicit-intake',
    nextAction: interaction.state === 'confirmed' ? 'read-result' : 'confirm-or-revise',
    // The real server persists occurredAt on the interaction at receive time and
    // `inspect` returns it, so the snapshot must carry it.
    occurredAt: interaction.occurredAt,
    ...(interaction.draft ? { draft: interaction.draft } : {}),
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
    scripted.interactions.set(id, { id, rawInput: String(body?.rawInput ?? ''), state: 'received', draft: null, occurredAt: OCCURRED_AT });
    if (receiveGate) await receiveGate.promise;
    // The real server's 201 body is exactly this receipt, nothing else.
    return { status: 201, body: { interactionId: id, occurredAt: OCCURRED_AT } };
  }
  const interactionMatch = /^\/api\/explicit\/interactions\/([^/]+)$/.exec(url.pathname);
  if (interactionMatch && method === 'GET') {
    const interaction = scripted.interactions.get(decodeURIComponent(interactionMatch[1]));
    if (!interaction) return { status: 404, body: { error: { code: 'interaction.not-found' } } };
    return { status: 200, body: snapshotFor(interaction) };
  }
  const interpretMatch = /^\/api\/explicit\/interactions\/([^/]+)\/interpret$/.exec(url.pathname);
  if (interpretMatch && method === 'POST') {
    if (interpretGate) await interpretGate.promise;
    const interaction = scripted.interactions.get(decodeURIComponent(interpretMatch[1]));
    interaction.state = 'awaiting-confirmation';
    interaction.draft = {
      draftId: `draft-${interaction.id}`,
      inputRevision: 1,
      normalizedInput: `${interaction.rawInput}（规范化）`,
      proposal: `提交后执行：${interaction.rawInput}`,
      knownFacts: ['用户提供了一条业务输入', '显式大脑已完成整理'],
    };
    return { status: 200, body: snapshotFor(interaction) };
  }
  const confirmationMatch = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(url.pathname);
  if (confirmationMatch && method === 'POST') {
    scripted.confirmationCount += 1;
    const interaction = scripted.interactions.get(decodeURIComponent(confirmationMatch[1]));
    interaction.state = 'confirmed';
    scripted.taskSeq += 1;
    const taskId = `ui-task-${scripted.taskSeq}`;
    const requirement = {
      requirementId: `requirement:${interaction.draft.draftId}:1`,
      draftId: interaction.draft.draftId,
      inputRevision: interaction.draft.inputRevision,
    };
    scripted.tasks = [{
      taskId: { scope: 'task', value: taskId },
      title: interaction.draft.normalizedInput,
      currentState: '排队中',
      stateLabel: '排队中',
      state: 'waiting',
      nextStep: '等待执行',
      updatedAt: new Date().toISOString(),
      identitySource: { ...requirement },
    }];
    return { status: 200, body: { requirement: { status: 'submitted', ...requirement } } };
  }
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return {
      status: 200,
      body: { draft: [], waiting: scripted.tasks, running: [], completed: [], stopped: [], failed: [] },
    };
  }
  // The SSE step stream is not needed for these two gaps; an empty stream keeps
  // the page quiet instead of a 404 reconnect loop.
  if (/\/events$/.test(url.pathname)) {
    return { status: 200, body: '', sse: true };
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
      let body;
      try { body = request.postData() ? JSON.parse(request.postData()) : undefined; } catch { body = undefined; }
      const result = await handleScriptedApi(url, request.method(), body);
      await route.fulfill({
        status: result.status,
        contentType: result.sse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
        body: result.sse ? '' : JSON.stringify(result.body),
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

const liveBlockState = () => {
  const block = document.querySelector('.status-banner .progress.progress--live');
  if (!block) return { hasBlock: false, phase: null, animation: null, spinnerOpacity: null, visible: false };
  const phase = block.querySelector('.progress-phase');
  const spinner = block.querySelector('.progress-spinner');
  return {
    hasBlock: true,
    phase: phase ? phase.textContent : null,
    animation: spinner ? getComputedStyle(spinner).animationName : null,
    spinnerOpacity: spinner ? getComputedStyle(spinner).opacity : null,
    visible: block.getClientRects().length > 0,
  };
};

const readTurns = () => {
  const host = document.querySelector('[data-interaction-work-card-host][data-entry="entry"]');
  if (!host) return [];
  return [...host.querySelectorAll('.iwc-conversation-turn')].map((turn) => ({
    kind: turn.querySelector('.iwc-kind-chip')?.textContent ?? null,
    time: turn.querySelector('.iwc-time')?.textContent ?? null,
    text: (turn.querySelector('.iwc-turn-body')?.textContent ?? '').slice(0, 60),
  }));
};

async function runInFlightBanner(page, pageErrors, expectedTime) {
  void expectedTime;
  await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entry-form textarea[name="rawInput"]', { timeout: 10_000 });
  await page.fill('#entry-form textarea[name="rawInput"]', '读取 README');
  const receiveBefore = scripted.receiveCount;
  setGate('receive');
  await page.click('#entry-form button[type="submit"]');

  await page.waitForSelector('.status-banner .progress.progress--live', { timeout: 15_000 });
  const inflight = await page.evaluate(liveBlockState);
  observe('in-flight live block', inflight);
  record('in-flight live progress block renders', inflight.hasBlock === true, inflight.hasBlock);
  record('in-flight phase shows the submit copy', inflight.phase === PHASE_COPY, inflight.phase);
  record('in-flight spinner animates with progress-spin', inflight.animation === 'progress-spin', inflight.animation);
  record('in-flight progress block is laid out and visible', inflight.visible === true, inflight.visible);
  record('in-flight spinner is fully opaque', inflight.spinnerOpacity === '1', inflight.spinnerOpacity);
  record('in-flight submit issues exactly one receive', scripted.receiveCount - receiveBefore === 1, scripted.receiveCount - receiveBefore);
  await page.screenshot({ path: join(evidenceRoot, 'inflight-live-progress.png') });

  releaseGate('receive');
  await page.waitForFunction(
    () => !document.querySelector('.status-banner .progress.progress--live'),
    undefined,
    { timeout: 25_000 },
  );
  const settled = await page.evaluate(liveBlockState);
  observe('post-settle live block', settled);
  record('progress block is removed after settle', settled.hasBlock === false, settled.hasBlock);
  record('entry page produced no runtime errors', pageErrors.length === 0, pageErrors);
}

async function runUserTurnTime(page, pageErrors, expectedTime) {
  await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entry-form textarea[name="rawInput"]', { timeout: 10_000 });
  await page.fill('#entry-form textarea[name="rawInput"]', '读取 README');
  setGate('interpret');
  await page.click('#entry-form button[type="submit"]');

  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-interaction-work-card-host][data-entry="entry"]');
      return host ? host.querySelectorAll('.iwc-time').length >= 1 : false;
    },
    undefined,
    { timeout: 25_000 },
  );
  const receiptTurns = await page.evaluate(readTurns);
  observe('receipt-projected turns', receiptTurns);
  const userTurn = receiptTurns.find((turn) => turn.kind === '用户') ?? receiptTurns[0];
  record('user turn renders the real receipt time', userTurn?.time === expectedTime, { actual: userTurn?.time, expected: expectedTime });
  record('user turn never falls back to 时间未提供', userTurn?.time !== '时间未提供', userTurn?.time);
  await page.screenshot({ path: join(evidenceRoot, 'user-turn-time.png') });

  releaseGate('interpret');
  await page.waitForFunction(
    () => {
      const tone = document.querySelector('.status-banner')?.dataset?.tone;
      return tone === 'danger' || tone === 'success';
    },
    undefined,
    { timeout: 25_000 },
  );
  const settledTurns = await page.evaluate(readTurns);
  observe('settled turns', settledTurns);
  const decisionTurn = settledTurns.find((turn) => turn.kind === '决策');
  record('decision turn keeps the explicit-missing fallback', decisionTurn?.time === '时间未提供', decisionTurn?.time);
  record('card page produced no runtime errors', pageErrors.length === 0, pageErrors);
}

async function main() {
  const { formatTime } = await import(new URL(`file://${join(repoRoot, 'docs/ui/runtime-api.js')}`).href);
  const expectedTime = formatTime(OCCURRED_AT);
  observe('expected rendered receipt time', expectedTime);

  const runs = [
    { name: 'run 1 (in-flight banner)', body: runInFlightBanner },
    { name: 'run 2 (user-turn time)', body: runUserTurnTime },
  ];
  for (const run of runs) {
    await withScriptedPage(async (page, pageErrors) => {
      try {
        await run.body(page, pageErrors, expectedTime);
      } catch (error) {
        record(`${run.name} completed`, false, error.message);
      }
    });
  }

  const passed = checks.filter((check) => check.pass).length;
  console.log(`# entry-submit-progress browser proof: ${passed}/${checks.length} checks passed`);
  console.log(`# evidence dir: ${evidenceRoot}`);
  for (const check of checks) {
    console.log(`#   ${check.pass ? 'ok' : 'not ok'} - ${check.name}${check.detail === null ? '' : ` :: ${JSON.stringify(check.detail)}`}`);
  }
  for (const item of observations) {
    console.log(`#   obs - ${item.name}: ${JSON.stringify(item.value)}`);
  }
  console.log(`1..${checks.length}`);
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
