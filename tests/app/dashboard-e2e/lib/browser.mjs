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
 * exact resources the cleanup closure stops and verifies.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAttemptAuth } from './auth.mjs';
import { taskIdValue } from './binding.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = resolve(__dirname, '..', '..', '..', '..');

const PLAYWRIGHT_CANDIDATES = [
  process.env.HUMANAGENT_PLAYWRIGHT_MODULE,
  'playwright',
  '/opt/homebrew/lib/node_modules/playwright/index.js',
].filter(Boolean);

const TERMINAL_TIMEOUT_MS = Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 600_000);
const SERVE_READY_TIMEOUT_MS = Number(process.env.E2E_SERVE_READY_TIMEOUT_MS ?? 90_000);
const SERVE_STARTUP_STOP_TIMEOUT_MS = Number(process.env.E2E_SERVE_STARTUP_STOP_TIMEOUT_MS ?? 10_000);
const SERVE_STARTUP_LOG_LIMIT_BYTES = 256 * 1024;
const SERVE_STARTUP_EXCERPT_CHARS = 8_000;

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function excerpt(text, limit = SERVE_STARTUP_EXCERPT_CHARS) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... [truncated: ${text.length - limit} of ${text.length} chars omitted]`;
}

/**
 * The startup log is execution-owned evidence: it lives under this attempt's
 * run-notes receipt directory so it survives the unsettled-retention branch for
 * the recovery owner, and is never written into the real user root.
 */
async function writeStartupLog(binding, suffix, text) {
  const base = binding.receiptDir ?? binding.attemptRoot ?? binding.workspace ?? tmpdir();
  const path = join(base, `serve-startup-${binding.attemptId ?? 'attempt'}.${suffix}.log`);
  const full = String(text ?? '');
  const stored = full.length > SERVE_STARTUP_LOG_LIMIT_BYTES ? full.slice(0, SERVE_STARTUP_LOG_LIMIT_BYTES) : full;
  await mkdir(base, { recursive: true });
  await writeFile(path, stored, 'utf8');
  return {
    path,
    bytes: byteLength(full),
    storedBytes: byteLength(stored),
    truncated: stored.length !== full.length,
    excerpt: excerpt(full),
  };
}

/** Persist child stdout/stderr verbatim (stderr may be empty; stdout is kept regardless). */
async function persistServeStartupLogs(binding, launch) {
  if (launch.stdoutLog || launch.stderrLog) return launch;
  launch.evidenceDir = binding.receiptDir ?? binding.attemptRoot ?? binding.workspace ?? tmpdir();
  const [stdoutLog, stderrLog] = await Promise.all([
    writeStartupLog(binding, 'stdout', launch.stdout),
    writeStartupLog(binding, 'stderr', launch.stderr),
  ]);
  launch.stdoutLog = stdoutLog;
  launch.stderrLog = stderrLog;
  return launch;
}

function childExitStatus(child) {
  if (!child) return null;
  if (child.exitCode === null && child.signalCode === null) return null;
  return { exitCode: child.exitCode ?? null, signal: child.signalCode ?? null };
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

/**
 * The single readiness verdict. The three real readiness branches are
 * distinguishable:
 *  - `readiness_timeout`: the deadline expired with no banner-shaped match;
 *  - `banner_parse_failed`: a banner-shaped match appeared but never parsed;
 *  - `early_exit`: the child exited before a banner was parsed;
 * plus `startup_failed` for a failure after a parsed banner (missing url or a
 * failed liveness probe) and `ready` once the banner and liveness both pass.
 * A parse failure is recorded alongside the branch, never swallowed.
 */
function finalizeServeReadiness(launch, outcome, detail = {}) {
  if (launch.readiness !== 'launching') return launch;
  launch.readiness = outcome;
  launch.readinessAt = new Date().toISOString();
  if (outcome === 'readiness_timeout') {
    launch.failureReason = `serve readiness timed out after ${launch.readyTimeoutMs}ms with no parsed banner`;
  } else if (outcome === 'banner_parse_failed') {
    launch.failureReason = `serve readiness timed out after ${launch.readyTimeoutMs}ms; a banner-shaped object matched but did not parse: ${launch.parser.lastParseError}`;
  } else if (outcome === 'early_exit') {
    launch.failureReason = `serve exited before reporting a URL (exitCode=${detail.exitCode ?? 'null'} signal=${detail.signal ?? 'null'})`;
  } else {
    launch.failureReason = detail.reason ?? null;
  }
  return launch;
}

/** Wait for an already-signalled child to actually exit; report the real result. */
async function waitForServeExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, ...(childExitStatus(child) ?? { exitCode: null, signal: null }) };
  }
  return new Promise((done) => {
    const timer = setTimeout(() => done({ exited: false, exitCode: null, signal: null, reason: `pid ${child.pid} did not exit within ${timeoutMs}ms` }), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ exited: true, exitCode: code ?? null, signal: signal ?? null });
    });
  });
}

/**
 * Terminate the failed startup child with explicit-PID SIGTERM and verify the
 * exit. If the child really stays alive it is not claimed as stopped: the real
 * live PID is recorded on the binding so cleanup hands it to recovery.
 */
async function stopFailedServeChild(binding, launch) {
  const child = launch.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    launch.stop = { attempted: false, reason: 'child already exited before any stop signal' };
    return launch.stop;
  }
  try {
    child.kill('SIGTERM');
  } catch (error) {
    launch.stop = { attempted: true, signal: 'SIGTERM', delivered: false, reason: `SIGTERM failed: ${error.message}` };
    return launch.stop;
  }
  const first = await waitForServeExit(child, SERVE_STARTUP_STOP_TIMEOUT_MS);
  if (first.exited) {
    launch.stop = { attempted: true, signal: 'SIGTERM', delivered: true, exited: true, escalated: false, exitCode: first.exitCode, signalCode: first.signal };
    return launch.stop;
  }
  try {
    child.kill('SIGKILL');
  } catch { /* already gone */ }
  const second = await waitForServeExit(child, SERVE_STARTUP_STOP_TIMEOUT_MS);
  launch.stop = second.exited
    ? { attempted: true, signal: 'SIGTERM', delivered: true, exited: true, escalated: true, exitCode: second.exitCode, signalCode: second.signal }
    : { attempted: true, signal: 'SIGTERM', delivered: true, exited: false, escalated: true, reason: second.reason ?? `pid ${child.pid} survived SIGTERM and SIGKILL` };
  return launch.stop;
}

/**
 * The real exit status of the attempt's serve child. `checked` is false when
 * this attempt never spawned a child and no usable PID was registered, so the
 * caller must not report "exited" or "retained" from a guess.
 */
export function serveExitStatus(binding) {
  const launch = binding.serveLaunch ?? null;
  const child = launch?.child ?? binding.serveChild ?? null;
  if (child) {
    const status = childExitStatus(child);
    if (status) return { checked: true, exited: true, ...status };
    if (launch?.spawnError) return { checked: true, exited: true, exitCode: null, signal: null, reason: `spawn failed: ${launch.spawnError}` };
    return { checked: true, exited: false, exitCode: null, signal: null, pid: child.pid ?? null };
  }
  if (launch?.spawnError) return { checked: true, exited: true, exitCode: null, signal: null, reason: `spawn failed: ${launch.spawnError}` };
  const alive = isProcessAlive(binding.servePid);
  if (alive === null) return { checked: false, exited: null, exitCode: null, signal: null, reason: 'no serve child or usable serve pid was registered by this attempt' };
  return alive
    ? { checked: true, exited: false, exitCode: null, signal: null, pid: binding.servePid }
    : { checked: true, exited: true, exitCode: null, signal: null, pid: binding.servePid, reason: `pid ${binding.servePid} is not running` };
}

function idValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && value !== null ? value.value : String(value);
}

function sameId(left, right) {
  const a = idValue(left);
  const b = idValue(right);
  return a !== null && b !== null && a === b;
}

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
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body, raw: text.slice(0, 2000), total: body?.counts?.total ?? null };
    } catch (error) {
      return { status: null, body: null, raw: error instanceof Error ? error.message : String(error), total: null };
    }
  };
  const [tasks, dashboard] = await Promise.all([
    probe('/api/tasks'),
    binding.taskId
      ? probe(`/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/dashboard`)
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
  // The candidate CLI is the default and the real path. An explicit override
  // exists only so deterministic contract tests can drive this exact spawn and
  // readiness machinery with a controlled child instead of a real service.
  const cli = options.cliPath ?? cliPath(repoPath);
  if (!cli) {
    throw new Error(`built CLI is missing at ${join(repoPath, 'dist/app/app/src/cli.js')}; run \`pnpm build:app\` in the worktree first`);
  }
  if (binding.serviceMode === 'installed-attach') {
    throw new Error('installed-attach never starts a candidate serve; use attachToInstalledService()');
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
  const readyTimeoutMs = Number(options.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS);

  const startedAt = new Date().toISOString();
  const launch = {
    attemptId: binding.attemptId ?? null,
    pid: null,
    argv: [process.execPath, cli, 'serve', '--mode', 'rcc', '--protocol', 'responses', '--binding', `ui-dash-e2e-${binding.attemptId}`, '--port', '0'],
    cwd: repoPath,
    workspace,
    controlRoot,
    readyTimeoutMs,
    startedAt,
    spawnedAt: null,
    spawnError: null,
    readiness: 'launching',
    readinessAt: null,
    failureReason: null,
    parser: { matched: false, parseFailed: false, matchedBytes: 0, lastParseError: null, attempts: 0 },
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    exit: null,
    stop: null,
  };
  binding.serveLaunch = launch;

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
  launch.pid = child.pid ?? null;
  launch.child = child;
  binding.servePid = child.pid;
  binding.serveChild = child;
  binding.serviceMode = 'candidate';

  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => {
      finalizeServeReadiness(launch, launch.parser.parseFailed ? 'banner_parse_failed' : 'readiness_timeout');
      fail(new Error(`serve did not report a URL within ${readyTimeoutMs}ms: ${launch.failureReason}${launch.parser.parseFailed ? `; last parse error: ${launch.parser.lastParseError}` : ''}; stderr tail: ${launch.stderr.slice(-1200)}`));
    }, readyTimeoutMs);
    const onData = (chunk) => {
      launch.stdoutBytes += chunk.length;
      launch.stdout += chunk.toString();
      const match = launch.stdout.match(/\{[\s\S]*?\n\}/);
      if (!match) return;
      launch.parser.matched = true;
      launch.parser.matchedBytes = Buffer.byteLength(match[0], 'utf8');
      launch.parser.attempts += 1;
      try {
        const parsed = JSON.parse(match[0]);
        launch.parser.parseFailed = false;
        clearTimeout(timer);
        settle(parsed);
      } catch (error) {
        // Keep buffering until the JSON object is complete, but record that a
        // matched object did not parse so a timeout can name the real reason.
        launch.parser.parseFailed = true;
        launch.parser.lastParseError = error.message;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      launch.stderrBytes += chunk.length;
      launch.stderr += chunk.toString();
    });
    child.once('spawn', () => { launch.spawnedAt = new Date().toISOString(); });
    child.once('error', (error) => {
      launch.spawnError = `${error.code ?? 'error'}: ${error.message}`;
      launch.errorAt = new Date().toISOString();
      clearTimeout(timer);
      fail(new Error(`serve spawn failed: ${launch.spawnError}`));
    });
    child.once('exit', (code, signal) => {
      launch.exit = { code: code ?? null, signal: signal ?? null, at: new Date().toISOString() };
      if (launch.readiness === 'launching') finalizeServeReadiness(launch, 'early_exit', { exitCode: code ?? null, signal: signal ?? null });
      fail(new Error(`serve exited early (code=${String(code)} signal=${String(signal)}): ${launch.stderr.slice(-1200)}`));
    });
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
    launch.banner = launched;
    Object.defineProperty(binding, 'serveStderrTail', {
      enumerable: false,
      configurable: true,
      get: () => launch.stderr.slice(-4000),
    });
    binding.serveStderrTailFinal = () => launch.stderr.slice(-4000);
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
    const auth = (options.authFactory ?? createAttemptAuth)(binding);
    await auth.pair();
    const probeLiveness = options.probeLiveness ?? ((target, token) => requestJsonWithStatus(`${target}/api/liveness`, {}, token));
    const liveness = await probeLiveness(base, auth);
    if (liveness.status !== 200 || liveness.body?.status !== 'alive' || liveness.body?.providerReady !== undefined) {
      throw new Error(`serve liveness readiness failed: ${JSON.stringify(liveness).slice(0, 600)}`);
    }
    binding.readiness = { status: liveness.status, body: liveness.body };
    launch.readiness = 'ready';
    launch.readinessAt = new Date().toISOString();
    // Persist the same raw startup evidence on the ready path: the banner bytes
    // that were accepted are part of the attempt's record, not only failures.
    await persistServeStartupLogs(binding, launch).catch((persistError) => {
      launch.evidenceError = persistError.message;
    });
    return binding;
  } catch (error) {
    // The startup never reached `ready`, so this attempt must not claim a
    // retained service. Stop the exact child by explicit PID, verify the exit,
    // and persist the raw stdout/stderr before rethrowing.
    if (launch.readiness === 'launching') finalizeServeReadiness(launch, 'startup_failed', { reason: error.message });
    launch.error = { message: error.message, at: new Date().toISOString() };
    await stopFailedServeChild(binding, launch);
    if (launch.stop?.exited === true && !launch.exit) {
      launch.exit = { code: launch.stop.exitCode ?? null, signal: launch.stop.signalCode ?? null, at: new Date().toISOString(), source: 'verified-stop' };
    }
    launch.verifiedExit = serveExitStatus(binding);
    await persistServeStartupLogs(binding, launch).catch((persistError) => {
      launch.evidenceError = persistError.message;
    });
    const detail = launch.verifiedExit?.exited === true
      ? `child exited (exitCode=${launch.verifiedExit.exitCode ?? 'null'} signal=${launch.verifiedExit.signal ?? 'null'})`
      : `child pid ${child.pid} is still alive and is handed to recovery, not reported as stopped`;
    throw new Error(`${error.message}; serve startup branch=${launch.readiness}; ${detail}; stdout=${launch.stdoutBytes}B stderr=${launch.stderrBytes}B`);
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

/**
 * Installed-attach: attach to the operator's already-running canonical serve
 * owner instead of starting a new one. The runner never starts, replaces or
 * stops this owner. It verifies the live lease (owner identity, pid, port), the
 * served entry/artifact, readiness, and the optional required task scope, then
 * authenticates through the existing `humanagent pair` <-> `/api/auth/pair`
 * mechanism. No credential is written to the binding or receipt.
 */
export async function attachToInstalledService(binding, options = {}) {
  const repoPath = binding.repoPath ?? DEFAULT_REPO_PATH;
  const expectedOwner = options.expectedOwner ?? 'humanagent.app.serve';
  const paths = binding.formalPaths;
  if (!paths) {
    throw new Error('installed-attach requires resolveFormalAttachPaths() to have derived the formal project paths');
  }
  const baseUrl = options.baseUrl ?? process.env.HUMANAGENT_ATTACH_BASE_URL
    ?? (process.env.HUMANAGENT_ATTACH_PORT ? `http://127.0.0.1:${process.env.HUMANAGENT_ATTACH_PORT}` : null);
  if (!baseUrl) {
    throw new Error('installed-attach requires an explicit owner endpoint: set HUMANAGENT_ATTACH_BASE_URL (or HUMANAGENT_ATTACH_PORT)');
  }
  const requiredTaskId = options.requiredTaskId ?? process.env.HUMANAGENT_ATTACH_TASK ?? null;
  const boundTaskId = binding.scope?.taskId ?? binding.taskId ?? null;
  if (requiredTaskId !== null && boundTaskId !== null && !sameId(requiredTaskId, boundTaskId)) {
    throw new Error(
      `installed-attach task identity conflict: scope/task ${JSON.stringify(idValue(boundTaskId))} `
      + `does not match HUMANAGENT_ATTACH_TASK ${JSON.stringify(idValue(requiredTaskId))}`,
    );
  }
  const explicitTaskId = requiredTaskId ?? boundTaskId;
  const explicitTaskIdentity = boundTaskId ?? requiredTaskId;
  if (!explicitTaskId) {
    throw new Error(
      'installed-attach requires an explicit existing task via options.scope.taskId or HUMANAGENT_ATTACH_TASK',
    );
  }

  const supervisorModule = join(repoPath, 'dist', 'app', 'app', 'src', 'supervisor', 'index.js');
  if (!existsSync(supervisorModule)) {
    throw new Error(`supervisor module is not built at ${supervisorModule}; run \`pnpm build:app\` first`);
  }
  const { readDaemonLease } = await import(pathToFileURL(supervisorModule).href);
  const lease = await (options.readLease ?? readDaemonLease)(paths);
  if (!lease) {
    throw new Error(`installed-attach found no daemon lease under ${paths.projectRoot}; the formal service must be running`);
  }
  if (lease.ownerId !== expectedOwner) {
    throw new Error(`installed-attach refused owner ${JSON.stringify(lease.ownerId)}; expected ${expectedOwner}`);
  }
  if (lease.controlEndpoint === undefined) {
    throw new Error('installed-attach: the live owner has not published a supervisor control endpoint');
  }
  const url = new URL(baseUrl);
  const urlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (urlPort !== lease.controlEndpoint.port) {
    throw new Error(`installed-attach endpoint port ${urlPort} does not match the live lease port ${lease.controlEndpoint.port}`);
  }
  let alive = true;
  try {
    process.kill(lease.pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    throw new Error(`installed-attach: lease pid ${lease.pid} is not running; refuse to attach to a stale owner`);
  }

  binding.serviceMode = 'installed-attach';
  binding.serveBaseUrl = baseUrl.replace(/\/$/, '');
  binding.servePort = urlPort;
  // The service is not this attempt's to stop; keep the pid only as the
  // retained-identity proof, never as a signal target.
  binding.attachedOwner = { ownerId: lease.ownerId, pid: lease.pid, port: lease.controlEndpoint.port, leaseId: lease.leaseId, generation: lease.generation };
  binding.attachedLeaseProjectRoot = paths.projectRoot;
  binding.attachedLeasePath = join(paths.projectRoot, 'daemon', 'lease.json');
  binding.servePid = null;

  // Pairing is scoped to the formal installed owner, not to the ephemeral
  // attempt workspace. The auth helper uses binding.workspace/controlRoot to
  // create the pairing challenge and derives the cookie origin from baseUrl.
  const authBinding = {
    ...binding,
    workspace: binding.formalWorkspace ?? paths.workspaceCwd ?? binding.workspace,
    controlRoot: paths.controlRoot,
    runtimePaths: paths,
    serveBaseUrl: baseUrl.replace(/\/$/, ''),
  };
  const auth = options.auth ?? createAttemptAuth(authBinding);
  binding.auth = auth;
  if (typeof auth.pair === 'function') await auth.pair();
  const liveness = await requestJsonWithStatus(`${binding.serveBaseUrl}/api/liveness`, {}, auth);
  if (liveness.status !== 200 || liveness.body?.status !== 'alive') {
    throw new Error(`installed-attach readiness failed: ${JSON.stringify(liveness).slice(0, 600)}`);
  }
  // Artifact provenance: the served entry must be the real Dashboard UI, not a
  // placeholder; verify the identity endpoint reports this exact live owner.
  const entryResponse = await (auth.fetch ?? fetch)(`${binding.serveBaseUrl}/dashboard.html`, { headers: { accept: 'text/html' } });
  if (!entryResponse.ok) {
    throw new Error(`installed-attach served entry did not load: status=${entryResponse.status}`);
  }

  const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(explicitTaskId))}/dashboard`, {}, auth)
    .catch((error) => ({ error: error.message }));
  if (!probe || probe.error) {
    throw new Error(`installed-attach task scope check failed for ${idValue(explicitTaskId)}: ${probe?.error ?? 'no dashboard'}`);
  }
  if (probe.taskId !== undefined && !sameId(probe.taskId, explicitTaskId)) {
    throw new Error(
      `installed-attach task scope check returned task ${JSON.stringify(idValue(probe.taskId))} `
      + `instead of ${JSON.stringify(idValue(explicitTaskId))}`,
    );
  }
  binding.taskId = explicitTaskIdentity;
  binding.attachTaskProbe = probe;
  binding.readiness = { status: liveness.status, body: liveness.body, mode: 'installed-attach' };
  return binding;
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

/**
 * Open the real served entry the attempt selected. The homepage (`/`, served as
 * `index.html`/`entry.js`) submits once and authorizes the new task in the same
 * handling; the dashboard page (`dashboard.html`/`dashboard.js`) is the preview
 * entry. Both are the real served pages, not API substitutes.
 */
async function openEntryPage(binding) {
  const { page } = binding.browser;
  const entry = binding.entry ?? 'dashboard';
  if (entry !== 'dashboard' && entry !== 'homepage') {
    throw new Error(`unknown entry ${JSON.stringify(entry)}; expected homepage or dashboard`);
  }
  const entryUrl = entry === 'homepage' ? `${binding.serveBaseUrl}/` : `${binding.serveBaseUrl}/dashboard.html`;
  const response = await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
  if (!response || !response.ok()) {
    throw new Error(`served UI entry did not load: ${entryUrl} status=${response?.status()}`);
  }
  binding.entryUrl = entryUrl;
  if (entry === 'homepage') {
    await page.waitForSelector('#entry-form textarea[name="rawInput"]', { timeout: 15_000 });
    const directiveBox = await page.locator('#entry-form textarea[name="rawInput"]').boundingBox();
    if (!directiveBox || directiveBox.width <= 0 || directiveBox.height <= 0) {
      throw new Error(`real homepage input was not laid out with a positive bbox: ${JSON.stringify(directiveBox)}`);
    }
    binding.entryLayout = { directive: directiveBox };
    return entryUrl;
  }
  await page.waitForSelector('.quick-create-form textarea[name="directive"]', { timeout: 15_000 });
  // The rendered entry control is proven by its real layout. New-task submit
  // itself authorizes the task, so the Dashboard has no confirmation checkbox.
  const directiveBox = await page.locator('.quick-create-form textarea[name="directive"]').boundingBox();
  if (!directiveBox || directiveBox.width <= 0 || directiveBox.height <= 0) {
    throw new Error(`real browser input was not laid out with a positive bbox: ${JSON.stringify(directiveBox)}`);
  }
  binding.entryLayout = { directive: directiveBox };
  return entryUrl;
}

function taskScopedNavigation(value, baseUrl) {
  let candidate;
  try {
    candidate = value instanceof URL ? value : new URL(String(value), baseUrl);
  } catch {
    return null;
  }
  let expected;
  try {
    expected = new URL(baseUrl);
  } catch {
    return null;
  }
  if (candidate.origin !== expected.origin) return null;
  if (candidate.pathname !== '/observation.html' && candidate.pathname !== '/task-dashboard.html') return null;
  const taskId = candidate.searchParams.get('task');
  if (!taskId || taskId.trim() === '') return null;
  return {
    taskId,
    href: candidate.href,
    pathname: candidate.pathname,
    origin: candidate.origin,
  };
}

async function waitForTaskScopedNavigation(binding, timeoutMs) {
  const page = binding.browser.page;
  if (typeof page.waitForURL === 'function') {
    try {
      // `page.waitForURL` returns `Promise<void>`: it synchronizes on the
      // navigation/load state and resolves `undefined`. Await it for
      // synchronization only, then read the settled URL from `page.url()` and
      // validate it with the same-origin/task-scoped rules.
      await page.waitForURL(
        (url) => taskScopedNavigation(url, binding.serveBaseUrl) !== null,
        { timeout: timeoutMs, waitUntil: 'domcontentloaded' },
      );
    } catch (error) {
      throw new Error(
        `homepage submission did not navigate to a same-origin task-scoped observation: ${error.message}`,
      );
    }
    const navigation = taskScopedNavigation(page.url(), binding.serveBaseUrl);
    if (!navigation) {
      throw new Error('homepage submission settled on an invalid task-scoped navigation');
    }
    return navigation;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const navigation = taskScopedNavigation(page.url(), binding.serveBaseUrl);
    if (navigation) return navigation;
    if (Date.now() > deadline) {
      throw new Error('homepage submission did not navigate to a same-origin task-scoped observation before timeout');
    }
    await sleep(50);
  }
}

/**
 * Read the real input stage of the selected entry before it is submitted: the
 * URL the browser is on, the directive control's real value, visibility, layout
 * and required/readOnly state, the submit control, and any second-confirmation
 * control. The caller asserts these preconditions before it screenshots the
 * stage, so an input-stage screenshot can only exist for a page that really
 * shows the filled directive.
 */
export async function readEntryInputStage(binding, selector) {
  const { page } = binding.browser;
  return page.evaluate((inputSelector) => {
    const textarea = document.querySelector(inputSelector);
    const form = textarea?.closest('form') ?? null;
    const submit = form?.querySelector('button[type="submit"]') ?? null;
    const rect = textarea?.getBoundingClientRect() ?? null;
    const style = textarea ? getComputedStyle(textarea) : null;
    const visible = Boolean(
      textarea
      && rect
      && rect.width > 0
      && rect.height > 0
      && style
      && style.visibility !== 'hidden'
      && style.display !== 'none',
    );
    return {
      url: location.href,
      pathname: location.pathname,
      value: textarea?.value ?? null,
      visible,
      bbox: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      readOnly: textarea?.readOnly ?? null,
      required: textarea?.required ?? null,
      submitId: submit?.id ?? null,
      submitLabel: submit?.textContent?.trim() ?? null,
      submitEnabled: submit ? !submit.disabled : null,
      secondConfirmationControls: document.querySelectorAll(
        '#dashboard-confirm-button, .draft-area, [data-testid="auto-confirm"], input[name="autoConfirm"]',
      ).length,
    };
  }, selector);
}

function readRequestJson(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

/**
 * The served entry each real input stage lives on. The existing-task change
 * entry drives its own served page, so its stage is asserted against that exact
 * path instead of the new-task Dashboard path.
 */
const ENTRY_INPUT_PATHS = Object.freeze({
  homepage: '/',
  dashboard: '/dashboard.html',
  interaction: '/interaction.html',
});

/**
 * Assert the real input stage of the served entry before its single submit.
 *
 * The input-stage screenshot is only meaningful when the page is really on the
 * served entry with the directive in its form: the URL path, the visible
 * directive value, its positive layout box, the required attribute, the enabled
 * submit control and the absence of any second-confirmation control are asserted
 * first. A failed precondition throws, so the runner records the deviation
 * instead of a green input stage captured over a blank page.
 */
export async function assertEntryInputStage(binding, { entry, inputSelector, directive }) {
  const dom = await readEntryInputStage(binding, inputSelector);
  const expectedPath = ENTRY_INPUT_PATHS[entry] ?? ENTRY_INPUT_PATHS.dashboard;
  const missing = [];
  if (dom.value !== directive) {
    missing.push(`directive value=${JSON.stringify(dom.value)} does not match the submitted directive`);
  }
  if (dom.visible !== true || !dom.bbox || dom.bbox.width <= 0 || dom.bbox.height <= 0) {
    missing.push(`directive control is not visible with a positive layout box: ${JSON.stringify(dom.bbox)}`);
  }
  if (dom.required !== true) missing.push('directive control is not a required input');
  if (dom.submitEnabled !== true) missing.push('the single submit control is missing or disabled');
  if (dom.secondConfirmationControls !== 0) {
    missing.push(`${dom.secondConfirmationControls} second-confirmation control(s) are rendered on the served entry`);
  }
  if (dom.pathname !== expectedPath) {
    missing.push(`entry URL path=${JSON.stringify(dom.pathname)} (expected ${expectedPath})`);
  }
  if (missing.length) {
    throw new Error(`input-stage preconditions failed before the submit click: ${missing.join('; ')}`);
  }
  return dom;
}

/**
 * Read the served existing-task change panel: the intake values, the reviewable
 * revision the runtime returned, the confirmation gate state and the typed error
 * the page rendered. Every value comes from the real DOM the human sees; none is
 * derived from an API response the page did not render.
 */
export async function readExistingChangeDom(binding) {
  const { page } = binding.browser;
  return page.evaluate(() => {
    const text = (node) => node?.textContent?.trim() ?? null;
    const controlValue = (rootSelector, name) =>
      document.querySelector(`${rootSelector} [name="${name}"]`)?.value ?? null;
    const error = document.querySelector('[data-existing-change-error]');
    const proposal = document.querySelector('[data-existing-change-proposal]');
    const save = document.querySelector('[data-action="save-existing-change"]');
    const confirm = document.querySelector('[data-action="confirm-existing-change"]');
    return {
      url: location.href,
      pathname: location.pathname,
      panelPresent: document.querySelector('[data-existing-change]') !== null,
      state: text(document.querySelector('[data-existing-change-state]')),
      taskRef: controlValue('[data-existing-change-intake]', 'taskRef'),
      changeInput: controlValue('[data-existing-change-intake]', 'changeInput'),
      proposalHidden: proposal ? proposal.hidden : null,
      taskLabel: text(document.querySelector('[data-existing-change-task]')),
      revisionLabel: text(document.querySelector('[data-existing-change-revision]')),
      fields: {
        goal: controlValue('[data-existing-change-edit]', 'goal'),
        scope: controlValue('[data-existing-change-edit]', 'scope'),
        proposal: controlValue('[data-existing-change-edit]', 'proposal'),
      },
      saveDisabled: save ? save.disabled : null,
      confirmDisabled: confirm ? confirm.disabled : null,
      confirmationText: text(document.querySelector('[data-existing-change-confirmation]')),
      feedback: text(document.querySelector('[data-existing-change-feedback]')),
      errorHidden: error ? error.hidden : null,
      errorCode: text(error?.querySelector('strong')),
      errorText: text(error?.querySelector('p')),
    };
  });
}

/**
 * Drive the real task input on the selected entry and return the dispatched task.
 *
 * Dashboard entry: 输入 -> 显式草稿 -> 用户点击确认 (the preview flow). Clarifying
 * questions are answered in-page, up to a bounded number of attempts.
 *
 * Homepage entry: a single submit authorizes the new task; the explicit brain
 * organizes and FIFO-enqueues the requirement in the same handling, so there is
 * no second visible confirmation.
 */
export async function submitDirectiveAndConfirmDraft(binding, directive, options = {}) {
  const { page } = binding.browser;
  const base = binding.serveBaseUrl;
  const maxClarifications = options.maxClarifications ?? 3;
  const clarificationAnswer = options.clarificationAnswer ?? 'Do not clarify. Proceed directly with the tools available in the workspace and finish.';

  await openEntryPage(binding);
  if ((binding.entry ?? 'dashboard') === 'homepage') {
    await page.fill('#entry-form textarea[name="rawInput"]', directive);
    // The single authorization action is the click below. The caller gets the
    // filled-but-unsubmitted stage here, so an input-stage screenshot proves the
    // real directive, URL and control before the submit.
    await options.onDirectiveFilled?.({
      entry: 'homepage',
      url: page.url(),
      inputSelector: '#entry-form textarea[name="rawInput"]',
      directive,
    });
    binding.formalEntryStarted = true;
    // Register the wait before the click so a fast submission cannot race past
    // the observation. The selected identity comes only from this navigation.
    const navigationPromise = waitForTaskScopedNavigation(
      binding,
      Number(options.confirmTimeoutMs ?? 90_000),
    );
    try {
      await page.click('#entry-form button[type="submit"]');
    } catch (error) {
      await navigationPromise.catch(() => {});
      throw error;
    }
    const navigation = await navigationPromise;
    binding.taskId = navigation.taskId;
    binding.submissionNavigation = navigation;
    // The homepage renders its read-only organization feedback on the same page;
    // capture the intent it reports without requiring a second confirmation.
    binding.draft = { intent: 'create', proposal: '', metaRows: [], entry: 'homepage', submittedOnce: true };
    binding.confirmStatus = 'single-submit';
    binding.draftRowsBeforeConfirm = 0;
    return binding;
  }

  const tasksBeforeSubmit = await jsonRequest(`${base}/api/tasks`, {}, binding.auth);
  const taskIdsBeforeSubmit = new Set(taskGroups(tasksBeforeSubmit)
    .map((task) => task?.taskId?.value)
    .filter((taskId) => typeof taskId === 'string' && taskId.length > 0));
  await page.fill('.quick-create-form textarea[name="directive"]', directive);
  // The one user authorization action is the click below. The caller gets the
  // filled-but-unsubmitted stage here, so the input-stage screenshot proves the
  // visible directive, the served URL and the single submit control before it is
  // used. It must never be taken before this page has loaded.
  await options.onDirectiveFilled?.({
    entry: 'dashboard',
    url: page.url(),
    inputSelector: '.quick-create-form textarea[name="directive"]',
    directive,
  });
  binding.formalEntryStarted = true;
  const confirmationResponsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/explicit/interactions/')
    && response.url().endsWith('/confirmation')
    && response.request().method() === 'POST',
  { timeout: Number(options.confirmTimeoutMs ?? 90_000) }).catch((error) => ({ waitError: error }));

  const clarificationLog = [];
  let confirmationResponse;
  for (let attempt = 0; attempt <= maxClarifications; attempt += 1) {
    if (attempt === 0) {
      // This is the one user authorization action for a new Dashboard task.
      await page.click('#dashboard-create-submit');
    } else {
      await page.fill('#dashboard-create-clarification input[name="answer"]', clarificationAnswer);
      await page.click('#dashboard-create-clarification button[type="submit"]');
    }
    let outcome;
    try {
      outcome = await waitForDom(page, 'single-submit acceptance or clarification', async () => {
        const clarification = await page.$('#dashboard-create-clarification');
        if (clarification) return { kind: 'clarification' };
        const progressText = (await page.textContent('.quick-create-progress .progress-phase'))?.trim() ?? '';
        if (progressText.includes('已入队')) return { kind: 'accepted', progressText };
        if (progressText === '已处理') {
          return {
            kind: 'status-only',
            progressText,
            reply: (await page.textContent('.quick-create-progress .progress-detail'))?.trim() ?? '',
          };
        }
        const errorText = (await page.textContent('#dashboard-create-error'))?.trim() ?? '';
        if (errorText) return { kind: 'error', errorText };
        return null;
      }, Number(options.draftTimeoutMs ?? 180_000));
    } catch (error) {
      const stage = await describeDraftStage(binding).catch(() => null);
      binding.entryDiagnostics = stage;
      throw new Error(`${error.message}; dashboard-submit runtime state=${JSON.stringify(stage).slice(0, 2400)}`);
    }
    if (outcome.kind === 'accepted') {
      confirmationResponse = await confirmationResponsePromise;
      if (confirmationResponse?.waitError) {
        throw new Error(`Dashboard showed queue acceptance without its confirmation response: ${confirmationResponse.waitError.message}`);
      }
      if (confirmationResponse.status() < 200 || confirmationResponse.status() >= 300) {
        throw new Error(`Dashboard confirmation POST returned non-2xx status=${confirmationResponse.status()}`);
      }
      // The exact authorization request is part of the evidence: its draftId and
      // inputRevision must agree with the requirement identity the runtime
      // returns, so a receipt can show which revision the human authorized.
      const confirmationRequest = confirmationResponse.request?.() ?? null;
      binding.confirmationRequest = confirmationRequest ? readRequestJson(confirmationRequest) : null;
      binding.confirmationRequestUrl = confirmationResponse.url?.() ?? null;
      binding.confirmationResponseStatus = confirmationResponse.status();
      break;
    }
    if (outcome.kind === 'error') {
      throw new Error(`Dashboard new-task submission was refused or failed visibly: ${outcome.errorText}`);
    }
    if (outcome.kind === 'status-only') {
      binding.submissionDisposition = { kind: 'status-only', reply: outcome.reply };
      binding.entryDiagnostics = await describeDraftStage(binding).catch((error) => ({ diagnosticError: error.message }));
      throw new Error(`Dashboard explicit brain classified new-task input as status-only; no requirement was authorized: ${outcome.reply}`);
    }
    clarificationLog.push({ attempt: attempt + 1, kind: 'clarification' });
    if (!clarificationAnswer || attempt >= maxClarifications) {
      throw new Error(`Dashboard requested clarification before accepting the task: ${JSON.stringify(clarificationLog)}`);
    }
  }
  if (!confirmationResponse) {
    throw new Error(`Dashboard did not accept one new-task submission: ${JSON.stringify(clarificationLog).slice(0, 500)}`);
  }

  const confirmationBody = await confirmationResponse.text().then((text) => JSON.parse(text));
  const requirement = confirmationBody?.requirement;
  if (!requirement?.requirementId || !requirement?.draftId || !Number.isInteger(requirement?.inputRevision)) {
    throw new Error(`Dashboard confirmation receipt did not identify one submitted requirement: ${JSON.stringify(confirmationBody).slice(0, 1000)}`);
  }
  binding.requirementReceipt = requirement;
  binding.explicitInteractionId = decodeURIComponent(new URL(confirmationResponse.url()).pathname.split('/').at(-2));

  const taskId = await waitForDom(page, 'unique task created by submitted requirement', async () => {
    const tasks = await jsonRequest(`${base}/api/tasks`, {}, binding.auth);
    const created = taskGroups(tasks).filter((task) => {
      const id = task?.taskId?.value;
      return typeof id === 'string' && !taskIdsBeforeSubmit.has(id);
    });
    if (created.length > 1) {
      throw new Error(`one Dashboard submission created ${created.length} new tasks: ${created.map((task) => task.taskId.value).join(', ')}`);
    }
    return created.length === 1 ? created[0].taskId.value : null;
  }, Number(options.confirmTimeoutMs ?? 90_000));
  const taskProbe = await jsonRequest(`${base}/api/tasks/${encodeURIComponent(taskId)}/dashboard`, {}, binding.auth);
  if (!sameId(taskProbe.taskId, taskId)) {
    throw new Error(`new-task Dashboard API identity mismatch: expected ${taskId}, received ${JSON.stringify(taskProbe.taskId ?? null)}`);
  }

  binding.taskId = taskId;
  binding.draft = { intent: 'create', proposal: '', metaRows: [], entry: 'dashboard', submittedOnce: true };
  binding.draftRowsBeforeConfirm = (tasksBeforeSubmit.draft ?? []).length;
  binding.confirmStatus = confirmationResponse.status();
  return binding;
}

function taskGroups(tasks) {
  return ['running', 'waiting', 'draft', 'completed', 'failed']
    .flatMap((group) => Array.isArray(tasks?.[group]) ? tasks[group] : []);
}

/** Open the per-task dashboard and wait for the task to be nonterminal-running. */
export async function openTaskDashboard(binding, options = {}) {
  const { page } = binding.browser;
  const dashboardUrl = `${binding.serveBaseUrl}/task-dashboard.html?task=${encodeURIComponent(taskIdValue(binding.taskId))}`;
  if (page.url() !== dashboardUrl) {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  }
  if (options.waitNonterminal !== false) {
    await waitForDom(page, 'nonterminal task dashboard', async () => {
      const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/dashboard`, {}, binding.auth);
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
    const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/dashboard`, {}, binding.auth);
    if (['succeeded', 'failed', 'stopped'].includes(probe.state)) return probe.state;
    return null;
  }, Number(options.timeoutMs ?? TERMINAL_TIMEOUT_MS));
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/dashboard`, {}, binding.auth);
  binding.terminalState = state;
  binding.dashboardProbe = probe;
  return probe;
}

