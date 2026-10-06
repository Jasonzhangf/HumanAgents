#!/usr/bin/env node
/**
 * Real RCC 4444 production scheduled-occurrence acceptance.
 *
 * This drives the built HumanAgent CLI `serve --mode rcc` entry — the same
 * supervisor-owned serve entry production uses — and proves that a plan the
 * public HTTP explicit-brain form persisted really executes when its `startAt`
 * arrives:
 *
 *   serve --mode rcc   - real supervisor lease, real UI runtime assembly, real
 *                        `UiRuntimeScheduler` due-time patrol, real
 *                        `OccurrenceConsumerRouter` -> `DurableOccurrenceConsumer`,
 *                        real provider port against 127.0.0.1:4444
 *   explicit form      - a `scheduled` execution policy is confirmed through
 *                        /api/explicit/... and persisted as one active plan
 *   due-time patrol    - nothing runs before `startAt`; at `startAt` the patrol
 *                        schedules the slot, claims the occurrence and drives the
 *                        real provider execution
 *   journal evidence   - the on-disk consumer journal carries exactly one
 *                        admission, one terminal checkpoint and one receipt for
 *                        the settled occurrence
 *
 * It never mocks the consumer, the lease, the journal or the scheduler clock,
 * and it removes its own fixture root and stops its own serve process on both
 * the success and the exception path.
 *
 * Required env:
 *   none (the live RCC endpoint must answer on 127.0.0.1:4444)
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL                  default http://127.0.0.1:4444
 *   HUMANAGENT_UI_MODEL                      default gpt-5.5
 *   HUMANAGENT_SCHEDULER_RCC_RECEIPT         default dist/receipts/scheduler-production-wiring-rcc-proof.json
 *   HUMANAGENT_SCHEDULER_RCC_DELAY_MS        default 8000 (scheduled startAt lead time)
 *   HUMANAGENT_SCHEDULER_RCC_RAW_DIR         optional directory for raw journal copies
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_SCHEDULER_RCC_RECEIPT ?? 'dist/receipts/scheduler-production-wiring-rcc-proof.json',
);
const RAW_DIR = process.env.HUMANAGENT_SCHEDULER_RCC_RAW_DIR;
const START_DELAY_MS = Number(process.env.HUMANAGENT_SCHEDULER_RCC_DELAY_MS ?? 8_000);
const TERMINAL_TIMEOUT_MS = 600_000;
const WORKSPACE_FILE = 'scheduled-notes.txt';
const WORKSPACE_CONTENT = 'the scheduled production occurrence read this file through the real RCC provider';

const jsonlModule = new URL('../../dist/tests/packages/adapters/jsonl/src/index.js', import.meta.url).href;
const { JsonlOrganJournal } = await import(jsonlModule);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms));
}

function startServe({ workspace, controlRoot }) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'ui-scheduler-production-rcc',
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', 'rcc/ui-scheduler-production',
    '--rcc-base-url', RCC_BASE_URL,
    '--workspace', workspace,
    '--control-root', controlRoot,
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr}`)), 60_000);
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
    pid: child.pid,
    logs: () => ({ stdout, stderr }),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

/** Pair this process with the live serve owner through the real pairing command. */
async function pairSession({ workspace, controlRoot, base }) {
  const raw = execFileSync(process.execPath, [
    CLI_PATH, 'pair', '--workspace', workspace, '--control-root', controlRoot,
  ], { encoding: 'utf8' });
  const challenge = JSON.parse(raw);
  assert.ok(typeof challenge.code === 'string' && challenge.code !== '', `the pair command returned a code: ${raw}`);
  const response = await fetch(`${base}/api/auth/pair`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code: challenge.code }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `pairing must succeed: ${text}`);
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = values.map((value) => String(value).split(';')[0]).filter(Boolean).join('; ');
  assert.ok(cookie !== '', 'pairing returned a browser session cookie');
  return cookie;
}

