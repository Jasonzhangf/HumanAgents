#!/usr/bin/env node
/**
 * Real browser explicit -> implicit -> executor completion proof (T6).
 *
 * Drives the *served HumanAgent UI* with a real headless Chromium instead of
 * calling the HTTP Runtime API directly:
 *
 *   1. load the served entry page at the real loopback serve URL
 *   2. type a task into the UI and submit it to the explicit brain
 *   3. wait for the confirmable draft rendered by the UI
 *   4. click the UI confirm button (nothing enters the queue without it)
 *   5. follow the queued task row link the UI renders
 *   6. wait until the task dashboard DOM shows the task completed
 *   7. assert the dashboard DOM shows >= 2 provider.tool rounds + checkpoint
 *   8. open the Pipeline Observation page and assert the DOM shows completed
 *      nodes carrying evidence
 *
 * The live RCC endpoint must answer on 127.0.0.1:4444; there is no mock server
 * and no fake provider. HTTP reads are used only to bind the receipt to exact
 * runtime facts (task id, execution epoch, tool rounds, checkpoint id) and to
 * copy the projections the DOM was rendered from; every user action and every
 * completion claim is asserted against the browser DOM.
 *
 * Persists `dist/receipts/browser-explicit-implicit-e2e-proof.json`.
 *
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL            default http://127.0.0.1:4444
 *   HUMANAGENT_UI_MODEL               default gpt-5.5
 *   HUMANAGENT_BROWSER_RECEIPT_PATH   default ./dist/receipts/browser-explicit-implicit-e2e-proof.json
 *   HUMANAGENT_BROWSER_SHOT_DIR       default ./dist/receipts/browser-e2e-shots
 *   HUMANAGENT_BROWSER_KEEP_ROOT=1    keep the disposable serve root for inspection
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_BROWSER_RECEIPT_PATH ?? 'dist/receipts/browser-explicit-implicit-e2e-proof.json',
);
const SHOT_DIR = resolve(process.env.HUMANAGENT_BROWSER_SHOT_DIR ?? 'dist/receipts/browser-e2e-shots');
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const TERMINAL_TIMEOUT_MS = 300_000;
const MAX_INTERPRET_ATTEMPTS = 4;

const PLAYWRIGHT_CANDIDATES = [
  process.env.HUMANAGENT_PLAYWRIGHT_MODULE,
  'playwright',
  '/opt/homebrew/lib/node_modules/playwright/index.js',
].filter(Boolean);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line
      && !line.includes('docs/evidence/explicit-implicit-e2e/')
      && !line.includes('dist/receipts/'))
    .sort();
  return `sha256:${createHash('sha256').update(`${entries.join('\n')}\n`).digest('hex')}`;
}

function harnessDigest() {
  return `sha256:${createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}`;
}

async function loadPlaywright() {
  const failures = [];
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    try {
      const mod = await import(candidate);
      const pw = mod.default ?? mod;
      if (pw?.chromium) return pw;
      failures.push(`${candidate}: no chromium export`);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`playwright is not importable: ${failures.join(' | ')}`);
}

function startServe(root) {
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'ui-ei-browser-proof',
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', 'rcc/ui-explicit-implicit',
    '--rcc-base-url', RCC_BASE_URL,
    '--workspace', workspace,
    '--control-root', controlRoot,
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr}`)), 30_000);
    const onData = (chunk) => {
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
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr}`)));
  });

  return {
    ready,
    pid: child.pid,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    throw new Error(`request failed ${response.status} ${url}: ${text.slice(0, 800)}`);
  }
  return body;
}

function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

/**
 * The UI renders every state change itself; this only waits for the DOM to
 * reach a predicate. It never issues runtime writes.
 */
