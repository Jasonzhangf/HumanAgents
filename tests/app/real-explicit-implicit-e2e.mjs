#!/usr/bin/env node
/**
 * Real RCC explicit -> implicit -> executor completion proof (T4).
 *
 * Drives the built HumanAgent CLI `serve --mode rcc` entry over its HTTP
 * Runtime API:
 *
 *   explicit round 1  - business input -> real provider explicit brain draft
 *                       -> user confirmation -> implicit FIFO admission
 *                       -> executor runs file.read -> task succeeded
 *   explicit round 2  - append a second concrete requirement to the same task
 *                       -> confirmed -> second real RCC execution reads another
 *                       workspace file -> task succeeded again
 *   UI observation    - the served dashboard/task-detail/observation projections
 *                       show the nodes, tool evidence, and completed state
 *
 * Persists `dist/receipts/explicit-implicit-e2e-proof.json`.
 *
 * Required env:
 *   none (the live RCC endpoint must answer on 127.0.0.1:4444)
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL       default http://127.0.0.1:4444
 *   HUMANAGENT_UI_MODEL           default gpt-5.5
 *   HUMANAGENT_EI_RECEIPT_PATH    default ./dist/receipts/explicit-implicit-e2e-proof.json
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_EI_RECEIPT_PATH ?? 'dist/receipts/explicit-implicit-e2e-proof.json',
);
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const TERMINAL_TIMEOUT_MS = 240_000;
const MAX_INTERPRET_ATTEMPTS = 4;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes('docs/evidence/explicit-implicit-e2e/')
      && !line.includes('dist/receipts/explicit-implicit-e2e-proof.json'))
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
    '--binding', 'ui-ei-e2e-proof',
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

async function statusText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`status failed ${response.status} ${url}`);
  return response.text();
}

async function pollTaskState(base, taskId, timeoutMs = TERMINAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let dashboard;
  for (;;) {
    try {
      dashboard = await jsonRequest(`${base}/api/tasks/${taskId}/dashboard`);
    } catch (error) {
      if (!String(error).includes('task.not.found')) throw error;
      dashboard = undefined;
    }
    if (dashboard) {
      if (!['created', 'admitted', 'running', 'waiting', 'settling'].includes(dashboard.state)) {
        return dashboard;
      }
    }
    if (Date.now() > deadline) return dashboard ?? null;
    await new Promise((settle) => setTimeout(settle, 1000));
  }
}

async function resolveImplicitTaskId(base, draftId, timeoutMs = 30_000) {
  const expected = `ui-task-implicit-${draftId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await jsonRequest(`${base}/api/tasks`);
    const all = [...(list.running ?? []), ...(list.waiting ?? []), ...(list.completed ?? []), ...(list.stopped ?? []), ...(list.draft ?? []), ...(list.failed ?? [])];
    const found = all.find((task) => task.taskId?.value === expected);
    if (found) return { taskId: expected, task: found };
    if (Date.now() > deadline) {
      const first = all[0];
      if (first) return { taskId: first.taskId?.value ?? first.taskId, task: first };
      throw new Error(`implicit task ${expected} was not created: ${JSON.stringify(all.map((task) => task.taskId?.value))}`);
    }
    await new Promise((settle) => setTimeout(settle, 1000));
  }
}

async function waitForImplicitTask(base, draftId) {
  const resolved = await resolveImplicitTaskId(base, draftId);
  const operationId = `ui-operation-implicit-${draftId}`;
  return { taskId: resolved.taskId, operationId, task: resolved.task };
}

async function waitForNewTask(base, excludeTaskId, timeoutMs = TERMINAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await jsonRequest(`${base}/api/tasks`);
    const all = [...(list.running ?? []), ...(list.waiting ?? []), ...(list.completed ?? []), ...(list.stopped ?? []), ...(list.draft ?? []), ...(list.failed ?? [])];
    const task = all.find((candidate) => (candidate.taskId?.value ?? candidate.taskId) !== excludeTaskId);
    if (task) return { taskId: task.taskId?.value ?? task.taskId, task };
    if (Date.now() > deadline) throw new Error(`no second task appeared after excluding ${excludeTaskId}: ${JSON.stringify(all.map((candidate) => candidate.taskId?.value))}`);
    await new Promise((settle) => setTimeout(settle, 1000));
  }
}

function eventKinds(dashboard) {
  return (dashboard.recentEvents ?? []).map((event) => `${event.kind}:${event.state}`);
}

async function interpretUntilDraft(base, input) {
  let lastError;
  for (let attempt = 0; attempt < MAX_INTERPRET_ATTEMPTS; attempt += 1) {
    const sourceRef = `${input.sourceRef}-attempt-${attempt + 1}`;
    const created = await jsonRequest(`${base}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'business',
        sourceRef,
        rawInput: input.rawInput,
      }),
    });
    const interactionId = created.interactionId;
    let snapshot;
    try {
      snapshot = await jsonRequest(`${base}/api/explicit/interactions/${interactionId}/interpret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (snapshot.state !== 'awaiting-confirmation' || !snapshot.draft) {
      lastError = new Error(`explicit interpretation reached ${snapshot.state} instead of awaiting-confirmation`);
      continue;
    }
    const draftMatches = input.requireDraft
      ? snapshot.draft.proposal.includes(input.requireDraft)
        && (input.requireIntent ? snapshot.draft.proposedIntent === input.requireIntent : true)
      : true;
    if (!draftMatches) {
      lastError = new Error(`explicit draft did not satisfy requirement: ${snapshot.draft.proposal.slice(0, 300)}`);
      continue;
    }
    return { interaction: snapshot, draft: snapshot.draft };
  }
  throw lastError ?? new Error(`no valid explicit draft after ${MAX_INTERPRET_ATTEMPTS} attempts`);
}

async function confirmDraft(base, interaction, draft, confirmationMark) {
  return jsonRequest(`${base}/api/explicit/interactions/${interaction.interactionId}/confirmation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      draftId: draft.draftId,
      inputRevision: draft.inputRevision,
      confirmationRef: confirmationMark.confirmationRef,
      confirmedBy: confirmationMark.confirmedBy,
      confirmedAt: confirmationMark.confirmedAt,
      payloadRef: confirmationMark.payloadRef,
    }),
  });
}

async function captureObservation(base, taskId) {
  const dashboard = await jsonRequest(`${base}/api/tasks/${taskId}/dashboard`);
  const observation = await jsonRequest(`${base}/api/tasks/${taskId}/observation`);
  const detail = await jsonRequest(`${base}/api/tasks/${taskId}`);
  return { dashboard, observation, detail };
}

function assertCompleted(dashboard, expect) {
  if (dashboard.state !== 'succeeded') {
    console.error('DEBUG_ASSERT_COMPLETED', JSON.stringify(dashboard, null, 2));
    throw new Error(`task did not complete: state=${dashboard.state}; output=${JSON.stringify(dashboard.output ?? null).slice(0, 600)}`);
  }
  if (expect && (!dashboard.output || !dashboard.output.includes(expect))) {
    throw new Error(`task output did not include expected text ${expect}: ${JSON.stringify(dashboard.output ?? null).slice(0, 600)}`);
  }
}

function assertObservation(observation) {
  const ids = (observation.nodes ?? []).map((node) => node.nodeId);
  for (const expected of ['sensory.inbox', 'explicit.normalize', 'implicit.classify', 'interactive.queue', 'execution.queue', 'pipeline.execute', 'settle', 'task.output']) {
    if (!ids.includes(expected)) throw new Error(`observation is missing node ${expected}: ${ids.join(', ')}`);
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'ha-explicit-implicit-4-e2e-'));
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'workspace', 'marker.txt'), 'EXPLICIT_IMPLICIT_E2E_MARKER_7A1C\n', 'utf8');
  await writeFile(join(root, 'workspace', 'readme-first-line.txt'), 'FIRST_LINE_PROVEN_8B2D\n', 'utf8');

  let serve;
  const steps = {};
  const rounds = [];
  try {
    serve = startServe(root);
    const launched = await serve.ready;
    const base = launched.url;
    steps.serve = {
      root,
      url: base,
      checkpointRoot: launched.checkpointRoot,
      memoryAnalysisMode: launched.memoryAnalysisMode,
    };

    steps.status = await jsonRequest(`${base}/api/runtime/status`);
    steps.uiRoot = await statusText(`${base}/`);

    const firstInput = {
      sourceRef: 'explicit-implicit-e2e-round-1',
      rawInput: 'Do not clarify. Create exactly one concrete task: read marker.txt and readme-first-line.txt, combine both facts into a single completion summary, finish with the word COMPLETE, and end with exactly HUMANAGENT_REVIEW: passed.',
      requireDraft: 'readme-first-line.txt',
      requireIntent: 'create',
    };
    const first = await interpretUntilDraft(base, firstInput);
    steps.round1Draft = first.draft;
    await confirmDraft(base, first.interaction, first.draft, {
      confirmationRef: `confirmation-${first.draft.draftId}`,
      confirmedBy: 'e2e-user',
      confirmedAt: new Date().toISOString(),
      payloadRef: `humanagent://e2e/requirement/${first.draft.draftId}`,
    });
    const firstImplicit = await waitForImplicitTask(base, first.draft.draftId);
    const firstTaskId = firstImplicit.taskId;
    const firstOperationId = firstImplicit.operationId;
    const firstTerminal = await pollTaskState(base, firstTaskId);
    assertCompleted(firstTerminal, 'EXPLICIT_IMPLICIT_E2E_MARKER_7A1C');
    const firstObservation = await captureObservation(base, firstTaskId);
    assertObservation(firstObservation.observation);
    rounds.push({
      round: 1,
      interactionId: first.interaction.interactionId,
      draftId: first.draft.draftId,
      taskId: firstTaskId,
      operationId: firstOperationId,
      terminalState: firstTerminal.state,
      events: eventKinds(firstTerminal),
      output: firstTerminal.output,
      observation: firstObservation.observation,
    });

    const secondInput = {
      sourceRef: 'explicit-implicit-e2e-round-2',
      rawInput: 'Do not clarify. Create exactly one concrete task: read marker.txt and readme-first-line.txt, combine both facts into a single completion summary, finish with the word COMPLETE, and end with exactly HUMANAGENT_REVIEW: passed.',
      requireDraft: 'marker.txt',
      requireIntent: 'create',
    };
    const second = await interpretUntilDraft(base, secondInput);
    steps.round2Draft = second.draft;
    await confirmDraft(base, second.interaction, second.draft, {
      confirmationRef: `confirmation-${second.draft.draftId}`,
      confirmedBy: 'e2e-user',
      confirmedAt: new Date().toISOString(),
      payloadRef: `humanagent://e2e/requirement/${second.draft.draftId}`,
    });
    const secondImplicit = await waitForNewTask(base, firstTaskId);
    const secondTaskId = secondImplicit.taskId;
    const secondTerminal = await pollTaskState(base, secondTaskId);
    assertCompleted(secondTerminal, 'FIRST_LINE_PROVEN_8B2D');
    const secondOperationId = secondTerminal.operationId ?? null;
    const secondObservation = await captureObservation(base, secondTaskId);
    assertObservation(secondObservation.observation);
    rounds.push({
      round: 2,
      interactionId: second.interaction.interactionId,
      draftId: second.draft.draftId,
      taskId: secondTaskId,
      operationId: secondOperationId,
      terminalState: secondTerminal.state,
      events: eventKinds(secondTerminal),
      output: secondTerminal.output,
      observation: secondObservation.observation,
    });

    if (rounds.length < 2) throw new Error('proof expected at least two executor rounds');

    const receipt = {
      proof: 'explicit-implicit-e2e',
      generatedAt: new Date().toISOString(),
      sourceDigest: sourceDigest(),
      rcc: {
        baseUrl: RCC_BASE_URL,
        protocol: 'responses',
        model: MODEL,
        route: 'rcc/ui-explicit-implicit',
      },
      serve: steps.serve,
      status: steps.status,
      uiRootServed: typeof steps.uiRoot === 'string' && steps.uiRoot.startsWith('<!doctype html>') || steps.uiRoot.startsWith('<!DOCTYPE html>'),
      dashboards: {
        round1: rounds[0] ?? null,
        round2: rounds[1] ?? null,
      },
      rounds,
    };
    await mkdir(resolve('dist/receipts'), { recursive: true });
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (serve) await serve.stop();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
