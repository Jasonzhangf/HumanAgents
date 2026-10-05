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
 * It runs three independent real-provider cases, each leaving a real
 * task/operation/checkpoint/receipt plus real provider evidence on disk:
 *   success - a real provider run succeeds
 *   failure - a real provider tool round fails (`file.read` on a directory
 *             surfaces EISDIR), so the consumer must persist a failed terminal
 *             receipt that keeps the original provider error and the correct
 *             recovery responsibility
 *   stop    - a real operator stop is requested and settled, so the consumer
 *             must persist a cancelled terminal receipt
 *
 * The provider seam is never mocked, a non-success provider terminal is never
 * rewritten into a success, and an operator stop is never used as failure
 * evidence. Every case removes its own fixture root and releases its lease on
 * both the success and the exception path.
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
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_RCC_MODEL ?? 'gpt-5.5';
const FAILURE_TOOL_ERROR = 'EISDIR: illegal operation on a directory, read';
const FAILURE_MAX_ATTEMPTS = 4;
const FAILURE_PROMPT = [
  'Use the file.read tool to read the directory at path "adir"',
  '(the directory itself, not a file inside it).',
  'Then report what happened.',
].join(' ');

// Optional: when set, every case writes its raw provider/consumer evidence here
// before the fixture root is removed.
const RAW_DIR = process.env.HUMANAGENT_RCC_E2E_RAW_DIR;
// Test-only hook: throw right after a named case registers its fixture root, so
// the exception-path cleanup can be exercised against this committed harness.
const INJECT_FAILURE = process.env.HUMANAGENT_RCC_E2E_INJECT_FAILURE;

const allocatedRoots = new Set();

async function writeRawEvidence(name, payload) {
  if (RAW_DIR === undefined || RAW_DIR.trim() === '') return;
  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(join(RAW_DIR, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function cleanupRoots() {
  const failures = [];
  const removed = [];
  for (const root of allocatedRoots) {
    try {
      await rm(root, { recursive: true, force: true });
      const absent = !existsSync(root);
      removed.push({ root, absent });
      if (absent) {
        allocatedRoots.delete(root);
      } else {
        failures.push(new Error(`fixture root still exists after removal: ${root}`));
      }
    } catch (error) {
      removed.push({ root, absent: !existsSync(root), error: error instanceof Error ? error.message : String(error) });
      failures.push(error);
    }
  }
  await writeRawEvidence('rcc-e2e-cleanup.json', {
    removed,
    failureCount: failures.length,
    allAbsent: removed.every((entry) => entry.absent),
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, `fixture cleanup failed for ${failures.length} root(s)`);
  }
}

const uiRuntimeModule = new URL('../../dist/tests/packages/app/src/ui-runtime/index.js', import.meta.url).href;
const consumerModule = new URL('../../dist/tests/packages/app/src/ui-runtime/occurrence-consumer.js', import.meta.url).href;
const supervisorModule = new URL('../../dist/tests/packages/app/src/supervisor/index.js', import.meta.url).href;
const journalModule = new URL('../../dist/tests/packages/adapters/jsonl/src/index.js', import.meta.url).href;
const providerModule = new URL('../../dist/tests/packages/adapters/provider/src/index.js', import.meta.url).href;
const providerToolExecutionModule = new URL('../../dist/tests/packages/app/src/provider-tool-execution.js', import.meta.url).href;
const configModule = new URL('../../dist/tests/packages/config/src/index.js', import.meta.url).href;
const contractsModule = new URL('../../dist/tests/packages/contracts/src/index.js', import.meta.url).href;
const coreModule = new URL('../../dist/tests/packages/core/src/subscription.js', import.meta.url).href;

const { buildRccExecutionPort, FileCheckpointStore } = await import(uiRuntimeModule);
const { DurableOccurrenceConsumer } = await import(consumerModule);
const { acquireDaemonLease } = await import(supervisorModule);
const { JsonlOrganJournal } = await import(journalModule);
const { ProviderAgentDriver } = await import(providerModule);
const { createResponsesFileToolExecutor, RESPONSES_FILE_READ_TOOL } = await import(providerToolExecutionModule);
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
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.executeTool === undefined ? {} : { executeTool: input.executeTool }),
  });
  const events = [];
  let error;
  let providerError;
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
    providerError = caught?.providerError ?? caught?.cause?.providerError;
  }
  let settlement;
  if (started) {
    try {
      await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
      settlement = driver.settlement();
    } catch (settleError) {
      if (error === undefined) {
        error = settleError;
        providerError = settleError?.providerError ?? settleError?.cause?.providerError;
      }
    }
  }
  return { events, settlement, error, providerError };
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