/** Confirm one `scheduled` execution policy through the real public HTTP form entry. */
async function confirmScheduledPlan(call, rawInput, startAt) {
  const created = await call('/api/explicit/inputs', {
    method: 'POST',
    body: {
      sourceRef: 'ui:scheduler-production-rcc',
      rawInput,
      channel: 'business',
      requestKind: 'new-task-preview',
    },
  });
  const interactionId = created.interactionId;
  assert.ok(typeof interactionId === 'string' && interactionId !== '', 'the input route returned an interaction id');
  const route = `/api/explicit/interactions/${encodeURIComponent(interactionId)}`;
  await call(`${route}/matching`, { method: 'POST', body: {} });
  await call(`${route}/match`, {
    method: 'POST',
    body: { normalizedInput: rawInput, matchedTasks: [], knownFacts: [] },
  });
  await call(`${route}/proposal`, {
    method: 'POST',
    body: { proposedIntent: 'create', proposal: `create:${rawInput}` },
  });
  const snapshot = await call(route);
  assert.ok(snapshot.draft, 'the explicit flow produced a reviewable draft');
  const confirmed = await call(`${route}/confirmation`, {
    method: 'POST',
    body: {
      draftId: snapshot.draft.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:scheduler-production-rcc',
      confirmedBy: 'human:operator',
      confirmedAt: new Date().toISOString(),
      payloadRef: 'asset://requirements/scheduler-production-rcc',
      executionPolicy: {
        policyId: 'policy-scheduler-production-rcc',
        policyRevision: 1,
        timezone: 'UTC',
        canonicalInstant: new Date().toISOString(),
        dstMode: 'wall',
        dstMissedPolicy: 'shift-forward',
        dstAmbiguousPolicy: 'earlier-offset',
        latePolicy: 'run-once',
        busyPolicy: 'skip',
        executionMode: 'scheduled',
        startAt,
      },
    },
  });
  assert.ok(typeof confirmed.requirement?.requirementId === 'string' && confirmed.requirement.requirementId !== '',
    `the confirmation persisted the requirement: ${JSON.stringify(confirmed)}`);
  return confirmed.requirement.requirementId;
}

function planFor(status, requirementId) {
  const plan = (status.plans ?? []).find((candidate) => candidate.subscriptionId === `subscription:${requirementId}`);
  assert.ok(plan, `the patrol reports the persisted plan for ${requirementId}: ${JSON.stringify(status.plans ?? [])}`);
  return plan;
}

/** Recursively collect files under a root whose path matches a segment. */
async function findFiles(root, predicate) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (predicate(path)) found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

