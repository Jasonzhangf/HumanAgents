import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
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
  type InteractionHelperAssignmentFields,
  type InteractionHelperIdentity,
  type InteractionLatestTurn,
  type InteractionLatestTurnEntry,
  type InteractionTurnIdentity,
  type ProviderBinding,
  type RawAsset,
  type TasklessProviderExecutionIdentityRef,
  id,
} from '../../../packages/contracts/src/index.js';
import {
  acceptTasklessInteractionHelperResult,
  executeTasklessInteractionHelper,
  type InteractionHelperJournalPort,
  type TasklessHelperExecutionBinding,
} from '../../../packages/runtime/src/explicit-brain/taskless-helper-executor.js';
import {
  ExplicitTurnHelperSession,
  type DispatchExplicitTurnHelperInput,
  type ExplicitTurnHelperClock,
  type ExplicitTurnHelperFactory,
} from '../../../packages/runtime/src/explicit-brain/interaction-turn-session.js';

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
  readonly settleCalls: { readonly runtimeId: string; readonly executionEpoch: number }[];
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

function recordingDriver(
  closureState: AgentClosure['state'] = 'succeeded',
  options: { readonly observeError?: Error } = {},
): RecordingDriver {
  const startRequests: AgentStartRequest<TasklessProviderExecutionIdentityRef>[] = [];
  const submitPayloads: BusinessPayload[] = [];
  const settleCalls: { runtimeId: string; executionEpoch: number }[] = [];
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
    settleCalls,
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
      if (options.observeError !== undefined) throw options.observeError;
      yield {
        ...tasklessIdentityRef(),
        kind: 'provider.output',
        evidenceRefs: [evidence('event-taskless')],
      } satisfies AgentEvent<TasklessProviderExecutionIdentityRef>;
    },
    requestStop: async () => ({ requested: false, operationId }),
    settle: async (request) => {
      settleCalls.push({ runtimeId: request.runtimeId, executionEpoch: request.executionEpoch });
      return closure;
    },
  };
}

async function fixture(
  root: string = tmpdir(),
): Promise<{ readonly file: string; readonly cleanup: () => Promise<void> }> {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'taskless-helper-executor-'));
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
      targetRefs: [...assignment.targetRefs],
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

test('a taskless helper observe failure still settles the started driver exactly once', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = journalFor(file);
    const observeFailure = new Error('helper observe stream failed');
    const driver = recordingDriver('unknown', { observeError: observeFailure });

    await assert.rejects(
      () =>
        executeTasklessInteractionHelper({
          journal,
          driver,
          assignment,
          binding,
          execution,
          inputs: { request: 'bounded helper request' },
          dispatchAcceptedAt: '2026-10-15T00:00:13.000Z',
          returnedAt: '2026-10-15T00:00:14.000Z',
          evidenceRefs: [evidence('dispatch-observe-fail-taskless')],
          conclude: () => {
            throw new Error('conclude must not run when observation fails');
          },
        }),
      (error: unknown) => {
        // The original first error survives because settle itself succeeded.
        assert.equal(error, observeFailure);
        return true;
      },
    );

    // A started execution must be collapsed exactly once even when observe throws.
    assert.equal(driver.startRequests.length, 1);
    assert.equal(driver.submitPayloads.length, 1);
    assert.equal(driver.settleCalls.length, 1);
    assert.deepEqual(driver.settleCalls[0], {
      runtimeId: execution.runtimeId,
      executionEpoch: execution.executionEpoch,
    });

    // The durable dispatch fact stands, but no returned fact is fabricated.
    const readback = await journal.readExact(identity);
    assert.notEqual(readback.dispatchAccepted, null);
    assert.equal(readback.returned, null);
    assert.equal(readback.ownerAccepted, null);
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

// ---------------------------------------------------------------------------
// Runtime explicit-turn helper session public consumer.
//
// Failure mode: the Runtime turn/session coordinator is missing or mis-owns
// helper lifecycle. A returned success is auto-accepted, one provider binding is
// reused for every dynamic role, the parent turn transcript leaks into a helper
// request, or a transport closure state is rewritten into a business status
// instead of the caller's real conclusion. Probability is unknown (new seam).
// Impact is false recovery responsibility. Cost is one scenario in this
// existing public-consumer file.
// ---------------------------------------------------------------------------

const sessionOrganId = id('organ', 'organ-explicit-turn-session');
const sessionScopeId = 'interaction-scope-explicit-turn-session';
const sessionInteractionId = 'interaction-explicit-turn-session';
const sessionInputRevision = 7;
const sessionTurnId = 'turn-explicit-turn-session';
const parentTranscriptSentinel = 'parent-transcript-sentinel-session';
const reviewOutputRef = 'output://explicit-turn-session-review';
const reviewDigest = `sha256:${'e'.repeat(64)}`;
const sessionClockBase = Date.parse('2026-10-15T00:00:00.000Z');
const sessionSettleAdvanceMillis = 30_000;

const sessionIdentity: InteractionTurnIdentity = {
  organId: sessionOrganId,
  interactionScopeId: sessionScopeId,
  interactionId: sessionInteractionId,
  inputRevision: sessionInputRevision,
  turnId: sessionTurnId,
};

const sessionInitialLatestTurn: InteractionLatestTurn = {
  ...sessionIdentity,
  entries: [
    {
      kind: 'user-input',
      content: {
        ref: { ...sessionEvidence('parent-input'), locator: parentTranscriptSentinel },
        view: { kind: 'utf8-text' },
      },
    },
  ],
};

function sessionEvidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-explicit-turn-session',
    locator: `interaction://${label}`,
    digest: `sha256:${'c'.repeat(64)}`,
    scope: { organId: sessionOrganId },
  };
}

