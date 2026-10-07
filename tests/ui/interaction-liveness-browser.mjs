#!/usr/bin/env node
/**
 * Real-browser proof for task-6: the interaction work card must tell the truth
 * about a running execution, and it must stay readable when the execution stops
 * making progress or the live connection dies.
 *
 * What is real here:
 *   - the composed candidate: `startUiRuntime` from the built `dist/app`, under a
 *     real supervisor lease, with the real access-control service, the real HTTP
 *     server, the real SSE boundary, and the pages copied from `docs/ui` into
 *     `dist/app/ui`;
 *   - the browser: real headless Chromium, real page loads, real clicks, real
 *     EventSource connections;
 *   - the clock: wall time. The no-activity case waits out the real declared
 *     silence budget instead of shortening it.
 * What is injected, and only this:
 *   - the provider execution port, because a deterministic stall and a
 *     deterministic provider failure cannot be produced by the live provider.
 *     It is the same `FakeReplayExecutionRuntimePort` the app suite uses, and
 *     every event it reports travels the real coordinator, the real journal and
 *     the real HTTP/SSE projections.
 *   - the explicit-brain interpreter, which returns one fixed requirement so the
 *     intake is deterministic. The user actions are still real browser actions
 *     against the real routes.
 *
 * The transport-loss case is why the transport fact is page-local: this harness
 * takes the browser offline, and a server-derived transport value would be
 * unfetchable at exactly that moment. Chromium's offline emulation does not tear
 * down an already-established loopback EventSource, so the stream's own `onerror`
 * may never fire; what the page can observe is that its next read fails, and that
 * failed read is what must be rendered. The `working` case also asserts the
 * settled-stream rule, because the server closes the stream when the execution
 * terminates and that expected close must not be rendered as a transport loss.
 *
 * The `corrupt-frame` case is the one place where the stream bytes are faulted:
 * the real runtime server serializes every frame with `JSON.stringify`, so it
 * cannot produce a frame the page fails to parse. A real HTTP SSE server writes
 * one well-formed frame and then frames that are not valid JSON, and holds the
 * connection open so no `onerror` can mask the defect. Only the URL of the
 * execution-event stream is repointed; the page, its listener, its `EventSource`
 * and every dashboard read stay real. A frame the page cannot parse must be
 * surfaced as a transport fault instead of being counted as healthy progress.
 *
 * Env:
 *   LIVENESS_E2E_EVIDENCE    required: execution-owned evidence root
 *   LIVENESS_E2E_SCENARIOS   default "working,no-activity,transport-lost,corrupt-frame,failure"
 *   LIVENESS_E2E_UI_ROOT     default <repo>/dist/app/ui
 *   LIVENESS_E2E_PLAYWRIGHT  default /opt/homebrew/lib/node_modules/playwright/index.js
 *   LIVENESS_E2E_KEEP_ROOT=1 keep the disposable runtime root for inspection
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distRoot = join(repoRoot, 'dist', 'app');
const evidenceRoot = process.env.LIVENESS_E2E_EVIDENCE?.trim();
const uiRoot = resolve(process.env.LIVENESS_E2E_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const keepRoot = process.env.LIVENESS_E2E_KEEP_ROOT === '1';
const scenarios = (process.env.LIVENESS_E2E_SCENARIOS ?? 'working,no-activity,transport-lost,corrupt-frame,failure')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!evidenceRoot) {
  throw new Error('LIVENESS_E2E_EVIDENCE is required; point it at an execution-owned directory');
}

const playwrightModule = await import(
  process.env.LIVENESS_E2E_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js',
);
const playwright = playwrightModule.default ?? playwrightModule;

const { id } = await import(join(distRoot, 'contracts', 'src', 'index.js'));
const { ensureControlLayout, resolveRuntimePaths } = await import(join(distRoot, 'config', 'src', 'index.js'));
const { acquireDaemonLease } = await import(join(distRoot, 'app', 'src', 'supervisor', 'index.js'));
const { AccessControlService } = await import(join(distRoot, 'app', 'src', 'ui-runtime', 'access-control.js'));
const { FakeReplayExecutionRuntimePort, startUiRuntime } = await import(
  join(distRoot, 'app', 'src', 'ui-runtime', 'index.js')
);
const { MemoryCoordinator } = await import(join(distRoot, 'runtime', 'src', 'index.js'));
const { DeterministicMemoryBackend } = await import(join(distRoot, 'adapters', 'memory', 'src', 'index.js'));
const { DEFAULT_AGENT_IO_POLICY } = await import(join(distRoot, 'runtime', 'src', 'agent-io', 'types.js'));

// The declared silence budget is read from its single source of truth. The
// harness must never restate it as a literal, because the chip renders it.
const silenceBudgetMs = DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs;
if (!Number.isSafeInteger(silenceBudgetMs) || silenceBudgetMs <= 0) {
  throw new Error(`the declared silence budget is not a usable duration: ${String(silenceBudgetMs)}`);
}

const organId = id('organ', 'organ-liveness-e2e');
const binding = {
  bindingId: 'binding-liveness-e2e',
  providerId: 'provider-liveness-e2e',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-liveness-e2e',
  configDigest: 'sha256:liveness-e2e-config',
  capabilityDigest: 'sha256:liveness-e2e-capability',
};

const CARD_HOST = '[data-interaction-work-card-host]';
const cardText = (page) => page.$eval(CARD_HOST, (node) => (node.innerText || node.textContent || '').trim());

function requirementInterpreter() {
  return {
    async interpret(input) {
      return {
        kind: 'requirement',
        normalizedInput: input.rawInput,
        knownFacts: [],
        intent: 'create',
        proposal: `create:${input.rawInput}`,
        decisionRefs: ['decision:liveness-e2e'],
      };
    },
  };
}

/**
 * The real provider port with a deterministic gate in front of its event
 * stream. `complete` behaves like the plain replay; `stall` starts the execution
 * and then reports nothing at all; `fail` reports a real provider failure whose
 * `cause` is the underlying transport error.
 */