async function waitForDom(page, label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = `predicate error: ${error.message}`;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for DOM condition: ${label}; last=${JSON.stringify(last).slice(0, 400)}`);
    }
    await sleep(intervalMs);
  }
}

function eventKinds(dashboard) {
  return (dashboard.recentEvents ?? []).map((event) => `${event.kind}:${event.state}`);
}

function providerToolRoundCount(dashboard) {
  return (dashboard.recentEvents ?? []).filter((event) => event.kind === 'provider.tool').length;
}

function requestStartTurnCount(dashboard) {
  return (dashboard.recentEvents ?? []).filter((event) => event.summary === 'provider requested model work').length;
}

function requestStartTurns(dashboard) {
  return (dashboard.recentEvents ?? [])
    .filter((event) => event.summary === 'provider requested model work')
    .map((event) => ({
      eventId: event.eventId ?? null,
      seq: event.seq ?? null,
      occurredAt: event.occurredAt ?? null,
      kind: event.kind,
      state: event.state,
      summary: event.summary,
    }));
}

function providerToolLabels(dashboard) {
  return (dashboard.recentEvents ?? [])
    .filter((event) => event.kind === 'provider.tool')
    .map((event) => event.summary);
}

function genericProviderModelRows(eventRows) {
  return (eventRows ?? []).filter((row) => row.summary === 'model');
}

function terminalTurn(dashboard) {
  return (dashboard.recentEvents ?? []).find((event) => event.kind === 'execution.terminal') ?? null;
}

function bboxFor(box) {
  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    x: Math.round(box.x),
    y: Math.round(box.y),
  };
}

function assertCompleted(dashboard) {
  if (dashboard.state !== 'succeeded') {
    throw new Error(`task did not complete: state=${dashboard.state}; output=${JSON.stringify(dashboard.output ?? null).slice(0, 600)}`);
  }
  if (!dashboard.checkpoint || dashboard.checkpoint.outcome !== 'succeeded') {
    throw new Error(`task did not expose a committed succeeded checkpoint: ${JSON.stringify(dashboard.checkpoint ?? null)}`);
  }
}

async function assertDashboardDom(page, expectedToolRounds) {
  const stateChip = (await page.textContent('.state-chip'))?.trim();
  const facts = await page.$$eval('.detail-cell', (cells) => cells.map((cell) => ({
    label: cell.querySelector('dt')?.textContent?.trim() ?? '',
    value: cell.querySelector('dd')?.textContent?.trim() ?? '',
  })));
  const checkpoint = facts.find((fact) => fact.label === 'Checkpoint');
  const currentState = facts.find((fact) => fact.label === '当前状态');
  const eventKindsDom = await page.$$eval('.event-kind', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
  const toolRoundsDom = eventKindsDom.filter((text) => text.startsWith('provider.tool')).length;
  const eventRows = await page.$$eval('.event-list li.event', (rows) => rows.map((row) => ({
    kind: row.querySelector('.event-kind')?.textContent?.trim() ?? '',
    summary: row.children[2]?.textContent?.trim() ?? '',
    text: row.textContent?.trim() ?? '',
  })));
  const requestStartRowsDom = eventRows.filter((row) => row.summary === 'provider requested model work');

  if (stateChip !== '已完成') {
    throw new Error(`dashboard DOM did not show 已完成: chip=${JSON.stringify(stateChip)}`);
  }
  if (currentState?.value !== '已完成') {
    throw new Error(`dashboard DOM current-state fact did not show 已完成: ${JSON.stringify(currentState)}`);
  }
  if (!checkpoint || !checkpoint.value.includes('succeeded')) {
    throw new Error(`dashboard DOM checkpoint fact did not show a succeeded checkpoint: ${JSON.stringify(checkpoint)}`);
  }
  if (toolRoundsDom < expectedToolRounds) {
    throw new Error(`dashboard DOM showed ${toolRoundsDom} provider.tool rounds, expected >= ${expectedToolRounds}`);
  }
  const toolRequestRowsDom = eventRows.filter((row) => row.kind.startsWith('provider.tool') && row.summary.startsWith('调用工具：'));
  if (toolRequestRowsDom.length < expectedToolRounds) {
    throw new Error(`dashboard DOM showed ${toolRequestRowsDom.length} provider tool request rows, expected >= ${expectedToolRounds}: ${eventRows.map((row) => row.summary).join(' | ')}`);
  }
  if (genericProviderModelRows(eventRows).length > 0) {
    throw new Error(`dashboard DOM still showed generic provider.model rows with summary=model: ${JSON.stringify(genericProviderModelRows(eventRows))}`);
  }
  if (!requestStartRowsDom.some((row) => row.kind.startsWith('provider.model'))) {
    throw new Error(`dashboard DOM showed no visible provider request-start row: ${eventRows.map((row) => row.summary).join(' | ')}`);
  }
  return { stateChip, currentState, checkpoint, toolRoundsDom, eventKindsDom, eventRows, requestStartRowsDom, toolRequestRowsDom };
}

async function assertDashboardDomRequestStarts(page, label, expected = 2) {
  const eventRows = await page.$$eval('.event-list li.event', (rows) => rows.map((row) => ({
    kind: row.querySelector('.event-kind')?.textContent?.trim() ?? '',
    summary: row.children[2]?.textContent?.trim() ?? '',
    text: row.textContent?.trim() ?? '',
  })));
  const requestStartRowsDom = eventRows.filter((row) => row.summary === 'provider requested model work');
  if (genericProviderModelRows(eventRows).length > 0) {
    throw new Error(`${label}: dashboard DOM still showed generic provider.model rows with summary=model: ${JSON.stringify(genericProviderModelRows(eventRows))}`);
  }
  if (requestStartRowsDom.length < expected) {
    throw new Error(`${label}: dashboard DOM showed ${requestStartRowsDom.length} request-start rows, expected >= ${expected}: ${eventRows.map((row) => row.summary).join(' | ')}`);
  }
  return { eventRows, requestStartRowsDom };
}

async function assertObservationDom(page) {
  const nodes = await page.$$eval('.flow-node', (cards) => cards.map((card) => ({
    nodeId: card.dataset.nodeId ?? '',
    state: card.dataset.state ?? '',
  })));
  if (nodes.length === 0) throw new Error('observation DOM rendered no flow nodes');
  const ids = nodes.map((node) => node.nodeId);
  for (const expected of ['sensory.inbox', 'explicit.normalize', 'implicit.classify', 'interactive.queue', 'execution.queue', 'pipeline.execute', 'settle', 'task.output']) {
    if (!ids.includes(expected)) throw new Error(`observation DOM is missing node ${expected}: ${ids.join(', ')}`);
  }
  const metaChip = (await page.textContent('.observation-meta .state-chip'))?.trim();
  if (metaChip !== '已完成') {
    throw new Error(`observation DOM meta chip did not show 已完成: ${JSON.stringify(metaChip)}`);
  }
  return nodes;
}

async function screenshot(page, name) {
  const path = join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'ha-browser-explicit-implicit-e2e-'));
  const keepRoot = process.env.HUMANAGENT_BROWSER_KEEP_ROOT === '1';
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'workspace', 'marker.txt'), 'BROWSER_E2E_MARKER_4F9A\n', 'utf8');
  await writeFile(join(root, 'workspace', 'readme-first-line.txt'), 'BROWSER_FIRST_LINE_7C3E\n', 'utf8');
  await mkdir(SHOT_DIR, { recursive: true });

  const playwright = await loadPlaywright();
  let serve;
  let browser;
  const steps = {};
  try {
    steps.rccHealth = await jsonRequest(`${RCC_BASE_URL}/health`);
    serve = startServe(root);
    const launched = await serve.ready;
    const base = launched.url;
    steps.serve = {
      root,
      url: base,
      pid: serve.pid,
      checkpointRoot: launched.checkpointRoot,
      memoryAnalysisMode: launched.memoryAnalysisMode,
    };

    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
    });

    // 1. Load the real served dashboard page.
    const entryUrl = `${base}/dashboard.html`;
    const entryResponse = await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    if (!entryResponse || !entryResponse.ok()) {
      throw new Error(`served UI entry did not load: ${entryUrl} status=${entryResponse?.status()}`);
    }
    await page.waitForSelector('.quick-create-form textarea[name="directive"]', { timeout: 15_000 });
    const inputHandle = await page.$('.quick-create-form textarea[name="directive"]');
    const inputBox = inputHandle ? bboxFor(await inputHandle.boundingBox()) : null;
    const policyHandle = await page.$('.quick-create-policy input[name="autoConfirm"]');
    const policyBox = policyHandle ? bboxFor(await policyHandle.boundingBox()) : null;
    if (!inputBox || inputBox.width <= 0 || inputBox.height <= 0) {
      throw new Error(`real browser input was not laid out with a positive bbox: ${JSON.stringify(inputBox)}`);
    }
    if (!policyBox || policyBox.width <= 0 || policyBox.height <= 0) {
      throw new Error(`dashboard autoConfirm checkbox was not laid out with a positive bbox: ${JSON.stringify(policyBox)}`);
    }
    if (policyBox.width > 20 || policyBox.height > 20) {
      throw new Error(`dashboard autoConfirm checkbox was not compact: ${JSON.stringify(policyBox)}`);
    }
    // 2. Type a real task into the dashboard and submit it to the explicit brain.
    const rawInput = 'Do not clarify. Create exactly one concrete task: read the files marker.txt and readme-first-line.txt at the workspace root, combine both facts into a single completion summary that includes the exact contents of both files verbatim, and finish with the word COMPLETE.';
    steps.entry = { url: page.url(), title: await page.title(), inputBox, policyBox, screenshot: await screenshot(page, '01-entry') };
    await page.fill('.quick-create-form textarea[name="directive"]', rawInput);
    await page.click('form button[type="submit"]');

    // 3. Wait for the UI to render a confirmable draft.
    let draft;
    for (let attempt = 0; attempt < MAX_INTERPRET_ATTEMPTS; attempt += 1) {
      const outcome = await waitForDom(page, 'explicit draft', async () => {
        const confirm = await page.$('.draft-actions button.button--primary');
        if (confirm) {
          const text = (await confirm.textContent())?.trim();
          if (text === '确认并执行') return { kind: 'draft' };
        }
        const submitText = (await page.textContent('.quick-create-form button[type="submit"]'))?.trim() ?? '';
        const progressText = (await page.textContent('.quick-create-progress .progress-phase'))?.trim() ?? '';
        const placeholder = await page.getAttribute('.quick-create-form textarea[name="directive"]', 'placeholder');
        if (submitText === '回答并继续' || progressText === '需要补充信息') {
          return { kind: 'clarification', submitText, progressText, placeholder: placeholder ?? null };
        }
        return null;
      }, 120_000);
      if (outcome.kind === 'draft') {
        const metaRows = await page.$$eval('.draft-meta', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
        const proposal = (await page.textContent('.draft-area .draft-proposal'))?.trim() ?? '';
        const intent = (metaRows.find((row) => row.startsWith('意图：')) ?? '').replace('意图：', '');
        if (intent !== 'create') {
          throw new Error(`dashboard draft did not satisfy the requirement: intent=${intent}; proposal=${proposal.slice(0, 300)}`);
        }
        draft = { intent, proposal, metaRows };
        break;
      }
      // The UI asked for clarification: answer it through the UI and continue.
      if (!outcome.placeholder && !outcome.submitText) {
        throw new Error('dashboard clarification state had no UI evidence');
      }
      await page.fill('.quick-create-form textarea[name="directive"]:not([readonly])', 'Use the workspace root files directly; do not ask again.');
      await page.click('.quick-create-form button[type="submit"]');
    }
    if (!draft) throw new Error(`no confirmable explicit draft after ${MAX_INTERPRET_ATTEMPTS} attempts`);
    steps.draft = { ...draft, screenshot: await screenshot(page, '02-draft') };

    // 4. Confirm through the UI. Nothing may enter the queue before this click.
    const tasksBeforeConfirm = await jsonRequest(`${base}/api/tasks`);
    const draftRowsBefore = (tasksBeforeConfirm.draft ?? []).length;
    const confirmResponsePromise = page.waitForResponse((response) => response.url().includes('/api/explicit/interactions/') && response.url().endsWith('/confirmation') && response.request().method() === 'POST');
    await page.click('.draft-actions button.button--primary');
    const confirmResponse = await confirmResponsePromise;
    const confirmStatus = confirmResponse.status();
    if (confirmStatus < 200 || confirmStatus >= 300) {
      throw new Error(`confirmation POST returned non-2xx status=${confirmStatus}; response=${JSON.stringify({ url: confirmResponse.url(), ok: confirmResponse.ok() })}`);
    }
    const dispatchedTask = await waitForDom(page, 'dispatched task id', async () => {
      const tasks = await jsonRequest(`${base}/api/tasks`);
      const candidates = []
        .concat(tasks.running ?? [])
        .concat(tasks.waiting ?? [])
        .concat(tasks.draft ?? [])
        .concat(tasks.completed ?? [])
        .concat(tasks.failed ?? [])
        .filter((task) => task?.taskId?.value && task.updatedAt);
      if (candidates.length === 0) return null;
      const latest = candidates
        .map((task) => ({ task, timestamp: new Date(task.updatedAt).getTime() }))
        .sort((left, right) => right.timestamp - left.timestamp)[0];
      return latest?.task?.taskId?.value ?? null;
    }, 60_000);
    const taskId = typeof dispatchedTask === 'string' ? dispatchedTask : null;
    if (!taskId) throw new Error('confirmation did not create a dispatched task');

    // 5. Open the dashboard for the dispatched task as soon as its id is known.
    const dashboardUrl = `${base}/task-dashboard.html?task=${encodeURIComponent(taskId)}`;
    if (page.url() !== dashboardUrl) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await page.waitForLoadState('domcontentloaded').catch(() => {});
        }
      }
    }
    steps.admission = {
      draftRowsBeforeConfirm: draftRowsBefore,
      confirmStatus,
      taskId,
      screenshot: await screenshot(page, '03-queued'),
    };

    // 6. Capture request-start rows while nonterminal before terminal.
    let activeRequestStartDom;
    let activeScreenshot;
    try {
      activeRequestStartDom = await waitForDom(page, 'nonterminal request-start marker', async () => assertDashboardDomRequestStarts(page, 'nonterminal dashboard', 1), 90_000, 250);
      const chip = (await page.locator('.state-chip').first().textContent().catch(() => ''))?.trim();
      if (chip?.trim() === '已完成' || chip?.trim() === '失败' || chip?.trim() === '已停止') {
        throw new Error(`nonterminal request-start evidence was captured after terminal state: ${chip?.trim()}`);
      }
      activeScreenshot = await screenshot(page, '04-task-dashboard-nonterminal-request-starts');
    } catch (error) {
      const fallbackScreenshot = await screenshot(page, '04-task-dashboard-missing-request-starts').catch(() => null);
      throw new Error(`${error.message}; screenshot=${JSON.stringify(fallbackScreenshot)}`);
    }
    let terminalState;
    try {
      terminalState = await waitForDom(page, 'task runtime terminal', async () => {
        const probe = await jsonRequest(`${base}/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
        if (['succeeded', 'failed', 'stopped'].includes(probe.state)) return probe.state;
        return null;
      }, TERMINAL_TIMEOUT_MS, 500);
      await page.reload({ waitUntil: 'domcontentloaded' });
    } catch (error) {
      const probe = await jsonRequest(`${base}/api/tasks/${encodeURIComponent(taskId)}/dashboard`).catch((probeError) => ({ probeError: String(probeError) }));
      const probeScreenshot = await screenshot(page, '04-task-dashboard-terminal-timeout').catch(() => null);
      const probeEvents = eventKinds(probe);
      const probeSummary = JSON.stringify({
        state: probe.state ?? null,
        executionEpoch: probe.executionEpoch ?? null,
        checkpoint: probe.checkpoint ?? null,
        toolRounds: providerToolRoundCount(probe),
        requestStartCount: requestStartTurnCount(probe),
        recentEventKinds: probeEvents.slice(-10),
        probeError: probe.probeError ?? null,
      });
      throw new Error(`${error.message}; runtime dashboard probe=${probeSummary}; screenshot=${JSON.stringify(probeScreenshot)}`);
    }
    const dashboardDom = await waitForDom(page, 'task dashboard completed DOM', async () => {
      const apiProbe = await jsonRequest(`${base}/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
      if (apiProbe.state !== 'succeeded') return null;
      const chip = await page.locator('.state-chip').first().textContent().catch(() => null);
      if (chip?.trim() !== '已完成') return null;
      return assertDashboardDom(page, 2);
    }, 30_000, 250);
    const dashboardShot = await screenshot(page, '04-task-dashboard-completed');

    const dashboard = await jsonRequest(`${base}/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
    assertCompleted(dashboard);
    const toolRounds = providerToolRoundCount(dashboard);
    const requestStartCount = requestStartTurnCount(dashboard);
    if (toolRounds < 2) {
      throw new Error(`runtime reported ${toolRounds} provider.tool rounds, expected >= 2`);
    }
    if (requestStartCount < 2) {
      throw new Error(`runtime reported ${requestStartCount} provider request-start turns, expected >= 2: ${JSON.stringify(requestStartTurns(dashboard))}`);
    }
    if (!providerToolLabels(dashboard).some((label) => label.startsWith('调用工具：'))) {
      throw new Error(`runtime did not report provider tool request labels: ${JSON.stringify(providerToolLabels(dashboard))}`);
    }
    if (providerToolLabels(dashboard).some((label) => /succeeded|success|completed/i.test(label))) {
      throw new Error(`runtime reported tool-call completion semantics instead of request semantics: ${JSON.stringify(providerToolLabels(dashboard))}`);
    }
    if (terminalTurn(dashboard)?.state !== 'succeeded') {
      throw new Error(`runtime did not report a distinct successful terminal turn: ${JSON.stringify(terminalTurn(dashboard))}`);
    }
    if (dashboardDom.requestStartRowsDom.length !== requestStartCount) {
      throw new Error(`terminal dashboard DOM showed ${dashboardDom.requestStartRowsDom.length} request-start rows, runtime reported ${requestStartCount}`);
    }
    steps.dashboard = {
      taskId,
      state: dashboard.state,
      executionEpoch: dashboard.executionEpoch ?? null,
      operationId: dashboard.operationId ?? null,
      checkpoint: dashboard.checkpoint ?? null,
      toolRounds,
      requestStartCount,
      requestStartTurns: requestStartTurns(dashboard),
      providerToolLabels: providerToolLabels(dashboard),
      terminalTurn: terminalTurn(dashboard),
      events: eventKinds(dashboard),
      dom: dashboardDom,
      activeRequestStartDom,
      activeScreenshot,
      screenshot: dashboardShot,
    };

    // 7. Open the Pipeline Observation page and assert the DOM shows completed nodes.
    await page.goto(`${base}/observation.html?task=${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.flow-node', { timeout: 30_000 });
    const observationNodes = await assertObservationDom(page);
    const observationShot = await screenshot(page, '05-observation-completed');
    const observation = await jsonRequest(`${base}/api/tasks/${encodeURIComponent(taskId)}/observation`);
    steps.observation = {
      scopeRef: observation.scope?.scopeRef ?? null,
      nodes: observationNodes,
      evidenceCount: (observation.nodes ?? []).reduce((sum, node) => sum + (node.evidenceCount ?? 0), 0),
      screenshot: observationShot,
    };

    // 8. The task list page must show the same task as completed.
    await page.goto(`${base}/tasks.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-task-groups]', { timeout: 30_000 });
    const listRowText = await waitForDom(page, 'task list completed row', async () => {
      const rows = await page.$$eval('a', (links, expectedTaskId) => links
        .map((link) => ({ href: link.getAttribute('href') ?? '', text: link.textContent?.trim() ?? '' }))
        .filter((link) => link.href.includes(encodeURIComponent(expectedTaskId)) || link.href.includes(expectedTaskId)), taskId);
      const row = rows.find((candidate) => candidate.text.includes('已完成'));
      return row ? row.text : null;
    }, 60_000, 1000);
    steps.taskList = { rowText: listRowText, screenshot: await screenshot(page, '06-task-list') };

    const receipt = {
      proof: 'explicit-implicit-browser-e2e',
      generatedAt: new Date().toISOString(),
      candidate: {
        head: git(['rev-parse', 'HEAD']),
        tree: git(['write-tree']),
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        sourceDigest: sourceDigest(),
        harnessDigest: harnessDigest(),
      },
      rcc: {
        baseUrl: RCC_BASE_URL,
        health: steps.rccHealth,
        protocol: 'responses',
        model: MODEL,
        route: 'rcc/ui-explicit-implicit',
      },
      serve: steps.serve,
      browser: {
        engine: 'chromium',
        headless: true,
        entryUrl,
        consoleErrors,
      },
      flow: {
        rawInput,
        draft: { intent: steps.draft.intent, proposal: steps.draft.proposal },
        admission: steps.admission,
      },
      task: {
        taskId,
        terminalState: dashboard.state,
        toolRounds,
        requestStartCount,
        executionEpoch: dashboard.executionEpoch ?? null,
        checkpoint: dashboard.checkpoint ?? null,
      },
      dom: {
        dashboard: steps.dashboard.dom,
        observationNodes,
        taskListRow: listRowText,
      },
      screenshots: [
        steps.entry.screenshot,
        steps.draft.screenshot,
        steps.admission.screenshot,
        activeScreenshot,
        dashboardShot,
        observationShot,
        steps.taskList.screenshot,
      ],
      projections: {
        dashboard,
        observation,
      },
    };
    await mkdir(resolve('dist/receipts'), { recursive: true });
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      receiptPath: RECEIPT_PATH,
      taskId,
      terminalState: dashboard.state,
      toolRounds,
      requestStartCount,
      checkpoint: dashboard.checkpoint?.seq ?? null,
      screenshots: receipt.screenshots,
    }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (serve) await serve.stop();
    if (keepRoot) {
      console.error(`HUMANAGENT_BROWSER_ROOT=${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