/** Read the newest execution terminal record from the authoritative journal. */
export async function readDashboardProbe(binding) {
  return jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/dashboard`, {}, binding.auth);
}

export async function captureDashboardEvidence(binding) {
  const dashboardProbe = await readDashboardProbe(binding).catch((error) => ({ error: error.message }));
  const observation = await jsonRequest(
    `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/observation`,
    {},
    binding.auth,
  ).catch((error) => ({ error: error.message }));
  const rootScopeRef = observation?.scope?.scopeRef ?? `task://${taskIdValue(binding.taskId)}/observation`;
  // `pipeline.execute` is a registry node on the root scope; the child scope only
  // holds provider sub-event nodes, so select it without the child scope ref.
  const executeNode = await jsonRequest(
    `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/observation?node=pipeline.execute`,
    {},
    binding.auth,
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
    const dashboardUrl = `${binding.serveBaseUrl}/task-dashboard.html?task=${encodeURIComponent(taskIdValue(binding.taskId))}`;
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
      stateChip: text(document.querySelector('.page-heading .state-chip')),
      statusLayers: cells(document.querySelector('.status-layers')),
      facts: cells([...document.querySelectorAll('.detail-grid')].find((grid) => !grid.classList.contains('status-layers'))),
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
 * Read the rendered pipeline observation page: the real node cards and the
 * page-level projected state chip.
 */
export async function readObservationDom(binding) {
  const { page } = binding.browser;
  await page.goto(`${binding.serveBaseUrl}/observation.html?task=${encodeURIComponent(taskIdValue(binding.taskId))}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.flow-node', { timeout: 30_000 });
  return page.evaluate(() => ({
    nodeIds: [...document.querySelectorAll('.flow-node')].map((card) => card.dataset.nodeId ?? ''),
    metaChip: document.querySelector('.observation-meta .state-chip')?.textContent?.trim() ?? null,
  }));
}

/**
 * Read the rendered runtime task list. The dispatched task must appear there as
 * a completed row that links to its own dashboard.
 */
export async function readTaskListDom(binding) {
  const { page } = binding.browser;
  await page.goto(`${binding.serveBaseUrl}/tasks.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task-groups]', { timeout: 30_000 });
  return page.evaluate(() => ({
    groupTitles: [...document.querySelectorAll('[data-task-groups] h2')].map((node) => node.textContent?.trim() ?? ''),
    links: [...document.querySelectorAll('[data-task-groups] a')].map((link) => ({
      href: link.getAttribute('href') ?? '',
      text: link.textContent?.trim() ?? '',
    })),
  }));
}

/**
 * Collect rendered trajectory rows from the newest dashboard page and, while
 * `stop` is unsatisfied, from the paged-back pages (bounded). The dashboard
 * pages its history by turn, so rows of one turn are not all on one page.
 */
export async function collectDashboardEventRows(binding, stop, maxPages = 3) {
  const { page } = binding.browser;
  const rows = [...((await readTaskDashboardDom(binding)).eventRows ?? [])];
  for (let index = 0; index < maxPages; index += 1) {
    if (stop(rows)) break;
    const older = page.locator('.history-pager button', { hasText: '更早' }).first();
    if (await older.count() === 0 || await older.isDisabled()) break;
    await older.click();
    await page.waitForTimeout(200);
    rows.push(...((await readTaskDashboardDom(binding, { navigate: false })).eventRows ?? []));
  }
  return rows;
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
  const response = await (binding.auth?.fetch ?? fetch)(url, { headers: { accept: 'text/event-stream' } }).catch((error) => ({ error: error.message }));
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
  const dashboardUrl = `${base}/task-dashboard.html?task=${encodeURIComponent(taskIdValue(binding.taskId))}`;
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
    const pageStatusNode = document.querySelector('.status-banner');
    const pageStatus = text(pageStatusNode);
    return {
      layers,
      freshness,
      stateChip,
      actionStatus,
      pageStatus,
      pageStatusRole: pageStatusNode?.getAttribute('role') ?? null,
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
    const failedReadVisible = state.pageStatusRole === 'status'
      && state.pageStatus.trim() !== ''
      && state.pageStatus !== connected.pageStatus
      && !state.pageStatus.includes('任务投影已同步');
    const projectionReadAttempted = state.dashboardReads > connected.dashboardReads;
    return disconnected && noFakeFailure && failedReadVisible && projectionReadAttempted ? state : null;
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
