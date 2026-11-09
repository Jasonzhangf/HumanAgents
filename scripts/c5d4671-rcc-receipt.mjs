#!/usr/bin/env node
/**
 * Real RCC 4444 same-entry receipt for c5d4671.
 *
 * Drives the built HumanAgent CLI `serve --mode rcc` entry over its HTTP API
 * against the live RCC endpoint on 127.0.0.1:4444 and captures the task event
 * stream to terminal settlement. Asserts the same-entry facts the focused test
 * asserts over the fake replay port: provider.model dispatches then settles
 * under one turnId, and the orchestrated child lifecycle steps are present.
 *
 * Usage:
 *   node scripts/c5d4671-rcc-receipt.mjs [receipt-path]
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve('dist/app/app/src/cli.js');
const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const TERMINAL_TIMEOUT_MS = 600_000;
// The locked builtin agent prompts (including the review prompt the RCC
// orchestration ports require at startup) live in the agent-templates package.
const TEMPLATE_ROOT = process.env.HUMANAGENT_TEMPLATE_ROOT
  ?? resolve('packages/agent-templates/templates');

// The isolated control root gets a real config.toml with room for both child
// roles. The TOML fixture is the single source of truth for this receipt and is
// validated by tests/app/c5d4671-receipt-config-public-consumer.test.ts.
const RECEIPT_CONFIG_PATH = new URL('./c5d4671-receipt-config.toml', import.meta.url);

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

function startServe(root) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'rcc-c5d4671',
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', 'default',
    '--rcc-base-url', RCC_BASE_URL,
    '--workspace', join(root, 'workspace'),
    '--control-root', join(root, 'control'),
    '--port', '0',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HUMANAGENT_TEMPLATE_ROOT: TEMPLATE_ROOT },
  });

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
    stdout: () => stdout,
    stderr: () => stderr,
    capture: () => ({ stdout, stderr }),
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

async function startTask(url, prompt) {
  const task = await jsonRequest(`${url}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'rcc c5d4671 receipt', directive: prompt }),
  });
  const taskId = task.taskId.value;
  const grantRead = await jsonRequest(`${url}/api/tasks/${taskId}/control/grant`, {});
  const currentRevision = grantRead.readback?.grant?.revision ?? 0;
  const grant = await jsonRequest(`${url}/api/tasks/${taskId}/control/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `c5d4671-grant-${taskId}`, expectedRevision: currentRevision }),
  });
  const started = await jsonRequest(`${url}/api/tasks/${taskId}/executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'rcc', prompt }),
  });
  return { taskId, operationId: started.operationId, grantState: grant.readback?.grant?.state ?? null };
}

async function collectEvents(url, operationId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  let rawSse = '';
  try {
    const response = await fetch(`${url}/api/executions/${operationId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`event stream failed ${response.status} for ${operationId}`);
    let buffer = '';
    for await (const chunk of response.body) {
      const text = Buffer.from(chunk).toString('utf8');
      rawSse += text;
      buffer += text;
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
        if (last.kind === 'execution.terminal' && last.terminalPhase === 'final') return { events, rawSse };
      }
    }
    return { events, rawSse };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function findTaskControlJournals(root, depth = 0) {
  if (depth > 6) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await findTaskControlJournals(full, depth + 1));
    } else if (entry.isFile() && entry.name === 'task-control.jsonl') {
      paths.push(full);
    }
  }
  return paths;
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { _raw: line }; }
    });
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

async function main() {
  const receiptPath = resolve(process.argv[2] ?? 'dist/receipts/c5d4671-rcc-receipt.json');
  const root = await mkdtemp(join(tmpdir(), 'humanagent-c5d4671-rcc-'));
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'control'), { recursive: true });
  await writeFile(join(root, 'control', 'config.toml'), await readFile(RECEIPT_CONFIG_PATH, 'utf8'), 'utf8');
  const serve = startServe(root);
  const receipt = {
    proof: 'c5d4671-rcc-same-entry',
    generatedAt: new Date().toISOString(),
    model: MODEL,
    rccBaseUrl: RCC_BASE_URL,
    state: 'UNVERIFIED',
  };
  let removeRoot = false;
  let receiptWritten = false;
  const writeReceipt = async () => {
    await mkdir(resolve(receiptPath, '..'), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    receiptWritten = true;
  };
  try {
    const launched = await serve.ready;
    receipt.serveUrl = launched.url;
    const prompt = [
      'You are the parent agent executing one formal humanagent turn.',
      'Call child_call once with kind "execution", agentId "orchestration-default", purpose "compute 2+2",',
      'instructions "Do not inspect any files. Compute 2+2 and return exactly the number 4 as the complete body.",',
      'successCriteria ["body is 4"], and target "answer.txt".',
      'After it returns, capture its invocationId and call child_adopt once with that execution invocationId.',
      'Then call child_call once with kind "review", agentId "orchestration-default", purpose "review execution result", reviewKind "quality", and subjectInvocationId set to the execution invocationId you just adopted.',
      'The review child persists its review with file.write, then delivers with humanagent_child_deliver and ends with humanagent_turn_end.',
      'After the review returns, capture its invocationId and call child_adopt once with that review invocationId.',
      'Finally call humanagent_turn_end with outcome "completed". Use the adopted child result as the final answer: 4.',
    ].join(' ');
    receipt.prompt = prompt;
    const started = await startTask(launched.url, prompt);
    receipt.task = started;
    const collected = await collectEvents(launched.url, started.operationId, TERMINAL_TIMEOUT_MS);
    const { events, rawSse } = collected;
    receipt.rawSse = rawSse;
    receipt.events = events;
    const dashboard = await waitForTerminal(launched.url, started.taskId, TERMINAL_TIMEOUT_MS);
    const provider = events
      .filter((event) => event.kind === 'provider.model')
      .map((event) => ({ state: event.state, turnId: event.turnId ?? null }));
    const states = provider.map((event) => event.state);
    const firstDispatched = states.indexOf('dispatched');
    const firstSettled = states.indexOf('settled');
    const dispatchTurn = provider.find((event) => event.state === 'dispatched')?.turnId ?? null;
    const settleTurn = provider.find((event) => event.state === 'settled')?.turnId ?? null;
    receipt.provider = {
      rounds: provider.length,
      states: [...new Set(states)],
      firstDispatched,
      firstSettled,
      dispatchTurn,
      settleTurn,
      childPrepared: states.includes('child.prepared'),
      childReturned: states.includes('child.returned'),
      childAdopted: states.includes('child.adopted'),
      reviewCheckpointed: states.includes('review.checkpointed'),
    };
    receipt.terminal = {
      state: dashboard.state,
      output: dashboard.output ?? null,
      error: dashboard.error ?? null,
      checkpoint: dashboard.checkpoint ?? null,
    };
    const controlPaths = await findTaskControlJournals(join(root, 'control'));
    receipt.taskControl = await Promise.all(controlPaths.map(async (path) => ({
      path,
      entries: await readJsonl(path),
    })));
    receipt.committedCheckpoints = receipt.taskControl.flatMap((journal) =>
      journal.entries
        .filter((entry) => entry.kind === 'checkpoint')
        .map((entry) => ({ journal: journal.path, entry })));
    const ok = dashboard.state === 'succeeded'
      && typeof dashboard.output === 'string' && dashboard.output.trim().length > 0
      && firstDispatched >= 0
      && firstSettled > firstDispatched
      && states.includes('dispatching')
      && ['child.prepared', 'child.returned', 'child.adopted', 'review.checkpointed'].every((s) => states.includes(s))
      && dispatchTurn !== null && dispatchTurn === settleTurn;
    receipt.state = ok ? 'SUCCESS' : 'INCOMPLETE';
    receipt.missing = ok ? [] : [
      dashboard.state !== 'succeeded' && `terminal ${dashboard.state}`,
      !(typeof dashboard.output === 'string' && dashboard.output.trim().length > 0) && 'non-empty output',
      firstDispatched < 0 && 'provider dispatched',
      !(firstSettled > firstDispatched) && 'settle after dispatch',
      !states.includes('dispatching') && 'provider dispatching',
      ...['child.prepared', 'child.returned', 'child.adopted', 'review.checkpointed']
        .filter((s) => !states.includes(s))
        .map((s) => `missing ${s}`),
      (dispatchTurn === null || dispatchTurn !== settleTurn) && 'same dispatch/settle turn',
    ].filter(Boolean);
    receipt.serveOutput = serve.capture();
    await writeReceipt();
    console.log(JSON.stringify({
      state: receipt.state,
      receiptPath,
      task: receipt.task,
      provider: receipt.provider,
      terminal: receipt.terminal,
      missing: receipt.missing,
    }, null, 2));
    removeRoot = receipt.state === 'SUCCESS';
    if (receipt.state !== 'SUCCESS') process.exitCode = 1;
  } catch (error) {
    receipt.state = 'INCOMPLETE';
    receipt.error = error instanceof Error ? error.stack ?? error.message : String(error);
    receipt.serveOutput = serve.capture();
    await writeReceipt().catch(() => undefined);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await serve.stop().catch((error) => {
      receipt.stopError = error instanceof Error ? error.stack ?? error.message : String(error);
    });
    receipt.serveOutput = serve.capture();
    await writeReceipt().catch((error) => {
      console.error(`failed to write receipt: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (removeRoot && receiptWritten) {
      await rm(root, { recursive: true, force: true });
    } else {
      console.error(`preserving evidence root: ${root}`);
    }
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
