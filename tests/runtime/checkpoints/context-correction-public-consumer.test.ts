import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  id,
  type Checkpoint,
  type ContextHistoryRecord,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type Task,
} from '../../../packages/contracts/src/index.js';
import {
  createJsonlConditionalReentrySubmissionPort,
  createJsonlContextCorrectionSubmissionPort,
  readCurrentFromRecords,
} from '../../../packages/app/src/ui-runtime/reentry-current-facts.js';
import {
  acceptedContextCorrectionBasesFromRecords,
  conditionalReentryFromRecord,
  contextCorrectionFromRecord,
  createJsonlCheckpointClosurePort,
  createJsonlCheckpointJournal,
  createJsonlContextHistoryPort,
  exactJournalRecord,
} from '../../../packages/app/src/checkpoint-journal.js';
import { createJsonlOperationControlJournal, readOperationControlFromRecords } from '../../../packages/app/src/operation-control-journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../../packages/app/src/runtime-current-state-journal.js';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../../packages/adapters/jsonl/src/task-grants.js';
import { applyContextCorrectionExclusions } from '../../../packages/core/src/context-correction.js';
import { AgentLoopRuntime } from '../../../packages/runtime/src/agent-loop/runtime.js';
import { prepareCheckpointClosure } from '../../../packages/runtime/src/checkpoints/closure.js';
import {
  commitContextCorrection,
  commitReentry,
  submitCheckpoint,
} from '../../../packages/runtime/src/checkpoints/submission.js';
import type {
  ConditionalReentryRecord,
  ConfirmedReentryCommand,
  ConfirmedContextCorrectionCommand,
  ContextCorrectionRecord,
  ReentryCurrentFacts,
  ReentryCurrentRead,
} from '../../../packages/runtime/src/checkpoints/conditional-reentry.js';
import type { OperationControlReadback } from '../../../packages/runtime/src/gateway/ports.js';
import type {
  RuntimeTaskCurrentState,
  RuntimeTaskCurrentStateTransition,
} from '../../../packages/runtime/src/ui-runtime/current-state.js';

const fixtureRoot = process.env['HUMANAGENT_C4_FIXTURE_ROOT']
  ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-context-correction-r1-20261015';
const journalPath = join(fixtureRoot, 'context-correction-public-consumer.jsonl');
const organId = id('organ', 'context-correction-organ');
const taskId = id('task', 'context-correction-task');
const otherTaskId = id('task', 'context-correction-other-task');
const cycleId = id('cycle', 'context-correction-cycle');
const runtimeId = 'context-correction-runtime';
const ownerId = 'context-correction-owner';
const scope: ScopeRef = { organId, taskId, cycleId };
const taskScope: ScopeRef = { organId, taskId };
const wrongA = 'business-ref:wrong-a';
const similarA2 = 'business-ref:wrong-a2';
const correctRef = 'business-ref:correct';
const inactiveWrongB = 'business-ref:inactive-b';
const viewedOnlyRef = 'business-ref:viewed-only';
const uncommittedRef = 'business-ref:uncommitted';

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function evidence(label: string, evidenceScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', `context-correction-${label}`),
    kind: 'execution',
    source: 'context-correction-public-consumer',
    locator: `context-correction://${label}`,
    scope: evidenceScope,
  };
}

function checkpoint(seq: number, previousCheckpointId: Checkpoint['previousCheckpointId'], executionEpoch: number): Checkpoint {
  return {
    id: id('checkpoint', `context-correction-checkpoint-${seq}`),
    scope,
    cycleId,
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch,
    outcome: 'succeeded',
    summary: `checkpoint ${seq}`,
    recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`evidence-${seq}`)],
    next: { kind: 'continue', ref: `checkpoint-${seq}-continue` },
  };
}

function task(): Task {
  return {
    id: taskId,
    organId,
    title: 'Context correction public consumer',
    directive: 'verify the correction carrier and reassembly edge',
    directiveRevision: 1,
    state: 'running',
    memoryScope: 'task',
  };
}

