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
 *        - one submit authorizes the task and lands directly on observation;
 *        - the second confirmation panel and `#entry-confirm-button` are gone;
 *        - the clarification loop survives;
 *        - a failed submit keeps the input and shows a readable error;
 *        - a rapid double click still creates exactly one task.
 *
 *   B. Real RCC proof. An isolated `serve --mode rcc` process (never the shared
 *      10086 instance) drives the served entry page against the live RCC
 *      endpoint on 127.0.0.1:4444 and records:
 *        - a real once execution reaching observation with a provider tool trace;
 *        - a scheduled plan persisted as a real subscription;
 *        - a recurring plan persisted with real time/zone/period parameters.
 *
 * Set `T22C_EVIDENCE` to the execution-owned evidence root. Optional:
 *   T22C_UI_ROOT            override the built UI root (red-base reproduction)
 *   T22C_RCC_MODEL          default goaichat.glm-5.3
 *   T22C_RCC_BASE_URL       default http://127.0.0.1:4444
 *   T22C_SKIP_RCC=1         run only section A
 */

import { createServer } from 'node:http';
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
// Section A: scripted runtime API + static UI server
// ---------------------------------------------------------------------------

const scripted = {
  interactions: new Map(),
  tasks: [],
  interactionSeq: 0,
  taskSeq: 0,
  confirmFails: false,
  confirmationCount: 0,
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
    if (/CLARIFY/.test(interaction.rawInput) && !interaction.answered) {
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
    const interaction = scripted.interactions.get(decodeURIComponent(clarificationMatch[1]));
    interaction.answered = true;
    interaction.state = 'matching';
    interaction.clarifications = [{ question: '请补充验收范围。', answer: String(body?.answer ?? '') }];
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
    scripted.tasks.push({
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
  if (url.pathname === '/api/tasks' && method === 'GET') {
    return { status: 200, body: { draft: [], waiting: [...scripted.tasks], running: [], completed: [], stopped: [], failed: [] } };
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
        response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength });
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

async function readEditableValues(page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll('input, textarea')];
    return {
      values: controls.map((control) => control.value),
      hasNormalizedInputControl: controls.some((control) => control.name === 'normalizedInput'),
    };
  });
}

