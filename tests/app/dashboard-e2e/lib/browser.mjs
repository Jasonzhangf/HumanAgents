/**
 * Real browser session and serve lifecycle — real implementation.
 *
 * Owns graph node: browser_session (in every per-command graph).
 *
 * Spawns this attempt's own `humanagent serve` on the isolated control root and
 * workspace, waits for the runtime to report ready, launches a real headless
 * Chromium against the served Dashboard, and exposes the page helpers the
 * scenarios use: type into the new-task form, wait for the visible draft,
 * confirm it, wait for the task to leave the queue and start executing, and
 * capture the human-observation screenshots.
 *
 * The attempt's serve PID and port are registered on the binding and are the
 * exact resources the cleanup closure stops and verifies. The page-driving
 * patterns mirror tests/app/real-browser-explicit-implicit-e2e.mjs, which is
 * the proven real-entry driver.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttemptAuth } from './auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = resolve(__dirname, '..', '..', '..', '..');

const PLAYWRIGHT_CANDIDATES = [
  process.env.HUMANAGENT_PLAYWRIGHT_MODULE,
  'playwright',
  '/opt/homebrew/lib/node_modules/playwright/index.js',
].filter(Boolean);

const TERMINAL_TIMEOUT_MS = Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 600_000);

function cliPath(repoPath = DEFAULT_REPO_PATH) {
  const candidate = join(repoPath, 'dist/app/app/src/cli.js');
  return existsSync(candidate) ? candidate : null;
}

export function loadPlaywright() {
  const failures = [];
  const attempts = PLAYWRIGHT_CANDIDATES.map(async (candidate) => {
    try {
      const mod = await import(candidate);
      const pw = mod.default ?? mod;
      if (pw?.chromium) return pw;
      failures.push(`${candidate}: no chromium export`);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  });
  return Promise.all(attempts).then((results) => {
    const found = results.find(Boolean);
    if (found) return found;
    throw new Error(`playwright is not importable: ${failures.join(' | ')}`);
  });
}

export async function jsonRequest(url, init, auth) {
  const requester = auth?.fetch ?? fetch;
  return requester(url, init).then(async (response) => {
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text.slice(0, 800) };
    }
    if (!response.ok) {
      throw new Error(`request failed ${response.status} ${url}: ${JSON.stringify(body).slice(0, 600)}`);
    }
    return body;
  });
}

async function requestJsonWithStatus(url, init, auth) {
  const requester = auth?.fetch ?? fetch;
  const response = await requester(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 800) };
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

export function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

/** Wait for a DOM predicate; the UI renders state itself, this only observes. */
export async function waitForDom(page, label, predicate, timeoutMs, intervalMs = 500) {
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

/**
 * Read the runtime's own draft-stage state so a timeout is diagnosable instead
 * of just "last=null". The Dashboard exposes interaction state through the
 * explicit-brain route; a stalled interpretation is a real deviation, so the
 * attempt records what the runtime actually reported.
 */
export async function describeDraftStage(binding) {
  if (!binding.serveBaseUrl) return null;
  const probe = async (path) => {
    try {
      const response = await (binding.auth?.fetch ?? fetch)(`${binding.serveBaseUrl}${path}`, { headers: { accept: 'application/json' } });
      const text = await response.text();
      return { status: response.status, body: text.slice(0, 2000) };
    } catch (error) {
      return { status: null, body: error instanceof Error ? error.message : String(error) };
    }
  };
  const [tasks, dashboard] = await Promise.all([
    probe('/api/tasks'),
    binding.taskId
      ? probe(`/api/tasks/${encodeURIComponent(binding.taskId)}/dashboard`)
      : Promise.resolve(null),
  ]);
  return {
    tasks,
    dashboard,
    serveStderrTail: typeof binding.serveStderrTailFinal === 'function' ? binding.serveStderrTailFinal() : null,
  };
}

export async function startServeForAttempt(binding, options = {}) {
  const repoPath = binding.repoPath ?? DEFAULT_REPO_PATH;
  const cli = cliPath(repoPath);
  if (!cli) {
    throw new Error(`built CLI is missing at ${join(repoPath, 'dist/app/app/src/cli.js')}; run \`pnpm build:app\` in the worktree first`);
  }
  const workspace = binding.workspace;
  const controlRoot = binding.controlRoot;
  await mkdir(workspace, { recursive: true });
  await mkdir(controlRoot, { recursive: true });

  const env = { ...process.env };
  const userHome = env.HOME;
  delete env.HOME; // do not let the control root resolve into the real user root
  env.HOME = binding.attemptRoot;
  // The isolated HOME must not hide external CLI credentials: the bound search
  // provider (`monid`) resolves its key through XDG_CONFIG_HOME, falling back to
  // `$HOME/.config`. Point XDG_CONFIG_HOME at the real user config so the child
  // sees the same credentials a normal `humanagent serve` would, while the
  // control root stays inside the attempt root.
  if ((env.XDG_CONFIG_HOME ?? '') === '' && userHome) {
    env.XDG_CONFIG_HOME = join(userHome, '.config');
  }
  const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
  const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';

  const child = spawn(process.execPath, [
    cli,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', `ui-dash-e2e-${binding.attemptId}`,
    '--provider', 'rcc',
    '--model', MODEL,
    '--rcc-base-url', RCC_BASE_URL,
    '--workspace', workspace,
    '--control-root', controlRoot,
    '--port', '0',
  ], { cwd: repoPath, env, stdio: ['ignore', 'pipe', 'pipe'] });
  binding.servePid = child.pid;
  binding.serveChild = child;

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr.slice(-1200)}`)), Number(options.readyTimeoutMs ?? 90_000));
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
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr.slice(-1200)}`)));
  });

  try {
    const launched = await ready;
    const base = launched.url ?? launched.baseUrl ?? null;
    if (!base) throw new Error(`serve banner did not include a url: ${JSON.stringify(launched).slice(0, 600)}`);
    const port = Number(new URL(base).port ?? 0) || null;
    binding.servePort = port;
    binding.serveBaseUrl = base;
    binding.serveControlRoot = launched.controlRoot ?? null;
    binding.serveCheckpointRoot = launched.checkpointRoot ?? null;
    binding.serveStderr = '';
    Object.defineProperty(binding, 'serveStderrTail', {
      enumerable: false,
      configurable: true,
      get: () => stderr.slice(-4000),
    });
    binding.serveStderrTailFinal = () => stderr.slice(-4000);
    binding.serve = {
      pid: child.pid,
      port,
      baseUrl: base,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((done) => child.once('exit', done));
        child.kill('SIGTERM');
        await exited;
      },
    };
    const auth = createAttemptAuth(binding);
    await auth.pair();
    const liveness = await requestJsonWithStatus(`${base}/api/liveness`, {}, auth);
    if (liveness.status !== 200 || liveness.body?.status !== 'alive' || liveness.body?.providerReady !== undefined) {
      throw new Error(`serve liveness readiness failed: ${JSON.stringify(liveness).slice(0, 600)}`);
    }
    binding.readiness = { status: liveness.status, body: liveness.body };
    return binding;
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

