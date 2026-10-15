import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import {
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentOutput,
  type AgentStartRequest,
  type BusinessPayload,
  type EvidenceRef,
  type InteractionHelperAssignment,
  type InteractionHelperIdentity,
  type ProviderBinding,
  type TasklessProviderExecutionIdentityRef,
  id,
} from '../../../packages/contracts/src/index.js';
import {
  acceptTasklessInteractionHelperResult,
  executeTasklessInteractionHelper,
  type InteractionHelperJournalPort,
  type TasklessHelperExecutionBinding,
} from '../../../packages/runtime/src/explicit-brain/taskless-helper-executor.js';

// Failure mode: this new dispatch/return/owner-accept boundary anchors the wrong
// direction of responsibility. A return is mistaken for an acceptance, an
// external dispatch runs before the durable fact exists, parent context leaks
// into the helper request, or a real failed/incomplete result is accepted only
// through a fabricated success. The probability is unknown because the seam is
// new. The impact is false recovery responsibility and lost failure truth. The
// cost is one local Journal-backed public consumer plus its counterexamples.

const organId = id('organ', 'organ-taskless-helper-executor');
const operationId = id('operation', 'operation-taskless-helper');

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-explicit-brain',
    locator: `interaction://${label}`,
    digest: `sha256:${'b'.repeat(64)}`,
    scope: { organId },
  };
}

const assignment: InteractionHelperAssignment = {
  organId,
  interactionScopeId: 'interaction-scope-taskless',
  interactionId: 'interaction-taskless',
  inputRevision: 4,
  parentTurnId: 'turn-taskless',
  assignmentId: 'assignment-taskless',
  helperCallId: 'call-taskless',
  attempt: 1,
  objective: 'Return the bounded helper conclusion',
  targetRefs: ['interaction://interaction-taskless'],
  expectedOutputRefs: ['output://helper-taskless'],
  expectedArtifactDigests: ['sha256:helper-taskless'],
  acceptanceCriteriaDigest: 'sha256:criteria-taskless',
  successCriteria: ['Return the bounded conclusion'],
  failureCriteria: ['Return no conclusion'],
  incompleteCriteria: ['Return a partial conclusion'],
  requiredCapabilities: ['text-generation'],
  mergeGate: 'not-required',
};

const identity: InteractionHelperIdentity = {
  organId: assignment.organId,
  interactionScopeId: assignment.interactionScopeId,
  interactionId: assignment.interactionId,
  inputRevision: assignment.inputRevision,
  parentTurnId: assignment.parentTurnId,
  assignmentId: assignment.assignmentId,
  helperCallId: assignment.helperCallId,
  attempt: assignment.attempt,
};

const binding: ProviderBinding = {
  bindingId: 'binding-taskless',
  providerId: 'rcc-taskless',
  protocol: 'responses',
  endpointRef: 'endpoint://rcc-taskless',
  modelRef: 'rcc-taskless-model',
  configDigest: 'sha256:taskless-config',
  capabilityDigest: 'sha256:taskless-capabilities',
};

const execution: TasklessHelperExecutionBinding = {
  runtimeId: 'runtime-taskless-helper',
  operationId,
  executionEpoch: 3,
};

interface RecordingDriver extends AgentDriver<TasklessProviderExecutionIdentityRef> {
  readonly startRequests: AgentStartRequest<TasklessProviderExecutionIdentityRef>[];
  readonly submitPayloads: BusinessPayload[];
}

function tasklessIdentityRef(): TasklessProviderExecutionIdentityRef {
  return {
    runtimeId: execution.runtimeId,
    organId,
    operationId,
    executionEpoch: execution.executionEpoch,
    helper: identity,
    taskId: undefined,
    cycleId: undefined,
  };
}

function recordingDriver(closureState: AgentClosure['state'] = 'succeeded'): RecordingDriver {
  const startRequests: AgentStartRequest<TasklessProviderExecutionIdentityRef>[] = [];
  const submitPayloads: BusinessPayload[] = [];
  const output: AgentOutput<TasklessProviderExecutionIdentityRef> = {
    ...tasklessIdentityRef(),
    assignmentId: assignment.assignmentId,
    payload: { summary: 'the bounded helper conclusion' },
    outputRefs: ['output://helper-taskless'],
    evidenceRefs: [evidence('driver-output-taskless')],
  };
  const closure: AgentClosure = { state: closureState, evidenceRefs: [evidence('closure-taskless')] };
  return {
    kind: 'taskless-helper-recording-driver',
    startRequests,
    submitPayloads,
    capabilities: async () => ({
      driverKind: 'taskless-helper-recording-driver',
      capabilities: ['text-generation'],
      version: '1',
    }),
    start: async (request) => {
      startRequests.push(request);
      return { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch };
    },
    resume: async () => {
      throw new Error('taskless helper execution never resumes a checkpoint');
    },
    submit: async (request) => {
      submitPayloads.push(request.payload);
      return output;
    },
    observe: async function* () {
      yield {
        ...tasklessIdentityRef(),
        kind: 'provider.output',
        evidenceRefs: [evidence('event-taskless')],
      } satisfies AgentEvent<TasklessProviderExecutionIdentityRef>;
    },
    requestStop: async () => ({ requested: false, operationId }),
    settle: async () => closure,
  };
}

