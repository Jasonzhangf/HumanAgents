#!/usr/bin/env node
/**
 * Real no-progress black box for the silence-based stream budget.
 *
 * Case A proves a slow but advancing stream still succeeds: a local upstream
 * drips one function_call_arguments delta every few seconds for one content unit
 * and completes it after more than the old 120 s unit window. Every frame adds
 * new bytes, so the stream is making forward progress and the task must reach
 * `succeeded` with the exact delivery text.
 *
 * Case B proves real silence fails in bounded time: an upstream accepts the
 * request, sends a couple of frames, and then stops writing bytes while holding
 * the socket open. The task must reach a typed `stream.no-progress` terminal
 * and its journal/evidence files must stop growing afterwards.
 *
 * Case C proves the default budget does not disturb the real upstream: a short
 * task against the real RCC endpoint must still succeed with the right output.
 *
 * Everything except the upstream is the real runtime: the CLI serve entry, the
 * UI Runtime HTTP API, the task create and grant control paths, the execution
 * entry, the Provider adapter and the transport. Nothing touches the shared
 * production instance on 10086: control root, workspace, journals and port
 * belong to this run.
 *
 * Usage: node tests/app/request-budget-blackbox.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve('dist/app/app/src/cli.js');
const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
// Slow but advancing at the production rate: one delta every 2.4 seconds. The
// turn payload splits into one frame per two characters, so 160 target frames
// yield about 150 real frames and the single provider request spans more than
// five minutes of provider time. The old
// agent-io default turn ceiling was 120 s, so this case dies on that budget and
// must pass on the production-calibrated one.
const SLOW_FRAME_COUNT = Number(process.env.REQUEST_BUDGET_SLOW_FRAMES ?? '160');
const SLOW_FRAME_MS = Number(process.env.REQUEST_BUDGET_SLOW_MS ?? '2400');
// The turn payload is short, so an N-chunk split yields fewer real frames than
// N. Do not assert on an exact frame count: assert on the elapsed request span
// and on the fact that every delta arrived and the turn succeeded.
const SLOW_MIN_DELTAS = 40;
const SLOW_MIN_SPAN_MS = 300_000;
const SLOW_TIMEOUT_MS = 600_000;
const SILENCE_TIMEOUT_MS = 300_000;
const NORMAL_TIMEOUT_MS = 180_000;
const SETTLE_OBSERVATION_MS = 15_000;

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
const phase = (message) => process.stderr.write(`[request-budget] ${message}\n`);

function startServe(root, baseUrl) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'rcc-entry',
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', 'default',
    '--rcc-base-url', baseUrl,
    '--workspace', join(root, 'workspace'),
    '--control-root', join(root, 'control'),
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr}`)), 60_000);
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
    stderr: () => stderr,
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
  if (!response.ok) throw new Error(`request failed ${response.status} ${url}: ${text.slice(0, 600)}`);
  return body;
}

async function waitForTerminal(url, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dashboard = await jsonRequest(`${url}/api/tasks/${taskId}/dashboard`);
    if (!['created', 'admitted', 'running', 'waiting', 'settling'].includes(dashboard.state)) return dashboard;
    if (Date.now() > deadline) return dashboard;
    await sleep(250);
  }
}

async function startTask(url, title, prompt) {
  const task = await jsonRequest(`${url}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, directive: prompt }),
  });
  const taskId = task.taskId.value;
  const grantRead = await jsonRequest(`${url}/api/tasks/${taskId}/control/grant`, {});
  const currentRevision = grantRead.readback?.grant?.revision ?? 0;
  const grant = await jsonRequest(`${url}/api/tasks/${taskId}/control/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `blackbox-grant-${taskId}`, expectedRevision: currentRevision }),
  });
  const startedAtMs = Date.now();
  const started = await jsonRequest(`${url}/api/tasks/${taskId}/executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'rcc', prompt }),
  });
  return {
    taskId,
    operationId: started.operationId,
    startedAtMs,
    grantState: grant.readback?.grant?.state ?? null,
  };
}


/**
 * Reads the Planner payload out of a Planner request, if this is one. The
 * runtime sends the Planner its own JSON as a user content part.
 */
function plannerRequest(body) {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    return undefined;
  }
  return wire.input
    ?.filter((item) => item.role === 'user')
    .flatMap((item) => item.content ?? [])
    .map((part) => {
      try {
        return JSON.parse(part.text ?? '');
      } catch {
        return undefined;
      }
    })
    .find((value) => value?.role === 'planner');
}