function sessionClock(): {
  readonly clock: ExplicitTurnHelperClock;
  readonly advance: (millis: number) => void;
} {
  let current = sessionClockBase;
  return {
    clock: { now: () => new Date(current).toISOString() },
    advance: (millis) => {
      current += millis;
    },
  };
}

function sessionHelperIdentity(assignment: InteractionHelperAssignment): InteractionHelperIdentity {
  return {
    organId: assignment.organId,
    interactionScopeId: assignment.interactionScopeId,
    interactionId: assignment.interactionId,
    inputRevision: assignment.inputRevision,
    parentTurnId: assignment.parentTurnId,
    assignmentId: assignment.assignmentId,
    helperCallId: assignment.helperCallId,
    attempt: assignment.attempt,
  };
}

interface SessionDispatchRecord {
  readonly selection: { readonly roleId: string; readonly configuredAgentId?: string };
  readonly assignment: InteractionHelperAssignment;
  readonly execution: TasklessHelperExecutionBinding;
  readonly startRequests: AgentStartRequest<TasklessProviderExecutionIdentityRef>[];
  readonly submitPayloads: BusinessPayload[];
  readonly settleCalls: { readonly runtimeId: string; readonly executionEpoch: number }[];
  closes: number;
}

interface SessionFactorySpec {
  readonly binding: ProviderBinding;
  readonly closureState: AgentClosure['state'];
}

function sessionDriver(input: {
  readonly assignment: InteractionHelperAssignment;
  readonly execution: TasklessHelperExecutionBinding;
  readonly closureState: AgentClosure['state'];
  readonly onSettle?: () => void;
}): {
  readonly driver: AgentDriver<TasklessProviderExecutionIdentityRef>;
  readonly startRequests: AgentStartRequest<TasklessProviderExecutionIdentityRef>[];
  readonly submitPayloads: BusinessPayload[];
  readonly settleCalls: { readonly runtimeId: string; readonly executionEpoch: number }[];
} {
  const { assignment, execution } = input;
  const helper = sessionHelperIdentity(assignment);
  const startRequests: AgentStartRequest<TasklessProviderExecutionIdentityRef>[] = [];
  const submitPayloads: BusinessPayload[] = [];
  const settleCalls: { runtimeId: string; executionEpoch: number }[] = [];
  const output: AgentOutput<TasklessProviderExecutionIdentityRef> = {
    runtimeId: execution.runtimeId,
    organId: assignment.organId,
    operationId: execution.operationId,
    executionEpoch: execution.executionEpoch,
    helper,
    taskId: undefined,
    cycleId: undefined,
    assignmentId: assignment.assignmentId,
    payload: {},
    outputRefs: [],
    evidenceRefs: [sessionEvidence(`${assignment.helperCallId}-driver-output`)],
  };
  const closure: AgentClosure = {
    state: input.closureState,
    evidenceRefs: [sessionEvidence(`${assignment.helperCallId}-closure`)],
  };
  const driver: AgentDriver<TasklessProviderExecutionIdentityRef> = {
    kind: 'explicit-turn-session-recording-driver',
    capabilities: async () => ({
      driverKind: 'explicit-turn-session-recording-driver',
      capabilities: ['text-generation'],
      version: '1',
    }),
    start: async (request) => {
      startRequests.push(request);
      return { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch };
    },
    resume: async () => {
      throw new Error('explicit turn helper never resumes');
    },
    submit: async (request) => {
      submitPayloads.push(request.payload);
      return output;
    },
    observe: async function* () {
      yield {
        runtimeId: execution.runtimeId,
        organId: assignment.organId,
        operationId: execution.operationId,
        executionEpoch: execution.executionEpoch,
        helper,
        taskId: undefined,
        cycleId: undefined,
        kind: 'provider.output',
        evidenceRefs: [sessionEvidence(`${assignment.helperCallId}-event`)],
      } satisfies AgentEvent<TasklessProviderExecutionIdentityRef>;
    },
    requestStop: async () => ({ requested: false, operationId: execution.operationId }),
    settle: async (request) => {
      settleCalls.push({ runtimeId: request.runtimeId, executionEpoch: request.executionEpoch });
      input.onSettle?.();
      return closure;
    },
  };
  return { driver, startRequests, submitPayloads, settleCalls };
}