/** Probe the RCC provider; a missing provider must surface, not be substituted. */
export async function probeProvider(binding) {
  const rcc = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
  try {
    return await jsonRequest(`${rcc}/health`);
  } catch (error) {
    throw new Error(`RCC provider ${rcc} is unreachable: ${error.message}`);
  }
}

export async function launchBrowserSession(binding) {
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  if (binding.auth?.paired) await binding.auth.installBrowserContext(context);
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  binding.browser = {
    browser,
    page,
    context,
    consoleErrors,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
  return binding.browser;
}

export async function captureScreenshot(binding, name) {
  const { page } = binding.browser;
  await mkdir(binding.screenshotsDir, { recursive: true });
  const path = join(binding.screenshotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function openEntryPage(binding) {
  const { page } = binding.browser;
  const entryUrl = `${binding.serveBaseUrl}/dashboard.html`;
  const response = await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
  if (!response || !response.ok()) {
    throw new Error(`served UI entry did not load: ${entryUrl} status=${response?.status()}`);
  }
  await page.waitForSelector('.quick-create-form textarea[name="directive"]', { timeout: 15_000 });
  return entryUrl;
}

/**
 * Drive 输入任务 -> 显式草稿 -> 用户确认 through the real served page and return
 * the dispatched task id. The UI asks clarifying questions; each one is answered
 * in-page rather than retried, up to a bounded number of attempts.
 */
export async function submitDirectiveAndConfirmDraft(binding, directive, options = {}) {
  const { page } = binding.browser;
  const base = binding.serveBaseUrl;
  const maxClarifications = options.maxClarifications ?? 3;
  const clarificationAnswer = options.clarificationAnswer ?? 'Do not clarify. Proceed directly with the tools available in the workspace and finish.';

  await openEntryPage(binding);
  await page.fill('.quick-create-form textarea[name="directive"]', directive);
  binding.formalEntryStarted = true;
  await page.click('form button[type="submit"]');

  let draft;
  const clarificationLog = [];
  for (let attempt = 0; attempt < maxClarifications; attempt += 1) {
    let outcome;
    try {
      outcome = await waitForDom(page, 'explicit draft or clarification', async () => {
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
      }, Number(options.draftTimeoutMs ?? 180_000));
    } catch (error) {
      const stage = await describeDraftStage(binding).catch(() => null);
      throw new Error(`${error.message}; draft-stage runtime state=${JSON.stringify(stage).slice(0, 2400)}`);
    }
    if (outcome.kind === 'draft') {
      const metaRows = await page.$$eval('.draft-meta', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
      draft = {
        intent: (metaRows.find((row) => row.startsWith('意图：')) ?? '').replace('意图：', ''),
        proposal: (await page.textContent('.draft-area .draft-proposal'))?.trim() ?? '',
        metaRows,
      };
      break;
    }
    if (!outcome.placeholder && !outcome.submitText) {
      throw new Error('dashboard clarification state had no UI evidence');
    }
    clarificationLog.push(outcome);
    if (!attempt || !clarificationAnswer) break;
    await page.fill('.quick-create-form textarea[name="directive"]:not([readonly])', clarificationAnswer);
    await page.click('.quick-create-form button[type="submit"]');
  }
  if (!draft) {
    throw new Error(`no confirmable explicit draft after ${maxClarifications} attempts: ${JSON.stringify(clarificationLog).slice(0, 500)}`);
  }

  const tasksBeforeConfirm = await jsonRequest(`${base}/api/tasks`, {}, binding.auth);
  const confirmResponsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/explicit/interactions/')
    && response.url().endsWith('/confirmation')
    && response.request().method() === 'POST');
  await page.click('.draft-actions button.button--primary');
  const confirmResponse = await confirmResponsePromise;
  if (confirmResponse.status() < 200 || confirmResponse.status() >= 300) {
    throw new Error(`confirmation POST returned non-2xx status=${confirmResponse.status()}`);
  }

  const taskId = await waitForDom(page, 'dispatched task id', async () => {
    const tasks = await jsonRequest(`${base}/api/tasks`, {}, binding.auth);
    const candidates = []
      .concat(tasks.running ?? [])
      .concat(tasks.waiting ?? [])
      .concat(tasks.draft ?? [])
      .concat(tasks.completed ?? [])
      .concat(tasks.failed ?? [])
      .filter((task) => task?.taskId?.value && task.updatedAt);
    if (candidates.length === 0) return null;
    return candidates
      .map((task) => ({ task, timestamp: new Date(task.updatedAt).getTime() }))
      .sort((left, right) => right.timestamp - left.timestamp)[0]?.task?.taskId?.value ?? null;
  }, Number(options.confirmTimeoutMs ?? 90_000));
  if (!taskId) throw new Error('confirmation did not create a dispatched task');

  binding.taskId = taskId;
  binding.draft = draft;
  binding.draftRowsBeforeConfirm = (tasksBeforeConfirm.draft ?? []).length;
  binding.confirmStatus = confirmResponse.status();
  return binding;
}

/** Open the per-task dashboard and wait for the task to be nonterminal-running. */
export async function openTaskDashboard(binding, options = {}) {
  const { page } = binding.browser;
  const dashboardUrl = `${binding.serveBaseUrl}/task-dashboard.html?task=${encodeURIComponent(binding.taskId)}`;
  if (page.url() !== dashboardUrl) {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  }
  if (options.waitNonterminal !== false) {
    await waitForDom(page, 'nonterminal task dashboard', async () => {
      const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(binding.taskId)}/dashboard`, {}, binding.auth);
      if (probe.state && !['succeeded', 'failed', 'stopped'].includes(probe.state)) return probe.state;
      if (probe.state === 'failed') return 'failed';
      return null;
    }, Number(options.runTimeoutMs ?? 240_000));
  }
  return dashboardUrl;
}

/** Wait for the task runtime terminal state and return the dashboard probe. */
export async function waitForTerminal(binding, options = {}) {
  const { page } = binding.browser;
  const state = await waitForDom(page, 'task runtime terminal', async () => {
    const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(binding.taskId)}/dashboard`, {}, binding.auth);
    if (['succeeded', 'failed', 'stopped'].includes(probe.state)) return probe.state;
    return null;
  }, Number(options.timeoutMs ?? TERMINAL_TIMEOUT_MS));
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(binding.taskId)}/dashboard`, {}, binding.auth);
  binding.terminalState = state;
  binding.dashboardProbe = probe;
  return probe;
}

/** Read the newest execution terminal record from the authoritative journal. */
export async function readDashboardProbe(binding) {
  return jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(binding.taskId)}/dashboard`, {}, binding.auth);
}

