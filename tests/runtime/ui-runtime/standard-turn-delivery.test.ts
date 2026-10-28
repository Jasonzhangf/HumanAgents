import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  id,
  type AcceptedRawFact,
  type EvidenceRef,
  type RawContentReadPort,
  type ScopeRef,
  type StandardTurnEndCommand,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import {
  bindAssignmentDelivery,
  readStandardTurnDelivery,
  StandardTurnDeliveryError,
  type InspectToolCompletionDescriptor,
  type StandardTurnDeliveryReaderPort,
} from '../../../packages/runtime/src/ui-runtime/standard-turn-delivery.js';

// The real Task B present result has a raw 434-byte JSON report and a separate
// committed file artifact. Both fields of the optional primary-output slot are
// absent. Before the fix the reader rejects this legal result as
// artifact-conflict at its first completion check. This test states the failure
// before execution; the actual RED is recorded in the worker run note.
test('inspect delivery binds the raw report when an inspect result has no primary output', async () => {
  const scope: ScopeRef = {
    organId: id('organ', 'inspect-report-organ'),
    taskId: id('task', 'inspect-report-task'),
    cycleId: id('cycle', 'inspect-report-cycle'),
    operationId: id('operation', 'inspect-report-parent'),
  };
  const toolOperationId = id('operation', 'inspect-report-tool');
  const reportText = '{"turn":1,"files":[{"path":"project-scope-isolation.md","description":"Short paragraph containing M4-SCOPE-MARKER-PROJECT-B explaining project scope isolation"}],"artifacts":[{"path":"project-scope-isolation.md","assetRef":"asset://provider-tool/artifact/provider-tool-present-ui-task-implicit-draft-2-call_00_Yy1JPH1lYglTkWSLLqNR0583-0","digest":"sha256:548aff83b0f705ac97cd34e1cf3142170b119935431c24bf3f8cd4a6ea158c6b","size":557}]}';
  const reportBytes = new TextEncoder().encode(reportText);
  assert.equal(reportBytes.byteLength, 434, 'the public consumer uses the real raw-report shape');
  const reportDigest = `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`;
  const rawReportLocator = 'asset://provider-tool/output/provider-tool-result-call_00_Yy1JPH1lYglTkWSLLqNR0583';
  const presentedArtifactRef = 'asset://provider-tool/artifact/provider-tool-present-ui-task-implicit-draft-2-call_00_Yy1JPH1lYglTkWSLLqNR0583-0';
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', 'inspect-report-output'),
    kind: 'tool',
    source: 'inspect-report-consumer',
    locator: rawReportLocator,
    digest: reportDigest,
    scope: { ...scope, operationId: toolOperationId },
  };
  const execution = {
    runtimeId: 'inspect-report-runtime',
    taskId: scope.taskId!,
    operationId: scope.operationId!,
    organId: scope.organId,
    cycleId: scope.cycleId!,
    executionEpoch: 3,
  };
  const fact: AcceptedRawFact = {
    seq: 1530,
    envelope: {
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      scope,
      request: { turnId: 'inspect-report-turn', requestId: 'inspect-report-request' },
      producerSeq: 1,
      fact: {
        kind: 'tool-result',
        contentUnitId: 'present-result',
        callId: 'call_00_Yy1JPH1lYglTkWSLLqNR0583',
        continuationRef: 'present-continuation',
        complete: true,
        result: {
          ...execution,
          toolId: 'present',
          callId: 'call_00_Yy1JPH1lYglTkWSLLqNR0583',
          status: 'succeeded',
          outputRefs: [presentedArtifactRef],
          evidenceRefs: [evidence],
        },
        rawOutput: { ref: evidence, view: { kind: 'utf8-text' } },
      },
    },
  };
  const assignment: WorkAssignment = {
    assignmentId: 'inspect-report-assignment',
    taskId: scope.taskId!,
    pipelineNodeId: 'inspect-report-node',
    attempt: 1,
    executionEpoch: 3,
    inputRevision: 1,
    objective: 'inspect and present the project material',
    targetRefs: [],
    expectedOutputRefs: [],
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  };
  const section = { text: 'inspect completed', evidenceRefs: [evidence] };
  const acceptedEnd: StandardTurnEndCommand = {
    kind: 'standard-turn-end',
    identity: {
      turnId: 'inspect-report-turn',
      workAssignmentRef: assignment.assignmentId,
      taskRef: assignment.taskId,
      scopeRef: scope,
      cycleRef: scope.cycleId!,
      inputRevision: assignment.inputRevision,
      directiveRevision: 1,
      executionEpoch: assignment.executionEpoch,
      runtimeBindingRef: 'inspect-report-binding',
      permissionRevision: 'inspect-report-permission',
    },
    summary: { goal: section, actions: section, result: section, expectedNextStep: section },
    deliveryRefs: [evidence.locator],
    resolvedEvidenceRefs: [evidence],
  };
  const inspectCompletion: InspectToolCompletionDescriptor = {
    execution,
    scope: evidence.scope,
    toolOperationId,
    requestId: fact.envelope.request.requestId,
    callId: fact.envelope.fact.kind === 'tool-result' ? fact.envelope.fact.callId : '',
    toolId: 'present',
    intentKind: 'inspect',
    status: 'succeeded',
    evidenceRefs: [evidence],
  };
  const rawContent: RawContentReadPort = {
    async read(request) {
      assert.deepEqual(request, {
        scope,
        content: fact.envelope.fact.kind === 'tool-result' ? fact.envelope.fact.rawOutput : undefined,
      });
      return reportBytes;
    },
  };
  const unexpectedEffect = async (): Promise<never> => {
    throw new Error('inspect delivery must not read or invent an effect completion');
  };
  const reader: StandardTurnDeliveryReaderPort = {
    rawContent,
    completion: {
      readExact: unexpectedEffect,
      commitIntent: unexpectedEffect,
      commitCompletion: unexpectedEffect,
      discoverExactExecution: unexpectedEffect,
    },
  };

  const readback = await readStandardTurnDelivery({
    assignment,
    acceptedEnd,
    entries: [fact],
    completionLookups: [],
    inspectCompletions: [inspectCompletion],
  }, reader);
  const material = readback.materials[0];
  assert.equal(material?.kind, 'inspect-tool-report');
  if (material?.kind !== 'inspect-tool-report') throw new Error('fixture must produce an inspect report');
  assert.equal(material.outputRef, rawReportLocator, 'the bound ref names the verified raw report, not the file artifact');
  assert.equal(material.outputDigest, reportDigest);
  assert.deepEqual(material.bytes, reportBytes);
  assert.deepEqual(material.acceptedToolResult.envelope.fact.kind, 'tool-result');
  if (material.acceptedToolResult.envelope.fact.kind !== 'tool-result') throw new Error('fixture must be a tool result');
  assert.deepEqual(material.acceptedToolResult.envelope.fact.result.outputRefs, [presentedArtifactRef],
    'the actual presented artifact remains accepted source fact');

  const binding = bindAssignmentDelivery({ assignment, readback });
  assert.deepEqual(binding.producedArtifactRefs, [rawReportLocator]);
  assert.deepEqual(binding.producedArtifactBodies, [reportText]);
  assert.deepEqual(binding.outputRefs, [rawReportLocator]);

  const withResult = (result: Extract<AcceptedRawFact['envelope']['fact'], { kind: 'tool-result' }>['result']): AcceptedRawFact => {
    if (fact.envelope.fact.kind !== 'tool-result') throw new Error('fixture must be a tool result');
    return { ...fact, envelope: { ...fact.envelope, fact: { ...fact.envelope.fact, result } } };
  };
  const rejects = async (candidate: AcceptedRawFact): Promise<void> => {
    await assert.rejects(
      () => readStandardTurnDelivery({ assignment, acceptedEnd, entries: [candidate], completionLookups: [], inspectCompletions: [inspectCompletion] }, reader),
      (error: unknown) => error instanceof StandardTurnDeliveryError
        && error.code === 'standard-turn-delivery.artifact-conflict',
    );
  };
  assert.equal(fact.envelope.fact.kind, 'tool-result');
  if (fact.envelope.fact.kind !== 'tool-result') throw new Error('fixture must be a tool result');
  await rejects(withResult({ ...fact.envelope.fact.result, outputDigest: `sha256:${'0'.repeat(64)}` }));
  await rejects(withResult({
    ...fact.envelope.fact.result,
    outputRef: ' ',
    outputDigest: reportDigest,
  }));
});

