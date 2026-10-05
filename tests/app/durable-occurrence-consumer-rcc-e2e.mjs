#!/usr/bin/env node
/**
 * Real RCC 4444 durable occurrence consumer acceptance.
 *
 * This drives the public `DurableOccurrenceConsumer.executeOccurrence` entry
 * over a real `SupervisorLease`, a real on-disk `JsonlOrganJournal` and
 * `FileCheckpointStore`, and the existing provider/business seam
 * (`buildRccExecutionPort` + `ProviderAgentDriver`) against the live RCC
 * endpoint on 127.0.0.1:4444.
 *
 * It proves both a real provider success and a real provider failure travel
 * through the consumer and leave a real task/operation/checkpoint/receipt plus
 * real provider evidence on disk. The provider seam is never mocked and a
 * non-success provider terminal is never rewritten into a success.
 *
 * The non-success case is a real operator stop: the live RCC stream is
 * requested to stop and then settled, so the consumer must persist the real
 * stopped/blocked provider terminal instead of a fabricated success.
 *
 * Required env:
 *   none (the live RCC endpoint must answer on 127.0.0.1:4444)
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL   default http://127.0.0.1:4444
 *   HUMANAGENT_RCC_MODEL      default gpt-5.5
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_RCC_MODEL ?? 'gpt-5.5';

const uiRuntimeModule = new URL('../../dist/tests/packages/app/src/ui-runtime/index.js', import.meta.url).href;
const consumerModule = new URL('../../dist/tests/packages/app/src/ui-runtime/occurrence-consumer.js', import.meta.url).href;
const supervisorModule = new URL('../../dist/tests/packages/app/src/supervisor/index.js', import.meta.url).href;
const journalModule = new URL('../../dist/tests/packages/adapters/jsonl/src/index.js', import.meta.url).href;
const providerModule = new URL('../../dist/tests/packages/adapters/provider/src/index.js', import.meta.url).href;
const configModule = new URL('../../dist/tests/packages/config/src/index.js', import.meta.url).href;
const contractsModule = new URL('../../dist/tests/packages/contracts/src/index.js', import.meta.url).href;
const coreModule = new URL('../../dist/tests/packages/core/src/subscription.js', import.meta.url).href;

const { buildRccExecutionPort, FileCheckpointStore } = await import(uiRuntimeModule);
const { DurableOccurrenceConsumer } = await import(consumerModule);
const { acquireDaemonLease } = await import(supervisorModule);
const { JsonlOrganJournal } = await import(journalModule);
const { ProviderAgentDriver } = await import(providerModule);
const { ensureControlLayout, resolveRuntimePaths } = await import(configModule);
const { id } = await import(contractsModule);
const { executionPolicyHash } = await import(coreModule);

const ORGAN_ID = id('organ', 'organ-durable-consumer-rcc');
const POLICY = {
  policyId: 'policy-durable-consumer-rcc',
  policyRevision: 1,
  timezone: 'UTC',
  canonicalInstant: '2026-10-05T00:00:00.000Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'skip',
  executionMode: 'once',
  dueAt: '2026-10-05T00:00:00.000Z',
};

function digest(domain, value) {
  const material = JSON.stringify({ domain, value });
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

function bindingFor(suffix, modelRef) {
  return {
    bindingId: `rcc-e2e-${suffix}`,
    providerId: 'rcc',
    protocol: 'responses',
    endpointRef: RCC_BASE_URL,
    modelRef,
    configDigest: `sha256:rcc-e2e-config-${suffix}`,
    capabilityDigest: `sha256:rcc-e2e-capability-${suffix}`,
  };
}

function occurrenceBindingFor(suffix) {
  const subscriptionId = `subscription-rcc-${suffix}`;
  const scheduleRevision = 1;
  const occurrenceOrdinal = 1;
  return {
    occurrenceId: `${subscriptionId}::${scheduleRevision}::${occurrenceOrdinal}`,
    subscriptionId,
    scheduleRevision,
    occurrenceOrdinal,
    taskId: id('task', `task-rcc-${suffix}`),
    operationId: id('operation', `operation-rcc-${suffix}`),
    executionEpoch: 1,
    inputArtifactDigest: `sha256:rcc-e2e-input-${suffix}`,
  };
}

function scopeFor(binding) {
  return {
    organId: ORGAN_ID,
    taskId: binding.taskId,
    cycleId: id('cycle', `cycle-${binding.taskId.value}`),
    operationId: binding.operationId,
  };
}

function occurrenceFor(binding) {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    state: 'due',
    dueAt: '2026-10-05T00:00:00.000Z',
  };
}

function claimFor(binding) {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    claimedBy: 'scheduler-durable-consumer-rcc',
    leaseId: 'scheduler-rcc-lease-1',
    schedulerInstanceId: 'scheduler-rcc-instance-1',
    generation: 1,
    executionEpoch: binding.executionEpoch,
    acquiredAt: '2026-10-05T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    policyRevision: POLICY.policyRevision,
    policyHash: executionPolicyHash(POLICY),
    policy: POLICY,
    taskId: binding.taskId,
    operationId: binding.operationId,
    inputArtifactDigest: binding.inputArtifactDigest,
  };
}

/**
 * Real provider run. Uses the existing provider seam end to end: a real
 * `ProviderAdapter` (via `buildRccExecutionPort`) is driven by the real
 * `ProviderAgentDriver` start/submit/observe/settle lifecycle.
 */
