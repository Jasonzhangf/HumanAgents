#!/usr/bin/env node
/**
 * Real stream-stall terminal black box.
 *
 * Case A proves the transport-level no-progress budget on the real entry: a
 * local upstream keeps dribbling function-call-argument deltas for one content
 * unit and never completes that item. The task must reach the typed failed
 * terminal state in bounded time instead of holding the turn open forever.
 *
 * Case B proves the budget does not misfire: a normal short task against the
 * real RCC upstream must still succeed and produce output.
 *
 * Everything except the upstream is the real runtime: the CLI serve entry, the
 * UI Runtime HTTP API, the task create and grant control paths, the execution
 * entry, the Provider adapter and the transport. Nothing touches the shared
 * production instance on 10086: control root, workspace, journals and port
 * belong to this run.
 *
 * Usage: node tests/app/stream-stall-terminal-blackbox.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve('dist/app/app/src/cli.js');
const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const STALL_DELTA_MS = 25;
const TERMINAL_TIMEOUT_MS = 120_000;
const NORMAL_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
const phase = (message) => process.stderr.write(`[stream-stall] ${message}\n`);

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

async function collectEvents(url, operationId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${url}/api/executions/${operationId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`event stream failed ${response.status} for ${operationId}`);
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');
        if (!data) continue;
        events.push(JSON.parse(data));
        const last = events.at(-1);
        if (last.kind === 'execution.terminal' && last.terminalPhase === 'final') return events;
      }
    }
    return events;
  } catch (error) {
    if (events.length > 0) return events;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** A local upstream that never completes one tool-argument content unit. */
async function startStallUpstream() {
  const state = { requests: 0, deltas: 0, closedAtMs: null, deltasAtClose: null };
  const upstream = createServer(async (request, response) => {
    for await (const _discard of request) { /* drain the request body */ }
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
    response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: `stub-stall-${state.requests}` } })}\n\n`);
    const drip = setInterval(() => {
      if (response.writableEnded || response.destroyed) return;
      state.deltas += 1;
      response.write(`data: ${JSON.stringify({
        type: 'response.function_call_arguments.delta',
        item_id: 'item-blackbox-stall',
        delta: String(state.deltas % 10),
      })}\n\n`);
    }, STALL_DELTA_MS);
    response.on('close', () => {
      clearInterval(drip);
      state.closedAtMs = Date.now();
      state.deltasAtClose = state.deltas;
    });
  });
  const url = await new Promise((settle, fail) => {
    upstream.once('error', fail);
    upstream.listen(0, '127.0.0.1', () => settle(`http://127.0.0.1:${upstream.address().port}`));
  });
  return { url, state, close: () => new Promise((done) => upstream.close(done)) };
}

async function caseA(root) {
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'control'), { recursive: true });
  const upstream = await startStallUpstream();
  const serve = startServe(root, upstream.url);
  try {
    const launched = await serve.ready;
    const task = await startTask(launched.url, 'stream stall terminal blackbox', 'summarize the workspace root');
    const dashboard = await waitForTerminal(launched.url, task.taskId, TERMINAL_TIMEOUT_MS);
    const elapsedMs = Date.now() - task.startedAtMs;
    const events = await collectEvents(launched.url, task.operationId, 60_000);
    const terminal = events.find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
    const result = {
      taskId: task.taskId,
      operationId: task.operationId,
      grantState: task.grantState,
      state: dashboard.state,
      elapsedMs,
      error: dashboard.error ?? null,
      events: events.map((event) => ({ kind: event.kind, state: event.state ?? null, summary: event.summary ?? null })),
      upstream: {
        requests: upstream.state.requests,
        deltas: upstream.state.deltas,
        deltasAtClose: upstream.state.deltasAtClose,
        closed: upstream.state.closedAtMs !== null,
      },
    };
    // The harness maps a mid-turn Provider failure onto `blocked` with the
    // typed Provider error kept as the task error and recovery responsibility
    // retained; a completed turn whose alignment decides not-complete is the
    // only path that reaches `failed`. Either terminal is acceptable here, but
    // the task must not stay running and must not fabricate success.
    if (dashboard.state !== 'failed' && dashboard.state !== 'blocked') {
      throw new Error(`case A did not reach a typed failure terminal: ${JSON.stringify(result)}`);
    }
    const code = result.error?.code ?? '';
    const message = result.error?.message ?? '';
    if (code !== 'stream.no-progress' && !String(message).includes('no forward progress')) {
      throw new Error(`case A failed without the no-progress typed error: ${JSON.stringify(result)}`);
    }
    if (upstream.state.closedAtMs === null) {
      throw new Error(`case A never released the stalled upstream stream: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await serve.stop();
    await upstream.close();
  }
}

async function caseB(root) {
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
      grantState: task.grantState,
      state: dashboard.state,
      elapsedMs,
      output: dashboard.output ?? null,
      error: dashboard.error ?? null,
    };
    if (dashboard.state !== 'succeeded') {
      throw new Error(`case B did not succeed: ${JSON.stringify(result)}`);
    }
    if (typeof dashboard.output !== 'string' || dashboard.output.trim().length === 0) {
      throw new Error(`case B produced no output: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await serve.stop();
  }
}

async function main() {
  const only = (process.env.STREAM_STALL_BLACKBOX_CASES ?? 'a,b').split(',').map((value) => value.trim()).filter(Boolean);
  const root = await mkdtemp(join(tmpdir(), 'humanagent-stream-stall-'));
  const receipt = { instance: root, model: MODEL, rccBaseUrl: RCC_BASE_URL };
  try {
    if (only.includes('a')) {
      phase('case A: stalled content-unit delta stream');
      receipt.a = await caseA(join(root, 'a'));
      phase(`case A failed as designed in ${String(receipt.a.elapsedMs)} ms: ${receipt.a.error?.code ?? ''}`);
    }
    if (only.includes('b')) {
      phase('case B: normal short task against real RCC');
      receipt.b = await caseB(join(root, 'b'));
      phase(`case B succeeded in ${String(receipt.b.elapsedMs)} ms`);
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
