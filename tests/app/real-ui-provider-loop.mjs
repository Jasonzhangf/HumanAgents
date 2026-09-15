#!/usr/bin/env node
/**
 * Real RCC UI provider loop proof.
 *
 * Drives the built HumanAgent CLI `serve --mode rcc` entry over its own HTTP
 * Runtime API and records the MUI-2 acceptance facts for both RCC entry
 * protocols (`responses` and `openai`):
 *
 *   probe    - GET /api/runtime/status reports the real RCC readiness state
 *   execute  - POST executions -> SSE model/output -> terminal -> checkpoint
 *   stop     - POST stop -> SSE settling -> stopped checkpoint -> terminal
 *   settle   - provider settlement is required before the stopped checkpoint
 *   close    - the provider close result is reported on the terminal event
 *
 * The receipt binds the candidate commit/tree, the RCC endpoint identity, the
 * per-run task/operation ids, and the on-disk checkpoint artifacts.
 *
 * Required env:
 *   none (the live RCC endpoint must answer on 127.0.0.1:4444)
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL   default http://127.0.0.1:4444
 *   HUMANAGENT_UI_MODEL       default gpt-5.5
 *   HUMANAGENT_UI_RECEIPT_PATH default ./dist/receipts/ui-provider-loop-proof.json
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_UI_RECEIPT_PATH ?? 'dist/receipts/ui-provider-loop-proof.json',
);
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const PROTOCOLS = ['responses', 'openai'];
const TERMINAL_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 180_000;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Digest of the tracked source tree that the proof actually exercised.
 *
 * The receipt cannot bind its own commit: committing the receipt necessarily
 * creates a new commit whose tree differs from the one the proof ran against.
 * Binding a source digest that excludes the evidence directory keeps the proof
 * verifiable from both the implementation commit and the evidence commit.
 */
function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes('docs/evidence/ui-provider-loop/'))
    .sort();
  return `sha256:${createHash('sha256').update(entries.join('\n')).digest('hex')}`;
}

function startServe(protocol, root) {
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', protocol,
    '--binding', `ui-rcc-${protocol}`,
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', `rcc/ui-${protocol}`,
    '--rcc-base-url', RCC_BASE_URL,
    '--workspace', workspace,
    '--control-root', controlRoot,
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve ${protocol} did not report a URL: ${stderr}`)), 30_000);
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
    child.once('exit', (code) => fail(new Error(`serve ${protocol} exited early (${String(code)}): ${stderr}`)));
  });

  return {
    child,
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
  if (!response.ok) {
    throw new Error(`request failed ${response.status} ${url}: ${text.slice(0, 600)}`);
  }
  return body;
}

function openEventStream(url) {
  const events = [];
  const waiters = [];
  const controller = new AbortController();
  const pump = (async () => {
    const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    if (!response.ok) throw new Error(`event stream failed ${response.status} ${url}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('');
        if (!data) continue;
        events.push(JSON.parse(data));
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(events)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.settle(events);
        }
      }
    }
  })().catch((error) => {
    for (const waiter of waiters.splice(0)) waiter.fail(error);
  });
  return {
    events,
    waitFor(predicate, label, timeoutMs = EVENT_TIMEOUT_MS) {
      if (predicate(events)) return Promise.resolve(events);
      return new Promise((settle, fail) => {
        const waiter = { predicate, settle, fail };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          fail(new Error(`timed out waiting for ${label}; saw ${events.map((event) => `${event.kind}:${event.state}`).join(', ')}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          settle: (value) => { clearTimeout(timer); settle(value); },
          fail: (error) => { clearTimeout(timer); fail(error); },
        });
      });
    },
    async close() {
      controller.abort();
      await pump.catch(() => {});
    },
  };
}

const terminalFinal = (events) => events.some((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');

async function runProtocol(protocol) {
  const root = await mkdtemp(join(tmpdir(), `humanagent-ui-loop-${protocol}-`));
  await mkdir(join(root, 'workspace'), { recursive: true });
  const serve = startServe(protocol, root);
  const record = { protocol, model: MODEL, root, steps: {}, events: {} };
  try {
    const launched = await serve.ready;
    record.endpoint = launched.url;
    record.checkpointRoot = launched.checkpointRoot;

    // probe
    const before = await jsonRequest(`${launched.url}/api/runtime/status`);
    record.steps.probe = { state: before.state, providerState: before.providerState, providerError: before.providerError ?? null };

    const task = await jsonRequest(`${launched.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `rcc ${protocol} provider loop`, directive: `prove ${protocol} entry` }),
    });
    const taskId = task.taskId.value;
    record.taskId = taskId;

    // execute -> natural terminal -> checkpoint -> close
    const started = await jsonRequest(`${launched.url}/api/tasks/${taskId}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rcc', prompt: 'Reply with the single word OK.' }),
    });
    record.steps.start = started;
    const stream = openEventStream(`${launched.url}/api/executions/${started.operationId}/events`);
    await stream.waitFor(terminalFinal, `${protocol} terminal`);
    record.events.execute = stream.events.map((event) => ({ kind: event.kind, state: event.state, summary: event.summary, terminalPhase: event.terminalPhase ?? null }));
    const dashboard = await jsonRequest(`${launched.url}/api/tasks/${taskId}/dashboard`);
    record.steps.execute = {
      state: dashboard.state,
      output: dashboard.output,
      checkpoint: dashboard.checkpoint ?? null,
      error: dashboard.error ?? null,
    };
    await stream.close();

    // stop -> settle -> stopped checkpoint -> close
    //
    // The upstream model may finish before the stop control reaches the
    // runtime. That is a genuine race, not a stop failure, so retry with a new
    // execution; any other error still propagates.
    let second;
    let stopStream;
    let stopRequest;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      second = await jsonRequest(`${launched.url}/api/tasks/${taskId}/executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'rcc', prompt: 'Write a detailed 2000 word essay about distributed systems. Do not stop early.' }),
      });
      stopStream = openEventStream(`${launched.url}/api/executions/${second.operationId}/events`);
      try {
        stopRequest = await jsonRequest(`${launched.url}/api/tasks/${taskId}/stop`, { method: 'POST' });
        break;
      } catch (error) {
        await stopStream.close();
        if (!String(error).includes('task.not.running')) throw error;
        stopStream = undefined;
      }
    }
    if (!stopRequest || !stopStream) throw new Error(`${protocol} execution finished before stop control could reach the runtime`);
    record.steps.secondStart = second;
    record.steps.stopRequest = stopRequest;
    await stopStream.waitFor(terminalFinal, `${protocol} stopped terminal`);
    record.events.stop = stopStream.events.map((event) => ({ kind: event.kind, state: event.state, summary: event.summary, terminalPhase: event.terminalPhase ?? null }));
    const stopped = await jsonRequest(`${launched.url}/api/tasks/${taskId}/dashboard`);
    record.steps.stop = {
      state: stopped.state,
      checkpoint: stopped.checkpoint ?? null,
      error: stopped.error ?? null,
    };
    await stopStream.close();

    const modeRoot = join(record.checkpointRoot, 'rcc');
    record.checkpointModeRoot = modeRoot;
    record.checkpointFiles = (await readdir(modeRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    record.checkpointJournal = [];
    for (const name of record.checkpointFiles) {
      record.checkpointJournal.push({ name, content: await readFile(join(modeRoot, name), 'utf8') });
    }
    return record;
  } finally {
    await serve.stop();
  }
}

