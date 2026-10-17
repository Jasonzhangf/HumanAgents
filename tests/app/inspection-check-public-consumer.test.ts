import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../packages/contracts/src/index.js';
import {
  type DurableInspectionDefinition,
  type InspectionAcceptedCheckPort,
  type InspectionCheckPort,
  type InspectionExecutionBinding,
  type InspectionExecutableCheck,
  type InspectionItemDelivery,
  type InspectionItemResultRecord,
} from '../../packages/contracts/src/i2-history.js';
import { createInspectionCheckPort } from '../../packages/app/src/inspection-check.js';
import { digestOf, type ReviewSubjectMaterial } from '../../packages/runtime/src/orchestration/index.js';

type InspectionCheckRequest = Parameters<InspectionCheckPort['run']>[0];

const organId = id('organ', 'organ-inspection-actor');
const taskId = id('task', 'task-inspection-actor');
const cycleId = id('cycle', 'cycle-inspection-actor');
const taskScope: ScopeRef & { readonly taskId: NonNullable<ScopeRef['taskId']> } = { organId, taskId };
const executionScope: ScopeRef = { organId, taskId, cycleId };

const definitionCommitRef: JournalCommitRef = {
  commitId: 'commit-inspection-definition',
  journalSeq: 7,
  recordDigest: 'sha256:definition-record',
};
const cycleOpenedCommitRef: JournalCommitRef = {
  commitId: 'commit-inspection-cycle',
  journalSeq: 6,
  recordDigest: 'sha256:cycle-opened',
};

const definitionId = 'inspection-actor-definition';
const definitionVersion = 'inspection-actor-definition-v1';
const checkId = 'inspection-actor-check-1';
const criterion = 'report whether the target contains a TODO marker';
const inputRefs = ['artifact://inspection-actor/target'];
const outputRef = 'artifact://inspection-actor/observation';
const attempt = 1;
const executionEpoch = 2;

const binding: InspectionExecutionBinding = {
  occurrence: { scope: taskScope, occurrenceId: 'occurrence-inspection-actor' },
  executionScope,
  cycleId: cycleId.value,
  executionEpoch,
  definition: { definitionId, definitionVersion },
  definitionCommitRef,
  definitionDigest: 'sha256:inspection-definition',
  cycleOpenedCommitRef,
  scheduleOccurrenceRef: null,
};

const check: InspectionExecutableCheck = { checkId, criterion, inputRefs };

const definition: DurableInspectionDefinition = {
  kind: 'inspection-definition',
  schemaVersion: 1,
  taskScope,
  content: {
    definition: {
      definitionId,
      definitionVersion,
      target: {
        targetRef: 'artifact://inspection-actor/target',
        sourceRef: 'artifact://inspection-actor/source',
      },
      checkItems: [{ checkId }],
    },
    checks: [{ checkId, criterion, inputRefs }],
  },
  definitionDigest: binding.definitionDigest,
  planRevisionCommitRef: {
    commitId: 'commit-inspection-plan',
    journalSeq: 5,
    recordDigest: 'sha256:plan',
  },
  createdAt: '2026-10-13T19:00:00.000Z',
};

const assignment: WorkAssignment = {
  assignmentId: 'assignment-inspection-actor',
  taskId,
  pipelineNodeId: 'node-inspection-actor',
  attempt,
  executionEpoch,
  inputRevision: 1,
  objective: 'observe the committed inspection check exactly',
  targetRefs: [outputRef],
  expectedOutputRefs: [outputRef],
  acceptanceCriteriaDigest: 'sha256:inspection-acceptance',
  successCriteria: ['return the exact structured inspection item result'],
  failureCriteria: [],
  incompleteCriteria: [],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};

const request: InspectionCheckRequest = { binding, check, assignment };

const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'evidence-inspection-actor-1'),
  kind: 'execution',
  source: 'inspection-actor-consumer',
  locator: 'observation://inspection-actor/result-1',
  digest: 'sha256:evidence-inspection-actor',
  scope: { organId, taskId },
};