export async function captureDashboardEvidence(binding) {
  const dashboardProbe = await readDashboardProbe(binding).catch((error) => ({ error: error.message }));
  const observation = await jsonRequest(
    `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(binding.taskId)}/observation`,
  ).catch((error) => ({ error: error.message }));
  const rootScopeRef = observation?.scope?.scopeRef ?? `task://${binding.taskId}/observation`;
  // `pipeline.execute` is a registry node on the root scope; the child scope only
  // holds provider sub-event nodes, so select it without the child scope ref.
  const executeNode = await jsonRequest(
    `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(binding.taskId)}/observation?node=pipeline.execute`,
  ).catch((error) => ({ error: error.message }));
  const taskDashboardDom = await readTaskDashboardDom(binding).catch((error) => ({ error: error.message }));
  const sse = await readSseEvents(binding).catch((error) => ({ error: error.message }));
  const toolSteps = (observation?.nodes ?? [])
    .filter((node) => node.nodeId === 'pipeline.execute')
    .flatMap((node) => Array.isArray(node.toolSteps) ? node.toolSteps : []);
  const toolStepEvidence = toolSteps.map((step) => ({
    stepId: step.stepId,
    name: step.name,
    status: step.status,
    statusDisplay: step.statusDisplay,
    returned: step.returned,
    occurredAt: step.occurredAt,
  }));
  return { dashboardProbe, observation, rootScopeRef, executeNode, toolStepEvidence, taskDashboardDom, sse };
}