function assertProtocol(record) {
  if (record.steps.probe.providerState !== 'ready') {
    throw new Error(`${record.protocol} probe was not ready: ${JSON.stringify(record.steps.probe)}`);
  }
  if (!['succeeded', 'waiting'].includes(record.steps.execute.state)) {
    throw new Error(`${record.protocol} execution did not settle successfully: ${JSON.stringify(record.steps.execute)}`);
  }
  const closeEvent = record.events.execute.find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
  if (!closeEvent || !/provider closed/.test(closeEvent.summary)) {
    throw new Error(`${record.protocol} terminal did not report provider close: ${JSON.stringify(closeEvent)}`);
  }
  if (record.steps.stop.state !== 'stopped') {
    throw new Error(`${record.protocol} stop did not reach stopped: ${JSON.stringify(record.steps.stop)}`);
  }
  if (record.steps.stop.checkpoint?.outcome !== 'stopped') {
    throw new Error(`${record.protocol} stop has no stopped checkpoint: ${JSON.stringify(record.steps.stop)}`);
  }
  const kinds = record.events.stop.map((event) => event.kind);
  for (const required of ['execution.settling', 'checkpoint.committed', 'execution.terminal']) {
    if (!kinds.includes(required)) throw new Error(`${record.protocol} stop stream is missing ${required}: ${kinds.join(', ')}`);
  }
  if (record.steps.execute.error || record.steps.stop.error) {
    throw new Error(`${record.protocol} produced a runtime error: ${JSON.stringify({ execute: record.steps.execute.error, stop: record.steps.stop.error })}`);
  }
}

async function main() {
  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.ui-provider-loop-proof',
    generatedAt: new Date().toISOString(),
    candidate: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      workingTreeClean: git(['status', '--porcelain', '--untracked-files=all']) === '',
      sourceDigest: sourceDigest(),
    },
    rcc: {
      baseUrl: RCC_BASE_URL,
      health: await jsonRequest(`${RCC_BASE_URL}/health`, {}),
    },
    protocols: [],
  };

  for (const protocol of PROTOCOLS) {
    const record = await runProtocol(protocol);
    assertProtocol(record);
    receipt.protocols.push(record);
    console.error(`${protocol}: probe/execute/stop/settle/checkpoint/close verified`);
  }

  await mkdir(resolve(RECEIPT_PATH, '..'), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    receipt: RECEIPT_PATH,
    protocols: receipt.protocols.map((record) => ({
      protocol: record.protocol,
      ready: record.steps.probe.providerState,
      execute: record.steps.execute.state,
      stop: record.steps.stop.state,
      stoppedCheckpoint: record.steps.stop.checkpoint?.outcome,
    })),
  }, null, 2));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