async function runProviderAgent(input) {
  const assignmentId = `occurrence-rcc-assignment-${input.operationId.value}`;
  const runtimeId = `occurrence-rcc-${input.operationId.value}-${input.executionEpoch}`;
  const driver = new ProviderAgentDriver({
    port: input.port,
    binding: input.binding,
    runtimeId,
    taskId: input.taskId,
    operationId: input.operationId,
    executionEpoch: input.executionEpoch,
    assignmentId,
    scope: input.scope,
    inputRefs: [input.prompt],
    ownerId: 'humanagent.app.occurrence-consumer.rcc-e2e',
  });
  const events = [];
  let error;
  let started = false;
  let stopRequested = false;
  try {
    await driver.start({
      runtimeId,
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId,
      organId: input.scope.organId,
      ...(input.scope.cycleId === undefined ? {} : { cycleId: input.scope.cycleId }),
      operationId: input.operationId,
    });
    started = true;
    await driver.submit({
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId,
      payload: { prompt: input.prompt },
    });
    for await (const event of driver.observe({ runtimeId })) {
      events.push(event);
      if (input.stopAfterFirstEvent === true && !stopRequested) {
        stopRequested = true;
        await driver.requestStop({ runtimeId, executionEpoch: input.executionEpoch, operationId: input.operationId });
      }
      if (event.terminalState !== undefined) break;
    }
  } catch (caught) {
    error = caught;
  }
  let settlement;
  if (started) {
    try {
      await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
      settlement = driver.settlement();
    } catch (settleError) {
      if (error === undefined) error = settleError;
    }
  }
  return { events, settlement, error };
}

/**
 * Re-scope the real provider evidence refs onto the consumer's task/operation
 * scope. The evidence content (source, locator, digest) is preserved; only the
 * scope projection changes, exactly like the existing serve orchestration seam.
 */
function projectEvidence(events, settlement, scope) {
  const raw = [
    ...events.flatMap((event) => event.evidenceRefs ?? []),
    ...(settlement?.evidenceRefs ?? []),
    ...(settlement?.resourceRelease?.evidenceRefs ?? []),
  ];
  const seen = new Set();
  const projected = [];
  for (const ref of raw) {
    const evidenceId = id('evidence', `occurrence-rcc-${ref.evidenceId.value}`);
    if (seen.has(evidenceId.value)) continue;
    seen.add(evidenceId.value);
    projected.push({ ...ref, evidenceId, scope });
  }
  return projected;
}

