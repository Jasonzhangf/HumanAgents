#!/usr/bin/env node
/**
 * Real RCC explicit -> implicit -> executor E2E proof.
 *
 * Drives the built HumanAgent CLI `serve --mode rcc --protocol responses`
 * over its own HTTP Runtime API. It submits a user task, requires explicit
 * brain interpretation and confirmation, lets the implicit consumer create
 * and start the execution, then waits for at least two provider tool rounds,
 * evidence refs, a committed checkpoint, and a final `succeeded` task.
 *
 * Required env:
 *   none (the live RCC endpoint must answer on 127.0.0.1:4444)
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL               default http://127.0.0.1:4444
 *   HUMANAGENT_UI_MODEL                   default gpt-5.5
 *   HUMANAGENT_EXPLICIT_IMPLICIT_RECEIPT_PATH default ./dist/receipts/explicit-implicit-e2e-proof.json
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_EXPLICIT_IMPLICIT_RECEIPT_PATH ?? 'dist/receipts/explicit-implicit-e2e-proof.json',
);
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const TERMINAL_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 180_000;
const TASK_POLL_MS = 500;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes('dist/receipts/explicit-implicit-e2e-proof.json'))
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
    '--binding', 'ui-rcc-explicit-implicit',
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
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
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

async function waitForTask(url) {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  for (;;) {
    const list = await jsonRequest(`${url}/api/tasks`);
    if (list.counts.total > 0) {
      const row = [
        ...list.running,
        ...list.waiting,
        ...list.completed,
        ...list.draft,
        ...list.failed,
        ...list.stopped,
      ][0];
      if (row) return { list, row };
    }
    if (Date.now() > deadline) {
      throw new Error(`implicit consumer did not create a task: ${JSON.stringify(list)}`);
    }
    await new Promise((settle) => setTimeout(settle, TASK_POLL_MS));
  }
}

async function waitForTerminal(url, taskId) {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  for (;;) {
    const dashboard = await jsonRequest(`${url}/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
    if (!['created', 'admitted', 'running', 'settling'].includes(dashboard.state)) return dashboard;
    if (Date.now() > deadline) return dashboard;
    await new Promise((settle) => setTimeout(settle, 500));
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-implicit-e2e-'));
  await mkdir(join(root, 'workspace', 'notes'), { recursive: true });
  await writeFile(join(root, 'workspace', 'notes', 'startup.md'), 'startup checklist: run typecheck, run focused tests, persist receipt\n', 'utf8');
  await writeFile(join(root, 'workspace', 'notes', 'runtime.md'), 'runtime entry: serve --mode rcc on port 0\n', 'utf8');
  const serve = startServe(root);
  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.explicit-implicit-e2e-proof',
    generatedAt: new Date().toISOString(),
    candidate: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      head: git(['rev-parse', 'HEAD']),
      sourceDigest: sourceDigest(),
    },
    rcc: {
      baseUrl: RCC_BASE_URL,
      health: await jsonRequest(`${RCC_BASE_URL}/health`, {}),
      routeSemantics: 'routeRef is a local HumanAgent entry label for binding and evidence; it is not sent as an RCC upstream route selector',
    },
    entry: 'CLI serve --mode rcc --protocol responses over the UI Runtime HTTP API',
    model: MODEL,
    record: null,
  };

  try {
    const launched = await serve.ready;
    receipt.endpoint = launched.url;
    receipt.checkpointRoot = launched.checkpointRoot;

    const before = await jsonRequest(`${launched.url}/api/runtime/status`);
    if (before.providerState !== 'ready') {
      throw new Error(`runtime was not provider-ready: ${JSON.stringify(before)}`);
    }

    const interaction = await jsonRequest(`${launched.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'business',
        sourceRef: 'e2e:explicit-implicit',
        rawInput: 'Create one task: read notes/startup.md and notes/runtime.md, combine both facts into a single completion summary, finish with the word COMPLETE, and end with exactly HUMANAGENT_REVIEW: passed.',
      }),
    });
    const interactionId = interaction.interactionId;

    const interpreted = await jsonRequest(`${launched.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {
      method: 'POST',
    });
    if (interpreted.state !== 'awaiting-confirmation' || !interpreted.draft?.draftId) {
      throw new Error(`explicit brain did not produce a confirmable draft: ${JSON.stringify(interpreted)}`);
    }
    const draft = interpreted.draft;
    if (draft.proposedIntent !== 'create' || !draft.proposal.trim()) {
      throw new Error(`explicit brain draft is not a create requirement: ${JSON.stringify(draft)}`);
    }

    const confirmedAt = new Date().toISOString();
    const confirmed = await jsonRequest(`${launched.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.draftId,
        inputRevision: draft.inputRevision,
        confirmationRef: 'confirmation:explicit-implicit-e2e',
        confirmedBy: 'human:operator',
        confirmedAt,
        payloadRef: 'asset://requirements/explicit-implicit-e2e',
      }),
    });
    const requirement = confirmed.requirement;
    if (!requirement?.requirementId || requirement.status !== 'submitted') {
      throw new Error(`confirmation did not submit the requirement: ${JSON.stringify(confirmed)}`);
    }

    const queuedStatus = await jsonRequest(`${launched.url}/api/runtime/status`);
    const queuedObservation = queuedStatus.implicitScheduling ?? null;
    if (queuedObservation?.state === 'queued' && typeof queuedObservation.fifoSeq !== 'number') {
      throw new Error(`queued projection did not carry a FIFO sequence: ${JSON.stringify(queuedObservation)}`);
    }

    const { row } = await waitForTask(launched.url);
    const taskId = row.taskId.value ?? row.taskId;
    const dashboard = await waitForTerminal(launched.url, taskId);
    if (dashboard.state !== 'succeeded') {
      throw new Error(`task did not complete successfully: ${JSON.stringify(dashboard)}`);
    }
    if (!dashboard.checkpoint) {
      throw new Error(`succeeded task has no committed checkpoint: ${JSON.stringify(dashboard)}`);
    }

    const operationId = dashboard.operationId ?? null;
    const eventList = dashboard.recentEvents ?? [];
    const toolEvents = eventList.filter((event) => event.kind === 'provider.tool');
    if (toolEvents.length < 2) {
      throw new Error(`expected at least two executor tool rounds, saw ${toolEvents.length}`);
    }
    const evidencedTool = toolEvents.find((event) => Array.isArray(event.evidenceRefs) && event.evidenceRefs.length > 0);
    if (!evidencedTool) {
      throw new Error('no provider tool event carried evidence refs');
    }

    const finalList = await jsonRequest(`${launched.url}/api/tasks`);
    const finalRow = [...finalList.completed, ...finalList.running, ...finalList.waiting, ...finalList.failed]
      .find((candidate) => (candidate.taskId.value ?? candidate.taskId) === taskId);
    if (!finalRow || finalRow.state !== 'succeeded') {
      throw new Error(`task list did not project completed: ${JSON.stringify({ taskId, finalList })}`);
    }

    const providerObservation = await jsonRequest(`${launched.url}/api/tasks/${encodeURIComponent(taskId)}/observation?scope=${encodeURIComponent(`task://${taskId}/observation/pipeline.execute`)}`);
    const providerNodes = providerObservation.nodes ?? [];
    const observationTools = providerNodes.filter((node) => node.title.startsWith('provider.tool'));
    if (observationTools.length < 2) {
      throw new Error(`observation did not project at least two provider tool nodes: ${JSON.stringify(providerNodes.map((node) => node.title))}`);
    }

    receipt.record = {
      interactionId,
      draft: {
        draftId: draft.draftId,
        inputRevision: draft.inputRevision,
        proposedIntent: draft.proposedIntent,
        proposal: draft.proposal,
      },
      confirmed: {
        confirmationRef: 'confirmation:explicit-implicit-e2e',
        confirmedAt,
        requirementId: requirement.requirementId,
        fifoSeq: queuedObservation?.fifoSeq ?? null,
      },
      queuedObservation,
      taskId,
      operationId,
      finalState: dashboard.state,
      checkpoint: dashboard.checkpoint ?? null,
      requirementAdmission: finalRow.requirementAdmission ?? null,
      requirementQueue: finalRow.requirementQueue ?? null,
      toolRounds: toolEvents.map((event) => ({
        kind: event.kind,
        state: event.state,
        summary: event.summary,
        evidenceRefs: event.evidenceRefs ?? [],
      })),
      providerNodeCount: providerNodes.length,
      observationToolCount: observationTools.length,
      eventSummaries: eventList.map((event) => ({
        kind: event.kind,
        state: event.state,
        summary: event.summary,
        terminalPhase: event.terminalPhase ?? null,
      })),
    };

    await mkdir(resolve(RECEIPT_PATH, '..'), { recursive: true });
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      receipt: RECEIPT_PATH,
      interactionId,
      taskId,
      operationId,
      fifoSeq: queuedObservation?.fifoSeq ?? null,
      queued: queuedObservation?.state ?? 'already-dispatched',
      finalState: dashboard.state,
      toolRounds: toolEvents.length,
      checkpointOutcome: dashboard.checkpoint?.outcome ?? null,
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