// A negative observed condition is still a completed measurement.
const completedDelivery: InspectionItemDelivery = {
  checkId,
  resultId: 'result-inspection-actor-1',
  attempt,
  outcome: { status: 'completed', judgment: 'one TODO marker observed' },
  evidenceRefs: [evidence],
  completedAt: '2026-10-13T20:15:00.000Z',
};
const completedRecord: InspectionItemResultRecord = {
  kind: 'inspection-item-result',
  schemaVersion: 1,
  binding,
  delivery: completedDelivery,
};
const completedBody = JSON.stringify(completedRecord);
const completedDigest = digestOf(completedBody);

const failedDelivery: InspectionItemDelivery = {
  checkId,
  resultId: 'result-inspection-actor-2',
  attempt,
  outcome: { status: 'unknown', reason: 'the actor stopped before the check could run' },
  evidenceRefs: [evidence],
  completedAt: '2026-10-13T20:20:00.000Z',
};

interface PortCounts {
  execute: number;
  read: number;
  readOutput: number;
}

function workResult(body: string, digest: string): WorkResult {
  return {
    taskId,
    pipelineNodeId: assignment.pipelineNodeId,
    agentId: 'agent-inspection-actor',
    assignmentId: assignment.assignmentId,
    attempt: assignment.attempt,
    executionEpoch: assignment.executionEpoch,
    inputRevision: assignment.inputRevision,
    producedArtifactRefs: [outputRef],
    producedArtifactDigests: [digest],
    producedArtifactBodies: [body],
    status: 'succeeded',
    summary: 'inspection observation produced',
    outputRefs: [outputRef],
    evidenceRefs: [],
    nextAction: 'settle',
  };
}

function structuredRecord(delivery: InspectionItemDelivery, resultBinding: InspectionExecutionBinding = binding): string {
  const record: InspectionItemResultRecord = {
    kind: 'inspection-item-result',
    schemaVersion: 1,
    binding: resultBinding,
    delivery,
  };
  return JSON.stringify(record);
}

function buildPort(options: {
  readonly result?: WorkResult | { readonly result: WorkResult };
  readonly material?: ReviewSubjectMaterial;
  readonly definition?: DurableInspectionDefinition;
} = {}): {
  readonly port: InspectionAcceptedCheckPort;
  readonly counts: PortCounts;
  readonly executed: InspectionCheckRequest[];
} {
  const counts: PortCounts = { execute: 0, read: 0, readOutput: 0 };
  const executed: InspectionCheckRequest[] = [];
  const port = createInspectionCheckPort({
    journal: {
      async read() {
        counts.read += 1;
        return options.definition ?? definition;
      },
    },
    execute: async (received) => {
      counts.execute += 1;
      executed.push(received);
      return options.result ?? workResult(completedBody, completedDigest);
    },
    readOutput: async () => {
      counts.readOutput += 1;
      return options.material ?? { ref: outputRef, body: completedBody, digest: completedDigest };
    },
  });
  return { port, counts, executed };
}

function expectContractError(pattern: RegExp) {
  return (error: unknown): boolean => {
    if (!(error instanceof ContractError)) {
      throw new Error(`expected ContractError, got ${String(error)}`);
    }
    assert.match(error.message, pattern);
    return true;
  };
}