/** Read the rendered task-dashboard DOM: status layers, trajectory rows, pager. */
export async function readTaskDashboardDom(binding, options = {}) {
  const { page } = binding.browser;
  if (options.navigate !== false) {
    const dashboardUrl = `${binding.serveBaseUrl}/task-dashboard.html?task=${encodeURIComponent(binding.taskId)}`;
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-layers .detail-cell', { timeout: 30_000 });
  }
  return page.evaluate(() => {
    const text = (node) => node?.textContent?.trim() ?? null;
    const cells = (root) => [...(root?.querySelectorAll('.detail-cell') ?? [])].map((cell) => ({
      label: text(cell.querySelector('dt')),
      value: text(cell.querySelector('dd')),
    }));
    const rows = [...document.querySelectorAll('.event-list li.event')];
    const eventIds = rows.map((row) => row.dataset.eventId ?? null);
    return {
      statusLayers: cells(document.querySelector('.status-layers')),
      eventRows: rows.map((row) => ({
        eventId: row.dataset.eventId ?? null,
        kind: text(row.querySelector('.event-kind')),
        summary: text(row.querySelector('summary span:nth-of-type(2)')),
        seq: text(row.querySelector('.event-seq')),
        detailLabels: [...row.querySelectorAll('.event-detail dt')].map((dt) => text(dt)),
        hasDetails: Boolean(row.querySelector('details')),
      })),
      eventIds,
      duplicateEventIds: eventIds.filter((value, index) => value !== null && eventIds.indexOf(value) !== index),
      turnTitles: [...document.querySelectorAll('.history-turn-title')].map((node) => text(node)),
      historyGap: text(document.querySelector('.history-gap')),
      pageStatus: text(document.querySelector('.status-banner')),
      pager: [...document.querySelectorAll('.history-pager button')].map((button) => ({
        label: text(button),
        disabled: button.disabled,
      })),
    };
  });
}