// Real local-file-search results carry a complete `executionFact`. The reader
// must verify that fact against the trusted inspect completion and the accepted
// result instead of rejecting every inspect result that has one.
test('inspect delivery accepts a verified execution fact and rejects a mismatched one', async () => {
  const scope: ScopeRef = {
    organId: id('organ', 'inspect-fact-organ'),
    taskId: id('task', 'inspect-fact-task'),
    cycleId: id('cycle', 'inspect-fact-cycle'),
    operationId: id('operation', 'inspect-fact-parent'),
  };
  const toolOperationId = id('operation', 'inspect-fact-tool');
  const reportText = '{"matches":[{"path":"note.md","line":1}]}';
  const reportBytes = new TextEncoder().encode(reportText);
  const reportDigest = `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`;
  const rawReportLocator = 'asset://provider-tool/output/inspect-fact-call';
  const callId = 'call_inspect_fact_1';
  const requestId = 'request-inspect-fact-1';
  const toolId = 'file.search';
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', 'inspect-fact-output'),
    kind: 'tool',
    source: 'inspect-fact-consumer',
    locator: rawReportLocator,
    digest: reportDigest,
    scope: { ...scope, operationId: toolOperationId },
  };
  const execution = {
    runtimeId: 'inspect-fact-runtime',
    taskId: scope.taskId!,
    operationId: scope.operationId!,
    organId: scope.organId,
    cycleId: scope.cycleId!,
    executionEpoch: 2,
  };
  const fact: AcceptedRawFact = {
    seq: 2001,
    envelope: {
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      scope,
      request: { turnId: 'inspect-fact-turn', requestId },
      producerSeq: 1,
      fact: {
        kind: 'tool-result',
        contentUnitId: 'inspect-fact-result',
        callId,
        continuationRef: 'inspect-fact-continuation',
        complete: true,
        result: {
          ...execution,
          toolId,
          callId,
          status: 'succeeded',
          outputRef: rawReportLocator,
          outputDigest: reportDigest,
          outputRefs: [rawReportLocator],
          evidenceRefs: [evidence],
          executionFact: {
            identity: {
              surface: 'responses',
              toolId,
              bindingRef: 'inspect-fact-binding',
              route: 'app.file-search.local',
            },
            requestRef: requestId,
            callRef: callId,
            operationRef: scope.operationId!.value,
            state: 'succeeded',
            rawEvidenceRefs: [rawReportLocator],
            resultRef: rawReportLocator,
            resultDigest: reportDigest,
          },
        },
        rawOutput: { ref: evidence, view: { kind: 'utf8-text' } },
      },
    },
  };
  const assignment: WorkAssignment = {
    assignmentId: 'inspect-fact-assignment',
    taskId: scope.taskId!,
    pipelineNodeId: 'inspect-fact-node',
    attempt: 1,
    executionEpoch: 2,
    inputRevision: 1,
    objective: 'inspect and present the project material',
    targetRefs: [],
    expectedOutputRefs: [],
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  };
  const section = { text: 'inspect completed', evidenceRefs: [evidence] };
  const acceptedEnd: StandardTurnEndCommand = {
    kind: 'standard-turn-end',
    identity: {
      turnId: 'inspect-fact-turn',
      workAssignmentRef: assignment.assignmentId,
      taskRef: assignment.taskId,
      scopeRef: scope,
      cycleRef: scope.cycleId!,
      inputRevision: assignment.inputRevision,
      directiveRevision: 1,
      executionEpoch: assignment.executionEpoch,
      runtimeBindingRef: 'inspect-fact-binding',
      permissionRevision: 'inspect-fact-permission',
    },
    summary: { goal: section, actions: section, result: section, expectedNextStep: section },
    deliveryRefs: [evidence.locator],
    resolvedEvidenceRefs: [evidence],
  };
  const inspectCompletion: InspectToolCompletionDescriptor = {
    execution,
    scope: evidence.scope,
    toolOperationId,
    requestId,
    callId,
    toolId,
    intentKind: 'inspect',
    status: 'succeeded',
    evidenceRefs: [evidence],
  };
  const rawContent: RawContentReadPort = {
    async read(request) {
      assert.deepEqual(request, {
        scope,
        content: fact.envelope.fact.kind === 'tool-result' ? fact.envelope.fact.rawOutput : undefined,
      });
      return reportBytes;
    },
  };
  const unexpectedEffect = async (): Promise<never> => {
    throw new Error('inspect delivery must not read or invent an effect completion');
  };
  const reader: StandardTurnDeliveryReaderPort = {
    rawContent,
    completion: {
      readExact: unexpectedEffect,
      commitIntent: unexpectedEffect,
      commitCompletion: unexpectedEffect,
      discoverExactExecution: unexpectedEffect,
    },
  };
  const read = (candidate: AcceptedRawFact) => readStandardTurnDelivery({
    assignment,
    acceptedEnd,
    entries: [candidate],
    completionLookups: [],
    inspectCompletions: [inspectCompletion],
  }, reader);

  const readback = await read(fact);
  const material = readback.materials[0];
  assert.equal(material?.kind, 'inspect-tool-report');
  if (material?.kind !== 'inspect-tool-report') throw new Error('fixture must produce an inspect report');
  assert.equal(material.outputRef, rawReportLocator);
  assert.equal(material.outputDigest, reportDigest);
  assert.deepEqual(material.bytes, reportBytes);

  assert.equal(fact.envelope.fact.kind, 'tool-result');
  if (fact.envelope.fact.kind !== 'tool-result') throw new Error('fixture must be a tool result');
  const baseFact = fact.envelope.fact;
  const baseResult = baseFact.result;
  const baseExecutionFact = baseResult.executionFact;
  if (baseExecutionFact === undefined) throw new Error('fixture must carry an execution fact');
  const withExecutionFact = (candidate: typeof baseExecutionFact): AcceptedRawFact => ({
    ...fact,
    envelope: {
      ...fact.envelope,
      fact: { ...baseFact, result: { ...baseResult, executionFact: candidate } },
    },
  });
  const rejects = async (candidate: AcceptedRawFact): Promise<void> => {
    await assert.rejects(
      () => read(candidate),
      (error: unknown) => error instanceof StandardTurnDeliveryError
        && error.code === 'standard-turn-delivery.completion-conflict',
    );
  };
  await rejects(withExecutionFact({ ...baseExecutionFact, callRef: 'call_mismatch' }));
  await rejects(withExecutionFact({ ...baseExecutionFact, resultDigest: `sha256:${'1'.repeat(64)}` }));
  const { resultRef: _omittedResultRef, ...withoutResultRef } = baseExecutionFact;
  await rejects(withExecutionFact(withoutResultRef));
});