/** The structured publication the runtime accepts from the Planner. */
function plannerPublication() {
  return {
    decision: 'complete',
    reasonText: 'the committed turn end confirms the literal reply was delivered',
    snapshot: {
      title: 'stream stall noise verification',
      summary: 'One turn replies with exactly OK; no tools were required.',
      completeness: { scope: 'whole-task', status: 'complete' },
      acceptanceCriteria: [{ criterionId: 'ac-1', description: 'The reply is exactly the literal token OK.' }],
      nodes: [
        {
          nodeId: 'n1',
          kind: 'verification',
          title: 'Confirm required reply',
          intent: 'Establish the required reply.',
          definition: { expectedReply: 'OK' },
        },
        {
          nodeId: 'n2',
          kind: 'delivery',
          title: 'Output literal OK',
          intent: 'Return OK as the whole response.',
          definition: { reply: 'OK', wholeResponse: true },
        },
      ],
      phases: [{ phaseId: 'p1', title: 'Terminal verification', memberNodeIds: ['n1', 'n2'] }],
      relations: [],
    },
  };
}

/** The accepted standard-turn end call, split into its real delivery payload. */
function turnEndArguments(deliveryText) {
  return JSON.stringify({
    summary: {
      goal: { text: 'Reply with exactly: OK', evidenceRefs: [] },
      actions: { text: 'No tools were required.', evidenceRefs: [] },
      result: { text: `Delivered exactly "${deliveryText}".`, evidenceRefs: [] },
      expectedNextStep: { text: 'No further work.', evidenceRefs: [] },
    },
    deliveryText,
    deliveryRefs: [],
  });
}

function splitIntoChunks(value, count) {
  const size = Math.max(1, Math.ceil(value.length / count));
  const chunks = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

function eventFrames(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/**
 * A local upstream that dribbles one content unit slowly and then completes it.
 * Every frame carries new bytes of the same JSON payload, exactly like the real
 * RCC stream that production mis-killed.
 */
async function startSlowAdvancingUpstream(deliveryText) {
  const state = { requests: 0, deltas: 0, executionCalls: 0, drainCalls: 0, plannerCalls: 0, firstDeltaAtMs: null, completedAtMs: null };
  const argumentJson = turnEndArguments(deliveryText);
  const chunks = splitIntoChunks(argumentJson, SLOW_FRAME_COUNT);
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    if (request.method === 'GET' && request.url.startsWith('/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: 'stub-0.0.0' }));
      return;
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    state.requests += 1;
    // The runtime re-sends the tool history after the end call to drain the
    // provider execution. Those rounds carry a function_call_output and answer
    // immediately; only the real execution round streams the slow payload.
    if (plannerRequest(raw) !== undefined || state.executionCalls > 0) {
      // The runtime asks an independent Planner to publish the task structure
      // after the turn closes. The first non-drain round is the execution under
      // test; every later non-drain round is that Planner. Answer it at once
      // with a real publication: it is not the stream under test, and a slow
      // or non-structural answer would blur the receipt.
      state.plannerCalls += 1;
      const plannerId = `stub-slow-planner-${state.plannerCalls}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(eventFrames([
        { type: 'response.created', response: { id: plannerId } },
        { type: 'response.output_text.done', item_id: 'item-slow-planner', text: JSON.stringify(plannerPublication()) },
        { type: 'response.completed', response: { id: plannerId } },
      ]));
      return;
    }
    if (raw.includes('function_call_output')) {
      state.drainCalls += 1;
      const drainId = `stub-slow-drain-${state.drainCalls}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(eventFrames([
        { type: 'response.created', response: { id: drainId } },
        { type: 'response.output_text.done', item_id: 'item-slow-drain', text: 'drained' },
        { type: 'response.completed', response: { id: drainId } },
      ]));
      return;
    }
    state.executionCalls += 1;
    const id = `stub-slow-${state.executionCalls}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(eventFrames([{ type: 'response.created', response: { id } }]));
    let index = 0;
    const drip = setInterval(() => {
      if (response.writableEnded || response.destroyed) {
        clearInterval(drip);
        return;
      }
      if (index >= chunks.length) {
        clearInterval(drip);
        // Complete the unit, then the item, then the response: a normal turn.
        response.write(eventFrames([
          { type: 'response.function_call_arguments.done', item_id: 'item-slow', arguments: argumentJson },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              call_id: 'call-slow',
              name: 'humanagent_turn_end',
              arguments: argumentJson,
            },
          },
          { type: 'response.completed', response: { id } },
        ]));
        state.completedAtMs = Date.now();
        response.end();
        return;
      }
      if (state.firstDeltaAtMs === null) state.firstDeltaAtMs = Date.now();
      state.deltas += 1;
      response.write(eventFrames([{
        type: 'response.function_call_arguments.delta',
        item_id: 'item-slow',
        delta: chunks[index],
      }]));
      index += 1;
    }, SLOW_FRAME_MS);
    response.on('close', () => clearInterval(drip));
  });
  const url = await new Promise((settle, fail) => {
    upstream.once('error', fail);
    upstream.listen(0, '127.0.0.1', () => settle(`http://127.0.0.1:${upstream.address().port}`));
  });
  return { url, state, close: () => new Promise((done) => upstream.close(done)) };
}

/** A local upstream that stops writing bytes while holding the socket open. */
async function startSilentUpstream() {
  const state = { requests: 0, sentFrames: 0, closedAtMs: null };
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    if (request.method === 'GET' && request.url.startsWith('/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: 'stub-0.0.0' }));
      return;
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    state.requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(eventFrames([
      { type: 'response.created', response: { id: `stub-silent-${state.requests}` } },
      { type: 'response.function_call_arguments.delta', item_id: 'item-silent', delta: '{"delivery' },
    ]));
    state.sentFrames = 2;
    // Never write again, and never end the response: the socket stays open with
    // no further bytes, the exact shape that used to hang a turn forever.
    response.on('close', () => { state.closedAtMs = Date.now(); });
  });
  const url = await new Promise((settle, fail) => {
    upstream.once('error', fail);
    upstream.listen(0, '127.0.0.1', () => settle(`http://127.0.0.1:${upstream.address().port}`));
  });
  return { url, state, close: () => new Promise((done) => upstream.close(done)) };
}

/** Snapshot of every regular file under the run's own control root. */
async function snapshotFiles(root) {
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(path));
        continue;
      }
      const info = await stat(path).catch(() => null);
      if (info) files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    }
    return files;
  };
  const files = await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    count: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.map((file) => ({ path: file.path.slice(root.length), size: file.size })),
  };
}

