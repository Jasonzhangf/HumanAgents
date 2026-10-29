#!/usr/bin/env node
/**
 * Real explicit -> FIFO -> independently granted execution -> public delivery.
 * Uses an already allocated stable serve entry. Never starts a CLI or a model.
 * Required env: HUMANAGENT_EI_BASE_URL, HUMANAGENT_EI_COOKIE (paired session).
 * Optional: HUMANAGENT_EI_RECEIPT_PATH, inside ~/.humanagent/test-fixtures.
 * Receipts contain public responses, never the pairing cookie. Failed runs keep
 * their receipt and Task recovery responsibility; they never retry by new Task.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TERMINAL_TIMEOUT_MS = 420_000;
const FIXTURE_BASE = join(homedir(), '.humanagent', 'test-fixtures');
const BUSINESS_INPUT = '分析以下交付事实并形成可执行建议。甲方案两人开发三天后可试用，缺点是导出需人工处理；乙方案一人开发七天，支持自动导出，但依赖尚未接入。首批只有五名内部用户，必须本周试用，导出每天一次即可。请先核实约束，再比较两案，给出选择、理由、两步执行建议和仍未知的问题。只使用给定材料，不访问网络或用户文件。';
const IDENTITY_KEYS = ['requirementId', 'draftId', 'inputRevision', 'draftRevisionVersion', 'draftRevisionHash', 'confirmationRef'];
const valueOf = (identity) => typeof identity === 'string' ? identity : identity?.value;
const delay = () => new Promise((settle) => setTimeout(settle, 1000));

function required(condition, field) {
  if (!condition) throw new Error(`UNVERIFIED: missing or inconsistent public ${field}`);
}

// Reuse the parent's paired session. Never read credentials/config or substitute
// an anonymous/forged principal. Do not print headers or the cookie.
async function jsonRequest(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: process.env.HUMANAGENT_EI_COOKIE, origin: base, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TERMINAL_TIMEOUT_MS),
  });
  let result;
  try { result = await response.json(); } catch {
    throw new Error(`non-JSON public response: ${response.status} ${path}`);
  }
  if (!response.ok) {
    const error = new Error(`public request failed: ${response.status} ${path}`);
    error.publicResponse = result;
    throw error;
  }
  return result;
}

async function interpretUntilDraft(base, input, steps) {
  steps.input = input;
  steps.received = await jsonRequest(base, '/api/explicit/inputs', {
    channel: 'business', requestKind: 'new-task-preview', inputRevision: 1,
    sourceRef: input.sourceRef, rawInput: input.rawInput,
  });
  required(typeof steps.received.interactionId === 'string', 'input.interactionId');
  const path = `/api/explicit/interactions/${encodeURIComponent(steps.received.interactionId)}`;
  let snapshot = await jsonRequest(base, path);
  if (snapshot.state === 'received' || snapshot.state === 'matching') {
    snapshot = await jsonRequest(base, `${path}/interpret`, {});
  }
  steps.organized = snapshot;
  required(snapshot.state === 'awaiting-confirmation' && snapshot.draft?.proposedIntent === 'create',
    'typed new-task preview awaiting-confirmation/create (no legacy fallback)');
  return { interaction: snapshot, draft: snapshot.draft };
}

async function confirmDraft(base, interaction, draft, identity) {
  // Same submit-handler ordering as docs/ui/requirement-submission.js. This
  // programmatic step does not add a second human business confirmation.
  return jsonRequest(base, `/api/explicit/interactions/${encodeURIComponent(interaction.interactionId)}/confirmation`, {
    draftId: draft.draftId, inputRevision: draft.inputRevision,
    ...(interaction.revision?.revisionVersion === undefined ? {}
      : { draftRevisionVersion: interaction.revision.revisionVersion }),
    ...(interaction.revision?.revisionHash === undefined ? {}
      : { draftRevisionHash: interaction.revision.revisionHash }),
    ...identity, confirmedBy: 'human:operator',
  });
}

function taskRows(list) {
  return ['running', 'waiting', 'completed', 'stopped', 'draft', 'failed']
    .flatMap((key) => list[key] ?? []);
}

async function waitForImplicitTask(base, requirement, steps) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    steps.taskList = await jsonRequest(base, '/api/tasks');
    // Exact committed TaskIdentity source. Never use title, a generated ID
    // convention, the first row, or event text to decide which Task to grant.
    const matches = taskRows(steps.taskList).filter((row) => IDENTITY_KEYS.every(
      (key) => row.identitySource?.[key] === requirement[key]));
    required(matches.length <= 1, 'unique TaskIdentity for accepted requirement');
    if (matches.length === 1) {
      const taskId = valueOf(matches[0].taskId);
      required(typeof taskId === 'string' && taskId.length > 0, 'TaskIdentity taskId');
      steps.identityRow = matches[0];
      return taskId;
    }
    if (Date.now() >= deadline) {
      throw new Error('UNVERIFIED: /api/tasks exposes no exact identitySource for final requirement; needs App public identity readback, not a guessed Task ID');
    }
    steps.scheduling = await jsonRequest(base, '/api/runtime/status');
    const fifo = steps.scheduling.implicitScheduling;
    if (fifo?.requirementId === requirement.requirementId) {
      assert.equal(fifo.draftId, requirement.draftId);
      assert.equal(fifo.fifoSeq, requirement.fifoSeq);
      steps.fifoObservation = fifo;
      required(!['failed', 'blocked'].includes(fifo.state), 'FIFO dispatch not blocked');
    }
    await delay();
  }
}

function assertSameExecution(actual, expected) {
  required(actual && valueOf(actual.taskId) === valueOf(expected.taskId), 'execution.taskId');
  assert.equal(actual.operationId, expected.operationId, 'retain original prepared operation');
  assert.equal(actual.executionEpoch, expected.executionEpoch, 'retain original allocation epoch');
}

async function pollTaskState(base, taskId, prepared, steps) {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  for (;;) {
    steps.dashboard = await jsonRequest(base, `/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
    assertSameExecution(steps.dashboard, prepared);
    if (steps.dashboard.state === 'succeeded') return steps.dashboard;
    if (['blocked', 'failed', 'stopped', 'unknown'].includes(steps.dashboard.state)) {
      throw new Error(`Task did not complete: ${steps.dashboard.state}; inspect saved public error/nextStep`);
    }
    if (Date.now() >= deadline) throw new Error('UNVERIFIED: standard turn/save/Planner did not reach Task succeeded before deadline; no automatic resume/start');
    await delay();
  }
}

function readValue(result, field) {
  required(result?.ok === true, `${field} readback${result?.failure?.code ? ` (${result.failure.code})` : ''}`);
  return result.value;
}

async function captureObservation(base, taskId, dashboard, steps) {
  const path = `/api/tasks/${encodeURIComponent(taskId)}`;
  steps.detail = await jsonRequest(base, path);
  steps.observation = await jsonRequest(base, `${path}/observation`);
  const activity = readValue(dashboard.agentActivity, 'Dashboard.agentActivity');
  steps.planner = [...activity.current, ...activity.historical, ...activity.unknown].filter(
    (entry) => entry.sourceKind === 'closed-turn-planner-call'
      && entry.executionEpoch === dashboard.executionEpoch);
  required(steps.planner.some((entry) => entry.commitRefs?.length > 0), 'independent closed-turn Planner committed activity');
  const plans = readValue(dashboard.taskPlanHistory, 'Dashboard.taskPlanHistory');
  required(plans.current?.state === 'known', 'accepted current task plan');
  required(plans.revisions.some((revision) => revision.revisionId === plans.current.value.revisionId),
    'accepted current plan revision readback');
  steps.planHistory = plans;
  required(dashboard.checkpoint?.checkpointId && dashboard.checkpoint.seq > 0, 'committed standard checkpoint');
  required(plans.scope?.projectKey && plans.scope.mode, 'checkpoint read projectKey/mode');
  const query = new URLSearchParams({
    projectKey: plans.scope.projectKey, mode: plans.scope.mode,
    checkpointId: dashboard.checkpoint.checkpointId,
  });
  steps.checkpointsResponse = await jsonRequest(base, `${path}/checkpoints?${query}`);
  // HTTP writeReadResult unwraps successful reads; Dashboard's embedded reads
  // above retain their RuntimeReadResult wrapper.
  const checkpoints = steps.checkpointsResponse;
  required(checkpoints.surface === 'runtime-checkpoint-history', 'checkpoint history HTTP projection');
  steps.checkpoint = checkpoints.viewed;
  const closure = steps.checkpoint?.recoveryBinding;
  const alignmentRef = closure?.alignmentRef ?? closure?.coreClosure?.nextAction?.ref;
  required(closure?.coreClosure?.committed === true && closure.preparationRef
    && closure.turnRecoveryRef && typeof alignmentRef === 'string'
    && alignmentRef.startsWith('turn-alignment:'), 'standard turn/save/checkpoint and Planner alignment references');
  assert.equal(closure.coreClosure.executionEpoch, dashboard.executionEpoch);
  const identity = steps.checkpoint.identity;
  assert.equal(valueOf(identity.checkpointId), dashboard.checkpoint.checkpointId);
  const ref = identity.commitRef;
  required(ref?.commitId && ref.journalSeq > 0 && ref.recordDigest, 'checkpoint asset read selector');
  query.set('checkpointCommitId', ref.commitId);
  query.set('checkpointJournalSeq', String(ref.journalSeq));
  query.set('checkpointRecordDigest', ref.recordDigest);
  steps.captureResponse = await jsonRequest(base, `${path}/checkpoints/assets/capture?${query}`);
  steps.capture = steps.captureResponse;
  required(steps.capture.surface === 'runtime-checkpoint-asset-body', 'capture HTTP projection');
  required(typeof steps.capture.text === 'string' && steps.capture.text.length > 0, 'capture asset body');
}

export function assertReceiptContract(receipt) {
  required(receipt?.proof === 'explicit-implicit-e2e', 'receipt proof');
  const { steps } = receipt;
  const requirement = steps.confirmation?.requirement;
  required(requirement && Number.isSafeInteger(requirement.fifoSeq) && requirement.fifoSeq > 0, 'final receipt FIFO sequence');
  for (const key of IDENTITY_KEYS) {
    required(requirement[key] !== undefined, `final receipt requirement.${key}`);
    assert.deepEqual(steps.identityRow?.identitySource?.[key], requirement[key], `exact TaskIdentity ${key}`);
  }
  required(steps.grant?.readback?.grant?.state === 'granted', 'committed auto-grant');
  required((steps.grant?.readback?.grant?.capability?.capabilities ?? [])
    .includes('provider.execution'), 'auto-grant scope');
  required(typeof steps.grant?.readback?.commit?.commitId === 'string', 'auto-grant commit reference');
  assert.deepEqual(steps.grantReadback.readback, steps.grant.readback, 'grant durable GET readback');
  assertSameExecution(steps.dashboard, steps.prepared);
  assert.equal(steps.dashboard.state, 'succeeded');
  const publication = steps.dashboard.publicOutput;
  required(publication?.state === 'committed', 'committed public delivery');
  required(typeof steps.dashboard.output === 'string' && steps.dashboard.output.trim().length > 0, 'public output body');
  required(publication.commits?.some((commit) => commit.text === steps.dashboard.output), 'public commit carrying actual output');
  assert.equal(steps.deliveryReadback.output, steps.dashboard.output);
  assert.deepEqual(steps.deliveryReadback.publicOutput, publication);
  required(steps.planner?.some((entry) => entry.commitRefs?.length > 0), 'independent Planner result evidence');
  const alignmentRef = steps.checkpoint?.recoveryBinding?.alignmentRef
    ?? steps.checkpoint?.recoveryBinding?.coreClosure?.nextAction?.ref;
  required(typeof alignmentRef === 'string' && alignmentRef.startsWith('turn-alignment:')
    && steps.capture?.text, 'standard closure and saved capture body');
  return true;
}

async function main() {
  const baseInput = process.env.HUMANAGENT_EI_BASE_URL;
  required(baseInput && process.env.HUMANAGENT_EI_COOKIE, 'parent-allocated HUMANAGENT_EI_BASE_URL and paired HUMANAGENT_EI_COOKIE; no implicit service launch');
  const url = new URL(baseInput);
  required(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash, 'stable base URL origin');
  const base = url.origin;
  const requestedReceipt = process.env.HUMANAGENT_EI_RECEIPT_PATH;
  if (requestedReceipt) {
    const rel = relative(FIXTURE_BASE, resolve(requestedReceipt));
    required(rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel),
      'receipt path inside ~/.humanagent/test-fixtures');
  }
  await mkdir(FIXTURE_BASE, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_BASE, 'explicit-implicit-e2e-'));
  const receiptPath = requestedReceipt ? resolve(requestedReceipt) : join(root, 'receipt.json');
  const token = root.slice(root.lastIndexOf('/') + 1);
  const steps = {};
  const receipt = {
    proof: 'explicit-implicit-e2e', generatedAt: new Date().toISOString(),
    state: 'UNVERIFIED', baseUrl: base, fixtureRoot: root, receiptPath, steps,
    resources: { ownedProcesses: [], service: 'parent-owned; never started or stopped',
      task: 'not yet submitted', cleanup: 'receipt retained; Task cleanup belongs to parent after inspection' },
    businessReview: {
      state: 'UNVERIFIED',
      criteria: ['核对本周试用、五名内部用户、每天一次导出', '比较两案人力、时间、导出和未接入依赖',
        '给出材料支持的选择和理由', '给出两步建议和未知问题', '不引入未提供事实，不访问网络或用户文件'],
      nextAction: 'inspect saved public output and execution evidence against these criteria; syntax/HTTP success alone is not business PASS',
    },
  };
  const persist = async () => {
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  };
  try {
    steps.status = await jsonRequest(base, '/api/runtime/status');
    const organized = await interpretUntilDraft(base, { sourceRef: token, rawInput: BUSINESS_INPUT }, steps);
    const identity = {
      confirmationRef: `${token}-confirmation`, payloadRef: pathToFileURL(join(root, 'input.json')).href,
      idempotencyKey: `${token}-submit`, confirmedAt: new Date().toISOString(),
    };
    await writeFile(join(root, 'input.json'), `${JSON.stringify(steps.input, null, 2)}\n`, 'utf8');
    steps.confirmation = await confirmDraft(base, organized.interaction, organized.draft, identity);
    await persist();
    const requirement = steps.confirmation.requirement;
    required(['submitted', 'duplicate'].includes(steps.confirmation.status) && requirement, 'typed final-submit receipt');
    assert.equal(requirement.draftId, organized.draft.draftId);
    assert.equal(requirement.inputRevision, organized.draft.inputRevision);
    assert.equal(requirement.confirmationRef, identity.confirmationRef);
    assert.equal(requirement.payloadRef, identity.payloadRef);
    if (organized.interaction.revision !== undefined) {
      assert.equal(requirement.draftRevisionVersion, organized.interaction.revision.revisionVersion);
      assert.equal(requirement.draftRevisionHash, organized.interaction.revision.revisionHash);
    }
    required(Number.isSafeInteger(requirement.fifoSeq) && requirement.fifoSeq > 0, 'accepted FIFO sequence');
    const taskId = await waitForImplicitTask(base, requirement, steps);
    receipt.resources.task = { taskId, retained: true, owner: 'parent canonical fixture cleanup/recovery' };
    const path = `/api/tasks/${encodeURIComponent(taskId)}`;
    steps.prepared = await jsonRequest(base, `${path}/dashboard`);
    required(steps.prepared.operationId && Number.isSafeInteger(steps.prepared.executionEpoch), 'prepared operation/epoch');
    required(['waiting', 'running', 'succeeded'].includes(steps.prepared.state), 'auto-grant Task is already dispatched or running');
    steps.grantBefore = await jsonRequest(base, `${path}/control/grant`);
    required(steps.grantBefore.readback && valueOf(steps.grantBefore.taskId) === taskId,
      'grant GET Task selector/readback');
    // G2.1 (commit e3cb74107): a confirmed new-task requirement already binds
    // its verified execution grant and starts execution without a redundant
    // manual grant. Verify the auto-grant readback instead of issuing one.
    required(steps.grantBefore.readback?.grant?.state === 'granted', 'new Task auto-grant is already granted');
    required((steps.grantBefore.readback?.grant?.capability?.capabilities ?? [])
      .includes('provider.execution'), 'auto-grant scope is provider.execution');
    required(typeof steps.grantBefore.readback?.commit?.commitId === 'string', 'auto-grant carries a real commit reference');
    steps.grant = steps.grantBefore;
    await persist();
    steps.grantReadback = await jsonRequest(base, `${path}/control/grant`);
    await persist();
    assert.deepEqual(steps.grantReadback.readback, steps.grant.readback);
    const terminal = await pollTaskState(base, taskId, steps.prepared, steps);
    await persist();
    await captureObservation(base, taskId, terminal, steps);
    steps.deliveryReadback = await jsonRequest(base, `${path}/dashboard`);
    assertReceiptContract(receipt);
    receipt.behavior = 'PASS: typed FIFO identity, auto-grant readback, standard closure/Planner, Task/public delivery readback';
    // Semantic review must still check output quality and forbidden I/O. Never
    // replace that check with non-empty output or keyword matching.
    receipt.state = 'UNVERIFIED';
    console.log(JSON.stringify({ state: receipt.state, behavior: receipt.behavior, receiptPath,
      nextAction: receipt.businessReview.nextAction }));
  } catch (error) {
    receipt.state = 'INCOMPLETE';
    receipt.failure = { message: error.message,
      ...(error.publicResponse === undefined ? {} : { publicResponse: error.publicResponse }) };
    throw error;
  } finally {
    await persist();
    console.error(`HUMANAGENT_EI_RECEIPT_PATH=${receiptPath}`);
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