/**
 * Flip the history pager to the previous page and read the rows again. Proves
 * the older-than-recent window is really reachable, not just advertised.
 */
export async function pageBackDashboardHistory(binding) {
  const { page } = binding.browser;
  const before = await readTaskDashboardDom(binding);
  const older = page.locator('.history-pager button', { hasText: '更早' }).first();
  if (await older.count() === 0 || await older.isDisabled()) {
    return { before, after: before, flipped: false, reason: 'no enabled 更早 pager button' };
  }
  await older.click();
  await page.waitForTimeout(200);
  const after = await readTaskDashboardDom(binding, { navigate: false });
  const beforeSeqs = before.eventRows.map((row) => Number(String(row.seq).replace(/\D/g, ''))).filter(Number.isFinite);
  const afterSeqs = after.eventRows.map((row) => Number(String(row.seq).replace(/\D/g, ''))).filter(Number.isFinite);
  const minBefore = beforeSeqs.length ? Math.min(...beforeSeqs) : null;
  const maxAfter = afterSeqs.length ? Math.max(...afterSeqs) : null;
  return {
    before,
    after,
    flipped: true,
    olderPageMaxSeq: maxAfter,
    newerPageMinSeq: minBefore,
    reachedOlderEvents: maxAfter !== null && minBefore !== null && maxAfter < minBefore,
  };
}

/**
 * Read the same SSE stream the dashboard subscribes to, replay plus live, and
 * return the event kinds and raw payloads it delivers. Empty means the attempt
 * captured no live connection for this task.
 */
export async function readSseEvents(binding, timeoutMs = 15_000) {
  const operationId = binding.dashboardProbe?.operationId ?? binding.operationId;
  if (!operationId) return { error: 'no operation id observed before the terminal' };
  const url = `${binding.serveBaseUrl}/api/executions/${encodeURIComponent(operationId)}/events`;
  const response = await fetch(url, { headers: { accept: 'text/event-stream' } }).catch((error) => ({ error: error.message }));
  if (!response?.body) return { error: response?.error ?? `unexpected response status=${response?.status}` };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      await reader.cancel().catch(() => {});
      break;
    }
    const waited = await Promise.race([
      reader.read(),
      new Promise((settle) => setTimeout(() => settle({ done: true, value: undefined }), deadline - Date.now())),
    ]);
    if (waited?.done) break;
    buffer += decoder.decode(waited.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.trim()) continue;
      const kindMatch = frame.match(/^event:\s*(.*)$/m);
      const idMatch = frame.match(/^id:\s*(.*)$/m);
      const dataMatch = frame.match(/^data:\s*(.*)$/m);
      let payload = {};
      try {
        payload = dataMatch ? JSON.parse(dataMatch[1]) : {};
      } catch {
        payload = { _raw: dataMatch?.[1] ?? '' };
      }
      const event = {
        sseId: idMatch?.[1] ?? null,
        sseKind: kindMatch?.[1] ?? null,
        kind: payload.kind ?? null,
        seq: payload.seq ?? null,
        eventId: payload.eventId ?? null,
        summary: payload.summary ?? null,
        data: dataMatch?.[1] ?? null,
      };
      events.push(event);
      if (payload.terminalPhase === 'final') return events;
    }
  }
  return events;
}