function sessionFactory(
  specs: Record<string, SessionFactorySpec>,
  onSettle?: () => void,
): {
  readonly factory: ExplicitTurnHelperFactory;
  readonly records: SessionDispatchRecord[];
} {
  const records: SessionDispatchRecord[] = [];
  const factory: ExplicitTurnHelperFactory = async (input) => {
    const spec = specs[input.selection.roleId] as SessionFactorySpec | undefined;
    if (spec === undefined) throw new Error(`no session spec for role ${input.selection.roleId}`);
    const bundle = sessionDriver({
      assignment: input.assignment,
      execution: input.execution,
      closureState: spec.closureState,
      onSettle,
    });
    const record: SessionDispatchRecord = {
      selection: input.selection,
      assignment: input.assignment,
      execution: input.execution,
      startRequests: bundle.startRequests,
      submitPayloads: bundle.submitPayloads,
      settleCalls: bundle.settleCalls,
      closes: 0,
    };
    records.push(record);
    return {
      binding: spec.binding,
      driver: bundle.driver,
      close: async () => {
        record.closes += 1;
      },
    };
  };
  return { factory, records };
}

type SessionConclude = DispatchExplicitTurnHelperInput['conclude'];

function sessionIncompleteConclude(agentId: string): SessionConclude {
  return () => ({
    agentId,
    producedArtifactRefs: [],
    producedArtifactDigests: [],
    status: 'incomplete',
    summary: 'bounded helper returned a partial conclusion',
    outputRefs: [],
    evidenceRefs: [sessionEvidence(`${agentId}-returned`)],
    nextAction: 'wait',
    conditionRef: 'condition://explicit-turn-session',
  });
}

function sessionSucceededConclude(agentId: string): SessionConclude {
  return () => ({
    agentId,
    producedArtifactRefs: [`artifact://${agentId}`],
    producedArtifactDigests: [reviewDigest],
    status: 'succeeded',
    summary: 'bounded helper returned a complete conclusion',
    outputRefs: [reviewOutputRef],
    evidenceRefs: [sessionEvidence(`${agentId}-returned`)],
    nextAction: 'settle',
  });
}

