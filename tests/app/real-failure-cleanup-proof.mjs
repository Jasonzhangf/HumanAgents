#!/usr/bin/env node
/**
 * Real RCC failure-cleanup proof (bug 7721953).
 *
 * Drives the built HumanAgent CLI `serve --mode rcc --protocol responses` entry
 * over its own HTTP Runtime API and records what happens when a provider tool
 * fails while the provider execution is still live:
 *
 *   failure   - the real `file.read` tool reads a directory, so the tool
 *               executor surfaces EISDIR and the execution fails
 *   cleanup   - failure cleanup must release the abandoned provider session
 *               through the standard stop control, not leave close pending
 *   terminal  - the task ends terminally `failed` with the real tool error and
 *               no advertised retry, so the resource release never disguises
 *               the business failure as a stop
 *
 * The receipt binds the candidate source digest, the RCC endpoint identity, the
 * task/operation ids, and the on-disk checkpoint journal, so the claim is
 * verifiable from the receipt alone.
 *
 * Required env:
 *   none (the live RCC endpoint must answer on 127.0.0.1:4444)
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL              default http://127.0.0.1:4444
 *   HUMANAGENT_UI_MODEL                  default gpt-5.5
 *   HUMANAGENT_FAILURE_RECEIPT_PATH      default ./dist/receipts/failure-cleanup-proof.json
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_FAILURE_RECEIPT_PATH ?? 'dist/receipts/failure-cleanup-proof.json',
);
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const TERMINAL_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 60_000;
const TOOL_FAILURE_MESSAGE = 'EISDIR: illegal operation on a directory, read';
// The upstream model decides whether to call the tool, so a run may end without
// exercising the failure path. Retry a bounded number of times and fail loudly
// rather than accepting a run that never reached the path under proof.
const MAX_ATTEMPTS = 4;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes('docs/evidence/failure-cleanup/'))
    .sort();
  return `sha256:${createHash('sha256').update(`${entries.join('\n')}\n`).digest('hex')}`;
}

function startServe(root) {
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'ui-rcc-responses',
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', 'rcc/ui-responses',
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

async function waitForTerminal(url, taskId, timeoutMs = TERMINAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dashboard = await jsonRequest(`${url}/api/tasks/${taskId}/dashboard`);
    if (!['created', 'admitted', 'running', 'waiting', 'settling'].includes(dashboard.state)) return dashboard;
    if (Date.now() > deadline) {
      // A task stuck in a non-terminal state is the regression under proof, so
      // return the observed projection and let the assertions report it.
      return dashboard;
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
}

/**
 * Collects the operation event stream. The runtime replays every event from the
 * start and closes the stream on the final terminal, so opening it after the
 * task settles still yields the complete history.
 */
async function collectEvents(url, operationId, timeoutMs = EVENT_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${url}/api/executions/${operationId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`event stream failed ${response.status} for ${operationId}`);
    const events = [];
    let buffer = '';
    try {
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
          const event = JSON.parse(data);
          events.push(event);
          if (event.kind === 'execution.terminal' && event.terminalPhase === 'final') return events;
        }
      }
    } catch (error) {
      // A stream that never reaches a final terminal is itself the regression:
      // report the observed events instead of an opaque abort error.
      if (timedOut && events.length > 0) return events;
      throw error;
    }
    return events;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readCheckpointJournal(checkpointRoot, taskId) {
  const modeRoot = join(checkpointRoot, 'rcc');
  const names = (await readdir(modeRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.startsWith(`task-${taskId}-cycle-`))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) throw new Error(`no checkpoint journal for ${taskId} under ${modeRoot}`);
  const records = [];
  for (const name of names) {
    for (const line of (await readFile(join(modeRoot, name), 'utf8')).trim().split('\n')) {
      if (!line) continue;
      records.push({ name, checkpoint: JSON.parse(line).checkpoint });
    }
  }
  return records;
}

/**
 * Runs the real entry until the provider tool failure path is exercised.
 *
 * A run that never calls `file.read` cannot prove the cleanup path, so it is
 * reported as a non-exercise and retried. Exhausting the attempts is a hard
 * failure, never a silent pass.
 */
async function runAttempt(url, checkpointRoot, attempt) {
  const task = await jsonRequest(`${url}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `failure cleanup ${attempt}`,
      directive: 'exercise the provider tool failure cleanup path',
    }),
  });
  const taskId = task.taskId.value;
  const started = await jsonRequest(`${url}/api/tasks/${taskId}/executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'rcc',
      prompt: 'Use the file.read tool to read the directory at path "adir" (the directory itself, not a file inside it). Then report what happened.',
    }),
  });
  const dashboard = await waitForTerminal(url, taskId);
  const eventList = await collectEvents(url, started.operationId);
  const toolCalled = eventList.some((event) => event.kind === 'provider.tool' && event.summary === 'file.read');
  const checkpoints = await readCheckpointJournal(checkpointRoot, taskId);
  return { attempt, taskId, operationId: started.operationId, dashboard, eventList, checkpoints, toolCalled };
}