async function fixture(): Promise<{ readonly file: string; readonly cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'taskless-helper-executor-'));
  return {
    file: join(directory, 'organ.jsonl'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function journalFor(file: string): InteractionHelperJournalPort {
  return new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
}

test('taskless helper execution keeps dispatch, return and owner acceptance separately durable', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = journalFor(file);
    const driver = recordingDriver();
    const executed = await executeTasklessInteractionHelper({
      journal,
      driver,
      assignment,
      binding,
      execution,
      inputs: { request: 'bounded helper request' },
      dispatchAcceptedAt: '2026-10-15T00:00:01.000Z',
      returnedAt: '2026-10-15T00:00:02.000Z',
      evidenceRefs: [evidence('dispatch-taskless')],
      conclude: ({ closure: settled, output, events }) => {
        if (settled.state !== 'succeeded') throw new Error('unexpected settled state for the fixture');
        return {
          agentId: 'agent-taskless-helper',
          producedArtifactRefs: ['artifact://helper-taskless'],
          producedArtifactDigests: ['sha256:helper-taskless'],
          status: 'succeeded',
          summary: 'The bounded taskless helper conclusion',
          outputRefs: output.outputRefs,
          evidenceRefs: [...events.flatMap((event) => event.evidenceRefs), ...output.evidenceRefs],
          nextAction: 'settle',
        };
      },
    });

    // The real binding/runtime/operation incarnation is durable before any dispatch.
    assert.equal(executed.incarnation.providerId, binding.providerId);
    assert.equal(executed.incarnation.modelRef, binding.modelRef);
    assert.equal(executed.incarnation.bindingId, binding.bindingId);
    assert.equal(executed.dispatchCommit.fact.incarnation?.runtimeId, execution.runtimeId);
    assert.equal(executed.dispatchCommit.fact.incarnation?.operationId, execution.operationId);
    assert.equal(executed.dispatchCommit.fact.incarnation?.executionEpoch, execution.executionEpoch);

    // The helper request carries only the assignment objective/targets and inputs.
    assert.deepEqual(driver.startRequests.length, 1);
    assert.equal(driver.submitPayloads.length, 1);
    const payload = driver.submitPayloads[0]!;
    assert.deepEqual(payload, {
      objective: assignment.objective,
      targetRefs: assignment.targetRefs,
      inputs: { request: 'bounded helper request' },
    });

    const afterExecute = await journal.readExact(identity);
    assert.notEqual(afterExecute.dispatchAccepted, null);
    assert.notEqual(afterExecute.returned, null);
    assert.equal(afterExecute.ownerAccepted, null);
    assert.deepEqual(afterExecute.returned?.fact.result, executed.result);
  } finally {
    await cleanup();
  }
});

test('a taskless helper dispatch append failure prevents any driver start or submit', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = journalFor(file);
    const driver = recordingDriver();
    const failingJournal: InteractionHelperJournalPort = {
      appendDispatchAccepted: async () => {
        throw new Error('durable dispatch append failed');
      },
      appendReturned: (fact) => journal.appendReturned(fact),
      appendOwnerAccepted: (fact) => journal.appendOwnerAccepted(fact),
      readExact: (helperIdentity) => journal.readExact(helperIdentity),
    };

    await assert.rejects(
      () =>
        executeTasklessInteractionHelper({
          journal: failingJournal,
          driver,
          assignment,
          binding,
          execution,
          inputs: { request: 'bounded helper request' },
          dispatchAcceptedAt: '2026-10-15T00:00:03.000Z',
          returnedAt: '2026-10-15T00:00:04.000Z',
          evidenceRefs: [evidence('dispatch-fail-taskless')],
          conclude: () => {
            throw new Error('conclude must not run without a durable dispatch');
          },
        }),
      /durable dispatch append failed/,
    );

    assert.equal(driver.startRequests.length, 0);
    assert.equal(driver.submitPayloads.length, 0);
  } finally {
    await cleanup();
  }
});