test('explicit turn helper session dispatches two independent helpers and accepts only the incomplete one', async () => {
  // The new session scenario uses the canonical exclusive HOME test root
  // (~/.humanagent/test-fixtures, overridable via HUMANAGENT_TEST_ROOT for
  // sandboxed runs); the original five cases keep their tmpdir fixture.
  const { file, cleanup } = await fixture(
    process.env.HUMANAGENT_TEST_ROOT ?? join(homedir(), '.humanagent', 'test-fixtures'),
  );
  try {
    const journal = journalFor(file);
    const bindingExec: ProviderBinding = {
      bindingId: 'binding-helper-exec',
      providerId: 'rcc-exec',
      protocol: 'anthropic',
      endpointRef: 'endpoint://exec',
      modelRef: 'model-helper-exec',
      configDigest: `sha256:${'1'.repeat(64)}`,
      capabilityDigest: `sha256:${'2'.repeat(64)}`,
    };
    const bindingReview: ProviderBinding = {
      bindingId: 'binding-helper-review',
      providerId: 'rcc-review',
      protocol: 'openai',
      endpointRef: 'endpoint://review',
      modelRef: 'model-helper-review',
      configDigest: `sha256:${'3'.repeat(64)}`,
      capabilityDigest: `sha256:${'4'.repeat(64)}`,
    };
    const { clock, advance } = sessionClock();
    const { factory, records } = sessionFactory(
      {
        execution: { binding: bindingExec, closureState: 'succeeded' },
        review: { binding: bindingReview, closureState: 'succeeded' },
      },
      () => advance(sessionSettleAdvanceMillis),
    );
    const session = new ExplicitTurnHelperSession({
      identity: sessionIdentity,
      latestTurn: sessionInitialLatestTurn,
      journal,
      clock,
      factory,
    });

    const execFields: InteractionHelperAssignmentFields = {
      objective: 'Explore the bounded question',
      targetRefs: ['interaction://explicit-turn-session-a'],
      expectedOutputRefs: [],
      acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`,
      successCriteria: ['Return a complete conclusion'],
      failureCriteria: ['Return no conclusion'],
      incompleteCriteria: ['Return a partial conclusion'],
      requiredCapabilities: ['text-generation'],
      mergeGate: 'not-required',
    };
    const reviewFields: InteractionHelperAssignmentFields = {
      objective: 'Review the bounded artifact',
      targetRefs: ['interaction://explicit-turn-session-b'],
      expectedOutputRefs: [reviewOutputRef],
      expectedArtifactDigests: [reviewDigest],
      acceptanceCriteriaDigest: `sha256:${'b'.repeat(64)}`,
      successCriteria: ['Return a complete review'],
      failureCriteria: ['Return no review'],
      incompleteCriteria: ['Return a partial review'],
      requiredCapabilities: ['text-generation'],
      mergeGate: 'not-required',
    };

    const dispatchedExec = await session.dispatchHelper({
      selection: { roleId: 'execution', configuredAgentId: 'agent-exec-1' },
      assignmentFields: execFields,
      inputs: { question: 'bounded-question-a' },
      evidenceRefs: [sessionEvidence('dispatch-exec')],
      conclude: sessionIncompleteConclude('agent-exec-1'),
    });
    const dispatchedReview = await session.dispatchHelper({
      selection: { roleId: 'review', configuredAgentId: 'agent-review-1' },
      assignmentFields: reviewFields,
      inputs: { artifactRef: 'artifact://bounded-review-b' },
      evidenceRefs: [sessionEvidence('dispatch-review')],
      conclude: sessionSucceededConclude('agent-review-1'),
    });

    const refinedResultExec: RawAsset = {
      ref: sessionEvidence('refined-exec'),
      view: { kind: 'utf8-text' },
    };
    const acceptance = await session.acceptHelper({
      helperCallId: dispatchedExec.identity.helperCallId,
      refinedResult: refinedResultExec,
      acceptedBy: 'runtime-explicit-turn-owner',
      acceptanceRef: 'acceptance://explicit-turn-session-exec',
      evidenceRefs: [sessionEvidence('owner-accepted-exec')],
    });

    // Two dynamic dispatches with different role selections.
    assert.equal(records.length, 2);
    assert.deepEqual(records[0]!.selection, { roleId: 'execution', configuredAgentId: 'agent-exec-1' });
    assert.deepEqual(records[1]!.selection, { roleId: 'review', configuredAgentId: 'agent-review-1' });

    // Every dispatch gets its own helper/assignment/attempt and independent runtime/operation.
    assert.notEqual(dispatchedExec.identity.helperCallId, dispatchedReview.identity.helperCallId);
    assert.notEqual(dispatchedExec.identity.assignmentId, dispatchedReview.identity.assignmentId);
    assert.notEqual(dispatchedExec.execution.runtimeId, dispatchedReview.execution.runtimeId);
    assert.notEqual(
      dispatchedExec.execution.operationId.value,
      dispatchedReview.execution.operationId.value,
    );
    assert.equal(dispatchedExec.identity.attempt, 1);
    assert.equal(dispatchedReview.identity.attempt, 1);

    // The real turn identity is bound into every helper identity.
    for (const dispatched of [dispatchedExec, dispatchedReview]) {
      assert.equal(dispatched.identity.organId.value, sessionOrganId.value);
      assert.equal(dispatched.identity.interactionScopeId, sessionScopeId);
      assert.equal(dispatched.identity.interactionId, sessionInteractionId);
      assert.equal(dispatched.identity.inputRevision, sessionInputRevision);
      assert.equal(dispatched.identity.parentTurnId, sessionTurnId);
    }

    // The driver start identity is taskless: a complete helper identity, no Task, no cycle.
    const startExec = records[0]!.startRequests[0]!;
    assert.equal(startExec.taskId, undefined);
    assert.equal(startExec.cycleId, undefined);
    assert.equal(startExec.organId.value, sessionOrganId.value);
    assert.equal(startExec.helper.helperCallId, dispatchedExec.identity.helperCallId);
    assert.equal(startExec.helper.parentTurnId, sessionTurnId);
    assert.equal(startExec.helper.attempt, 1);
    assert.equal(startExec.runtimeId, dispatchedExec.execution.runtimeId);
    assert.equal(startExec.operationId.value, dispatchedExec.execution.operationId.value);
    const startReview = records[1]!.startRequests[0]!;
    assert.equal(startReview.taskId, undefined);
    assert.equal(startReview.helper.helperCallId, dispatchedReview.identity.helperCallId);

    // Each helper request is bounded to its own objective/targets/inputs.
    assert.deepEqual(records[0]!.submitPayloads[0], {
      objective: execFields.objective,
      targetRefs: [...execFields.targetRefs],
      inputs: { question: 'bounded-question-a' },
    });
    assert.deepEqual(records[1]!.submitPayloads[0], {
      objective: reviewFields.objective,
      targetRefs: [...reviewFields.targetRefs],
      inputs: { artifactRef: 'artifact://bounded-review-b' },
    });
    for (const record of records) {
      assert.equal(
        JSON.stringify(record.submitPayloads[0]).includes(parentTranscriptSentinel),
        false,
      );
    }

    // Independent provider binding is durable on each dispatch.
    const readExec = await journal.readExact(dispatchedExec.identity);
    const readReview = await journal.readExact(dispatchedReview.identity);
    assert.equal(readExec.dispatchAccepted?.fact.incarnation?.bindingId, bindingExec.bindingId);
    assert.equal(readReview.dispatchAccepted?.fact.incarnation?.bindingId, bindingReview.bindingId);

    // Dispatch, return and owner acceptance stay separate durable facts.
    assert.notEqual(readExec.dispatchAccepted, null);
    assert.notEqual(readExec.returned, null);
    assert.notEqual(readExec.ownerAccepted, null);
    // The host clock only advances when the driver settles. A returnedAt sampled
    // at dispatch time (the pre-fix bug) records the dispatch value and misses
    // the settle advance, so this pins the durable time to the real return.
    assert.equal(
      readExec.returned?.fact.returnedAt,
      new Date(sessionClockBase + sessionSettleAdvanceMillis).toISOString(),
    );
    // The real business status survives; the transport closure state ('succeeded') is never mapped.
    assert.equal(readExec.returned?.fact.result.status, 'incomplete');
    assert.equal(readExec.ownerAccepted?.fact.result.status, 'incomplete');
    assert.equal(readExec.ownerAccepted?.fact.acceptedBy, 'runtime-explicit-turn-owner');

    assert.notEqual(readReview.dispatchAccepted, null);
    assert.notEqual(readReview.returned, null);
    // A returned success is not auto-accepted.
    assert.equal(readReview.ownerAccepted, null);
    assert.equal(readReview.returned?.fact.result.status, 'succeeded');

    // Only the accepted helper result enters the latest turn.
    const latest = session.latestTurn();
    const helperEntries = latest.entries.filter(
      (entry): entry is Extract<InteractionLatestTurnEntry, { kind: 'helper-result' }> =>
        entry.kind === 'helper-result',
    );
    assert.equal(latest.entries.length, 2);
    assert.equal(helperEntries.length, 1);
    assert.equal(helperEntries[0]!.result.helperCallId, dispatchedExec.identity.helperCallId);
    assert.equal(helperEntries[0]!.result.status, 'incomplete');
    assert.equal(helperEntries[0]!.refinedResult.ref.evidenceId.value, 'refined-exec');
    assert.equal(acceptance.latestTurnEntry.result.status, 'incomplete');

    // Normal lifecycle: every started helper settled exactly once and its owned provider closed once.
    assert.equal(records[0]!.settleCalls.length, 1);
    assert.equal(records[1]!.settleCalls.length, 1);
    assert.equal(records[0]!.closes, 1);
    assert.equal(records[1]!.closes, 1);
  } finally {
    await cleanup();
  }
});