async function sectionA(browser, base, artifactDir) {
  const runs = [
    { label: 'desktop', viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' },
    { label: 'mobile', viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' },
    { label: 'reduced-motion', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' },
  ];

  // Defect A: the brain feedback is read-only and never lands in an editable control.
  {
    const context = await browser.newContext({ viewport: runs[0].viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/interaction.html`, { waitUntil: 'domcontentloaded' });
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
    await context.close();
  }

  // Defect B: one submit authorizes the task and lands on observation.
  for (const run of runs) {
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#entry-form textarea[name="rawInput"]');
    const confirmButtonCount = await page.locator('#entry-confirm-button').count();
    record(`${run.label} no second confirmation button exists`, confirmButtonCount === 0, confirmButtonCount);
    await page.fill('#entry-form textarea[name="rawInput"]', '读取 README 并汇报');
    await page.click('#entry-form button[type="submit"]');
    await page.waitForURL(/observation\.html\?task=/, { timeout: 20_000 });
    const taskId = new URL(page.url()).searchParams.get('task');
    await page.waitForSelector('.flow-node[data-node-id="pipeline.execute"]', { timeout: 10_000 });
    const pipelineChip = (await page.textContent('.flow-node[data-node-id="pipeline.execute"] .state-chip'))?.trim();
    const nodeCount = await page.locator('.flow-node').count();
    record(`${run.label} one submit lands directly on the task observation`, Boolean(taskId), page.url());
    record(`${run.label} observation renders real pipeline nodes`, nodeCount > 0 && pipelineChip === '已完成', { nodeCount, pipelineChip });
    record(`${run.label} entry page has no page errors`, pageErrors.length === 0, pageErrors);
    await page.screenshot({ path: join(artifactDir, `defect-b-observation-${run.label}.png`) });
    await context.close();
  }

  // Clarification loop survives.
  {
    const context = await browser.newContext({ viewport: runs[0].viewport });
    const page = await context.newPage();
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#entry-form textarea[name="rawInput"]', 'CLARIFY 处理这份需求');
    await page.click('#entry-form button[type="submit"]');
    await page.waitForSelector('#entry-draft input[name="answer"]', { timeout: 10_000 });
    const question = (await page.textContent('#entry-draft')) ?? '';
    await page.fill('#entry-draft input[name="answer"]', '验收范围就是 README 的前 10 行');
    await page.click('#entry-draft button[type="submit"]');
    await page.waitForURL(/observation\.html\?task=/, { timeout: 20_000 });
    record('clarification question is rendered before authorization', question.includes('请补充验收范围'), question.slice(0, 200));
    record('clarification answer continues the same submission', /observation\.html\?task=/.test(page.url()), page.url());
    await context.close();
  }

  // Failure keeps the input and shows a readable, original error.
  {
    scripted.confirmFails = true;
    const context = await browser.newContext({ viewport: runs[0].viewport });
    const page = await context.newPage();
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#entry-form textarea[name="rawInput"]', '这条提交会被运行时拒绝');
    await page.click('#entry-form button[type="submit"]');
    await page.waitForSelector('#entry-error:not([hidden])', { timeout: 10_000 });
    const errorText = (await page.textContent('#entry-error')) ?? '';
    const textareaValue = await page.inputValue('#entry-form textarea[name="rawInput"]');
    const draftText = (await page.textContent('#entry-draft')) ?? '';
    record('failed submit keeps the user input', textareaValue === '这条提交会被运行时拒绝', textareaValue);
    record('failed submit shows a readable error with the original message', errorText.includes('final submit rejected by the scripted runtime'), errorText.slice(0, 300));
    record('failed submit keeps the last readable draft', draftText.includes('规范化输入'), draftText.slice(0, 200));
    await page.screenshot({ path: join(artifactDir, 'failure-retains-input.png') });
    scripted.confirmFails = false;
    await context.close();
  }

  // A rapid double click still produces exactly one task.
  {
    const receiveBefore = scripted.receiveCount;
    const confirmBefore = scripted.confirmationCount;
    const tasksBefore = scripted.tasks.length;
    const context = await browser.newContext({ viewport: runs[0].viewport });
    const page = await context.newPage();
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#entry-form textarea[name="rawInput"]', '只允许创建一次的任务');
    await page.evaluate(() => {
      const button = document.querySelector('#entry-form button[type="submit"]');
      button.click();
      button.click();
    });
    await page.waitForURL(/observation\.html\?task=/, { timeout: 20_000 });
    await sleep(1500);
    const receiveDelta = scripted.receiveCount - receiveBefore;
    const confirmDelta = scripted.confirmationCount - confirmBefore;
    const taskDelta = scripted.tasks.length - tasksBefore;
    record('rapid double click issues exactly one explicit input', receiveDelta === 1, receiveDelta);
    record('rapid double click issues exactly one confirmation', confirmDelta === 1, confirmDelta);
    record('rapid double click creates exactly one task', taskDelta === 1, taskDelta);
    await context.close();
  }
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

async function submitThroughEntry(page, { rawInput, mode, startAt }) {
  await page.goto(`${page.__base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entry-form textarea[name="rawInput"]');
  await page.fill('#entry-form textarea[name="rawInput"]', rawInput);
  await page.selectOption('#entry-form select[name="executionMode"]', mode);
  if (startAt) await page.fill('#entry-form input[name="scheduledStartAt"]', startAt);
  await page.click('#entry-form button[type="submit"]');
}

async function waitForPlanReceipt(page, mode) {
  await page.waitForSelector('#entry-draft', { timeout: 20_000 });
  await page.waitForFunction((expectedMode) => {
    const panel = document.querySelector('#entry-error');
    if (panel && !panel.hidden && (panel.textContent || '').trim()) return false;
    const status = document.querySelector('[role="status"]');
    const text = status?.textContent || '';
    return text.includes(expectedMode === 'once' ? '正在打开执行观测' : '执行计划已保存');
  }, mode, { timeout: 90_000 });
}

/**
 * Wait until the entry submission lands on the observation surface, or fail
 * fast with the error the page actually shows. A blind navigation wait turns
 * every upstream failure into an opaque timeout.
 */
async function waitForObservationNavigation(page, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/observation\.html\?task=/.test(page.url())) return;
    const failure = await page.evaluate(() => {
      const panel = document.querySelector('#entry-error');
      const panelText = panel && !panel.hidden ? (panel.textContent || '').trim() : '';
      const statusText = (document.querySelector('[role="status"]')?.textContent || '').trim();
      return panelText || (/owner=|next=/.test(statusText) ? statusText : '');
    }).catch(() => '');
    if (failure) throw new Error(`entry submission did not reach the observation surface: ${failure}`);
    await page.waitForTimeout(500);
  }
  throw new Error(`entry submission never reached the observation surface (url=${page.url()})`);
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
      if (node && ['succeeded', 'failed', 'stopped'].includes(node.state) && toolSteps.length > 0) {
        return timeline.join(' ');
      }
    } else {
      last = `observation http ${response.status()}`;
      timeline.push(last);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`real observation never projected a terminal tool trace: ${timeline.join(' ')}`);
}

async function sectionB(browser, artifactDir, root) {
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

    // Once: full submit -> real observation with a provider tool trace.
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await pairContext(context, base, workspace, controlRoot);
      const page = await context.newPage();
      page.__base = base;
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
      await waitForObservationNavigation(page);
      const taskId = new URL(page.url()).searchParams.get('task');
      const timeline = await waitForObservationTrace(context, base, taskId);
      observe('once observation settlement timeline', timeline);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.flow-node[data-node-id="pipeline.execute"]', { timeout: 20_000 });
      const nodeCount = await page.locator('.flow-node').count();
      const pipelineChip = (await page.textContent('.flow-node[data-node-id="pipeline.execute"] .state-chip'))?.trim();
      observe('once observation url', page.url());
      observe('once pipeline chip', pipelineChip);
      await page.locator('.flow-node[data-node-id="pipeline.execute"]').click();
      await page.waitForSelector('.node-drawer[open] .iwc-card', { timeout: 20_000 });
      await page.click('#iwc-tab-trace');
      await page.waitForTimeout(250);
      const traceText = await page.evaluate(() => {
        const trace = document.querySelector('.iwc-panel--trace');
        return trace?.innerText ?? document.querySelector('.node-drawer')?.innerText ?? '';
      });
      observe('once task id', taskId);
      observe('once trace text', traceText);
      record('once submit lands on the real observation page', Boolean(taskId), page.url());
      record('once observation renders the real pipeline', nodeCount >= 8, nodeCount);
      record('once observation drawer shows the real tool trace', /file\.read|create_goal|update_goal/.test(traceText), traceText.slice(0, 400));
      record('once submit sends a once execution policy', confirmationBody?.executionPolicy?.executionMode === 'once' && Boolean(confirmationBody?.executionPolicy?.dueAt), confirmationBody);
      record('once observation has no page errors', pageErrors.length === 0, pageErrors);
      await page.screenshot({ path: join(artifactDir, 'rcc-once-observation.png') });
      await context.close();
      run.ok = true;
    }

    // Scheduled and recurring: real plans persisted as subscriptions.
    const subscriptionsPath = join(launched.checkpointRoot, 'rcc', 'subscriptions.jsonl');
    for (const plan of [
      { mode: 'scheduled', label: 'scheduled', rawInput: 'Do not ask questions. Create exactly one task: report the current date.' },
      { mode: 'recurring', label: 'recurring', rawInput: 'Do not ask questions. Create exactly one task: report the current date.' },
    ]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await pairContext(context, base, workspace, controlRoot);
      const page = await context.newPage();
      page.__base = base;
      let confirmationBody;
      page.on('request', (request) => {
        if (request.url().endsWith('/confirmation') && request.method() === 'POST') confirmationBody = request.postDataJSON();
      });
      await submitThroughEntry(page, { rawInput: plan.rawInput, mode: plan.mode });
      await waitForPlanReceipt(page, plan.mode);
      record(`${plan.label} submit sends its execution policy`, confirmationBody?.executionPolicy?.executionMode === plan.mode && Boolean(confirmationBody?.executionPolicy?.timezone) && Boolean(confirmationBody?.executionPolicy?.startAt), confirmationBody);
      await context.close();
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
const browser = await playwright.chromium.launch({ headless: true });
let scriptedServer;
try {
  scriptedServer = await startScriptedServer();
  await sectionA(browser, scriptedServer.url, artifactDir);
} finally {
  await closeServer(scriptedServer);
  if (skipRcc) {
    observe('rcc', 'skipped via T22C_SKIP_RCC=1');
  } else {
    const root = await mkdtemp(join(tmpdir(), 't22c-entry-flow-'));
    await mkdir(join(root, 'workspace'), { recursive: true });
    await writeFile(join(root, 'workspace', 'marker.txt'), 'T22C_MARKER\n', 'utf8');
    try {
      await sectionB(browser, artifactDir, root);
    } catch (error) {
      record('real RCC section completed', false, error instanceof Error ? error.message : String(error));
    }
  }
  await browser.close();
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