/**
 * Open the task dashboard while the task is still live and verify the F07
 * freshness contract through real framed events:
 *   - the page subscribes to the SSE stream and reports 实时连接已建立
 *   - a real network interruption flips the freshness layer to 已断开
 *   - the interrupted page must not fake task failure
 *   - clearing the interruption restores 实时/收拢 without reloading.
 * Returns raw observed frames; this is the dashboard's real EventSource path.
 */
export async function probeDashboardLiveSse(binding, options = {}) {
  const { page, context } = binding.browser;
  const base = binding.serveBaseUrl;
  const dashboardUrl = `${base}/task-dashboard.html?task=${encodeURIComponent(binding.taskId)}`;
  await page.addInitScript(() => {
    const recorded = window.__humanagentSseRecorded ??= [];
    const original = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function wrapped(kind, listener, capture) {
      return original.call(this, kind, (message) => {
        recorded.push({
          kind,
          lastEventId: message?.lastEventId ?? null,
          data: message?.data ?? null,
        });
        return listener(message);
      }, capture);
    };
    window.__humanagentDashboardReads = 0;
    const originalFetch = window.fetch;
    window.fetch = function countedFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/tasks/') && url.includes('/dashboard')) {
        window.__humanagentDashboardReads += 1;
      }
      return originalFetch.call(this, input, init);
    };
  });
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.status-layers .detail-cell', { timeout: 30_000 });

  const readState = () => page.evaluate(() => {
    const text = (node) => node?.textContent?.trim() ?? null;
    const layers = [...document.querySelectorAll('.status-layers .detail-cell')].map((cell) => ({
      label: text(cell.querySelector('dt')),
      value: text(cell.querySelector('dd')),
    }));
    const freshness = layers.find((cell) => cell.label === '连接新鲜度')?.value ?? '';
    const stateChip = text(document.querySelector('.state-chip'));
    const actionStatus = text(document.querySelector('[role="status"]'));
    const pageStatus = text(document.querySelector('.status-banner'));
    return {
      layers,
      freshness,
      stateChip,
      actionStatus,
      pageStatus,
      dashboardReads: window.__humanagentDashboardReads ?? 0,
      sseRecorded: window.__humanagentSseRecorded ?? [],
    };
  });

  const connected = await waitForDom(page, 'live freshness connected', async () => {
    const state = await readState();
    return state.freshness.includes('实时连接已建立') ? state : null;
  }, options.connectedTimeoutMs ?? 90_000, 500);

  const failProjectionReads = async (route) => {
    await route.abort('failed');
  };
  await page.route('**/api/tasks/**/dashboard', failProjectionReads);
  await context.setOffline(true);
  const broken = await waitForDom(page, 'interrupted freshness shows 已断开 without task failure', async () => {
    const state = await readState();
    const disconnected = state.freshness.includes('实时连接已断开');
    const noFakeFailure = state.stateChip !== '失败' && !state.actionStatus.includes('执行失败');
    return disconnected && noFakeFailure ? state : null;
  }, options.brokenTimeoutMs ?? 60_000, 500);

  await page.unroute('**/api/tasks/**/dashboard', failProjectionReads);
  await context.setOffline(false);
  const recovered = await waitForDom(page, 'freshness restored after reconnect', async () => {
    const state = await readState();
    const liveOrSettled = state.freshness.includes('实时连接已建立') || state.freshness.includes('已收拢');
    return liveOrSettled ? state : null;
  }, options.recoveredTimeoutMs ?? 60_000, 500);

  return {
    dashboardUrl,
    connected,
    broken,
    recovered,
    sseKinds: [...new Set((recovered.sseRecorded ?? []).map((entry) => entry.kind))],
    providerToolResultSeen: (recovered.sseRecorded ?? []).some((entry) => entry.kind === 'provider.tool-result'),
    rawSseRecorded: (recovered.sseRecorded ?? []).slice(-160),
  };
}