class GatedReplayPort extends FakeReplayExecutionRuntimePort {
  constructor(options) {
    super(options);
    this.mode = options.mode;
    this.gate = undefined;
    this.releaseGate = undefined;
    this.observeCalls = 0;
    this.startedCount = 0;
  }

  hold() {
    this.gate = new Promise((settle) => {
      this.releaseGate = settle;
    });
  }

  release() {
    this.releaseGate?.();
  }

  async start(input) {
    const receipt = await super.start(input);
    this.startedCount += 1;
    return receipt;
  }

  async *observe(input) {
    this.observeCalls += 1;
    if (this.mode === 'fail') {
      throw new Error('provider event stream failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:4444'),
      });
    }
    if (this.gate) await this.gate;
    yield* super.observe(input);
  }
}

async function startHarness({ scenario, root }) {
  const checkpointRoot = join(root, 'checkpoints');
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: `liveness-e2e-${scenario}` });
  const port = new GatedReplayPort({
    binding,
    // The working case must stay observable long enough for the card to render
    // its live state; the gated cases hold the stream themselves.
    stepDelayMs: scenario === 'working' ? 1_200 : 20,
    mode: scenario === 'failure' ? 'fail' : scenario === 'working' ? 'complete' : 'stall',
  });
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = accessControl.createPairingChallenge('liveness-e2e', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0];
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl,
    organId,
    binding,
    port,
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot,
    providerState: 'ready',
    portNumber: 0,
    schedulerIntervalMs: 200,
    lease: () => lease,
    explicitBrainInterpreter: requirementInterpreter(),
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-liveness-e2e',
      roleId: 'execution',
    },
  });
  return {
    runtime,
    port,
    root,
    cookie,
    origin: new URL(runtime.server.url).origin,
    async close() {
      await runtime.close();
      await lease.release();
    },
  };
}

/**
 * A real HTTP server that answers one SSE endpoint with a well-formed frame and
 * then frames the page cannot parse, keeping the connection open.
 *
 * A malformed frame cannot be produced by the real runtime server: it serializes
 * every frame with `JSON.stringify`. Everything else in the `corrupt-frame`
 * scenario stays real — the real page, the real `EventSource` implementation,
 * the real page listener and the real dashboard reads. Only the stream bytes are
 * faulted, which is exactly the fault under test. The connection is held open on
 * purpose: a closed stream would fire `onerror` and mask the defect behind an
 * unrelated transport loss.
 */
async function startFaultyStreamServer() {
  const sockets = new Set();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    sockets.add(response.socket);
    response.write('event: provider.output\ndata: {"kind":"provider.output"}\n\n');
    const corrupt = setInterval(() => {
      response.write('event: provider.output\ndata: {not json\n\n');
    }, 120);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 1_000);
    response.on('close', () => {
      clearInterval(corrupt);
      clearInterval(heartbeat);
    });
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get requests() {
      return requests;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((settle) => server.close(settle));
    },
  };
}