function terminalProduction(input) {
  const evidenceRefs = projectEvidence(input.events, input.settlement, input.scope);
  assert.ok(
    evidenceRefs.length > 0,
    `real provider run produced no evidence refs (provider error: ${input.error instanceof Error ? input.error.message : String(input.error)})`,
  );
  const primary = evidenceRefs[0];
  const state = input.settlement?.state;
  const status = state === 'succeeded'
    ? 'success'
    : state === 'failed'
      ? 'failed'
      : state === 'cancelled' || state === 'stopped'
        ? 'cancelled'
        : 'blocked';
  const outcome = status === 'success'
    ? 'succeeded'
    : status === 'failed'
      ? 'failed'
      : status === 'cancelled'
        ? 'cancelled'
        : 'blocked';
  const nextKind = status === 'success' ? 'continue' : status === 'cancelled' ? 'stop' : 'recover';
  const providerSummary = input.events.map((event) => event.summary ?? '').join('').trim();
  const settlementReceiptRef = `provider-settlement/v1:${input.binding.providerId}:${input.binding.bindingId}:${String(state)}:${input.operationId.value}`;
  const checkpoint = {
    id: id('checkpoint', `rcc-terminal-${input.operationId.value}`),
    scope: input.scope,
    cycleId: input.scope.cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: input.executionEpoch,
    outcome,
    summary: providerSummary.length > 0 ? providerSummary : `rcc provider terminal ${String(state)}`,
    recoveryStateRef: primary,
    evidenceRefs,
    next: { kind: nextKind, ref: settlementReceiptRef },
  };
  const verification = {
    taskId: input.taskId,
    operationId: input.operationId,
    executionEpoch: input.executionEpoch,
    attempt: 1,
    inputArtifactDigest: input.inputArtifactDigest,
    policyRef: `occurrence-policy/v1:${POLICY.policyId}`,
    policyDigest: digest('occurrence-policy/v1', { policyId: POLICY.policyId, policyRevision: POLICY.policyRevision }),
    status,
    checks: status === 'success'
      ? [{
          checkId: 'rcc-provider-terminal',
          kind: 'native',
          status: 'succeeded',
          decisionRef: settlementReceiptRef,
          decisionDigest: digest('rcc-provider-settlement/v1', { state, evidence: evidenceRefs.map((ref) => ref.locator) }),
          artifactDigests: [input.inputArtifactDigest],
          evidenceRefs,
        }]
      : [],
    evidenceRefs,
    ...(status === 'rejected' ? { rejectionCode: 'checker-rejected' } : {}),
  };
  return {
    checkpoint,
    verification,
    settlementReceiptRef,
    ...(status === 'success'
      ? {}
      : {
          recoveryResponsibility: {
            providerEffectState: 'possible',
            resourceInventory: evidenceRefs,
            releaseProofs: [],
          },
        }),
  };
}

function createDispatchPort(input) {
  return {
    async dispatch({ occurrence, binding: taskBinding }) {
      const prompt = [
        'You are a HumanAgent durable occurrence worker.',
        `Occurrence: ${occurrence.occurrenceId}.`,
        'Reply with a single short sentence that states the token HUMANAGENT_CONSUMER_OK.',
      ].join(' ');
      const run = await runProviderAgent({
        port: input.port,
        binding: input.binding,
        taskId: taskBinding.taskId,
        operationId: taskBinding.operationId,
        executionEpoch: taskBinding.executionEpoch,
        scope: input.scope,
        prompt,
        stopAfterFirstEvent: input.stopAfterFirstEvent === true,
      });
      const production = terminalProduction({
        ...run,
        binding: input.binding,
        scope: input.scope,
        taskId: taskBinding.taskId,
        operationId: taskBinding.operationId,
        executionEpoch: taskBinding.executionEpoch,
        inputArtifactDigest: taskBinding.inputArtifactDigest,
      });
      return production;
    },
  };
}