function assertFailureCleanup(record) {
  const { dashboard, eventList, checkpoints } = record;
  if (dashboard.state !== 'failed') {
    throw new Error(`task did not fail terminally: ${dashboard.state} / ${JSON.stringify(dashboard.error ?? null)}`);
  }
  if (dashboard.error?.message !== TOOL_FAILURE_MESSAGE) {
    throw new Error(`task did not report the real tool failure: ${JSON.stringify(dashboard.error ?? null)}`);
  }
  if (dashboard.error?.cleanupError !== undefined) {
    throw new Error(`failure cleanup leaked into the task error: ${JSON.stringify(dashboard.error.cleanupError)}`);
  }
  if (JSON.stringify(dashboard.allowedActions) !== JSON.stringify(['start'])) {
    throw new Error(`failed task advertised unexpected actions: ${JSON.stringify(dashboard.allowedActions)}`);
  }
  const kinds = eventList.map((event) => `${event.kind}:${event.state}`);
  if (kinds.some((kind) => kind === 'provider.error:blocked')) {
    throw new Error(`cleanup failure was projected as blocked: ${kinds.join(', ')}`);
  }
  if (eventList.some((event) => event.summary?.includes('close.pending.executions'))) {
    throw new Error('provider close stayed pending after failure cleanup');
  }
  const cleanup = eventList.find((event) =>
    event.kind === 'checkpoint.committed' && event.state === 'stopped'
    && event.summary === 'failure cleanup released the abandoned provider execution');
  if (!cleanup) throw new Error(`failure cleanup stop checkpoint is missing: ${kinds.join(', ')}`);
  const terminal = eventList.find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
  if (!terminal || terminal.state !== 'failed') {
    throw new Error(`terminal event did not report failed: ${JSON.stringify(terminal ?? null)}`);
  }
  const outcomes = checkpoints.map((entry) => entry.checkpoint.outcome);
  if (JSON.stringify(outcomes) !== JSON.stringify(['stopped', 'failed'])) {
    throw new Error(`checkpoint journal was not [stopped, failed]: ${JSON.stringify(outcomes)}`);
  }
  const [stopped, failed] = checkpoints.map((entry) => entry.checkpoint);
  if (failed.previousCheckpointId?.value !== stopped.id.value) {
    throw new Error('failed checkpoint did not chain to the cleanup stop checkpoint');
  }
  // A non-stopped checkpoint must keep the same operation identity as its
  // predecessor, and every evidence reference must share that scope.
  if (failed.scope.operationId?.value !== stopped.scope.operationId?.value) {
    throw new Error('failed checkpoint did not inherit the cleanup operation identity');
  }
  for (const checkpoint of [stopped, failed]) {
    for (const evidenceRef of checkpoint.evidenceRefs) {
      if (JSON.stringify(evidenceRef.scope) !== JSON.stringify(checkpoint.scope)) {
        throw new Error(`evidence scope did not match checkpoint scope: ${JSON.stringify(evidenceRef.scope)}`);
      }
    }
    if (JSON.stringify(checkpoint.recoveryStateRef?.scope) !== JSON.stringify(checkpoint.scope)) {
      throw new Error('recovery state reference scope did not match checkpoint scope');
    }
  }
  if (!terminal.evidenceRefs.some((ref) => ref.locator?.includes('provider-close'))) {
    throw new Error('terminal did not bind the provider close evidence');
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-failure-cleanup-'));
  await mkdir(join(root, 'workspace', 'adir'), { recursive: true });
  await writeFile(join(root, 'workspace', 'note.txt'), 'plain file\n', 'utf8');
  const serve = startServe(root);
  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.failure-cleanup-proof',
    generatedAt: new Date().toISOString(),
    candidate: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      head: git(['rev-parse', 'HEAD']),
      sourceDigest: sourceDigest(),
    },
    rcc: {
      baseUrl: RCC_BASE_URL,
      health: await jsonRequest(`${RCC_BASE_URL}/health`, {}),
    },
    entry: 'CLI serve --mode rcc --protocol responses over the UI Runtime HTTP API',
    model: MODEL,
    nonExercisedAttempts: [],
    record: null,
  };
  try {
    const launched = await serve.ready;
    receipt.endpoint = launched.url;
    receipt.checkpointRoot = launched.checkpointRoot;

    let exercised;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const record = await runAttempt(launched.url, launched.checkpointRoot, attempt);
      if (record.toolCalled) {
        exercised = record;
        break;
      }
      receipt.nonExercisedAttempts.push({
        attempt,
        taskId: record.taskId,
        state: record.dashboard.state,
        error: record.dashboard.error ?? null,
      });
    }
    if (!exercised) {
      throw new Error(`the provider tool failure path was not exercised in ${MAX_ATTEMPTS} attempts`);
    }

    assertFailureCleanup(exercised);

    receipt.record = {
      attempt: exercised.attempt,
      taskId: exercised.taskId,
      operationId: exercised.operationId,
      state: exercised.dashboard.state,
      error: exercised.dashboard.error ?? null,
      allowedActions: exercised.dashboard.allowedActions,
      checkpointOutcomes: exercised.checkpoints.map((entry) => entry.checkpoint.outcome),
      checkpointOperationIds: exercised.checkpoints.map((entry) => entry.checkpoint.scope.operationId?.value ?? null),
      events: exercised.eventList.map((event) => ({
        kind: event.kind,
        state: event.state,
        summary: event.summary,
        terminalPhase: event.terminalPhase ?? null,
      })),
      checkpointJournal: exercised.checkpoints.map((entry) => ({ name: entry.name, checkpoint: entry.checkpoint })),
    };

    await mkdir(resolve(RECEIPT_PATH, '..'), { recursive: true });
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      receipt: RECEIPT_PATH,
      state: receipt.record.state,
      error: receipt.record.error?.message,
      allowedActions: receipt.record.allowedActions,
      checkpointOutcomes: receipt.record.checkpointOutcomes,
    }, null, 2));
  } finally {
    await serve.stop();
    await rm(root, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
