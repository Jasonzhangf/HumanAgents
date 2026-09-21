#!/usr/bin/env node
/**
 * Deterministic Cordis Host closeout proof.
 *
 * Drives the built HumanAgent CLI `serve --mode fake` entry over its own HTTP
 * Runtime API and records the Gate 28 Cordis Host closeout facts:
 *
 *   launch      - the live serve entry reports the fixed kernel plus the
 *                 explicit fake/template/memory/UI plugins and a complete
 *                 composition inventory
 *   execute     - POST task + execution -> SSE provider lifecycle ->
 *                 checkpoint -> final provider-close terminal
 *   projection  - task detail reports the same terminal output/state
 *   shutdown    - SIGTERM releases the daemon lease and leaves no live process
 *
 * The receipt binds the implementation commit/tree and a digest of all
 * non-evidence tracked source, then copies the durable launch, SSE, task,
 * journal, checkpoint, and lease artifacts into the receipt file. The receipt
 * itself is committed separately and does not claim to bind its carrier hash.
 *
 * Optional env:
 *   HUMANAGENT_CORDIS_RECEIPT_PATH default ./dist/receipts/cordis-host-closeout.json
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { treeDigest } from '../../scripts/digests.mjs';

const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_CORDIS_RECEIPT_PATH ?? 'dist/receipts/cordis-host-closeout.json',
);
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const EXPECTED_PLUGINS = [
  'humanagent.harness-kernel',
  'humanagent.agent-templates',
  'humanagent.fake-provider',
  'humanagent.memory',
  'humanagent.ui',
];
const EXPECTED_COMPONENTS = [
  'configuration',
  'memory',
  'provider-execution',
  'ui-runtime',
  'cordis-host',
  'fixed-harness-kernel',
  'fake-plugin',
  'template-plugin',
  'memory-plugin',
  'ui-plugin',
  'supervisor-lease-startup-dispose',
  'rejected-interaction-closure',
];
const EXPECTED_EVENT_KINDS = [
  'execution.started',
  'provider.model',
  'provider.output',
  'provider.tool',
  'provider.output',
  'execution.terminal',
  'execution.settling',
  'checkpoint.committed',
  'execution.terminal',
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function buildArtifact() {
  await rm(resolve('dist/app'), { recursive: true, force: true });
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'packages/app/tsconfig.json'], { stdio: 'inherit' });
  await cp(
    resolve('packages/agent-templates/templates'),
    resolve('dist/app/agent-templates/templates'),
    { recursive: true },
  );
}

function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes('docs/evidence/gate28-cordis-host-closeout-'))
    .sort();
  return `sha256:${createHash('sha256').update(`${entries.join('\n')}\n`).digest('hex')}`;
}

function startServe(root) {
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), '# Cordis closeout project\n', 'utf8');
  mkdirSync(controlRoot, { recursive: true });
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'fake',
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
        // Keep buffering until the launch JSON object is complete.
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr}`)));
  });

  return {
    child,
    ready,
    stderr: () => stderr,
    async stop() {
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
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch((error) => {
    if (error?.name !== 'AbortError') throw error;
  });
  return {
    events,
    async waitForTerminal(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const terminal = events.find((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final');
        if (terminal) return terminal;
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error(`timed out waiting for final terminal; saw ${events.map((event) => `${event.kind}:${event.state}`).join(', ')}`);
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

function assertLaunch(launch) {
  if (launch.mode !== 'fake') throw new Error(`unexpected mode: ${String(launch.mode)}`);
  if (JSON.stringify(launch.plugins) !== JSON.stringify(EXPECTED_PLUGINS)) {
    throw new Error(`unexpected plugin set: ${JSON.stringify(launch.plugins)}`);
  }
  if (launch.composition?.complete !== true) {
    throw new Error(`composition was not complete: ${JSON.stringify(launch.composition)}`);
  }
  for (const component of EXPECTED_COMPONENTS) {
    const observed = launch.composition.components?.find((candidate) => candidate.component === component);
    if (observed?.state !== 'composed') {
      throw new Error(`composition component ${component} was not composed: ${JSON.stringify(observed)}`);
    }
  }
  if (JSON.stringify(launch.supervisor?.stages) !== JSON.stringify(['cordis-host', 'serve-runtime', 'ui-runtime'])) {
    throw new Error(`unexpected supervisor stages: ${JSON.stringify(launch.supervisor?.stages)}`);
  }
}

function assertExecution(events, task, terminal) {
  const kinds = events.map((event) => event.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(EXPECTED_EVENT_KINDS)) {
    throw new Error(`unexpected event sequence: ${JSON.stringify(kinds)}`);
  }
  if (terminal.state !== 'succeeded' || terminal.summary !== 'execution succeeded; provider closed') {
    throw new Error(`unexpected final terminal: ${JSON.stringify(terminal)}`);
  }
  const evidence = terminal.evidenceRefs?.map((ref) => ref.evidenceId?.value) ?? [];
  for (const required of ['fake-settle-succeeded', 'fake-close']) {
    if (!evidence.includes(required)) throw new Error(`final terminal is missing ${required}: ${JSON.stringify(evidence)}`);
  }
  if (task.state !== 'ready' || task.output?.state !== 'succeeded') {
    throw new Error(`unexpected task projection: ${JSON.stringify(task)}`);
  }
}

function assertShutdown(leaseAfterShutdown) {
  if (!leaseAfterShutdown) throw new Error('shutdown did not retain a lease artifact');
  let lease;
  try {
    lease = JSON.parse(leaseAfterShutdown);
  } catch {
    throw new Error(`shutdown lease artifact is not JSON: ${leaseAfterShutdown}`);
  }
  if (typeof lease.disposedAt !== 'string' || lease.disposedAt.length === 0) {
    throw new Error(`shutdown lease has no disposedAt: ${leaseAfterShutdown}`);
  }
}

function readJsonlLines(text, label) {
  if (!text) throw new Error(`${label} artifact is missing`);
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`${label} artifact contains no records`);
  return lines.map((line, row) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} artifact row ${row} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function assertArtifacts(record) {
  const { journal, checkpoint, checkpointJournal } = record.artifacts;
  const journalLines = readJsonlLines(journal, 'event-journal');
  const checkpointLines = readJsonlLines(checkpoint, 'checkpoint');
  const uiLines = readJsonlLines(checkpointJournal, 'ui-runtime-journal');
  const checkpointRecord = checkpointLines[checkpointLines.length - 1]?.checkpoint;
  if (!checkpointRecord) {
    throw new Error('checkpoint artifact has no checkpoint record');
  }
  if (checkpointRecord.outcome !== 'succeeded') {
    throw new Error(`checkpoint outcome is not succeeded: ${checkpointRecord.outcome}`);
  }
  if (checkpointRecord.summary !== 'execution succeeded') {
    throw new Error(`checkpoint summary is not 'execution succeeded': ${checkpointRecord.summary}`);
  }
  const journalKinds = new Set(journalLines.map((line) => line.payload?.type ?? line.kind));
  for (const required of ['event', 'barrier-intent']) {
    if (!journalKinds.has(required)) {
      throw new Error(`event-journal is missing ${required}: ${[...journalKinds].join(',')}`);
    }
  }
  if (!journalLines.some((line) => line.payload?.type === 'barrier-intent' && line.payload.barrierIntent?.intent?.disposition === 'applied')) {
    throw new Error('event-journal has no applied barrier-intent for the committed checkpoint');
  }
  const pendingRetry = journalLines.find((line) =>
    line.payload?.type === 'retry' && line.payload.retry?.state === 'pending');
  if (pendingRetry) {
    throw new Error(`event-journal has a pending retry: ${JSON.stringify(pendingRetry.payload.retry)}`);
  }
  const uiEvents = uiLines.map((line) => line.kind === 'operation.event' ? line.event : line);
  const uiKinds = new Set(uiEvents.map((line) => line.kind));
  for (const required of ['task.created', 'checkpoint.committed', 'execution.terminal']) {
    if (!uiKinds.has(required)) {
      throw new Error(`ui-runtime-journal is missing ${required}: ${[...uiKinds].join(',')}`);
    }
  }
  const terminal = uiEvents.find((line) => line.kind === 'execution.terminal' && line.terminalPhase === 'final');
  if (!terminal) throw new Error(`ui-runtime-journal is missing the final terminal event`);
  const evidenceIds = (terminal.evidenceRefs ?? []).map((ref) => ref.evidenceId?.value);
  for (const required of ['fake-settle-succeeded', 'fake-close']) {
    if (!evidenceIds.includes(required)) {
      throw new Error(`final terminal evidence is missing ${required}: ${evidenceIds.join(',')}`);
    }
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function run() {
  const implementationCommit = git(['rev-parse', 'HEAD']);
  const implementationTree = git(['rev-parse', 'HEAD^{tree}']);
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('candidate worktree must be clean before proof');
  await buildArtifact();
  const artifactDigest = await treeDigest(resolve('dist/app'));
  const root = await mkdtemp(join(tmpdir(), 'humanagent-cordis-closeout-'));
  const serve = startServe(root);
  const record = {
    schemaVersion: 1,
    kind: 'humanagent.cordis-host-closeout-proof',
    generatedAt: new Date().toISOString(),
    candidate: {
      implementationCommit,
      implementationTree,
      artifactPath: resolve('dist/app'),
      artifactDigest,
      sourceDigest: sourceDigest(),
    },
    root,
    launch: null,
    requests: {},
    events: [],
    task: null,
    artifacts: {},
  };
  let stream;
  let primaryError;
  try {
    const launch = await serve.ready;
    record.launch = launch;
    assertLaunch(launch);

    const status = await jsonRequest(`${launch.url}/api/runtime/status`);
    record.requests.status = status;
    if (status.mode !== 'fake' || status.state !== 'ready') {
      throw new Error(`unexpected runtime status: ${JSON.stringify(status)}`);
    }

    const task = await jsonRequest(`${launch.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'cordis closeout', directive: 'return the deterministic fake result' }),
    });
    const taskId = task.taskId.value;
    record.requests.task = task;

    const started = await jsonRequest(`${launch.url}/api/tasks/${taskId}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'return the deterministic fake result' }),
    });
    record.requests.execution = started;

    stream = openEventStream(`${launch.url}/api/executions/${started.operationId}/events`);
    const terminal = await stream.waitForTerminal();
    record.events = stream.events;
    record.task = await jsonRequest(`${launch.url}/api/tasks/${taskId}`);
    assertExecution(record.events, record.task, terminal);

    record.artifacts.journal = await readIfPresent(launch.eventJournal);
    record.artifacts.checkpoint = await readIfPresent(join(
      launch.checkpointRoot,
      'fake',
      `task-${taskId}-cycle-ui-cycle-1.jsonl`,
    ));
    record.artifacts.checkpointJournal = await readIfPresent(join(launch.checkpointRoot, 'fake', 'ui-runtime-journal.jsonl'));
    record.artifacts.lease = await readIfPresent(launch.supervisor.leasePath);
    return record;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (stream) {
      try {
        await stream.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await serve.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (record.launch?.supervisor?.leasePath) {
        record.artifacts.leaseAfterShutdown = await readIfPresent(record.launch.supervisor.leasePath);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!primaryError && cleanupErrors.length > 0) throw cleanupErrors[0];
  }
}

async function main() {
  const receipt = await run();
  assertShutdown(receipt.artifacts.leaseAfterShutdown);
  assertArtifacts(receipt);
  await mkdir(dirname(RECEIPT_PATH), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    receipt: RECEIPT_PATH,
    implementationCommit: receipt.candidate.implementationCommit,
    journalKinds: [...new Set(JSON.parse('[' + receipt.artifacts.journal.split('\n').filter(Boolean).join(',') + ']').map((line) => line.payload?.type ?? line.kind))],
    checkpointOutcome: JSON.parse(receipt.artifacts.checkpoint.split('\n').at(-2)).checkpoint.outcome,
    terminalSummary: (function () {
      const lines = receipt.artifacts.checkpointJournal.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const terminal = lines.map((line) => line.kind === 'operation.event' ? line.event : line)
        .find((line) => line.kind === 'execution.terminal' && line.terminalPhase === 'final');
      return terminal?.summary;
    })(),
    plugins: receipt.launch.plugins,
    compositionComplete: receipt.launch.composition.complete,
    eventKinds: receipt.events.map((event) => event.kind),
    terminal: receipt.events.at(-1)?.summary,
    taskState: receipt.task.state,
  }, null, 2));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