async function runCase({ suffix, modelRef, stopAfterFirstEvent }) {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-durable-consumer-rcc-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const evidenceRoot = join(root, 'provider-evidence');
  await mkdir(workspace);
  await mkdir(evidenceRoot);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);

  const binding = bindingFor(suffix, modelRef);
  const taskBinding = occurrenceBindingFor(suffix);
  const scope = scopeFor(taskBinding);
  const journalPath = join(paths.journalRoot, `task-${taskBinding.taskId.value}-cycle-cycle-${taskBinding.taskId.value}.jsonl`);
  const port = buildRccExecutionPort({ binding, routeRef: `rcc/${suffix}`, baseUrl: RCC_BASE_URL }, evidenceRoot);
  const lease = await acquireDaemonLease(paths, { ownerId: `durable-consumer-rcc-${suffix}` });
  let result;
  try {
    const consumer = new DurableOccurrenceConsumer({
      lease,
      scope,
      journal: new JsonlOrganJournal(journalPath),
      checkpoints: new FileCheckpointStore(journalPath),
      dispatch: createDispatchPort({ port, binding, scope, stopAfterFirstEvent }),
    });
    const receipt = await consumer.executeOccurrence({
      occurrence: occurrenceFor(taskBinding),
      policy: POLICY,
      claim: claimFor(taskBinding),
    });
    const records = await new JsonlOrganJournal(journalPath).replay();
    const admission = records.filter((record) => record.payload?.kind === 'occurrence-execution-admission');
    const checkpointRecords = records.filter((record) => record.kind === 'checkpoint');
    const receiptRecords = records.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt');
    const evidenceFiles = await readdir(evidenceRoot);
    result = {
      suffix,
      status: receipt.verification.status,
      settlementState: receiptRecords[0]?.payload?.terminalOutcome,
      taskId: receipt.taskId.value,
      operationId: receipt.operationId.value,
      executionEpoch: receipt.executionEpoch,
      terminalCheckpointRef: receipt.terminalCheckpointRef,
      settlementReceiptRef: receipt.settlementReceiptRef,
      admissionCount: admission.length,
      checkpointCount: checkpointRecords.length,
      receiptCount: receiptRecords.length,
      evidenceFileCount: evidenceFiles.length,
      journalPath,
    };
    assert.equal(admission.length, 1, `${suffix}: expected exactly one admission`);
    assert.equal(checkpointRecords.length, 1, `${suffix}: expected exactly one terminal checkpoint`);
    assert.equal(receiptRecords.length, 1, `${suffix}: expected exactly one terminal receipt`);
    assert.ok(evidenceFiles.length > 0, `${suffix}: expected real provider evidence artifacts on disk`);
    return { result, root, journalPath };
  } finally {
    await lease.release().catch(() => undefined);
  }
}

async function main() {
  const health = await fetch(`${RCC_BASE_URL}/health`);
  assert.equal(health.status, 200, 'RCC health endpoint must answer 200');
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok', 'RCC health endpoint must report status ok');

  const success = await runCase({ suffix: 'success', modelRef: MODEL });
  const failure = await runCase({ suffix: 'failure', modelRef: MODEL, stopAfterFirstEvent: true });
  try {
    assert.equal(success.result.status, 'success', 'real RCC success must persist a success terminal');
    assert.notEqual(failure.result.status, 'success', 'real RCC failure must not persist a success terminal');
    const report = {
      rccBaseUrl: RCC_BASE_URL,
      model: MODEL,
      health: { status: healthBody.status, version: healthBody.version, buildVersion: healthBody.build_version },
      success: success.result,
      failure: failure.result,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(success.root, { recursive: true, force: true });
    await rm(failure.root, { recursive: true, force: true });
    assert.equal(existsSync(success.root), false, 'success fixture root must be removed');
    assert.equal(existsSync(failure.root), false, 'failure fixture root must be removed');
  }
}

await main();