test('inspection actor returns the exact structured observation, rejects summary-only output, and preserves explicit failure', async () => {
  // A successful WorkResult whose produced body is only the executor summary
  // must not become a measurement.
  const summaryOnly = 'inspection completed: one TODO marker observed';
  const summaryRun = buildPort({
    result: workResult(summaryOnly, digestOf(summaryOnly)),
    material: { ref: outputRef, body: summaryOnly, digest: digestOf(summaryOnly) },
  });
  await assert.rejects(
    () => summaryRun.port.run(request),
    expectContractError(/inspection item result record/),
  );
  assert.equal(summaryRun.counts.execute, 1);

  // The exact structured observation is returned unchanged, and the actual
  // WorkAssignment object is forwarded to the admitted actor.
  const structuredRun = buildPort();
  const delivery = await structuredRun.port.run(request);
  assert.deepEqual(delivery, completedDelivery);
  assert.equal(delivery.checkId, checkId);
  assert.equal(delivery.attempt, attempt);
  assert.equal(delivery.resultId, 'result-inspection-actor-1');
  assert.equal(
    delivery.outcome.status === 'completed' ? delivery.outcome.judgment : undefined,
    'one TODO marker observed',
  );
  assert.deepEqual(delivery.evidenceRefs, [evidence]);
  assert.equal(delivery.completedAt, '2026-10-13T20:15:00.000Z');
  assert.equal(structuredRun.executed.length, 1);
  assert.equal(structuredRun.executed[0]?.assignment, assignment);
  assert.equal(structuredRun.executed[0]?.check, check);
  assert.equal(structuredRun.executed[0]?.binding, binding);

  // An explicit non-success delivery is preserved verbatim, with no
  // manufactured judgment and no promotion to completed.
  const failedBody = structuredRecord(failedDelivery);
  const failedRun = buildPort({
    result: workResult(failedBody, digestOf(failedBody)),
    material: { ref: outputRef, body: failedBody, digest: digestOf(failedBody) },
  });
  const failed = await failedRun.port.run(request);
  assert.deepEqual(failed, failedDelivery);
  assert.equal(failed.outcome.status, 'unknown');
  assert.equal(failed.outcome.status === 'completed' ? failed.outcome.judgment : undefined, undefined);
  if (failed.outcome.status !== 'completed') {
    assert.equal(failed.outcome.reason, 'the actor stopped before the check could run');
  }

  // Valid completed JSON cannot promote an actually failed execution.
  const failedExecutionRun = buildPort({
    result: {
      ...workResult(completedBody, completedDigest),
      status: 'failed',
      failureRef: 'failure://inspection-actor/execution',
    },
  });
  await assert.rejects(
    () => failedExecutionRun.port.run(request),
    expectContractError(/non-successful execution.*completed/),
  );
  assert.equal(failedExecutionRun.counts.execute, 1);
});

test('inspection accepted delivery validates committed identity without re-executing or reading output', async () => {
  const fullBody = 'full child result body; this is not inspection control JSON';
  const result = workResult(fullBody, digestOf(fullBody));
  const run = buildPort();
  const port = run.port;

  const accepted = await port.accept({
    binding,
    check,
    assignment,
    result,
    delivery: completedDelivery,
  });

  assert.equal(accepted, completedDelivery);
  assert.equal(
    accepted.outcome.status === 'completed' ? accepted.outcome.judgment : undefined,
    'one TODO marker observed',
  );
  assert.equal(accepted.evidenceRefs, completedDelivery.evidenceRefs);
  assert.deepEqual(accepted.evidenceRefs, [evidence]);
  assert.equal(result.producedArtifactBodies?.[0], fullBody);
  assert.deepEqual(run.counts, { execute: 0, read: 1, readOutput: 0 });

  await assert.rejects(
    () => port.accept({
      binding: { ...binding, definitionDigest: 'sha256:not-the-committed-definition' },
      check,
      assignment,
      result,
      delivery: completedDelivery,
    }),
    expectContractError(/definition digest/),
  );

  const foreignDefinitionRun = buildPort({
    definition: {
      ...definition,
      content: {
        ...definition.content,
        definition: {
          ...definition.content.definition,
          definitionVersion: 'inspection-actor-definition-foreign',
        },
      },
    },
  });
  await assert.rejects(
    () => foreignDefinitionRun.port.accept({
      binding,
      check,
      assignment,
      result,
      delivery: completedDelivery,
    }),
    expectContractError(/definition identity/),
  );
  assert.deepEqual(foreignDefinitionRun.counts, { execute: 0, read: 1, readOutput: 0 });
});