function errorRefsOf(input) {
  const refs = [];
  for (const candidate of [input.error, input.providerError, input.settlement?.error]) {
    if (!candidate) continue;
    for (const ref of candidate.evidenceRefs ?? []) refs.push(ref);
  }
  return refs;
}

// A driver event carries the typed provider error under `providerEvent.error`;
// only the derived agent event keeps it nested.
function eventError(event) {
  return event.error ?? event.providerEvent?.error;
}

function providerErrorMessage(input) {
  // The original execution failure is the tool/observe error. A provider
  // settlement error is derived (for example a continuation-unavailable error
  // after a failed tool round), so it must never mask the real cause.
  const candidates = [
    input.providerError?.message,
    ...input.events.map((event) => eventError(event)?.message).filter((value) => value !== undefined),
    input.error instanceof Error ? input.error.message : undefined,
    ...input.events.map((event) => event.summary ?? '').filter((value) => value.includes('EISDIR') || value.includes('failed')),
    input.settlement?.error?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return `rcc provider execution failed (${String(input.settlement?.state ?? 'no settlement')})`;
}

function providerErrorCode(input) {
  const candidates = [
    input.providerError?.code,
    ...input.events.map((event) => eventError(event)?.code).filter((value) => value !== undefined),
    input.settlement?.error?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return 'provider.execution.failed';
}

function providerFailed(input) {
  const state = input.settlement?.state;
  if (state === 'failed' || state === 'unknown') return true;
  if (input.error !== undefined || input.providerError !== undefined || input.settlement?.error !== undefined) return true;
  if (input.events.some((event) => event.error !== undefined || event.terminalState === 'failed')) return true;
  return false;
}

function terminalProduction(input) {
  const evidenceRefs = projectEvidence(input.events, input.settlement, input.scope);
  const errorEvidenceRefs = errorRefsOf(input);
  assert.ok(
    evidenceRefs.length > 0 || errorEvidenceRefs.length > 0,
    `real provider run produced no evidence refs (provider error: ${providerErrorMessage(input)})`,
  );
  const primary = evidenceRefs[0] ?? errorEvidenceRefs[0];
  const state = input.settlement?.state;
  const failed = providerFailed(input);
  const status = state === 'succeeded' && !failed
    ? 'success'
    : failed
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
  const errorSummary = failed ? `${providerErrorCode(input)}: ${providerErrorMessage(input)}` : '';
  const settlementReceiptRef = `provider-settlement/v1:${input.binding.providerId}:${input.binding.bindingId}:${status}:${input.operationId.value}`;
  const checkpointSummary = failed
    ? errorSummary
    : providerSummary.length > 0
      ? providerSummary
      : `rcc provider terminal ${String(state)}`;
  const allEvidenceRefs = [
    ...errorEvidenceRefs.filter((ref) => !evidenceRefs.some((known) => known.evidenceId.value === ref.evidenceId.value)),
    ...evidenceRefs,
  ];
  const checkpoint = {
    id: id('checkpoint', `rcc-terminal-${input.operationId.value}`),
    scope: input.scope,
    cycleId: input.scope.cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: input.executionEpoch,
    outcome,
    summary: checkpointSummary,
    recoveryStateRef: primary,
    evidenceRefs: allEvidenceRefs,
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
      : status === 'failed'
        ? [{
            checkId: 'rcc-provider-error',
            kind: 'native',
            status: 'failed',
            decisionRef: errorEvidenceRefs[0]?.locator ?? settlementReceiptRef,
            decisionDigest: digest('rcc-provider-error/v1', { error: errorSummary, evidence: allEvidenceRefs.map((ref) => ref.locator) }),
            artifactDigests: [input.inputArtifactDigest],
            evidenceRefs: allEvidenceRefs,
          }]
        : [],
    evidenceRefs: allEvidenceRefs,
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
            resourceInventory: allEvidenceRefs,
            releaseProofs: [],
          },
        }),
  };
}