test('owner acceptance accepts a durable returned conclusion and keeps its real status', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = journalFor(file);
    const driver = recordingDriver('failed');
    const executed = await executeTasklessInteractionHelper({
      journal,
      driver,
      assignment,
      binding,
      execution,
      inputs: { request: 'bounded helper request' },
      dispatchAcceptedAt: '2026-10-15T00:00:05.000Z',
      returnedAt: '2026-10-15T00:00:06.000Z',
      evidenceRefs: [evidence('dispatch-failed-taskless')],
      conclude: () => ({
        agentId: 'agent-taskless-helper',
        producedArtifactRefs: [],
        producedArtifactDigests: [],
        status: 'failed',
        summary: 'The bounded taskless helper conclusion failed',
        outputRefs: [],
        evidenceRefs: [evidence('returned-failed-taskless')],
        nextAction: 'remediate',
        failureRef: 'failure://helper-taskless',
      }),
    });

    assert.equal(executed.result.status, 'failed');
    const refinedResult = { ref: evidence('refined-failed-taskless'), view: { kind: 'utf8-text' } } as const;

    const acceptance = await acceptTasklessInteractionHelperResult({
      journal,
      identity,
      result: executed.result,
      refinedResult,
      acceptedBy: 'runtime-explicit-brain-owner',
      acceptanceRef: 'acceptance://helper-taskless-failed',
      acceptedAt: '2026-10-15T00:00:07.000Z',
      evidenceRefs: [evidence('owner-accepted-failed-taskless')],
    });

    const readback = await journal.readExact(identity);
    assert.notEqual(readback.ownerAccepted, null);
    // The real failed conclusion and its failureRef survive acceptance unchanged.
    assert.equal(readback.ownerAccepted?.fact.result.status, 'failed');
    assert.equal(readback.ownerAccepted?.fact.result.failureRef, 'failure://helper-taskless');
    assert.equal(acceptance.latestTurnEntry.kind, 'helper-result');
    assert.equal(acceptance.latestTurnEntry.result.status, 'failed');
    assert.equal(acceptance.latestTurnEntry.result.failureRef, 'failure://helper-taskless');
    assert.equal(acceptance.latestTurnEntry.refinedResult.ref.evidenceId.value, 'refined-failed-taskless');
  } finally {
    await cleanup();
  }
});

test('owner acceptance without an append is refused, and a fabricated result cannot be accepted', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = journalFor(file);
    const driver = recordingDriver('waiting');
    const executed = await executeTasklessInteractionHelper({
      journal,
      driver,
      assignment,
      binding,
      execution,
      inputs: { request: 'bounded helper request' },
      dispatchAcceptedAt: '2026-10-15T00:00:08.000Z',
      returnedAt: '2026-10-15T00:00:09.000Z',
      evidenceRefs: [evidence('dispatch-incomplete-taskless')],
      conclude: () => ({
        agentId: 'agent-taskless-helper',
        producedArtifactRefs: [],
        producedArtifactDigests: [],
        status: 'incomplete',
        summary: 'The bounded taskless helper conclusion is partial',
        outputRefs: [],
        evidenceRefs: [evidence('returned-incomplete-taskless')],
        nextAction: 'wait',
        conditionRef: 'condition://helper-taskless',
      }),
    });
    assert.equal(executed.result.status, 'incomplete');

    const refinedResult = { ref: evidence('refined-incomplete-taskless'), view: { kind: 'utf8-text' } } as const;

    // Failure mode: an incomplete conclusion is reported as a success or accepted
    // from a result that was never durably returned.
    await assert.rejects(
      () =>
        acceptTasklessInteractionHelperResult({
          journal,
          identity,
          result: { ...executed.result, status: 'succeeded' },
          refinedResult,
          acceptedBy: 'runtime-explicit-brain-owner',
          acceptanceRef: 'acceptance://helper-taskless-fabricated',
          acceptedAt: '2026-10-15T00:00:10.000Z',
          evidenceRefs: [evidence('owner-accepted-fabricated-taskless')],
        }),
      /does not match the durable returned fact/,
    );
    await assert.rejects(
      () =>
        acceptTasklessInteractionHelperResult({
          journal,
          identity: { ...identity, helperCallId: 'call-unrelated-taskless' },
          result: executed.result,
          refinedResult,
          acceptedBy: 'runtime-explicit-brain-owner',
          acceptanceRef: 'acceptance://helper-taskless-missing-returned',
          acceptedAt: '2026-10-15T00:00:11.000Z',
          evidenceRefs: [evidence('owner-accepted-unrelated-taskless')],
        }),
      /no durable returned fact to accept/,
    );

    // The true incomplete conclusion is accepted without disguising its status.
    const acceptance = await acceptTasklessInteractionHelperResult({
      journal,
      identity,
      result: executed.result,
      refinedResult,
      acceptedBy: 'runtime-explicit-brain-owner',
      acceptanceRef: 'acceptance://helper-taskless-incomplete',
      acceptedAt: '2026-10-15T00:00:12.000Z',
      evidenceRefs: [evidence('owner-accepted-incomplete-taskless')],
    });
    assert.equal(acceptance.latestTurnEntry.result.status, 'incomplete');
    assert.equal(acceptance.latestTurnEntry.result.conditionRef, 'condition://helper-taskless');
    const readback = await journal.readExact(identity);
    assert.equal(readback.ownerAccepted?.fact.result.status, 'incomplete');
    assert.equal(readback.ownerAccepted?.fact.acceptedBy, 'runtime-explicit-brain-owner');
  } finally {
    await cleanup();
  }
});