test('inspection actor rejects a changed immutable check and a foreign structured delivery', async () => {
  // The immutable definition belongs to the product Task. The assignment
  // belongs to the distinct actual execution Task supplied by the caller.
  const executionTaskId = id('task', 'task-inspection-execution');
  const distinctBinding: InspectionExecutionBinding = {
    ...binding,
    executionScope: { ...executionScope, taskId: executionTaskId },
  };
  const distinctAssignment: WorkAssignment = { ...assignment, taskId: executionTaskId };
  const distinctRequest: InspectionCheckRequest = {
    ...request, binding: distinctBinding, assignment: distinctAssignment,
  };
  const distinctBody = structuredRecord(completedDelivery, distinctBinding);
  const distinctDigest = digestOf(distinctBody);
  const distinctRun = buildPort({
    result: { ...workResult(distinctBody, distinctDigest), taskId: executionTaskId },
    material: { ref: outputRef, body: distinctBody, digest: distinctDigest },
  });
  assert.deepEqual(await distinctRun.port.run(distinctRequest), completedDelivery);
  assert.equal(distinctRun.executed[0]?.assignment, distinctAssignment);
  assert.equal(distinctRun.executed[0]?.binding, distinctBinding);

  const wrongExecutionAssignmentRun = buildPort();
  await assert.rejects(
    () => wrongExecutionAssignmentRun.port.run({ ...distinctRequest, assignment }),
    expectContractError(/assignment task.*execution task/),
  );
  assert.equal(wrongExecutionAssignmentRun.counts.execute, 0);

  const criterionRun = buildPort();
  await assert.rejects(
    () => criterionRun.port.run({ ...request, check: { ...check, criterion: `${criterion} (edited)` } }),
    expectContractError(/criterion/),
  );
  assert.equal(criterionRun.counts.execute, 0);

  const inputRun = buildPort();
  await assert.rejects(
    () => inputRun.port.run({ ...request, check: { ...check, inputRefs: ['artifact://inspection-actor/other'] } }),
    expectContractError(/input refs/),
  );
  assert.equal(inputRun.counts.execute, 0);

  const versionRun = buildPort();
  await assert.rejects(
    () => versionRun.port.run({
      ...request,
      binding: { ...binding, definition: { ...binding.definition, definitionVersion: 'inspection-actor-definition-v2' } },
    }),
    expectContractError(/definition identity/),
  );
  assert.equal(versionRun.counts.execute, 0);

  const foreignDeliveryBody = structuredRecord({ ...completedDelivery, checkId: 'inspection-actor-check-other' });
  const foreignDeliveryRun = buildPort({
    result: workResult(foreignDeliveryBody, digestOf(foreignDeliveryBody)),
    material: { ref: outputRef, body: foreignDeliveryBody, digest: digestOf(foreignDeliveryBody) },
  });
  await assert.rejects(
    () => foreignDeliveryRun.port.run(request),
    expectContractError(/check id/),
  );

  const foreignBindingBody = structuredRecord(completedDelivery, {
    ...binding,
    occurrence: { ...binding.occurrence, occurrenceId: 'occurrence-inspection-actor-other' },
  });
  const foreignBindingRun = buildPort({
    result: workResult(foreignBindingBody, digestOf(foreignBindingBody)),
    material: { ref: outputRef, body: foreignBindingBody, digest: digestOf(foreignBindingBody) },
  });
  await assert.rejects(
    () => foreignBindingRun.port.run(request),
    expectContractError(/binding/),
  );

  const driftedDigestRun = buildPort({
    material: { ref: outputRef, body: completedBody, digest: 'sha256:drifted' },
  });
  await assert.rejects(
    () => driftedDigestRun.port.run(request),
    expectContractError(/digest/),
  );

  const missingBodyRun = buildPort({
    material: { ref: outputRef, body: '', digest: completedDigest },
  });
  await assert.rejects(
    () => missingBodyRun.port.run(request),
    expectContractError(/digest/),
  );

  const unrelatedRefRun = buildPort({
    material: { ref: 'artifact://inspection-actor/unrelated', body: completedBody, digest: completedDigest },
  });
  await assert.rejects(
    () => unrelatedRefRun.port.run(request),
    expectContractError(/produced artifact/),
  );
});