async function main() {
  const health = await fetch(`${RCC_BASE_URL}/health`);
  assert.equal(health.status, 200, 'RCC health endpoint must answer 200');
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok', 'RCC health endpoint must report status ok');

  const candidateSha = git(['rev-parse', 'HEAD']);
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-rcc-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, WORKSPACE_FILE), `${WORKSPACE_CONTENT}\n`);

  const serve = startServe({ workspace, controlRoot });
  let report;
  try {
    const launched = await serve.ready;
    const base = launched.url;
    assert.ok(typeof base === 'string' && base.startsWith('http'), 'serve reported an HTTP origin');
    const cookie = await pairSession({ workspace, controlRoot, base });
    const call = async (path, init = {}) => {
      const headers = { origin: base, cookie, accept: 'application/json' };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response from ${path}: ${text.slice(0, 400)}`);
      }
      if (!response.ok) throw new Error(`request failed ${response.status} ${path}: ${text.slice(0, 800)}`);
      return body;
    };

    const prompt = [
      `Use the file.read tool to read the file at path "${WORKSPACE_FILE}" in the workspace`,
      '(the file itself, not a directory).',
      'Then report its exact content.',
    ].join(' ');
    const startAt = new Date(Date.now() + START_DELAY_MS).toISOString();
    const requirementId = await confirmScheduledPlan(call, prompt, startAt);

    // 1. The plan must exist and must not have run before its due time.
    await sleep(Math.max(1_000, Math.floor(START_DELAY_MS / 2)));
    const early = await call('/api/runtime/scheduler');
    assert.equal(early.state, 'running', 'the patrol is armed under the real serve lease');
    const earlyPlan = planFor(early, requirementId);
    assert.equal(earlyPlan.state, 'active', 'the persisted plan is active');
    assert.equal(earlyPlan.settlements.length, 0, 'no occurrence settles before startAt');
    assert.equal(early.executed, 0, 'no occurrence executes before startAt');
    const earlyTasks = await call('/api/tasks');
    const scheduledBefore = [...(earlyTasks.running ?? []), ...(earlyTasks.completed ?? [])]
      .filter((task) => String(task.taskId?.value ?? '').startsWith('scheduled-task-'));
    assert.equal(scheduledBefore.length, 0, 'no scheduled task exists before startAt');

    // 2. Wait for the real due-time execution and its settlement.
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
    let settledPlan;
    let status;
    for (;;) {
      status = await call('/api/runtime/scheduler');
      settledPlan = planFor(status, requirementId);
      if (settledPlan.settlements.length === 1) break;
      if (Date.now() > deadline) {
        throw new Error(`the scheduled occurrence did not settle: ${JSON.stringify(settledPlan)} issue=${JSON.stringify(status.issue ?? null)}`);
      }
      await sleep(1_000);
    }
    const settlement = settledPlan.settlements[0];
    assert.equal(settlement.verificationStatus, 'success', 'the real RCC execution settled as a verified success');
    assert.ok(settlement.occurrenceId, 'the settlement names the occurrence it settled');
    assert.ok(status.executed >= 1, 'the patrol recorded a real execution');
    assert.ok(status.claimed >= 1, 'the patrol recorded a real claim');

    // 3. The executed task is observable through the public task surface.
    const tasks = await call('/api/tasks');
    const all = [
      ...(tasks.running ?? []), ...(tasks.completed ?? []), ...(tasks.waiting ?? []),
      ...(tasks.stopped ?? []), ...(tasks.failed ?? []),
    ];
    const executedTask = all.find((task) => String(task.taskId?.value ?? '').startsWith('scheduled-task-'));
    assert.ok(executedTask, `the executed occurrence task is listed publicly: ${JSON.stringify(all.map((task) => task.taskId?.value))}`);
    const dashboard = await call(`/api/tasks/${executedTask.taskId.value}/dashboard`);
    assert.equal(dashboard.state, 'succeeded', 'the scheduled task dashboard reached succeeded');
    assert.equal(dashboard.checkpoint?.outcome, 'succeeded', 'the committed checkpoint outcome is succeeded');

    // 4. Real provider evidence exists on disk for this execution. The serve
    //    output reports `<projectRoot>/checkpoints/ui-runtime`, so the artifact
    //    root is two levels up.
    const projectRoot = resolve(launched.checkpointRoot, '..', '..');
    const evidenceRoot = join(projectRoot, 'artifacts', 'ui-provider-evidence');
    const evidenceFiles = await findFiles(evidenceRoot, () => true);
    assert.ok(evidenceFiles.length > 0, `the real RCC provider left evidence artifacts under ${evidenceRoot}`);

    // 5. The durable consumer journal carries admission, checkpoint and receipt.
    const journals = await findFiles(launched.checkpointRoot, (path) => path.includes('occurrence-consumer') && path.endsWith('.jsonl'));
    assert.equal(journals.length, 1, `exactly one occurrence consumer journal exists: ${JSON.stringify(journals)}`);
    const records = await new JsonlOrganJournal(journals[0]).replay();
    if (RAW_DIR !== undefined && RAW_DIR.trim() !== '') {
      await mkdir(RAW_DIR, { recursive: true });
      await writeFile(
        join(RAW_DIR, 'occurrence-consumer-journal.jsonl'),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    }
    // Admission and receipt are typed event payloads; the checkpoint is its own
    // journal record kind. The journal record kind is never overloaded.
    const shape = records.map((record) => ({ kind: record.kind, payloadKind: record.payload?.kind ?? null }));
    const admissions = records.filter((record) => record.kind === 'event'
      && record.payload?.kind === 'occurrence-execution-admission');
    const checkpoints = records.filter((record) => record.kind === 'checkpoint');
    const receipts = records.filter((record) => record.kind === 'event'
      && record.payload?.kind === 'occurrence-terminal-receipt');
    assert.equal(admissions.length, 1, `one admission record: ${JSON.stringify(shape)}`);
    assert.equal(checkpoints.length, 1, `one terminal checkpoint record: ${JSON.stringify(shape)}`);
    assert.equal(receipts.length, 1, `one terminal receipt record: ${JSON.stringify(shape)}`);
    const checkpoint = checkpoints[0];
    assert.equal(checkpoint.checkpoint.outcome, 'succeeded', 'the journaled checkpoint outcome is succeeded');
    assert.equal(receipts[0].payload.verification?.status, 'success', 'the journaled receipt verification is success');

    report = {
      command: 'node tests/app/scheduler-production-wiring-rcc-e2e.mjs',
      candidateSha,
      rcc: {
        baseUrl: RCC_BASE_URL,
        health: { status: healthBody.status, version: healthBody.version, buildVersion: healthBody.build_version },
      },
      serve: {
        url: base,
        pid: serve.pid,
        checkpointRoot: launched.checkpointRoot,
        supervisor: launched.supervisor,
      },
      plan: {
        requirementId,
        subscriptionId: settledPlan.subscriptionId,
        state: settledPlan.state,
        currentOccurrenceOrdinal: settledPlan.currentOccurrenceOrdinal,
        occurrenceId: settlement.occurrenceId,
        occurrenceOrdinal: settlement.occurrenceOrdinal,
        verificationStatus: settlement.verificationStatus,
        settlementReceiptRef: settlement.settlementReceiptRef,
      },
      patrol: {
        state: status.state,
        ticks: status.ticks,
        claimed: status.claimed,
        executed: status.executed,
        settled: status.settled,
        skipped: status.skipped,
      },
      task: {
        taskId: executedTask.taskId.value,
        dashboardState: dashboard.state,
        checkpointOutcome: dashboard.checkpoint?.outcome,
      },
      consumerJournal: {
        path: journals[0],
        recordKinds: shape,
        commitIds: records.map((record) => record.commitId),
        admissionCount: admissions.length,
        checkpointCount: checkpoints.length,
        receiptCount: receipts.length,
        checkpointOutcome: checkpoint.checkpoint.outcome,
        receiptVerificationStatus: receipts[0].payload.verification?.status,
      },
      providerEvidenceFileCount: evidenceFiles.length,
      providerEvidenceRoot: evidenceRoot,
      noExecutionBeforeStartAt: true,
    };
  } finally {
    await serve.stop();
    await rm(root, { recursive: true, force: true });
  }

  await mkdir(resolve(RECEIPT_PATH, '..'), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    receiptPath: RECEIPT_PATH,
    candidateSha: report.candidateSha,
    plan: report.plan,
    patrol: report.patrol,
    consumerJournal: {
      path: report.consumerJournal.path,
      admissionCount: report.consumerJournal.admissionCount,
      checkpointCount: report.consumerJournal.checkpointCount,
      receiptCount: report.consumerJournal.receiptCount,
      checkpointOutcome: report.consumerJournal.checkpointOutcome,
    },
  }, null, 2)}\n`);
}

const isMainModule = process.argv[1] !== undefined
  && new URL(`file://${resolve(process.argv[1])}`).href === import.meta.url;

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
