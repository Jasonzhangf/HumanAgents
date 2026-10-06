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
  }, TERMINAL_TIMEOUT_MS);
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
