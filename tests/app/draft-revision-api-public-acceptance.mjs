#!/usr/bin/env node
/**
 * Public HTTP acceptance for the typed draft-revision API.
 *
 * Drives the real `/api/explicit/*` routes through an isolated `serve` process
 * in rcc mode with the live RCC provider. It covers the pre-confirmation typed
 * revision, refine, regenerate, formal rejection, stale-revision rejection,
 * idempotent repeated/concurrent submit, once/scheduled/recurring subscription
 * persistence, restart replay, and the legacy confirmation path. No browser,
 * fake provider, or source-structure assertion is used.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeProvider, startServeForAttempt } from './dashboard-e2e/lib/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const EVIDENCE_DIR = process.env.HUMANAGENT_DRAFT_REVISION_EVIDENCE_DIR
  ?? '/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/interaction-draft-revision-api-20261005/raw/http-acceptance';
const RECEIPT_PATH = join(EVIDENCE_DIR, 'draft-revision-api-public.receipt.json');
const RAW_LOG_PATH = join(EVIDENCE_DIR, 'draft-revision-api-public.raw.log');

const logs = [];
const startedAt = new Date().toISOString();
const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const receipt = {
  proof: 'draft-revision-api-public-http',
  status: 'RUNNING',
  candidateSha: null,
  startedAt,
  endedAt: null,
  evidenceDir: EVIDENCE_DIR,
  receiptPath: RECEIPT_PATH,
  rawLogPath: RAW_LOG_PATH,
  rcc: null,
  runtime: null,
  cases: [],
  subscriptions: null,
  firstDeviation: null,
  cleanup: null,
};

const policyBase = {
  policyRevision: 1,
  timezone: 'UTC',
  canonicalInstant: '2026-10-05T00:00:00.000Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'skip',
};
const oncePolicy = { ...policyBase, policyId: 'accept-once', executionMode: 'once', dueAt: '2026-10-05T00:00:00.000Z' };
const scheduledPolicy = { ...policyBase, policyId: 'accept-scheduled', timezone: 'America/Los_Angeles', executionMode: 'scheduled', startAt: '2026-10-05T01:00:00.000Z' };
const recurringPolicy = { ...policyBase, policyId: 'accept-recurring', executionMode: 'recurring', startAt: '2026-10-05T00:00:00.000Z', endAt: '2026-10-05T02:30:00.000Z', maxOccurrences: 10, frequency: 'interval', intervalMinutes: 60 };

let root = null;
let binding = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logs.push(line);
  console.error(line);
}

function record(name, data) {
  receipt.cases.push({ name, ...data });
  return data;
}

function fail(code, message, affected) {
  receipt.firstDeviation = { code, message, affected };
  receipt.status = 'RED';
  throw new Error(`${code}: ${message}`);
}

async function request(path, init = {}) {
  const url = new URL(path, binding.serveBaseUrl);
  const response = await binding.auth.fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 4000) };
  }
  return { path: url.pathname, method: init.method ?? 'GET', status: response.status, body };
}

function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function newTypedInteraction(label, rawInput) {
  const created = await post('/api/explicit/inputs', {
    channel: 'business',
    requestKind: 'new-task-preview',
    sourceRef: `accept-${label}-${attemptId}`,
    rawInput,
  });
  if (created.status !== 201 || typeof created.body?.interactionId !== 'string') {
    fail('explicit-input.create-failed', `create failed for ${label}`, created);
  }
  const interactionId = created.body.interactionId;
  const interpreted = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {});
  if (interpreted.status !== 200) {
    fail('explicit-input.interpret-failed', `interpret failed for ${label}`, interpreted);
  }
  return { interactionId, interpreted };
}

async function readSubscriptions() {
  const file = join(binding.serveCheckpointRoot ?? '', 'rcc', 'subscriptions.jsonl');
  if (!existsSync(file)) return {};
  const raw = await readFile(file, 'utf8');
  let latest = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const state = parsed?.payload?.state;
      if (state && typeof state === 'object' && state.subscriptions) latest = state.subscriptions;
    } catch {
      // ignore partial lines
    }
  }
  return latest;
}

async function stopServe() {
  if (binding?.serve) await binding.serve.stop();
}

async function startServe() {
  await startServeForAttempt(binding, { readyTimeoutMs: 90_000 });
  receipt.serve = {
    pid: binding.servePid,
    port: binding.servePort,
    baseUrl: binding.serveBaseUrl,
    controlRoot: binding.controlRoot,
    checkpointRoot: binding.serveCheckpointRoot,
    workspace: binding.workspace,
  };
}

async function main() {
  root = await mkdtemp(join(tmpdir(), 'humanagent-draft-revision-http-'));
  binding = {
    attemptId,
    attemptRoot: root,
    repoPath: REPO_ROOT,
    workspace: join(root, 'workspace'),
    controlRoot: join(root, 'control'),
  };
  receipt.attemptRoot = root;
  receipt.candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  try {
    try {
      receipt.rcc = await probeProvider(binding);
    } catch (error) {
      receipt.status = 'BLOCKED';
      throw new Error(`RCC provider is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    await startServe();
    const runtime = await request('/api/runtime/status');
    receipt.runtime = { status: runtime.status, state: runtime.body?.state ?? null, providerState: runtime.body?.providerState ?? null };
    if (runtime.status !== 200) fail('runtime-status.failed', 'runtime status was not 200', runtime);

    // 1. Pre-confirmation typed revision + refine + regenerate.
    const main = await newTypedInteraction('main', 'Create exactly one concrete task: summarize the current workspace marker file.');
    const base = await request(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}`);
    const baseRevision = base.body?.revision;
    if (base.status !== 200 || !baseRevision) {
      fail('typed-revision.missing', 'public GET did not project the typed revision before confirmation', base);
    }
    for (const field of ['draftId', 'revisionVersion', 'revisionHash', 'state', 'goal', 'scope', 'constraints', 'deliverables']) {
      if (baseRevision[field] === undefined) fail('typed-revision.field-missing', `typed revision is missing ${field}`, { field, baseRevision });
    }
    record('pre-confirmation-typed-revision', { interactionId: main.interactionId, revision: baseRevision });

    const refined = await post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/refine`, {
      draftId: baseRevision.draftId,
      baseRevisionVersion: baseRevision.revisionVersion,
      requestedRevisionHash: baseRevision.revisionHash,
      fields: {
        goal: 'Summarize the workspace marker file precisely',
        scope: 'Read only the workspace marker file and report its contents',
        normalizedInput: 'Summarize the workspace marker file precisely; read only the workspace marker file.',
      },
      instructionRef: `refine:${main.interactionId}`,
      idempotencyKey: `refine:${main.interactionId}:1`,
    });
    const refinedRevision = refined.body?.revision;
    if (refined.status !== 200 || !refinedRevision || refinedRevision.revisionVersion <= baseRevision.revisionVersion) {
      fail('refine.failed', 'public refine did not return a newer typed revision', refined);
    }
    record('refine', { revision: refinedRevision });

    const regenerated = await post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/regenerate`, {
      instruction: 'Also state the marker file name in the summary.',
    });
    if (regenerated.status !== 200 || !regenerated.body?.revision) {
      fail('regenerate.failed', 'public regenerate did not return a typed revision', regenerated);
    }
    record('regenerate', { revision: regenerated.body.revision });

    // 2. Stale revision must be rejected with a readable error and no side effect.
    const staleConfirm = await post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/confirmation`, {
      draftId: baseRevision.draftId,
      inputRevision: baseRevision.inputRevision,
      confirmationRef: `confirmation:stale:${main.interactionId}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: `asset://requirements/stale:${main.interactionId}`,
      draftRevisionVersion: baseRevision.revisionVersion,
      draftRevisionHash: baseRevision.revisionHash,
    });
    if (staleConfirm.status === 200) {
      fail('stale-revision.accepted', 'a stale revision confirmation was silently accepted', staleConfirm);
    }
    const staleCode = staleConfirm.body?.error?.code;
    const staleMessage = staleConfirm.body?.error?.message;
    if (typeof staleCode !== 'string' || !staleCode.startsWith('explicit-draft.')) {
      fail('stale-revision.code-missing', 'stale revision rejection did not preserve a readable typed error', staleConfirm);
    }
    record('stale-revision-rejected', { status: staleConfirm.status, code: staleCode, message: staleMessage });

    // 3. Confirm the current revision with the once policy; repeated and
    //    concurrent submits must reuse exactly one subscription.
    const current = (await request(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}`)).body.revision;
    const confirmBody = {
      draftId: current.draftId,
      inputRevision: current.inputRevision,
      confirmationRef: `confirmation:main:${main.interactionId}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: `asset://requirements/main:${main.interactionId}`,
      draftRevisionVersion: current.revisionVersion,
      draftRevisionHash: current.revisionHash,
      executionPolicy: oncePolicy,
    };
    const firstConfirm = await post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/confirmation`, confirmBody);
    if (firstConfirm.status !== 200) fail('confirm.failed', 'the current revision confirmation failed', firstConfirm);
    const requirementId = firstConfirm.body?.requirement?.requirementId;
    const [repeat, concurrentA, concurrentB] = await Promise.all([
      post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/confirmation`, confirmBody),
      post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/confirmation`, confirmBody),
      post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/confirmation`, confirmBody),
    ]);
    for (const [label, response] of [['repeat', repeat], ['concurrentA', concurrentA], ['concurrentB', concurrentB]]) {
      if (response.status !== 200 || response.body?.requirement?.requirementId !== requirementId) {
        fail('confirm.idempotency-broken', `${label} submit did not reuse the requirement`, response);
      }
    }
    record('idempotent-submit', { requirementId, repeat: repeat.status, concurrentA: concurrentA.status, concurrentB: concurrentB.status });

    // 4. Scheduled and recurring interactions each persist one subscription.
    for (const [label, policy] of [['scheduled', scheduledPolicy], ['recurring', recurringPolicy]]) {
      const scoped = await newTypedInteraction(label, `Create exactly one concrete task: ${label} acceptance work.`);
      const revision = (await request(`/api/explicit/interactions/${encodeURIComponent(scoped.interactionId)}`)).body.revision;
      const confirmed = await post(`/api/explicit/interactions/${encodeURIComponent(scoped.interactionId)}/confirmation`, {
        draftId: revision.draftId,
        inputRevision: revision.inputRevision,
        confirmationRef: `confirmation:${label}:${scoped.interactionId}`,
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-05T00:00:00.000Z',
        payloadRef: `asset://requirements/${label}:${scoped.interactionId}`,
        draftRevisionVersion: revision.revisionVersion,
        draftRevisionHash: revision.revisionHash,
        executionPolicy: policy,
      });
      if (confirmed.status !== 200) fail(`confirm.${label}-failed`, `${label} confirmation failed`, confirmed);
      record(`confirm-${label}`, { requirementId: confirmed.body?.requirement?.requirementId });
    }

    const beforeRestart = await readSubscriptions();
    const beforeKeys = Object.keys(beforeRestart);
    record('subscriptions-before-restart', { count: beforeKeys.length, keys: beforeKeys });
    if (beforeKeys.length !== 3) fail('subscriptions.count-mismatch', `expected 3 subscriptions before restart, found ${beforeKeys.length}`, beforeRestart);

    // 5. Restart with the same control root and replay the main confirmation.
    await stopServe();
    binding.serve = null;
    binding.serveChild = null;
    await startServe();
    const replayed = await post(`/api/explicit/interactions/${encodeURIComponent(main.interactionId)}/confirmation`, confirmBody);
    if (replayed.status !== 200 || replayed.body?.requirement?.requirementId !== requirementId) {
      fail('restart.replay-broken', 'restart replay did not reuse the requirement', replayed);
    }
    const afterRestart = await readSubscriptions();
    record('restart-replay', { requirementId, afterRestartCount: Object.keys(afterRestart).length });
    if (Object.keys(afterRestart).length !== 3) {
      fail('restart.subscription-count', 'restart replay changed the subscription count', { before: beforeKeys.length, after: Object.keys(afterRestart).length });
    }

    // 6. Formal rejection returns a closure receipt and blocks submission.
    const rejectable = await newTypedInteraction('reject', 'Create exactly one concrete task: reject acceptance work.');
    const rejectRevision = (await request(`/api/explicit/interactions/${encodeURIComponent(rejectable.interactionId)}`)).body.revision;
    const rejected = await post(`/api/explicit/interactions/${encodeURIComponent(rejectable.interactionId)}/reject`, {
      reason: 'user abandoned the draft',
      rejectionId: `rejection:${rejectable.interactionId}`,
    });
    const closure = rejected.body?.closure;
    if (rejected.status !== 200 || !closure || closure.durable !== true || closure.reason !== 'user abandoned the draft') {
      fail('reject.no-closure', 'formal rejection did not return a durable closure receipt', rejected);
    }
    const postRejectConfirm = await post(`/api/explicit/interactions/${encodeURIComponent(rejectable.interactionId)}/confirmation`, {
      draftId: rejectRevision.draftId,
      inputRevision: rejectRevision.inputRevision,
      confirmationRef: `confirmation:reject:${rejectable.interactionId}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: `asset://requirements/reject:${rejectable.interactionId}`,
      draftRevisionVersion: rejectRevision.revisionVersion,
      draftRevisionHash: rejectRevision.revisionHash,
      executionPolicy: oncePolicy,
    });
    if (postRejectConfirm.status === 200) fail('reject.still-submittable', 'a rejected draft could still be submitted', postRejectConfirm);
    record('reject-closure', { closure, postRejectStatus: postRejectConfirm.status, postRejectCode: postRejectConfirm.body?.error?.code });

    // 7. Legacy confirmation path (no requestKind, no policy) still works.
    const legacyCreated = await post('/api/explicit/inputs', {
      channel: 'business',
      sourceRef: `accept-legacy-${attemptId}`,
      rawInput: 'Create exactly one concrete task: legacy confirmation acceptance work.',
    });
    if (legacyCreated.status !== 201) fail('legacy.create-failed', 'legacy explicit input create failed', legacyCreated);
    const legacyId = legacyCreated.body.interactionId;
    const legacyInterpreted = await post(`/api/explicit/interactions/${encodeURIComponent(legacyId)}/interpret`, {});
    if (legacyInterpreted.status !== 200 || legacyInterpreted.body?.revision !== undefined) {
      fail('legacy.unexpected-revision', 'untyped interaction unexpectedly exposed a typed revision', legacyInterpreted);
    }
    const legacyDraft = legacyInterpreted.body?.draft;
    const legacyConfirm = await post(`/api/explicit/interactions/${encodeURIComponent(legacyId)}/confirmation`, {
      draftId: legacyDraft.draftId,
      inputRevision: legacyDraft.inputRevision,
      confirmationRef: `confirmation:legacy:${legacyId}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      payloadRef: `asset://requirements/legacy:${legacyId}`,
    });
    if (legacyConfirm.status !== 200 || typeof legacyConfirm.body?.requirement?.requirementId !== 'string') {
      fail('legacy.confirm-failed', 'legacy confirmation path regressed', legacyConfirm);
    }
    record('legacy-confirm', { status: legacyConfirm.status, requirementId: legacyConfirm.body.requirement.requirementId });

    receipt.subscriptions = { beforeRestart: beforeKeys, afterRestart: Object.keys(afterRestart) };
    receipt.status = 'PASS';
  } finally {
    let cleanupError = null;
    try {
      await stopServe();
    } catch (error) {
      cleanupError = `serve stop failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (root) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupError = cleanupError
          ? `${cleanupError}; temp root removal failed: ${error instanceof Error ? error.message : String(error)}`
          : `temp root removal failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    receipt.cleanup = {
      servePid: binding?.servePid ?? null,
      serveStopped: !binding?.serveChild || binding.serveChild.exitCode !== null || binding.serveChild.signalCode !== null,
      tempRoot: root,
      tempRootRemoved: root === null || !existsSync(root),
      error: cleanupError,
    };
    receipt.endedAt = new Date().toISOString();
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await writeFile(RAW_LOG_PATH, `${logs.join('\n')}\n`, 'utf8');
  }
}

main()
  .catch(async (error) => {
    if (receipt.status === 'RUNNING') receipt.status = 'ERROR';
    receipt.error = error instanceof Error ? error.message : String(error);
    log(receipt.error);
  })
  .finally(() => {
    const code = receipt.status === 'PASS' ? 0 : 1;
    receipt.exitCode = code;
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`, () => process.exit(code));
  });