async function openPage(browser, harness, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [name, value] = harness.cookie.split('=');
  await context.addCookies([{ name, value, url: harness.origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  if (options.faultyStreamOrigin) {
    // Point ONLY the task page's execution-event stream at the faulted server.
    // Every other request, including every dashboard read, stays on the real
    // runtime origin.
    await page.addInitScript((origin) => {
      const Real = window.EventSource;
      if (!location.pathname.endsWith('/task.html')) return;
      window.EventSource = function (url, init) {
        // The page builds this URL relative to its own origin, so resolve it
        // first and only then repoint the execution-event stream.
        let target = String(url);
        try {
          const resolved = new URL(target, location.href);
          if (/^\/api\/executions\/[^/]+\/events$/.test(resolved.pathname)) {
            target = `${origin}${resolved.pathname}${resolved.search}`;
          }
        } catch {
          // A URL the page cannot resolve is left untouched.
        }
        return new Real(target, init);
      };
    }, options.faultyStreamOrigin);
  }
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  return { context, page, consoleErrors };
}

function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}; last=${JSON.stringify(last)}`);
    }
    await sleep(intervalMs);
  }
}

async function waitForCardText(page, label, pattern, timeoutMs, intervalMs = 250) {
  return await waitFor(label, async () => {
    const text = await cardText(page).catch(() => '');
    return pattern.test(text) ? text : null;
  }, timeoutMs, intervalMs);
}

/**
 * Navigate to the task page the liveness assertions observe.
 *
 * The dashboard navigates itself to its own task surface as soon as the
 * dispatched task appears in the list, so an explicit navigation issued at the
 * same moment races that page-initiated navigation. Chromium reports the loser
 * as `net::ERR_ABORTED`. Retrying after the competing navigation settles reaches
 * the intended page; it does not weaken any assertion, because a page that
 * genuinely cannot load still fails every attempt and the card assertions below
 * still have to pass.
 */
async function gotoTaskPage(page, url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 4 || !message.includes('ERR_ABORTED')) throw error;
      await sleep(300);
    }
  }
}

/** Drive the real served dashboard intake: type, submit, confirm. Nothing else. */
async function dispatchTaskThroughUi(page, harness) {
  await page.goto(`${harness.origin}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.quick-create-form textarea[name="directive"]', { timeout: 15_000 });
  await page.fill('form.quick-create-form textarea[name="directive"]', 'liveness e2e deterministic task');
  await page.click('form.quick-create-form button[type="submit"]');
  await page.waitForSelector('.draft-actions button.button--primary', { timeout: 60_000 });
  const confirmText = (await page.textContent('.draft-actions button.button--primary'))?.trim();
  if (confirmText !== '确认并执行') {
    throw new Error(`the draft confirm button did not carry the expected label: ${String(confirmText)}`);
  }
  const confirmation = page.waitForResponse(
    (response) => response.url().includes('/api/explicit/interactions/')
      && response.url().endsWith('/confirmation')
      && response.request().method() === 'POST',
  );
  await page.click('.draft-actions button.button--primary');
  const response = await confirmation;
  if (response.status() < 200 || response.status() >= 300) {
    throw new Error(`confirmation POST returned status=${response.status()}`);
  }
  const taskId = await waitFor('a dispatched task', async () => {
    const tasks = await fetchJson(`${harness.origin}/api/tasks`, harness.cookie);
    const rows = []
      .concat(tasks.running ?? [])
      .concat(tasks.waiting ?? [])
      .concat(tasks.draft ?? [])
      .concat(tasks.completed ?? [])
      .concat(tasks.failed ?? [])
      .filter((row) => row?.taskId?.value);
    if (rows.length === 0) return null;
    return rows
      .map((row) => ({ id: row.taskId.value, at: new Date(row.updatedAt ?? 0).getTime() }))
      .sort((left, right) => right.at - left.at)[0].id;
  }, 60_000);
  return { taskId, confirmText };
}

async function fetchJson(url, cookie) {
  const response = await fetch(url, { headers: { cookie } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return await response.json();
}

async function screenshot(page, directory, name) {
  const path = join(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function runScenario(browser, scenario, result) {
  const root = await mkdtemp(join(tmpdir(), `humanagent-liveness-${scenario}-`));
  const shotDir = join(evidenceRoot, 'e2e', scenario);
  await mkdir(shotDir, { recursive: true });
  result.root = root;
  result.startedAt = new Date().toISOString();
  let harness;
  let opened;
  let faultyStream;
  const assert = (label, observed, pattern) => {
    const text = typeof observed === 'string' ? observed : JSON.stringify(observed);
    const pass = pattern instanceof RegExp ? pattern.test(text) : observed === pattern;
    result.assertions.push({ label, pass, expected: String(pattern), observed: text.slice(0, 2000) });
    if (!pass) throw new Error(`assertion failed: ${label}; expected=${String(pattern)}; observed=${text.slice(0, 2000)}`);
  };
  try {
    harness = await startHarness({ scenario, root });
    if (scenario === 'corrupt-frame') faultyStream = await startFaultyStreamServer();
    opened = await openPage(browser, harness, { faultyStreamOrigin: faultyStream?.origin });
    const { page } = opened;
    // The gate must be closed before the execution starts, otherwise the replay
    // can finish before the card is ever observed.
    if (scenario !== 'working') harness.port.hold();
    const dispatched = await dispatchTaskThroughUi(page, harness);
    result.taskId = dispatched.taskId;
    result.confirmLabel = dispatched.confirmText;

    await gotoTaskPage(page, `${harness.origin}/task.html?task=${encodeURIComponent(dispatched.taskId)}`);
    result.taskUrl = page.url();
    await page.waitForSelector(CARD_HOST, { timeout: 15_000 });

    if (scenario === 'working') {
      // The transport projection attaches on its own stream frame, so the card
      // can report the task as working one render before it names the live
      // connection. Waiting only for `工作中` and then asserting `传输 已连接` on
      // that same render raced the attach (1 failure in 3 observed runs). Wait
      // for both facts in the same render; a card that never attaches still
      // fails on the bounded timeout, so the assertion keeps its force.
      const working = await waitForCardText(
        page,
        'the card to report working with the live connection attached',
        /^(?=[\s\S]*工作中)(?=[\s\S]*传输 已连接)/,
        60_000,
      );
      assert('the running card reports the live connection', working, /传输 已连接/);
      result.screenshots.push(await screenshot(page, shotDir, '01-working'));
      const settled = await waitForCardText(page, 'the card to reach a terminal state', /已完成|已失败/, 90_000);
      // The server closes the SSE stream when the execution settles, so a naive
      // renderer turns that expected close into a false transport alarm. The
      // settled case is asserted here, so that false alarm cannot pass unnoticed.
      const settledTransport = await waitForCardText(
        page,
        'the settled card to name the stream as closed by the terminal state',
        /传输 已收拢/,
        30_000,
      );
      assert('the settled card names the stream as closed by the terminal state', settledTransport, /传输 已收拢/);
      assert('the settled card does not report a transport loss', settledTransport, /^(?!.*实时连接已断开)/s);
      result.screenshots.push(await screenshot(page, shotDir, '02-terminal'));
      result.observations = { working: working.slice(0, 1200), settled: settled.slice(0, 1200), settledTransport: settledTransport.slice(0, 1200) };
      return result;
    }

    if (scenario === 'no-activity') {
      const working = await waitForCardText(page, 'the card to report working', /工作中/, 60_000);
      result.screenshots.push(await screenshot(page, shotDir, '01-working'));
      const startedWaiting = Date.now();
      const stalled = await waitForCardText(
        page,
        'the card to report no real activity past the declared budget',
        /无活动/,
        silenceBudgetMs + 30_000,
      );
      result.silentWaitMs = Date.now() - startedWaiting;
      assert('the card reports no activity', stalled, /无活动/);
      assert('the card names the real observed silence in seconds', stalled, /(3[0-9]|4[0-9]|5[0-9]) 秒|(3[0-9]|4[0-9]|5[0-9])秒/);
      assert('the card names the declared silence budget', stalled, new RegExp(String(silenceBudgetMs)));
      assert('the card does not claim the task is still working', stalled, /^(?!.*工作中)/s);
      result.screenshots.push(await screenshot(page, shotDir, '02-no-activity'));
      harness.port.release();
      // The resumed replay is deliberately fast, so the working state it produces
      // is brief. Poll far more often than the default so the recovery is
      // observed rather than skipped between two samples; this changes how often
      // the page is read, not what the replay does.
      const recovered = await waitForCardText(page, 'the card to return to working after real activity resumes', /工作中/, 60_000, 25);
      assert('real activity resumes and the card says so', recovered, /工作中/);
      result.screenshots.push(await screenshot(page, shotDir, '03-recovered'));
      result.observations = { working: working.slice(0, 1200), stalled: stalled.slice(0, 1200), recovered: recovered.slice(0, 1200) };
      return result;
    }

    if (scenario === 'transport-lost') {
      // Same attach race as the working scenario above: wait for the working
      // verdict and the attached transport in one render before asserting it.
      const working = await waitForCardText(
        page,
        'the card to report working with the live connection attached',
        /^(?=[\s\S]*工作中)(?=[\s\S]*传输 已连接)/,
        60_000,
      );
      assert('the live connection is reported as attached', working, /传输 已连接/);
      result.screenshots.push(await screenshot(page, shotDir, '01-attached'));
      await opened.context.setOffline(true);
      const lost = await waitForCardText(page, 'the card to report the real transport loss', /实时连接已断开/, 30_000);
      assert('the card reports the real transport loss', lost, /实时连接已断开/);
      assert('the transport loss does not fabricate a liveness verdict', lost, /无活动|工作中/);
      result.screenshots.push(await screenshot(page, shotDir, '02-transport-lost'));
      await opened.context.setOffline(false);
      const restored = await waitForCardText(page, 'the card to report the reconnected stream', /传输 已连接/, 60_000);
      assert('the stream really reconnects', restored, /传输 已连接/);
      result.screenshots.push(await screenshot(page, shotDir, '03-reconnected'));
      harness.port.release();
      result.observations = { working: working.slice(0, 1200), lost: lost.slice(0, 1200), restored: restored.slice(0, 1200) };
      return result;
    }

    if (scenario === 'corrupt-frame') {
      // The stream carries a well-formed frame and then frames the page cannot
      // parse, and it stays open. A frame the page cannot parse is not an event:
      // counting it as a heartbeat reads a corrupt stream as healthy progress.
      // The loss window is short because the page legitimately reconnects after
      // a loss, so the card is sampled at a tight interval and the assertion is
      // that the fault is surfaced at all.
      const attached = await waitForCardText(page, 'the card to report the attached stream', /传输 已连接/, 60_000, 50);
      assert('the live connection is reported as attached', attached, /传输 已连接/);
      result.screenshots.push(await screenshot(page, shotDir, '01-attached'));
      // Recorded before the next assertion so a failure still carries the proof
      // that the faulted stream really was the stream the page attached to.
      result.observations = {
        attached: attached.slice(0, 1200),
        faultyStreamRequests: faultyStream?.requests ?? 0,
      };
      const corrupted = await waitForCardText(
        page,
        'the card to surface the frame it cannot parse',
        /实时连接已断开/,
        30_000,
        25,
      );
      assert('an unparseable frame is surfaced as a transport fault', corrupted, /实时连接已断开/);
      result.screenshots.push(await screenshot(page, shotDir, '02-corrupt-frame'));
      result.observations = {
        attached: attached.slice(0, 1200),
        corrupted: corrupted.slice(0, 1200),
        faultyStreamRequests: faultyStream?.requests ?? 0,
      };
      return result;
    }

    if (scenario === 'failure') {
      const failed = await waitForCardText(page, 'the card to report the failure', /已失败/, 90_000);
      assert('the card reports the failure', failed, /已失败/);
      assert('the failure keeps a readable message', failed, /provider event stream failed|provider/i);
      assert('the failure is not an endless spinner', failed, /^(?!.*工作中)/s);
      assert('the failure offers a next action', failed, /下一步/);
      result.screenshots.push(await screenshot(page, shotDir, '01-failed'));
      result.observations = { failed: failed.slice(0, 2000) };
      return result;
    }

    throw new Error(`unknown scenario: ${scenario}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    result.consoleErrors = opened?.consoleErrors ?? [];
    await opened?.context.close().catch(() => {});
    await harness?.close().catch((error) => {
      result.closeError = error instanceof Error ? error.message : String(error);
    });
    await faultyStream?.close().catch(() => {});
    if (!keepRoot) await rm(root, { recursive: true, force: true }).catch(() => {});
    result.rootRetained = keepRoot ? root : null;
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const receipt = {
  harness: 'tests/ui/interaction-liveness-browser.mjs',
  candidate: {
    sha: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
  },
  silenceBudgetMs,
  uiRoot,
  scenarios: [],
};

let failed = 0;
// `playwright.chromium` is a BrowserType; `newContext` lives on a launched
// Browser, so launch once per scenario and close it in the same scope.
for (const scenario of scenarios) {
  process.stdout.write(`▶ ${scenario}\n`);
  const result = { scenario, assertions: [], screenshots: [] };
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    await runScenario(browser, scenario, result);
    result.status = 'PASS';
    receipt.scenarios.push(result);
    process.stdout.write(`  PASS ${result.assertions.length} assertions\n`);
  } catch (error) {
    failed += 1;
    result.status = 'FAIL';
    result.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    receipt.scenarios.push(result);
    process.stdout.write(`  FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

await mkdir(join(evidenceRoot, 'e2e'), { recursive: true });
const receiptPath = join(evidenceRoot, 'e2e', 'liveness-browser-receipt.json');
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`receipt: ${receiptPath}\n`);
process.exit(failed === 0 ? 0 : 1);