async function caseA(root) {
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'control'), { recursive: true });
  const upstream = await startSlowAdvancingUpstream('OK');
  const serve = startServe(root, upstream.url);
  try {
    const launched = await serve.ready;
    const task = await startTask(launched.url, 'slow but advancing request budget', 'Reply with exactly: OK');
    const dashboard = await waitForTerminal(launched.url, task.taskId, SLOW_TIMEOUT_MS);
    const elapsedMs = Date.now() - task.startedAtMs;
    const spanMs = upstream.state.firstDeltaAtMs !== null && upstream.state.completedAtMs !== null
      ? upstream.state.completedAtMs - upstream.state.firstDeltaAtMs
      : null;
    const result = {
      taskId: task.taskId,
      operationId: task.operationId,
      state: dashboard.state,
      elapsedMs,
      unitSpanMs: spanMs,
      deltas: upstream.state.deltas,
      executionCalls: upstream.state.executionCalls,
      drainCalls: upstream.state.drainCalls,
      plannerCalls: upstream.state.plannerCalls,
      output: dashboard.output ?? null,
      error: dashboard.error ?? null,
    };
    if (dashboard.state !== 'succeeded') {
      throw new Error(`case A did not succeed on a slow but advancing request: ${JSON.stringify(result)}`);
    }
    if (typeof dashboard.output !== 'string' || !dashboard.output.includes('OK')) {
      throw new Error(`case A produced the wrong output: ${JSON.stringify(result)}`);
    }
    if (spanMs === null || spanMs < SLOW_MIN_SPAN_MS) {
      throw new Error(`case A did not keep one request open for five minutes of provider time: ${JSON.stringify(result)}`);
    }
    if (upstream.state.deltas < SLOW_MIN_DELTAS) {
      throw new Error(`case A lost deltas before completion: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await serve.stop();
    await upstream.close();
  }
}

async function caseB(root) {
  const controlRoot = join(root, 'control');
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(controlRoot, { recursive: true });
  const upstream = await startSilentUpstream();
  const serve = startServe(root, upstream.url);
  try {
    const launched = await serve.ready;
    const task = await startTask(launched.url, 'silent request budget', 'Reply with exactly: OK');
    const dashboard = await waitForTerminal(launched.url, task.taskId, SILENCE_TIMEOUT_MS);
    const elapsedMs = Date.now() - task.startedAtMs;
    // Let the closing checkpoint, settle and release receipts land, then take
    // two snapshots of the quiet period: evidence must be quiescent, not still
    // growing after the terminal.
    await sleep(SETTLE_OBSERVATION_MS);
    const afterTerminal = await snapshotFiles(controlRoot);
    await sleep(SETTLE_OBSERVATION_MS);
    const afterSettle = await snapshotFiles(controlRoot);
    const result = {
      taskId: task.taskId,
      operationId: task.operationId,
      state: dashboard.state,
      elapsedMs,
      output: dashboard.output ?? null,
      error: dashboard.error ?? null,
      upstreamClosed: upstream.state.closedAtMs !== null,
      evidenceAfterTerminal: afterTerminal,
      evidenceAfterSettle: afterSettle,
    };
    // The harness maps a mid-turn Provider failure onto `blocked` with the typed
    // error kept; `failed` is the completed-turn alignment path. Either terminal
    // is acceptable, but the turn must not stay running and must not report
    // success.
    if (dashboard.state !== 'failed' && dashboard.state !== 'blocked') {
      throw new Error(`case B did not reach a typed failure terminal: ${JSON.stringify(result)}`);
    }
    const code = dashboard.error?.code ?? '';
    const message = dashboard.error?.message ?? '';
    if (code !== 'stream.no-progress' && !String(message).includes('no forward progress')) {
      throw new Error(`case B failed without the no-progress typed error: ${JSON.stringify(result)}`);
    }
    if (elapsedMs >= SILENCE_TIMEOUT_MS) {
      throw new Error(`case B did not fail in bounded time: ${JSON.stringify(result)}`);
    }
    if (!result.upstreamClosed) {
      throw new Error(`case B never released the silent upstream stream: ${JSON.stringify(result)}`);
    }
    if (afterSettle.totalBytes !== afterTerminal.totalBytes || afterSettle.count !== afterTerminal.count) {
      throw new Error(`case B kept growing journal/evidence after the terminal: ${JSON.stringify(result)}`);
    }
    if (afterTerminal.count === 0) {
      throw new Error(`case B wrote no journal/evidence at all: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await serve.stop();
    await upstream.close();
  }
}

async function caseC(root) {
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'control'), { recursive: true });
  const serve = startServe(root, RCC_BASE_URL);
  try {
    const launched = await serve.ready;
    const task = await startTask(launched.url, 'normal short task against real RCC', 'Reply with exactly: OK');
    const dashboard = await waitForTerminal(launched.url, task.taskId, NORMAL_TIMEOUT_MS);
    const elapsedMs = Date.now() - task.startedAtMs;
    const result = {
      taskId: task.taskId,
      operationId: task.operationId,
      state: dashboard.state,
      elapsedMs,
      output: dashboard.output ?? null,
      error: dashboard.error ?? null,
    };
    if (dashboard.state !== 'succeeded') {
      throw new Error(`case C did not succeed against the real upstream: ${JSON.stringify(result)}`);
    }
    if (typeof dashboard.output !== 'string' || !dashboard.output.includes('OK')) {
      throw new Error(`case C produced the wrong output: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await serve.stop();
  }
}

async function main() {
  const only = (process.env.REQUEST_BUDGET_CASES ?? 'a,b,c').split(',').map((value) => value.trim()).filter(Boolean);
  const root = await mkdtemp(join(tmpdir(), 'humanagent-request-budget-'));
  const receipt = { instance: root, model: MODEL, rccBaseUrl: RCC_BASE_URL };
  try {
    if (only.includes('a')) {
      phase('case A: slow but advancing content unit');
      receipt.a = await caseA(join(root, 'a'));
      phase(`case A succeeded in ${String(receipt.a.elapsedMs)} ms across a ${String(receipt.a.unitSpanMs)} ms unit span`);
    }
    if (only.includes('b')) {
      phase('case B: silent stream');
      receipt.b = await caseB(join(root, 'b'));
      phase(`case B failed as designed in ${String(receipt.b.elapsedMs)} ms: ${receipt.b.error?.code ?? ''}`);
    }
    if (only.includes('c')) {
      phase('case C: normal short task against real RCC');
      receipt.c = await caseC(join(root, 'c'));
      phase(`case C succeeded in ${String(receipt.c.elapsedMs)} ms`);
    }
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