function createDispatchPort(input) {
  return {
    async dispatch({ occurrence, binding: taskBinding }) {
      const prompt = input.mode === 'failure'
        ? FAILURE_PROMPT
        : [
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
        stopAfterFirstEvent: input.mode === 'stop',
        ...(input.tooling === undefined
          ? {}
          : { tools: input.tooling.tools, executeTool: input.tooling.executeTool }),
      });
      input.capturedRuns.push(run);
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

/**
 * One isolated real-provider case. The fixture root is registered for outer
 * cleanup as soon as it exists, and the supervisor lease is always released in
 * a `finally` so a release failure is exposed instead of swallowed.
 */
async function runCase({ suffix, modelRef, mode }) {
  // Resolve symlinks so the bound workspace root is canonical: the real
  // `file.read` route rejects a workspace root that resolves through a symlink
  // (macOS `/var` -> `/private/var`), which would mask the intended failure.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'humanagent-durable-consumer-rcc-')));
  allocatedRoots.add(root);
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const evidenceRoot = join(root, 'provider-evidence');
  const artifactRoot = join(root, 'provider-tools');
  await mkdir(workspace);
  await mkdir(evidenceRoot);
  if (mode === 'failure') await mkdir(join(workspace, 'adir'));
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);

  const binding = bindingFor(suffix, modelRef);
  const taskBinding = occurrenceBindingFor(suffix);
  const scope = scopeFor(taskBinding);
  const journalPath = join(paths.journalRoot, `task-${taskBinding.taskId.value}-cycle-cycle-${taskBinding.taskId.value}.jsonl`);
  const port = buildRccExecutionPort({ binding, routeRef: `rcc/${suffix}`, baseUrl: RCC_BASE_URL }, evidenceRoot);
  // Only the failure case declares the real file.read tool, so the model must
  // call it to surface the real provider tool error. Success and stop declare
  // no tools.
  const tooling = mode === 'failure'
    ? (() => {
        const built = createResponsesFileToolExecutor({
          workspaceRoot: workspace,
          projectKey: `rcc-e2e-${suffix}`,
          artifactRoot,
        });
        return { tools: [RESPONSES_FILE_READ_TOOL], executeTool: built.executor };
      })()
    : undefined;
  const capturedRuns = [];
  const lease = await acquireDaemonLease(paths, { ownerId: `durable-consumer-rcc-${suffix}` });
  try {
    if (INJECT_FAILURE === suffix) throw new Error(`injected failure after ${suffix} fixture allocation`);
    const consumer = new DurableOccurrenceConsumer({
      lease,
      scope,
      journal: new JsonlOrganJournal(journalPath),
      checkpoints: new FileCheckpointStore(journalPath),
      dispatch: createDispatchPort({ port, binding, scope, mode, tooling, capturedRuns }),
    });
    const receipt = await consumer.executeOccurrence({
      occurrence: occurrenceFor(taskBinding),
      policy: POLICY,
      claim: claimFor(taskBinding),
      binding: taskBinding,
    });
    if (mode === 'success') {
      const repeated = await consumer.executeOccurrence({
        occurrence: occurrenceFor(taskBinding),
        policy: POLICY,
        claim: claimFor(taskBinding),
        binding: taskBinding,
      });
      assert.deepEqual(repeated, receipt, `${suffix}: real RCC replay must return the same terminal receipt`);
      const [parallelA, parallelB] = await Promise.all([
        consumer.executeOccurrence({
          occurrence: occurrenceFor(taskBinding),
          policy: POLICY,
          claim: claimFor(taskBinding),
          binding: taskBinding,
        }),
        consumer.executeOccurrence({
          occurrence: occurrenceFor(taskBinding),
          policy: POLICY,
          claim: claimFor(taskBinding),
          binding: taskBinding,
        }),
      ]);
      assert.deepEqual(parallelA, receipt, `${suffix}: concurrent real RCC replay must return the same terminal receipt`);
      assert.deepEqual(parallelB, receipt, `${suffix}: concurrent real RCC replay must return the same terminal receipt`);
    }
    const records = await new JsonlOrganJournal(journalPath).replay();
    const admission = records.filter((record) => record.payload?.kind === 'occurrence-execution-admission');
    const checkpointRecords = records.filter((record) => record.kind === 'checkpoint');
    const receiptRecords = records.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt');
    const evidenceFiles = await readdir(evidenceRoot);
    const terminalCheckpoint = checkpointRecords[0]?.checkpoint;
    const receiptRecord = receiptRecords[0]?.payload;
    const captured = capturedRuns[capturedRuns.length - 1];
    await writeRawEvidence(`rcc-e2e-${suffix}.json`, {
      suffix,
      mode,
      taskId: receipt.taskId.value,
      operationId: receipt.operationId.value,
      status: receipt.verification.status,
      terminalOutcome: receiptRecord?.terminalOutcome ?? null,
      checkpointOutcome: terminalCheckpoint?.outcome ?? null,
      checkpointSummary: terminalCheckpoint?.summary ?? null,
      settlementReceiptRef: receipt.settlementReceiptRef,
      verificationChecks: receipt.verification.checks,
      recoveryResponsibility: receiptRecord?.recoveryResponsibility ?? null,
      provider: captured === undefined
        ? null
        : {
            settlement: captured.settlement ?? null,
            providerError: captured.providerError ?? null,
            error: captured.error instanceof Error
              ? {
                  name: captured.error.name,
                  message: captured.error.message,
                  code: captured.error.code ?? null,
                  category: captured.error.category ?? null,
                }
              : captured.error ?? null,
            events: captured.events.map((event) => ({
              kind: event.kind,
              terminalState: event.terminalState ?? null,
              summary: event.summary ?? null,
              error: eventError(event) ?? null,
              evidenceRefs: event.evidenceRefs,
            })),
          },
      admissionRecords: admission,
      checkpointRecords: checkpointRecords.map((record) => record.checkpoint),
      terminalReceiptRecords: receiptRecords,
      evidenceFiles,
    });
    const result = {
      suffix,
      status: receipt.verification.status,
      settlementState: receiptRecord?.terminalOutcome,
      checkpointOutcome: terminalCheckpoint?.outcome,
      checkpointSummary: terminalCheckpoint?.summary,
      failedCheck: receipt.verification.checks.find((check) => check.status === 'failed') ?? null,
      evidenceLocators: records.flatMap((record) => [
        ...(record.checkpoint?.evidenceRefs ?? []).map((ref) => ref.locator),
        ...(record.payload?.verification?.evidenceRefs ?? []).map((ref) => ref.locator),
      ]),
      recoveryRequired: receiptRecord?.recoveryResponsibility !== undefined,
      recoveryProviderEffectState: receiptRecord?.recoveryResponsibility?.providerEffectState ?? null,
      recoveryResourceCount: receiptRecord?.recoveryResponsibility?.resourceInventory?.length ?? 0,
      taskId: receipt.taskId.value,
      operationId: receipt.operationId.value,
      executionEpoch: receipt.executionEpoch,
      terminalCheckpointRef: receipt.terminalCheckpointRef,
      settlementReceiptRef: receipt.settlementReceiptRef,
      admissionCount: admission.length,
      checkpointCount: checkpointRecords.length,
      receiptCount: receiptRecords.length,
      evidenceFileCount: evidenceFiles.length,
      capturedRunCount: capturedRuns.length,
      journalPath,
    };
    assert.equal(admission.length, 1, `${suffix}: expected exactly one admission`);
    assert.equal(checkpointRecords.length, 1, `${suffix}: expected exactly one terminal checkpoint`);
    assert.equal(receiptRecords.length, 1, `${suffix}: expected exactly one terminal receipt`);
    assert.ok(evidenceFiles.length > 0, `${suffix}: expected real provider evidence artifacts on disk`);
    if (mode === 'success') {
      assert.equal(capturedRuns.length, 1, `${suffix}: real RCC duplicate/concurrent replay must not dispatch a second business execution`);
    }
    return { result, root, journalPath };
  } finally {
    await lease.release();
  }
}

async function main() {
  const health = await fetch(`${RCC_BASE_URL}/health`);
  assert.equal(health.status, 200, 'RCC health endpoint must answer 200');
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok', 'RCC health endpoint must report status ok');

  const report = {
    rccBaseUrl: RCC_BASE_URL,
    model: MODEL,
    health: { status: healthBody.status, version: healthBody.version, buildVersion: healthBody.build_version },
    success: null,
    failure: null,
    stop: null,
    nonExercisedFailureAttempts: [],
  };
  try {
    const success = await runCase({ suffix: 'success', modelRef: MODEL, mode: 'success' });
    assert.equal(success.result.status, 'success', 'real RCC success must persist a success terminal');
    assert.equal(success.result.settlementState, 'succeeded', 'real RCC success must persist a succeeded receipt');
    assert.equal(success.result.checkpointOutcome, 'succeeded', 'real RCC success must persist a succeeded checkpoint');
    report.success = success.result;

    // The model decides whether to call file.read, so a run that never reached
    // the failure path is retried a bounded number of times and never accepted.
    let failure;
    for (let attempt = 1; attempt <= FAILURE_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await runCase({ suffix: 'failure', modelRef: MODEL, mode: 'failure' });
      if (outcome.result.status === 'failed') {
        failure = outcome;
        break;
      }
      report.nonExercisedFailureAttempts.push({
        attempt,
        status: outcome.result.status,
        settlementState: outcome.result.settlementState,
      });
    }
    assert.ok(
      failure !== undefined,
      `real RCC provider failure was not exercised in ${FAILURE_MAX_ATTEMPTS} attempt(s)`,
    );
    assert.equal(failure.result.status, 'failed', 'real RCC failure must persist a failed terminal');
    assert.equal(failure.result.settlementState, 'failed', 'real RCC failure must persist a failed receipt');
    assert.equal(failure.result.checkpointOutcome, 'failed', 'real RCC failure must persist a failed checkpoint');
    assert.ok(
      String(failure.result.checkpointSummary).includes(FAILURE_TOOL_ERROR),
      'failure receipt must carry the original provider error message',
    );
    assert.equal(
      failure.result.failedCheck?.status,
      'failed',
      'failure receipt must carry a failed verification check',
    );
    assert.ok(
      failure.result.failedCheck?.evidenceRefs?.length > 0,
      'failure verification check must bind the original provider error evidence',
    );
    assert.ok(
      failure.result.evidenceLocators.some((locator) => String(locator).includes('tool.result.failure')),
      'failure receipt must reference the original provider tool-error evidence',
    );
    assert.equal(
      failure.result.recoveryProviderEffectState,
      'possible',
      'failure receipt must record provider effects as not confirmed released',
    );
    assert.ok(
      failure.result.recoveryResourceCount > 0,
      'failure receipt must inventory the real provider evidence',
    );
    report.failure = failure.result;

    const stop = await runCase({ suffix: 'stop', modelRef: MODEL, mode: 'stop' });
    assert.equal(stop.result.status, 'cancelled', 'real operator stop must persist a cancelled terminal');
    assert.equal(stop.result.settlementState, 'cancelled', 'real operator stop must persist a cancelled receipt');
    assert.equal(stop.result.checkpointOutcome, 'cancelled', 'real operator stop must persist a cancelled checkpoint');
    report.stop = stop.result;

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await cleanupRoots();
  }
}

await main();