function currentState(): RuntimeTaskCurrentState {
  return {
    task: task(),
    processing: {
      entryPhase: 'execution',
      nextAction: { kind: 'continue' },
      hardBlockers: [],
      recoveryResponsibilityRef: 'recovery:context-correction',
      laterErrorRefs: [],
      stages: [],
    },
    retainedDuties: [{
      operationRef: 'operation:retained',
      owner: ownerId,
    }],
    sourceCommitRefs: [],
  };
}

function currentStateTransition(): RuntimeTaskCurrentStateTransition {
  return {
    transitionId: 'context-correction-current-state',
    taskScope,
    expectedStateCommitRef: null,
    state: currentState(),
  };
}

function commitRefOf(record: { readonly commitId?: string; readonly seq: number; readonly recordDigest: string }): JournalCommitRef {
  if (!record.commitId) throw new Error('expected a committed Journal record');
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function knownCurrentFacts(read: ReentryCurrentRead): ReentryCurrentFacts {
  if (read.state !== 'known') throw new Error(`expected known current facts: ${read.reason}`);
  return read;
}

function completeOperationControl(
  read: OperationControlReadback,
): Extract<OperationControlReadback, { readonly state: 'complete' }> {
  if (read.state !== 'complete') throw new Error(`expected complete operation control: ${read.reason}`);
  return read;
}

test('context correction persists exact exclusions over the real Journal carrier', async () => {
  await mkdir(fixtureRoot, { recursive: true });
  await rm(journalPath, { force: true });

  const journal = new JsonlOrganJournal(journalPath);
  const checkpoints = createJsonlCheckpointJournal({ filePath: journalPath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath: journalPath, journal });
  const contexts = createJsonlContextHistoryPort({ filePath: journalPath, journal });
  const operationControl = createJsonlOperationControlJournal({ journal });
  const grants = new JsonlTaskGrantJournal(journal);
  const currentStates = createJsonlRuntimeTaskCurrentStateJournal({ journal });

  const granted = await grants.grant({
    requestId: 'context-correction-grant',
    taskId,
    owner: ownerId,
    capability: {
      actionId: 'execution',
      capabilities: ['execute-task'],
      scope: taskScope,
    },
    expectedRevision: 0,
  });
  assert.equal(granted.grant?.state, 'granted');
  assert.ok(granted.commit);
  const grantCommit = granted.commit;

  await operationControl.initializeCoverage({
    scope,
    agentRuntimeId: runtimeId,
    harnessExecutionEpoch: 2,
    admissionCommitRef: grantCommit,
  });
  const operationReadback = completeOperationControl(
    readOperationControlFromRecords(await journal.replay(), {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 2,
    }),
  );
  assert.equal(operationReadback.state, 'complete');
  assert.ok(operationReadback.currentControlCommitRef);

  const sourceCheckpoint = checkpoint(1, null, 1);
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId,
    checkpoint: sourceCheckpoint,
    previous: null,
    journal: checkpoints,
    closurePort: closures,
  });
  const sourceCommit = await checkpoints.readCommitted(scope, sourceCheckpoint.id);
  assert.ok(sourceCommit);
  const sourceCheckpointReceipt = sourceCommit.commitRef;

  await AgentLoopRuntime.start({
    agentRuntimeId: runtimeId,
    role: 'execution',
    mode: 'observation',
    profiles: [{
      profileId: 'context-correction-profile',
      role: 'execution',
      mode: 'observation',
      observationScopes: ['task'],
      observationCapabilities: ['read-task'],
      orchestrationScope: 'local',
      orchestrationCapabilities: [],
      capabilityDigest: 'sha256:context-correction-profile',
    }],
    budget: {
      maxModeTransitions: 4,
      maxObservationScopes: 4,
      maxContextReplacements: 4,
      maxDeferredEvents: 4,
    },
    scope,
    executionEpoch: 1,
    permissionRevision: '1',
    observationStreamId: 'context-correction-stream',
    activeRefs: [inactiveWrongB, viewedOnlyRef],
    omittedRefs: [],
    durableContext: {
      stablePrefix: ['objective'],
      indexRefs: [inactiveWrongB, viewedOnlyRef],
      dynamicHead: [],
      repairRefs: [],
    },
  }, contexts);

  const viewedHead = await contexts.readContextHistory({
    scope,
    agentRuntimeId: runtimeId,
    limit: 1,
  });
  assert.ok(viewedHead.currentContextCommitRef);
  const viewedContext = await contexts.readContextCommit(scope, viewedHead.currentContextCommitRef);
  assert.deepEqual(viewedContext.contextView.activeRefs, [inactiveWrongB, viewedOnlyRef]);

  await operationControl.initializeCoverage({
    scope,
    agentRuntimeId: runtimeId,
    harnessExecutionEpoch: 1,
    admissionCommitRef: grantCommit,
  });
  const epoch1Control = completeOperationControl(
    readOperationControlFromRecords(await journal.replay(), {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 1,
    }),
  );
  const firstCheckpoint = checkpoint(2, sourceCheckpoint.id, 1);
  const firstPreparation = await prepareCheckpointClosure({
    checkpoint: firstCheckpoint,
    source: 'agent-tool',
    closureReason: 'first bound reentry target',
    contextCommitRef: viewedHead.currentContextCommitRef,
    contextHistory: contexts,
    operationSelector: {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 1,
    },
    operationControl: epoch1Control,
    permission: {
      permissionRevision: '1',
      grantCommitRef: grantCommit,
      revoked: false,
    },
    hardBlockers: [],
    unreturnedCallRefs: [],
    unresolvedOperationRefs: [],
    closurePort: closures,
    now: () => new Date('2026-10-15T11:00:00.000Z'),
  });
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId,
    checkpoint: firstCheckpoint,
    previous: sourceCheckpoint,
    journal: checkpoints,
    closurePort: closures,
    preparation: firstPreparation,
  });
  const firstCheckpointCommit = await checkpoints.readCommitted(scope, firstCheckpoint.id);
  assert.ok(firstCheckpointCommit);
  const firstCheckpointReceipt = firstCheckpointCommit.commitRef;

  const currentActiveRefs = [wrongA, similarA2, correctRef];
  const currentOmittedRefs: string[] = [];
  const currentContextViewRef = `${runtimeId}:context:2`;
  const currentObservationScopeId = `${runtimeId}:observation:2`;
  const currentContextDigest = digest({ activeRefs: currentActiveRefs, omittedRefs: currentOmittedRefs });
  const currentLoopBase = {
    checkpointId: id('checkpoint', 'context-correction-loop-2'),
    sequence: viewedContext.loopCheckpoint.sequence + 1,
    predecessor: {
      checkpointId: viewedContext.loopCheckpoint.checkpointId,
      digest: viewedContext.loopCheckpoint.digest,
    },
    executionEpoch: 2,
    observationScopeId: currentObservationScopeId,
    contextViewRef: currentContextViewRef,
    eventWatermark: viewedContext.loopCheckpoint.eventWatermark,
  };
  const currentLoopCheckpoint = {
    ...currentLoopBase,
    digest: digest({ ...currentLoopBase, contextDigest: currentContextDigest }),
  };
  const currentCheckpointRef = {
    checkpointId: currentLoopCheckpoint.checkpointId,
    digest: currentLoopCheckpoint.digest,
  };
  const currentDurableContext = {
    stablePrefix: ['objective'],
    indexRefs: [wrongA, similarA2, correctRef],
    dynamicHead: [
      { kind: 'tool-call', callId: 'call-1', toolId: 'lookup' },
      { kind: 'tool-result', callId: 'call-1', status: 'succeeded', effectRef: 'effect-1' },
    ],
    repairRefs: [correctRef],
  } as const;
  const currentContext: ContextHistoryRecord = {
    ...viewedContext,
    contextView: {
      ...viewedContext.contextView,
      contextViewRef: currentContextViewRef,
      executionEpoch: 2,
      checkpoint: currentCheckpointRef,
      contextDigest: currentContextDigest,
      activeRefs: currentActiveRefs,
      omittedRefs: currentOmittedRefs,
    },
    loopCheckpoint: currentLoopCheckpoint,
    previousContextCommitRef: viewedHead.currentContextCommitRef,
    durableContext: currentDurableContext,
    durableContextDigest: digest(currentDurableContext),
    loopControl: {
      ...viewedContext.loopControl,
      observationScopeId: currentObservationScopeId,
      observationScope: null,
      inboxExecutionEpoch: 2,
      inboxCheckpoint: currentCheckpointRef,
      inboxObservationScopeId: currentObservationScopeId,
      deltaExecutionEpoch: 2,
      deltaCheckpoint: currentCheckpointRef,
      deltaObservationScopeId: currentObservationScopeId,
    },
    replacement: null,
  };
  const currentContextCommitRef = await contexts.commit(currentContext, viewedHead.currentContextCommitRef);

  await journal.append({
    kind: 'event',
    scope,
    payload: {
      kind: 'context-history',
      record: {
        ...viewedContext,
        contextView: {
          ...viewedContext.contextView,
          activeRefs: [uncommittedRef],
          omittedRefs: [],
        },
      },
    },
  });

  const currentCheckpoint = checkpoint(3, firstCheckpoint.id, 2);
  const currentControl = completeOperationControl(
    readOperationControlFromRecords(await journal.replay(), {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 2,
    }),
  );
  assert.equal(currentControl.state, 'complete');
  const preparation = await prepareCheckpointClosure({
    checkpoint: currentCheckpoint,
    source: 'agent-tool',
    closureReason: 'current correction position',
    contextCommitRef: currentContextCommitRef,
    contextHistory: contexts,
    operationSelector: {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: 2,
    },
    operationControl: currentControl,
    permission: {
      permissionRevision: '1',
      grantCommitRef: grantCommit,
      revoked: false,
    },
    hardBlockers: [],
    unreturnedCallRefs: [],
    unresolvedOperationRefs: [],
    closurePort: closures,
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  });
  await submitCheckpoint({
    source: 'agent-tool',
    ownerId,
    checkpoint: currentCheckpoint,
    previous: firstCheckpoint,
    journal: checkpoints,
    closurePort: closures,
    preparation,
  });
  const currentCheckpointCommit = await checkpoints.readCommitted(scope, currentCheckpoint.id);
  assert.ok(currentCheckpointCommit);
  const currentCheckpointReceipt = currentCheckpointCommit.commitRef;

  const stateReceipt = await currentStates.commit(currentStateTransition());
  assert.equal(stateReceipt.commitId.length > 0, true);

  const beforeRecords = await journal.replay();
  const currentFacts = knownCurrentFacts(readCurrentFromRecords(beforeRecords, taskScope));
  assert.equal(currentFacts.position.contextCommitRef.commitId, currentContextCommitRef.commitId);
  assert.deepEqual(currentFacts.context.contextView.activeRefs, currentActiveRefs);

  const command: ConfirmedContextCorrectionCommand = {
    basis: {
      commandId: 'context-correction-command-1',
      taskScope: { organId, taskId },
      sourceCheckpointReceipt,
      expectedControlReceipt: currentFacts.position.controlCommitRef,
      expectedContextReceipt: currentFacts.position.contextCommitRef,
      expectedExecutionEpoch: currentFacts.position.executionEpoch,
      wrongRefs: [
        { taskScope: { organId, taskId }, ref: wrongA },
        { taskScope: { organId, taskId }, ref: inactiveWrongB },
      ],
      repairText: 'remove the confirmed wrong business refs only',
      confirmationRef: 'confirmation:context-correction-1',
      principalOwner: ownerId,
    },
    expectedOperationControlCommitRef: currentControl.currentControlCommitRef,
    expectedGrantCommitRef: grantCommit,
    permissionRevision: '1',
  };
  const port = createJsonlContextCorrectionSubmissionPort({ filePath: journalPath, journal });

  const unknownCommand: ConfirmedContextCorrectionCommand = {
    ...command,
    basis: {
      ...command.basis,
      commandId: 'context-correction-unknown-ref',
      wrongRefs: [{ taskScope: { organId, taskId }, ref: uncommittedRef }],
    },
  };
  await assert.rejects(
    () => port.prepare(unknownCommand),
    /no matching owner-resolved committed business ref/,
  );

  const foreignCommand: ConfirmedContextCorrectionCommand = {
    ...command,
    basis: {
      ...command.basis,
      commandId: 'context-correction-foreign-ref',
      wrongRefs: [{ taskScope: { organId, taskId: otherTaskId }, ref: wrongA }],
    },
  };
  await assert.rejects(
    () => port.prepare(foreignCommand),
    /does not belong to the confirmed task/,
  );

  const first = await commitContextCorrection({
    ownerId,
    correction: { port, command },
  });
  const afterRecords = await journal.replay();
  assert.equal(afterRecords.length, beforeRecords.length + 1);
  assert.deepEqual(afterRecords.slice(0, beforeRecords.length), beforeRecords);

  const physicalRecord = exactJournalRecord(afterRecords, first.commitRef);
  const correction = contextCorrectionFromRecord(physicalRecord);
  assert.ok(correction);
  assert.deepEqual(correction.basis, command.basis);
  assert.deepEqual(correction.correctedContext.contextView.activeRefs, [similarA2, correctRef]);
  assert.deepEqual(correction.correctedContext.contextView.omittedRefs, [wrongA, inactiveWrongB]);
  assert.equal(correction.correctedContext.contextView.activeRefs.includes(viewedOnlyRef), false);
  assert.deepEqual(correction.correctedContext.durableContext.indexRefs, [similarA2, correctRef]);
  assert.deepEqual(correction.correctedContext.durableContext.dynamicHead, currentDurableContext.dynamicHead);
  assert.deepEqual(correction.correctedContext.durableContext.repairRefs, [correctRef]);
  assert.equal(
    correction.correctedContext.durableContextDigest,
    digest({ ...currentDurableContext, indexRefs: [similarA2, correctRef] }),
  );
  assert.deepEqual(correction.retainedDuties, currentState().retainedDuties);
  assert.equal(correction.newExecutionEpoch > currentFacts.position.executionEpoch, true);
  assert.deepEqual(correction.fencedBindings, currentFacts.fencedBindings);
  assert.deepEqual(correction.correctedContext.previousContextCommitRef, currentFacts.position.contextCommitRef);

  const readback = await port.readContextCorrection(taskScope, command.basis.commandId);
  assert.ok(readback);
  assert.deepEqual(readback.commitRef, first.commitRef);
  assert.deepEqual(readback.record, first.record);

  await operationControl.initializeCoverage({
    scope,
    agentRuntimeId: runtimeId,
    harnessExecutionEpoch: correction.newExecutionEpoch,
    admissionCommitRef: first.commitRef,
  });
  const afterAdmissionRecords = await journal.replay();
  assert.deepEqual(afterAdmissionRecords.slice(0, afterRecords.length), afterRecords);

  const freshFacts = readCurrentFromRecords(afterAdmissionRecords, taskScope);
  const freshKnown = knownCurrentFacts(freshFacts);
  assert.deepEqual(freshKnown.context.contextView.activeRefs, [similarA2, correctRef]);
  assert.equal(freshKnown.position.controlCommitRef.commitId, first.commitRef.commitId);

  const acceptedBases = acceptedContextCorrectionBasesFromRecords(afterAdmissionRecords, taskScope);
  assert.equal(acceptedBases.length, 1);
  const futureEffective = applyContextCorrectionExclusions(
    acceptedBases[0]!,
    [wrongA, inactiveWrongB, similarA2, correctRef].map((ref) => ({
      taskScope: { organId, taskId },
      ref,
    })),
  ).map((entry) => entry.ref);
  assert.deepEqual(futureEffective, [similarA2, correctRef]);

  const retry = await commitContextCorrection({
    ownerId,
    correction: { port, command },
  });
  assert.deepEqual(retry.commitRef, first.commitRef);
  assert.deepEqual(retry.record, first.record);

  const conflicting: ConfirmedContextCorrectionCommand = {
    ...command,
    basis: {
      ...command.basis,
      repairText: 'different confirmed repair text',
    },
  };
  await assert.rejects(
    () => commitContextCorrection({ ownerId, correction: { port, command: conflicting } }),
    /already committed with different confirmed facts/,
  );

  const stale: ConfirmedContextCorrectionCommand = {
    ...command,
    basis: {
      ...command.basis,
      commandId: 'context-correction-stale-command',
    },
  };
  await assert.rejects(
    () => commitContextCorrection({ ownerId, correction: { port, command: stale } }),
    /stale|changed before context correction|current control token/,
  );

  const reentryPort = createJsonlConditionalReentrySubmissionPort({ filePath: journalPath, journal });
  const rewindControl = completeOperationControl(
    readOperationControlFromRecords(afterAdmissionRecords, {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: freshKnown.position.executionEpoch,
    }),
  );
  const rewindCommand: ConfirmedReentryCommand = {
    commandId: 'conditional-reentry-rewind-1',
    taskScope: { organId, taskId },
    targetCheckpointCommitRef: firstCheckpointReceipt,
    expectedCurrentControlCommitRef: freshKnown.position.controlCommitRef,
    expectedExecutionEpoch: freshKnown.position.executionEpoch,
    expectedOperationControlCommitRef: rewindControl.currentControlCommitRef,
    expectedGrantCommitRef: grantCommit,
    permissionRevision: '1',
    confirmationRef: 'confirmation:conditional-reentry-rewind',
    principalOwner: ownerId,
  };
  const rewind = await commitReentry({
    ownerId,
    conditional: { port: reentryPort, command: rewindCommand },
  });
  assert.equal(rewind.state, 'committed');
  const afterRewindCommitRecords = await journal.replay();
  assert.equal(afterRewindCommitRecords.length, afterAdmissionRecords.length + 1);
  assert.deepEqual(afterRewindCommitRecords.slice(0, afterAdmissionRecords.length), afterAdmissionRecords);
  const rewindCarrier: ConditionalReentryRecord | null = conditionalReentryFromRecord(
    exactJournalRecord(afterRewindCommitRecords, rewind.commitRef),
  );
  assert.ok(rewindCarrier);
  assert.deepEqual(rewindCarrier, rewind.record);
  assert.deepEqual(rewind.record.currentTask, task());
  assert.deepEqual(rewind.record.retainedDuties, currentState().retainedDuties);
  assert.equal(rewind.record.checkpointId.value, firstCheckpoint.id.value);
  assert.equal(rewind.record.sourceCheckpointCommitRef.commitId, firstCheckpointReceipt.commitId);
  assert.equal(rewind.record.previousExecutionEpoch, freshKnown.position.executionEpoch);
  assert.equal(rewind.record.newExecutionEpoch > freshKnown.position.executionEpoch, true);
  assert.equal(rewind.record.restoredContext.contextView.activeRefs.includes(inactiveWrongB), false);
  assert.equal(rewind.record.restoredContext.contextView.activeRefs.includes(wrongA), false);
  assert.equal(rewind.record.restoredContext.contextView.omittedRefs.includes(wrongA), true);
  assert.equal(rewind.record.restoredContext.contextView.omittedRefs.includes(inactiveWrongB), true);
  assert.deepEqual(rewind.record.restoredContext.contextView.activeRefs, [viewedOnlyRef]);
  assert.deepEqual(rewind.record.restoredContext.durableContext.indexRefs, [viewedOnlyRef]);
  const rewindReadback = await reentryPort.readReentry(taskScope, rewindCommand.commandId);
  assert.ok(rewindReadback);
  assert.deepEqual(rewindReadback.commitRef, rewind.commitRef);
  assert.deepEqual(rewindReadback.record, rewind.record);

  await operationControl.initializeCoverage({
    scope,
    agentRuntimeId: runtimeId,
    harnessExecutionEpoch: rewind.record.newExecutionEpoch,
    admissionCommitRef: rewind.commitRef,
  });
  const afterRewindCoverageRecords = await journal.replay();
  const rewindFacts = knownCurrentFacts(readCurrentFromRecords(afterRewindCoverageRecords, taskScope));
  assert.equal(rewindFacts.position.checkpointCommitRef.commitId, firstCheckpointReceipt.commitId);
  assert.equal(rewindFacts.position.controlCommitRef.commitId, rewind.commitRef.commitId);
  assert.equal(rewindFacts.position.executionEpoch, rewind.record.newExecutionEpoch);
  assert.deepEqual(rewindFacts.context.contextView.activeRefs, [viewedOnlyRef]);

  const forwardControl = completeOperationControl(
    readOperationControlFromRecords(afterRewindCoverageRecords, {
      scope,
      agentRuntimeId: runtimeId,
      harnessExecutionEpoch: rewindFacts.position.executionEpoch,
    }),
  );
  const forwardCommand: ConfirmedReentryCommand = {
    commandId: 'conditional-reentry-forward-1',
    taskScope: { organId, taskId },
    targetCheckpointCommitRef: currentCheckpointReceipt,
    expectedCurrentControlCommitRef: rewindFacts.position.controlCommitRef,
    expectedExecutionEpoch: rewindFacts.position.executionEpoch,
    expectedOperationControlCommitRef: forwardControl.currentControlCommitRef,
    expectedGrantCommitRef: grantCommit,
    permissionRevision: '1',
    confirmationRef: 'confirmation:conditional-reentry-forward',
    principalOwner: ownerId,
  };
  const forward = await commitReentry({
    ownerId,
    conditional: { port: reentryPort, command: forwardCommand },
  });
  assert.equal(forward.state, 'committed');
  const afterForwardCommitRecords = await journal.replay();
  assert.equal(afterForwardCommitRecords.length, afterRewindCoverageRecords.length + 1);
  assert.deepEqual(
    afterForwardCommitRecords.slice(0, afterRewindCoverageRecords.length),
    afterRewindCoverageRecords,
  );
  assert.deepEqual(forward.record.currentTask, task());
  assert.deepEqual(forward.record.retainedDuties, currentState().retainedDuties);
  assert.equal(forward.record.checkpointId.value, currentCheckpoint.id.value);
  assert.equal(forward.record.sourceCheckpointCommitRef.commitId, currentCheckpointReceipt.commitId);
  assert.equal(forward.record.previousExecutionEpoch, rewindFacts.position.executionEpoch);
  assert.equal(forward.record.newExecutionEpoch > rewind.record.newExecutionEpoch, true);
  assert.deepEqual(forward.record.restoredContext.contextView.activeRefs, [similarA2, correctRef]);
  assert.equal(forward.record.restoredContext.contextView.activeRefs.includes(wrongA), false);
  assert.equal(forward.record.restoredContext.contextView.omittedRefs.includes(wrongA), true);
  assert.deepEqual(forward.record.restoredContext.durableContext.indexRefs, [similarA2, correctRef]);
  const forwardReadback = await reentryPort.readReentry(taskScope, forwardCommand.commandId);
  assert.ok(forwardReadback);
  assert.deepEqual(forwardReadback.commitRef, forward.commitRef);
  assert.deepEqual(forwardReadback.record, forward.record);

  await operationControl.initializeCoverage({
    scope,
    agentRuntimeId: runtimeId,
    harnessExecutionEpoch: forward.record.newExecutionEpoch,
    admissionCommitRef: forward.commitRef,
  });
  const afterForwardCoverageRecords = await journal.replay();
  const forwardFacts = knownCurrentFacts(readCurrentFromRecords(afterForwardCoverageRecords, taskScope));
  assert.equal(forwardFacts.position.checkpointCommitRef.commitId, currentCheckpointReceipt.commitId);
  assert.equal(forwardFacts.position.controlCommitRef.commitId, forward.commitRef.commitId);
  assert.equal(forwardFacts.position.executionEpoch, forward.record.newExecutionEpoch);
  assert.deepEqual(forwardFacts.context.contextView.activeRefs, [similarA2, correctRef]);
  assert.deepEqual(forwardFacts.task, task());
  assert.deepEqual(forwardFacts.retainedDuties, currentState().retainedDuties);

  const rewindRetry = await commitReentry({
    ownerId,
    conditional: { port: reentryPort, command: rewindCommand },
  });
  assert.deepEqual(rewindRetry.commitRef, rewind.commitRef);
  assert.deepEqual(rewindRetry.record, rewind.record);

  const conflictingReentry: ConfirmedReentryCommand = {
    ...rewindCommand,
    confirmationRef: 'confirmation:conditional-reentry-conflict',
  };
  await assert.rejects(
    () => commitReentry({ ownerId, conditional: { port: reentryPort, command: conflictingReentry } }),
    /already committed with different confirmed facts/,
  );

  const staleReentry: ConfirmedReentryCommand = {
    ...rewindCommand,
    commandId: 'conditional-reentry-stale-1',
  };
  await assert.rejects(
    () => commitReentry({ ownerId, conditional: { port: reentryPort, command: staleReentry } }),
    /stale|changed/,
  );
});
