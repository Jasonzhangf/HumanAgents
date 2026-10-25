/// <reference path="../../adapters/node-modules.d.ts" />

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  ContractError,
  canonicalJsonStringify,
  id,
  type EvidenceRef,
  type AcceptedRawFact,
  type ProviderBinding,
  type ProviderCloseResult,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionProviderSettlementReceipt,
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
  type OccurrenceExecutionOwner,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentOutput,
  type AgentStartRequest,
  type InteractionHelperIdentity,
  type OperationId,
  type ProviderToolResult,
  type RawAsset,
  type RawContentReadPort,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
  type TasklessProviderExecutionIdentityRef,
} from '../../../packages/contracts/src/index.js';
import type {
  InteractionHelperAssignment,
  InteractionHelperResult,
  InteractionLatestTurn,
} from '../../../packages/contracts/src/interaction-helper.js';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import { JsonlInteractionHelperJournal } from '../../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import {
  filesystemProviderEvidenceSink,
  providerRawContentReader,
  type ProviderEvidenceSink,
} from '../../../packages/adapters/provider/src/evidence.js';
import {
  createInteractionParentTurnRawOwner,
  publishInteractionProviderSettlement,
  readInteractionProviderSettlement,
} from '../../../packages/runtime/src/explicit-brain/index.js';
import {
  prepareScopeSemanticHistory,
} from '../../../packages/runtime/src/context/interaction-semantic-context.js';
import {
  ExplicitTurnHelperSession,
  type ExplicitTurnHelperClock,
  type ExplicitTurnHelperFactory,
  type ExplicitTurnInterpretedOutcome,
} from '../../../packages/runtime/src/explicit-brain/interaction-turn-session.js';

// Failure mode: the neutral interaction parent raw owner is wired to the wrong
// authority. A refined child helper record is read back as parent raw history, a
// provider request is accepted before it is registered, an idempotent replay is
// mistaken for a conflict (or a conflicting replay is mistaken for a replay), an
// unfinished request is silently reported as settled, or the folded parent
// context loses the exact accepted raw bytes. The probability is unknown because
// the seam is new. The impact is parent/child context mixing, raw-history loss
// or a fabricated Task. The cost is one local Journal-backed public consumer.

const organId = id('organ', 'organ-parent-raw-owner');
const operationId = id('operation', 'operation-parent-raw-owner');
const scope: ScopeRef = { organId, operationId };
const turn: InteractionTurnIdentity = {
  organId,
  interactionScopeId: 'interaction-parent-scope',
  interactionId: 'interaction-parent',
  inputRevision: 1,
  turnId: 'turn-parent-raw-owner',
};
const execution: InteractionParentProviderExecutionIdentityRef = {
  runtimeId: 'runtime-parent-raw-owner',
  organId,
  operationId,
  executionEpoch: 1,
  interactionTurn: turn,
};
const committedAt = '2026-10-15T00:00:00.000Z';

// The actual binding every owner in this file freezes on its committed turn
// input. A new turn must commit a real binding; a resource close can never be
// recorded for a turn that has none.
const parentProviderBinding: ProviderBinding = {
  bindingId: 'binding-parent-raw-owner',
  providerId: 'provider-parent-raw-owner',
  protocol: 'responses',
  endpointRef: 'endpoint://parent-raw-owner',
  modelRef: 'model-parent-raw-owner',
  configDigest: 'sha256:parent-raw-owner-config',
  capabilityDigest: 'sha256:parent-raw-owner-capability',
};

interface Fixture {
  readonly journal: JsonlOrganJournal;
  readonly journalFile: string;
  readonly parentJournal: JsonlInteractionParentTurnJournal;
  readonly sink: ProviderEvidenceSink;
  readonly rawContent: RawContentReadPort;
  readonly cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = process.env.HUMANAGENT_TEST_ROOT
    ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-parent-raw-owner-20261016');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'parent-raw-owner-'));
  const store = new ImmutableAssetStore(join(directory, 'assets'));
  const sink = filesystemProviderEvidenceSink(store);
  const journalFile = join(directory, 'organ.jsonl');
  const journal = new JsonlOrganJournal(journalFile);
  return {
    journal,
    journalFile,
    parentJournal: new JsonlInteractionParentTurnJournal(journal),
    sink,
    rawContent: providerRawContentReader(sink),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function writeAsset(sink: ProviderEvidenceSink, label: string, content: string): Promise<RawAsset> {
  const ref = await sink.write({
    scope,
    kind: 'operation',
    type: label,
    locator: `operation/${operationId.value}/${label}`,
    content,
  });
  return { ref, view: { kind: 'utf8-text' } };
}

function requestRecord(
  requestId: string,
  parentRequestId?: string,
  phase: RuntimeRequestRecord['phase'] = 'dispatching',
): RuntimeRequestRecord {
  return {
    request: {
      turnId: `provider-${turn.turnId}`,
      requestId,
      ...(parentRequestId === undefined ? {} : { parentRequestId }),
    },
    ...(parentRequestId === undefined ? {} : { parentRequestId }),
    scope,
    phase,
  };
}

function parentRawRecordCount(records: readonly { readonly payload?: Record<string, unknown> }[]): number {
  return records.filter((record) => record.payload?.kind === 'interaction-parent.turn-raw.v1').length;
}

test('neutral interaction parent raw owner keeps one durable, parent-only raw history', async () => {
  const { journal, parentJournal, sink, rawContent, cleanup } = await fixture();
  try {
    const initialInput = await writeAsset(sink, 'interaction-parent-input', 'read README.md');
    const assistantText = await writeAsset(sink, 'interaction-parent-assistant-text', 'The README says hello.');
    const rawArguments = await writeAsset(sink, 'interaction-parent-tool-arguments', '{"path":"README.md"}');
    const rawOutput = await writeAsset(sink, 'interaction-parent-tool-output', 'README_CONTENT');
    const checkpoint: InteractionSemanticCheckpoint = {
      kind: 'semantic-checkpoint',
      organId,
      interactionScopeId: turn.interactionScopeId,
      interactionId: turn.interactionId,
      inputRevision: turn.inputRevision,
      turnId: 'turn-parent-prior',
      committedAt,
      claims: [{ fact: 'The prior answer was accepted', certainty: 'confirmed', sourceRefs: ['evidence://prior'] }],
      constraints: [{ fact: 'Stay inside the interaction organ', certainty: 'confirmed', sourceRefs: ['evidence://constraint'] }],
      evidenceRefs: [initialInput.ref],
      semanticAssetRefs: [initialInput.ref],
    };

    const owner = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      providerBinding: parentProviderBinding,
      priorCheckpoints: [checkpoint],
      journal: parentJournal,
      rawContent,
    });

    // The turn input is committed once; a repeat returns the committed fact.
    const opened = await owner.openTurnInput();
    assert.equal(opened.commit.journalSeq, 1);
    assert.deepEqual(await owner.openTurnInput(), opened);
    assert.equal(parentRawRecordCount(await journal.replay()), 1);

    // An unregistered request cannot own a durable raw fact.
    const firstRequest = requestRecord('request-parent-1');
    const orphan: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef> = {
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      scope,
      request: { turnId: firstRequest.request.turnId, requestId: firstRequest.request.requestId },
      producerSeq: 1,
      fact: {
        kind: 'content',
        contentUnitId: 'unit-orphan',
        channel: 'assistant-text',
        update: 'full',
        content: assistantText,
        complete: true,
      },
    };
    await assert.rejects(
      async () => { await owner.acceptRawFact(orphan); },
      (error: unknown) => error instanceof ContractError,
    );

    // A registered dispatching request stays observable as unsettled.
    const registered = await owner.registerRequest({
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      record: firstRequest,
    });
    assert.deepEqual(registered, firstRequest);
    assert.deepEqual(await owner.registerRequest({
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      record: firstRequest,
    }), firstRequest);
    const unsettled = await owner.inspectTurnRequests();
    assert.deepEqual(unsettled.requests.map((record) => record.request.requestId), ['request-parent-1']);
    assert.equal(unsettled.unsettledRequests.length, 1);
    assert.equal(unsettled.unsettledRequests[0]?.phase, 'dispatching');

    // The same request id is immutable: a different parent id conflicts.
    await assert.rejects(
      async () => {
        await owner.registerRequest({
          execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
          record: requestRecord('request-parent-1', 'request-parent-0'),
        });
      },
      (error: unknown) => error instanceof ContractError,
    );
    // The real driver registers the same request id across lifecycle phases.
    // Each new phase is a durable record, and the latest phase stays observable.
    const advanced = await owner.registerRequest({
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      record: requestRecord('request-parent-1', undefined, 'dispatched'),
    });
    assert.equal(advanced.phase, 'dispatched');
    const afterAdvance = await owner.inspectTurnRequests();
    assert.deepEqual(afterAdvance.requests.map((record) => record.request.requestId), ['request-parent-1']);
    assert.equal(afterAdvance.requests[0]?.phase, 'dispatched');
    assert.equal(afterAdvance.unsettledRequests.length, 1);
    assert.equal(afterAdvance.unsettledRequests[0]?.phase, 'dispatched');

    const requestOf = (record: RuntimeRequestRecord) => ({
      turnId: record.request.turnId,
      requestId: record.request.requestId,
      ...(record.request.parentRequestId === undefined
        ? {}
        : { parentRequestId: record.request.parentRequestId }),
    });
    const toolResult: ProviderToolResult<InteractionParentProviderExecutionIdentityRef> = {
      ...execution,
      toolId: 'file.read',
      callId: 'call-parent-1',
      status: 'succeeded',
      outputRefs: ['asset://provider-tool/readme'],
      evidenceRefs: [rawOutput.ref],
    };
    const facts: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef>[] = [
      {
        execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
        scope,
        request: requestOf(firstRequest),
        producerSeq: 1,
        fact: {
          kind: 'content',
          contentUnitId: 'unit-assistant-1',
          channel: 'assistant-text',
          update: 'full',
          content: assistantText,
          complete: true,
        },
      },
      {
        execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
        scope,
        request: requestOf(firstRequest),
        producerSeq: 2,
        fact: {
          kind: 'tool-call',
          contentUnitId: 'unit-call-1',
          call: {
            callId: 'call-parent-1',
            toolId: 'file.read',
            arguments: { path: 'README.md' },
            continuationRef: 'continuation-parent-1',
          },
          rawArguments,
          complete: true,
        },
      },
      {
        execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
        scope,
        request: requestOf(firstRequest),
        producerSeq: 3,
        fact: {
          kind: 'tool-result',
          contentUnitId: 'unit-result-1',
          callId: 'call-parent-1',
          continuationRef: 'continuation-parent-1',
          result: toolResult,
          rawOutput,
          complete: true,
        },
      },
    ];
    const accepted: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>[] = [];
    for (const fact of facts) accepted.push(await owner.acceptRawFact(fact));
    assert.deepEqual(accepted.map((entry) => entry.seq), [1, 2, 3]);

    // The same (request, producerSeq) with the same payload is idempotent, but a
    // different payload for that slot is an explicit conflict.
    const replayed = await owner.acceptRawFact(facts[0]!);
    assert.equal(replayed.seq, accepted[0]!.seq);
    const conflicting: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef> = {
      ...facts[0]!,
      fact: {
        kind: 'content',
        contentUnitId: 'unit-assistant-1',
        channel: 'assistant-text',
        update: 'full',
        content: rawArguments,
        complete: true,
      },
    };
    await assert.rejects(
      async () => { await owner.acceptRawFact(conflicting); },
      (error: unknown) => error instanceof ContractError,
    );

    // A child helper writes its own records into the same authoritative Journal.
    const childEvidence: EvidenceRef = { ...initialInput.ref, scope: { organId } };
    const childAssignment: InteractionHelperAssignment = {
      organId,
      interactionScopeId: turn.interactionScopeId,
      interactionId: turn.interactionId,
      inputRevision: turn.inputRevision,
      parentTurnId: turn.turnId,
      assignmentId: 'assignment-child-only',
      helperCallId: 'call-child-only',
      attempt: 1,
      objective: 'CHILD-ONLY-OBJECTIVE',
      targetRefs: ['interaction://child-only'],
      expectedOutputRefs: ['output://child-only'],
      successCriteria: ['CHILD-ONLY-SUCCESS'],
      failureCriteria: [],
      incompleteCriteria: [],
      requiredCapabilities: ['text-generation'],
      mergeGate: 'not-required',
    };
    const childResult: InteractionHelperResult = {
      organId,
      interactionScopeId: childAssignment.interactionScopeId,
      interactionId: childAssignment.interactionId,
      inputRevision: childAssignment.inputRevision,
      parentTurnId: childAssignment.parentTurnId,
      assignmentId: childAssignment.assignmentId,
      helperCallId: childAssignment.helperCallId,
      attempt: childAssignment.attempt,
      agentId: 'agent-child-only',
      producedArtifactRefs: ['artifact://child-only'],
      status: 'succeeded',
      summary: 'CHILD-ONLY-SUMMARY',
      outputRefs: ['output://child-only'],
      evidenceRefs: [childEvidence],
      nextAction: 'settle',
    };
    const helperJournal = new JsonlInteractionHelperJournal(journal);
    await helperJournal.appendDispatchAccepted({
      kind: 'dispatch-accepted',
      assignment: childAssignment,
      dispatchAcceptedAt: committedAt,
      evidenceRefs: [childEvidence],
    });
    await helperJournal.appendReturned(
      {
        kind: 'returned',
        result: childResult,
        returnedAt: committedAt,
        evidenceRefs: [childEvidence],
      },
      { description: 'Return the child-only result for the parent raw-turn fixture' },
    );
    await helperJournal.appendOwnerAccepted(
      {
        kind: 'owner-accepted',
        result: childResult,
        refinedResult: { ref: childEvidence, view: { kind: 'utf8-text' } },
        acceptedBy: 'owner',
        acceptanceRef: 'acceptance://child-only',
        acceptedAt: committedAt,
        evidenceRefs: [childEvidence],
      },
      { description: 'Adopt the child-only result for the parent raw-turn fixture' },
    );
    await helperJournal.appendSemanticCheckpoint({
      kind: 'semantic-checkpoint',
      organId,
      interactionScopeId: turn.interactionScopeId,
      interactionId: turn.interactionId,
      inputRevision: turn.inputRevision,
      turnId: 'turn-child-only',
      committedAt,
      claims: [{ fact: 'CHILD-ONLY-CLAIM', certainty: 'confirmed', sourceRefs: ['evidence://child-only'] }],
      constraints: [],
      evidenceRefs: [childEvidence],
      semanticAssetRefs: [childEvidence],
    });

    // The continuation request is registered, then materialized.
    const secondRequest = requestRecord('request-parent-2', 'request-parent-1');
    await owner.registerRequest({
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
      record: secondRequest,
    });
    const afterContinuation = await owner.inspectTurnRequests();
    assert.deepEqual(
      afterContinuation.unsettledRequests.map((record) => record.request.requestId),
      ['request-parent-1', 'request-parent-2'],
    );

    const context = await owner.requestContext({
      execution,
      request: requestOf(secondRequest),
      phase: 'continuation',
    });
    const units = context.canonical.units;
    assert.deepEqual(units.map((unit) => unit.kind), ['message', 'message', 'message', 'tool-call', 'tool-result']);
    assert.deepEqual(units[0], {
      kind: 'message',
      role: 'assistant',
      text: canonicalJsonStringify({
        kind: checkpoint.kind,
        interactionId: checkpoint.interactionId,
        inputRevision: checkpoint.inputRevision,
        turnId: checkpoint.turnId,
        committedAt: checkpoint.committedAt,
        claims: checkpoint.claims,
        constraints: checkpoint.constraints,
      }),
    });
    assert.deepEqual(units[1], { kind: 'message', role: 'user', text: 'read README.md' });
    assert.deepEqual(units[2], { kind: 'message', role: 'assistant', text: 'The README says hello.' });
    assert.deepEqual(units[3], {
      kind: 'tool-call',
      callId: 'call-parent-1',
      toolId: 'file.read',
      arguments: { path: 'README.md' },
    });
    assert.deepEqual(units[4], {
      kind: 'tool-result',
      callId: 'call-parent-1',
      toolId: 'file.read',
      output: 'README_CONTENT',
      status: 'succeeded',
      evidenceRefs: [rawOutput.ref],
    });

    // No child helper record is copied into the parent raw history.
    const snapshot = await parentJournal.readTurnSnapshot(turn);
    assert.equal(snapshot.acceptedFacts.length, 3);
    assert.deepEqual(snapshot.requests.map((record) => record.fact.request.requestId), [
      'request-parent-1',
      'request-parent-1',
      'request-parent-2',
    ]);
    const rendered = JSON.stringify(units);
    assert.equal(rendered.includes('CHILD-ONLY'), false);
  } finally {
    await cleanup();
  }
});

// Failure mode: the explicit-parent semantic closure chain is wired to the wrong
// evidence direction. A returned-but-unaccepted helper is promoted to accepted
// work, a raw child summary or raw parent prompt is committed as semantic
// content, a raw asset is relabeled as a semantic asset, a retry silently
// accepts a changed outcome under the same turn identity, or an unclosed parent
// turn advances history. The probability is unknown because the seam is new. The
// impact is lost recovery responsibility, fabricated semantic history or a
// leaked raw transcript. The cost is two local Journal-backed public consumers
// in the existing explicit-brain test file.

const semanticCloseOrganId = id('organ', 'organ-semantic-close');
const semanticCloseScope: ScopeRef = { organId: semanticCloseOrganId };

function semanticCloseEvidence(label: string, scope: ScopeRef = semanticCloseScope): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-explicit-brain-test',
    locator: `interaction://${label}`,
    scope,
  };
}

function providerSettlementReceipt(
  turn: InteractionTurnIdentity,
  execution: InteractionParentProviderExecutionIdentityRef,
  request: RuntimeRequestRecord,
): InteractionProviderSettlementReceipt {
  const evidence = semanticCloseEvidence('provider-settlement', {
    organId: turn.organId,
    operationId: execution.operationId,
  });
  return {
    interactionId: turn.interactionId,
    inputRevision: turn.inputRevision,
    request: parentRequestIdentity(request),
    settlement: {
      ...execution,
      state: 'succeeded',
      evidenceRefs: [evidence],
      resourceRelease: { state: 'released', evidenceRefs: [evidence] },
      persistence: { state: 'committed', evidenceRefs: [evidence] },
    },
  };
}

function semanticCloseTurn(
  interactionId: string,
  turnId: string,
  interactionScopeId = 'semantic-close-scope',
  inputRevision = 1,
): InteractionTurnIdentity {
  return { organId: semanticCloseOrganId, interactionScopeId, interactionId, inputRevision, turnId };
}

async function semanticCloseFixtureHome(): Promise<string> {
  const root = process.env.HUMANAGENT_TEST_ROOT
    ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-explicit-semantic-close-20261016');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'semantic-close-'));
}

async function semanticCloseAsset(
  sink: ProviderEvidenceSink,
  scope: ScopeRef,
  label: string,
  content: string,
): Promise<RawAsset> {
  const ref = await sink.write({
    scope,
    kind: 'operation',
    type: label,
    locator: `${scope.organId.value}/${label}`,
    content,
  });
  return { ref, view: { kind: 'utf8-text' } };
}

function parentExecution(
  turn: InteractionTurnIdentity,
  operationId: OperationId,
): InteractionParentProviderExecutionIdentityRef {
  return {
    runtimeId: `runtime-${turn.turnId}`,
    organId: semanticCloseOrganId,
    operationId,
    executionEpoch: 1,
    interactionTurn: turn,
  };
}

function parentExecutionRef(
  execution: InteractionParentProviderExecutionIdentityRef,
): { readonly runtimeId: string; readonly executionEpoch: number } {
  return { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch };
}

function parentRequestRecord(
  turn: InteractionTurnIdentity,
  scope: ScopeRef,
  requestId: string,
  phase: RuntimeRequestRecord['phase'],
  parentRequestId?: string,
): RuntimeRequestRecord {
  return {
    request: {
      turnId: `provider-${turn.turnId}`,
      requestId,
      ...(parentRequestId === undefined ? {} : { parentRequestId }),
    },
    ...(parentRequestId === undefined ? {} : { parentRequestId }),
    scope,
    phase,
  };
}

function parentRequestIdentity(record: RuntimeRequestRecord) {
  return {
    turnId: record.request.turnId,
    requestId: record.request.requestId,
    ...(record.request.parentRequestId === undefined
      ? {}
      : { parentRequestId: record.request.parentRequestId }),
  };
}

function helperIdentityOfAssignment(assignment: InteractionHelperAssignment): InteractionHelperIdentity {
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

function countingClock(times: readonly string[]): {
  readonly clock: ExplicitTurnHelperClock;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    clock: { now: () => times[Math.min(calls++, times.length - 1)]! },
    calls: () => calls,
  };
}

/** A minimal real AgentDriver double for the helper dispatch seam only. */
function semanticCloseHelperFactory(): ExplicitTurnHelperFactory {
  return async ({ assignment, execution }) => {
    const evidence = semanticCloseEvidence(`driver-${assignment.helperCallId}`, {
      organId: assignment.organId,
    });
    const helper = helperIdentityOfAssignment(assignment);
    const identity: TasklessProviderExecutionIdentityRef = {
      runtimeId: execution.runtimeId,
      organId: assignment.organId,
      operationId: execution.operationId,
      executionEpoch: execution.executionEpoch,
      helper,
      taskId: undefined,
      cycleId: undefined,
    };
    const output: AgentOutput<TasklessProviderExecutionIdentityRef> = {
      ...identity,
      assignmentId: assignment.assignmentId,
      payload: { summary: `driver-summary-${assignment.helperCallId}` },
      outputRefs: [...assignment.expectedOutputRefs],
      evidenceRefs: [evidence],
    };
    const closure: AgentClosure = { state: 'succeeded', evidenceRefs: [evidence] };
    const driver: AgentDriver<TasklessProviderExecutionIdentityRef> = {
      kind: 'semantic-close-recording-driver',
      capabilities: async () => ({
        driverKind: 'semantic-close-recording-driver',
        capabilities: ['text-generation'],
        version: '1',
      }),
      start: async (_request: AgentStartRequest<TasklessProviderExecutionIdentityRef>) => ({
        runtimeId: execution.runtimeId,
        executionEpoch: execution.executionEpoch,
      }),
      resume: async () => {
        throw new Error('semantic close helper never resumes a checkpoint');
      },
      submit: async () => output,
      observe: async function* () {
        yield {
          ...identity,
          kind: 'provider.output',
          evidenceRefs: [evidence],
        } satisfies AgentEvent<TasklessProviderExecutionIdentityRef>;
      },
      requestStop: async () => ({ requested: false, operationId: execution.operationId }),
      settle: async () => closure,
    };
    const binding: ProviderBinding = {
      bindingId: `binding-${assignment.helperCallId}`,
      providerId: 'rcc-semantic-close',
      protocol: 'responses',
      endpointRef: 'endpoint://rcc-semantic-close',
      modelRef: 'rcc-semantic-close-model',
      configDigest: 'sha256:semantic-close-config',
      capabilityDigest: 'sha256:semantic-close-capabilities',
    };
    return { binding, driver, close: async () => {} };
  };
}

function helperResultFields(input: {
  readonly agentId: string;
  readonly summary: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}): Omit<InteractionHelperResult, keyof InteractionHelperIdentity> {
  return {
    agentId: input.agentId,
    producedArtifactRefs: [],
    status: 'succeeded',
    summary: input.summary,
    outputRefs: [...input.outputRefs],
    evidenceRefs: [...input.evidenceRefs],
    nextAction: 'settle',
  };
}

test('explicit semantic close folds the settled parent turn and separates accepted from returned helpers', async () => {
  const directory = await semanticCloseFixtureHome();
  const store = new ImmutableAssetStore(join(directory, 'assets'));
  const sink = filesystemProviderEvidenceSink(store);
  const journal = new JsonlOrganJournal(join(directory, 'organ.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const rawContent = providerRawContentReader(sink);
  try {
    const turn = semanticCloseTurn('interaction-a', 'turn-a');
    const operationId = id('operation', 'operation-semantic-close-a');
    const scope: ScopeRef = { organId: semanticCloseOrganId, operationId };
    const execution = parentExecution(turn, operationId);
    const initialInput = await semanticCloseAsset(sink, scope, 'turn-a-input', 'summarize the bounded question');
    const deltaOne = await semanticCloseAsset(sink, scope, 'turn-a-delta-1', 'The ');
    const deltaTwo = await semanticCloseAsset(sink, scope, 'turn-a-delta-2', 'answer is 42.');
    const owner = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    await owner.openTurnInput();
    const record = parentRequestRecord(turn, scope, 'request-a', 'dispatching');
    await owner.registerRequest({ execution: parentExecutionRef(execution), record });
    const request = parentRequestIdentity(record);
    const facts: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef>[] = [
      {
        execution: parentExecutionRef(execution),
        scope,
        request,
        producerSeq: 1,
        fact: {
          kind: 'content',
          contentUnitId: 'assistant-a',
          channel: 'assistant-text',
          update: 'delta',
          content: deltaOne,
          complete: false,
        },
      },
      {
        execution: parentExecutionRef(execution),
        scope,
        request,
        producerSeq: 2,
        fact: {
          kind: 'content',
          contentUnitId: 'assistant-a',
          channel: 'assistant-text',
          update: 'delta',
          content: deltaTwo,
          complete: false,
        },
      },
      {
        execution: parentExecutionRef(execution),
        scope,
        request,
        producerSeq: 3,
        fact: { kind: 'content-complete', contentUnitId: 'assistant-a' },
      },
      {
        execution: parentExecutionRef(execution),
        scope,
        request,
        producerSeq: 4,
        fact: { kind: 'request-complete', terminal: 'completed' },
      },
    ];
    for (const fact of facts) await owner.acceptRawFact(fact);
    await owner.registerRequest({
      execution: parentExecutionRef(execution),
      record: parentRequestRecord(turn, scope, 'request-a', 'settled'),
    });
    const finalOutput = await owner.readFinalTurnOutput();
    assert.equal(finalOutput.assistantText, 'The answer is 42.');
    assert.equal(finalOutput.initialInputText, 'summarize the bounded question');
    assert.deepEqual(
      finalOutput.assistantContentRefs.map((ref) => ref.locator),
      [deltaOne.ref.locator, deltaTwo.ref.locator],
    );

    const { clock, calls } = countingClock([
      '2026-10-16T01:00:00.000Z',
      '2026-10-16T02:00:00.000Z',
      '2026-10-16T03:00:00.000Z',
      '2026-10-16T04:00:00.000Z',
      '2026-10-16T05:00:00.000Z',
      '2026-10-16T06:00:00.000Z',
      '2026-10-16T07:00:00.000Z',
    ]);
    const latestTurn: InteractionLatestTurn = {
      ...turn,
      entries: [{ kind: 'user-input', content: initialInput }],
    };
    const session = new ExplicitTurnHelperSession({
      identity: turn,
      latestTurn,
      journal: helperJournal,
      clock,
      factory: semanticCloseHelperFactory(),
      checkpointJournal: helperJournal,
      rawContent,
    });
    const accepted = await session.dispatchHelper({
      selection: { roleId: 'observer' },
      assignmentFields: {
        objective: 'Return the bounded observation',
        targetRefs: ['interaction://helper-a'],
        expectedOutputRefs: ['output://helper-a'],
        successCriteria: ['Return the observation'],
        failureCriteria: [],
        incompleteCriteria: [],
        requiredCapabilities: [],
        mergeGate: 'not-required',
      },
      inputs: { request: 'bounded helper-a request' },
      evidenceRefs: [semanticCloseEvidence('dispatch-a')],
      checkpointDescription: 'Return the first bounded observation for the parent turn',
      conclude: ({ output }) => helperResultFields({
        agentId: 'agent-helper-a',
        summary: 'RAW-SUMMARY-A-MUST-NOT-APPEAR',
        outputRefs: output.outputRefs,
        evidenceRefs: output.evidenceRefs,
      }),
    });
    const returned = await session.dispatchHelper({
      selection: { roleId: 'observer' },
      assignmentFields: {
        objective: 'Return the bounded observation',
        targetRefs: ['interaction://helper-b'],
        expectedOutputRefs: ['output://helper-b'],
        successCriteria: ['Return the observation'],
        failureCriteria: [],
        incompleteCriteria: [],
        requiredCapabilities: [],
        mergeGate: 'not-required',
      },
      inputs: { request: 'bounded helper-b request' },
      evidenceRefs: [semanticCloseEvidence('dispatch-b')],
      checkpointDescription: 'Return the second bounded observation without adoption',
      conclude: ({ output }) => helperResultFields({
        agentId: 'agent-helper-b',
        summary: 'RAW-SUMMARY-B-MUST-NOT-APPEAR',
        outputRefs: output.outputRefs,
        evidenceRefs: output.evidenceRefs,
      }),
    });
    const refinedScope: ScopeRef = { organId: semanticCloseOrganId, taskId: id('task', 'task-helper-a') };
    const refinedA = await semanticCloseAsset(sink, refinedScope, 'helper-a-refined', 'REFINED-A-SEMANTIC-TEXT');
    const acceptEvidence = semanticCloseEvidence('owner-accepted-a');
    await session.acceptHelper({
      helperCallId: accepted.identity.helperCallId,
      checkpointDescription: 'Adopt the first bounded observation for semantic close',
      refinedResult: refinedA,
      acceptedBy: 'parent-owner',
      acceptanceRef: 'acceptance://helper-a',
      evidenceRefs: [acceptEvidence],
    });

    const outcome: ExplicitTurnInterpretedOutcome = {
      kind: 'requirement',
      normalizedInput: 'summarize the bounded question',
      knownFacts: ['the bounded question is about the README'],
      decisionRefs: ['decision://explicit-brain/route'],
      structuredProposal: {
        revision: 1,
        intent: 'create',
        title: 'Summarize the bounded question',
        objective: 'Summarize the bounded question for the user',
        deliverable: 'A concise summary',
        deliveryConditions: ['Keep the summary inside the interaction organ'],
        evidenceRefs: ['evidence://structured/proposal'],
        blockingGaps: ['The downstream task is not admitted yet'],
      },
    };
    // Dispatch, return and owner acceptance already sampled the shared clock.
    // Closure must sample its own save time, rather than reuse a helper time.
    const samplesBeforeClose = calls();
    assert.equal(samplesBeforeClose, 5);

    // Failure basis: after memory loss or process restart, in-memory helper
    // dispatched and entries arrays are empty. If cold reconstruction does not
    // enumerate durable helpers via turnHelperJournal, accepted refined work and
    // unaccepted returns are silently omitted from the semantic checkpoint.
    // Impact: silent omission of accepted child work from the turn semantic checkpoint.
    // Cost: minimal in-memory reconstruction from the existing fixture directory.
    const coldJournal = new JsonlOrganJournal(join(directory, 'organ.jsonl'));
    const coldHelperJournal = new JsonlInteractionHelperJournal(coldJournal);
    const coldSession = new ExplicitTurnHelperSession({
      identity: turn,
      latestTurn,
      journal: coldHelperJournal,
      clock,
      factory: semanticCloseHelperFactory(),
      checkpointJournal: coldHelperJournal,
      rawContent,
      turnHelperJournal: coldHelperJournal,
    });
    const first = await coldSession.closeTurnSemanticCheckpoint({
      finalParentOutput: finalOutput,
      outcome,
    });
    assert.equal(first.checkpoint.committedAt, '2026-10-16T06:00:00.000Z');
    assert.equal(calls(), samplesBeforeClose + 1);
    assert.equal(first.checkpoint.interactionId, 'interaction-a');
    assert.equal(first.checkpoint.turnId, 'turn-a');

    const factsText = first.checkpoint.claims.map((claim) => claim.fact);
    const goal = factsText.find((fact) => fact.startsWith('goal: '));
    assert.ok(goal?.includes('Summarize the bounded question for the user'));
    assert.ok(goal?.includes('intent: create'));
    const acceptedClaim = first.checkpoint.claims.find((claim) =>
      claim.fact.startsWith('what-done(owner-accepted): [agent-helper-a:'));
    assert.ok(acceptedClaim?.fact.includes('REFINED-A-SEMANTIC-TEXT'));
    assert.ok(!acceptedClaim?.fact.includes('RAW-SUMMARY-A-MUST-NOT-APPEAR'));
    assert.ok(acceptedClaim?.sourceRefs.includes('acceptance://helper-a'));
    const returnedClaim = first.checkpoint.claims.find((claim) =>
      claim.fact.startsWith('helper-unaccepted(returned-only): [agent-helper-b:'));
    assert.ok(returnedClaim?.fact.includes('not accepted by parent owner'));
    assert.ok(!returnedClaim?.fact.includes('RAW-SUMMARY-B-MUST-NOT-APPEAR'));
    assert.ok(returnedClaim?.sourceRefs.includes(returned.returnedCommitId));
    assert.ok(factsText.includes('outcome(requirement:create): A concise summary'));
    assert.ok(factsText.includes('next: route confirmed requirement proposal to FIFO intake'));
    assert.ok(factsText.includes('unknown: The downstream task is not admitted yet'));
    assert.ok(first.checkpoint.constraints.some((claim) =>
      claim.fact === 'Keep the summary inside the interaction organ' && claim.certainty === 'confirmed'));

    // The refined asset is the only semantic asset; neither the raw initial input
    // nor the terminal assistant bytes are relabeled as semantic content.
    assert.deepEqual(first.checkpoint.semanticAssetRefs, [refinedA.ref]);
    assert.ok(first.checkpoint.evidenceRefs.some((ref) =>
      ref.locator === initialInput.ref.locator));
    assert.ok(first.checkpoint.evidenceRefs.some((ref) => ref.locator === deltaOne.ref.locator));
    assert.ok(first.checkpoint.evidenceRefs.some((ref) => ref.locator === deltaTwo.ref.locator));
    assert.ok(first.checkpoint.evidenceRefs.some((ref) => ref.locator === acceptEvidence.locator));
    assert.ok(!first.checkpoint.evidenceRefs.some((ref) => ref.locator === refinedA.ref.locator));

    // A same-identity retry reproduces the frozen content, returns the first
    // commit and never samples a new clock value.
    const retry = await session.closeTurnSemanticCheckpoint({
      finalParentOutput: finalOutput,
      outcome,
    });
    assert.deepEqual(retry, first);
    assert.equal(calls(), samplesBeforeClose + 1);
    const changed: ExplicitTurnInterpretedOutcome = {
      ...outcome,
      structuredProposal: { ...outcome.structuredProposal, deliverable: 'A changed summary' },
    };
    await assert.rejects(
      async () => { await session.closeTurnSemanticCheckpoint({ finalParentOutput: finalOutput, outcome: changed }); },
      (error: unknown) => error instanceof ContractError
        && /conflicts with the committed checkpoint/.test((error as Error).message),
    );
    const checkpointRecords = (await journal.replay())
      .filter((record) => record.payload?.kind === 'interaction-helper.semantic-checkpoint.v1');
    assert.equal(checkpointRecords.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Failure mode: the neutral parent raw owner has no durable resource-close fact,
// so an exact retry can append a second close or drift the first close time, a
// closed-output read can succeed without a real close, and the writer fence is
// missing so request or raw history keeps changing after the physical owner is
// gone. The probability is unknown because the seam is new. The impact is
// fabricated recovery evidence or post-close history mutation. The cost is one
// local Journal-backed public consumer in this existing explicit-brain file.
test('neutral parent raw owner records one real resource close, gates closed output, and fences later history', async () => {
  const root = process.env.HUMANAGENT_TEST_ROOT
    ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-parent-close-fact-20261016');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'parent-close-raw-'));
  const store = new ImmutableAssetStore(join(directory, 'assets'));
  const sink = filesystemProviderEvidenceSink(store);
  const journalFile = join(directory, 'organ.jsonl');
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const rawContent = providerRawContentReader(sink);
  try {
    const turn = semanticCloseTurn('interaction-close', 'turn-close');
    const operationId = id('operation', 'operation-semantic-close');
    const scope: ScopeRef = { organId: semanticCloseOrganId, operationId };
    const execution = parentExecution(turn, operationId);
    const initialInput = await semanticCloseAsset(sink, scope, 'turn-close-input', 'close the bounded question');
    const owner = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    await owner.openTurnInput();

    // The whole binding is frozen on the committed turn input, all seven fields.
    const committedInput = (await parentJournal.readTurnSnapshot(turn)).turnInput!.fact;
    assert.deepEqual(committedInput.providerBinding, parentProviderBinding);

    const record = parentRequestRecord(turn, scope, 'request-close', 'dispatching');
    await owner.registerRequest({ execution: parentExecutionRef(execution), record });
    const request = parentRequestIdentity(record);
    const answer = await semanticCloseAsset(sink, scope, 'turn-close-answer', 'closed answer');
    const answerFact: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef> = {
      execution: parentExecutionRef(execution),
      scope,
      request,
      producerSeq: 1,
      fact: {
        kind: 'content',
        contentUnitId: 'assistant-close',
        channel: 'assistant-text',
        update: 'full',
        content: answer,
        complete: true,
      },
    };
    await owner.acceptRawFact(answerFact);
    await owner.acceptRawFact({
      execution: parentExecutionRef(execution),
      scope,
      request,
      producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' },
    });
    await owner.registerRequest({
      execution: parentExecutionRef(execution),
      record: parentRequestRecord(turn, scope, 'request-close', 'settled'),
    });
    assert.equal((await owner.readFinalTurnOutput()).assistantText, 'closed answer');

    // A settled output without a durable close is not a closed output.
    await assert.rejects(
      async () => { await owner.readClosedTurnOutput(); },
      (error: unknown) => error instanceof ContractError
        && /requires the committed resource close/.test((error as Error).message),
    );
    assert.equal(await owner.readResourceClose(), null);

    const closedReceipt: ProviderCloseResult = {
      bindingId: parentProviderBinding.bindingId,
      providerId: parentProviderBinding.providerId,
      protocol: parentProviderBinding.protocol,
      state: 'closed',
      evidenceRefs: [semanticCloseEvidence('parent-close-receipt')],
    };
    // A real non-closed receipt never becomes a durable close.
    await assert.rejects(
      async () => {
        await owner.recordProviderClose({
          providerBinding: parentProviderBinding,
          result: {
            bindingId: parentProviderBinding.bindingId,
            providerId: parentProviderBinding.providerId,
            protocol: parentProviderBinding.protocol,
            state: 'pending',
            evidenceRefs: [semanticCloseEvidence('parent-close-pending')],
            ownerId: 'parent-close-owner',
            nextAction: { kind: 'wait', ref: 'cleanup' },
          },
          closedAt: committedAt,
        });
      },
      (error: unknown) => error instanceof ContractError
        && /requires an actual closed receipt/.test((error as Error).message),
    );
    // A close whose binding differs only by digest from the committed binding is
    // rejected, so the seven-field binding is compared, not just the id.
    await assert.rejects(
      async () => {
        await owner.recordProviderClose({
          providerBinding: { ...parentProviderBinding, configDigest: 'sha256:other-config' },
          result: closedReceipt,
          closedAt: committedAt,
        });
      },
      (error: unknown) => error instanceof ContractError
        && /does not match the committed turn input binding/.test((error as Error).message),
    );
    assert.equal(await owner.readResourceClose(), null);

    // The real close commits once. An exact retry keeps the first time and
    // commit and appends no second record; a changed receipt is a conflict.
    const firstClose = await owner.recordProviderClose({
      providerBinding: parentProviderBinding,
      result: closedReceipt,
      closedAt: committedAt,
    });
    const retryClose = await owner.recordProviderClose({
      providerBinding: parentProviderBinding,
      result: closedReceipt,
      closedAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(retryClose.fact.closedAt, committedAt);
    assert.deepEqual(retryClose.commit, firstClose.commit);
    const closeRecords = (await journal.replay())
      .filter((entry) => (entry.payload as { discriminant?: string } | undefined)?.discriminant === 'resource-close');
    assert.equal(closeRecords.length, 1);
    await assert.rejects(
      async () => {
        await owner.recordProviderClose({
          providerBinding: parentProviderBinding,
          result: { ...closedReceipt, evidenceRefs: [semanticCloseEvidence('changed-receipt')] },
          closedAt: committedAt,
        });
      },
      (error: unknown) => error instanceof ContractError
        && /conflicts with the committed resource close/.test((error as Error).message),
    );

    // The closed output is available only now, from one consistent snapshot.
    const closedOutput = await owner.readClosedTurnOutput();
    assert.equal(closedOutput.assistantText, 'closed answer');
    assert.deepEqual(closedOutput.resourceClose.fact.result, closedReceipt);

    // Writer fence: exact request and raw replays still return the committed
    // record with zero append; any new lifecycle record is rejected.
    const requestsBefore = (await parentJournal.readTurnSnapshot(turn)).requests.length;
    const rawBefore = (await parentJournal.readTurnSnapshot(turn)).acceptedFacts.length;
    await owner.registerRequest({ execution: parentExecutionRef(execution), record });
    await owner.acceptRawFact(answerFact);
    assert.equal((await parentJournal.readTurnSnapshot(turn)).requests.length, requestsBefore);
    assert.equal((await parentJournal.readTurnSnapshot(turn)).acceptedFacts.length, rawBefore);
    await assert.rejects(
      async () => {
        await owner.registerRequest({
          execution: parentExecutionRef(execution),
          record: parentRequestRecord(turn, scope, 'request-close-2', 'dispatching'),
        });
      },
      (error: unknown) => error instanceof ContractError
        && /new request lifecycle record is rejected/.test((error as Error).message),
    );
    await assert.rejects(
      async () => { await owner.acceptRawFact({ ...answerFact, producerSeq: 3 }); },
      (error: unknown) => error instanceof ContractError
        && /new raw fact is rejected/.test((error as Error).message),
    );

    // Durable replay: a fresh journal and a fresh owner read the same one close.
    const replayedJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const reopened = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      providerBinding: parentProviderBinding,
      journal: replayedJournal,
      rawContent,
    });
    const reopenedClose = await reopened.readResourceClose();
    assert.ok(reopenedClose);
    assert.equal(reopenedClose!.fact.closedAt, committedAt);
    assert.equal((await reopened.readClosedTurnOutput()).assistantText, 'closed answer');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Failure basis: the accepted design adds a new durable control record whose
// request and epoch association can drift, whose replay can duplicate, or whose
// post-close append can accidentally reopen raw history. Probability is unknown
// because this persistence boundary is new. Impact is a false current-success
// receipt or post-release raw mutation. Cost is one focused Journal consumer.
test('provider settlement publishes and reads the exact current terminal receipt', async () => {
  const directory = await semanticCloseFixtureHome();
  const store = new ImmutableAssetStore(join(directory, 'assets'));
  const sink = filesystemProviderEvidenceSink(store);
  const journalFile = join(directory, 'organ.jsonl');
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const rawContent = providerRawContentReader(sink);
  try {
    const turn = semanticCloseTurn('interaction-provider-settlement', 'turn-provider-settlement');
    const operationId = id('operation', 'operation-provider-settlement');
    const scope: ScopeRef = { organId: semanticCloseOrganId, operationId };
    const execution = parentExecution(turn, operationId);
    const initialInput = await semanticCloseAsset(sink, scope, 'settlement-input', 'settle the question');
    const owner = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    await owner.openTurnInput();

    const dispatching = parentRequestRecord(turn, scope, 'request-provider-settlement', 'dispatching');
    await owner.registerRequest({ execution: parentExecutionRef(execution), record: dispatching });
    const request = parentRequestIdentity(dispatching);
    const answer = await semanticCloseAsset(sink, scope, 'settlement-answer', 'settled answer');
    const answerFact: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef> = {
      execution: parentExecutionRef(execution),
      scope,
      request,
      producerSeq: 1,
      fact: {
        kind: 'content',
        contentUnitId: 'assistant-provider-settlement',
        channel: 'assistant-text',
        update: 'full',
        content: answer,
        complete: true,
      },
    };
    await owner.acceptRawFact(answerFact);
    await owner.acceptRawFact({
      execution: parentExecutionRef(execution),
      scope,
      request,
      producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' },
    });
    await owner.registerRequest({
      execution: parentExecutionRef(execution),
      record: parentRequestRecord(turn, scope, 'request-provider-settlement', 'settled'),
    });
    const closedReceipt: ProviderCloseResult = {
      bindingId: parentProviderBinding.bindingId,
      providerId: parentProviderBinding.providerId,
      protocol: parentProviderBinding.protocol,
      state: 'closed',
      evidenceRefs: [semanticCloseEvidence('settlement-close', scope)],
    };
    await owner.recordProviderClose({
      providerBinding: parentProviderBinding,
      result: closedReceipt,
      closedAt: committedAt,
    });

    // An old journal has no receipt and the read is explicit, not a success.
    assert.deepEqual((await parentJournal.readTurnSnapshot(turn)).providerSettlements, []);
    await assert.rejects(
      async () => { await readInteractionProviderSettlement({ journal: parentJournal, turn }); },
      (error: unknown) => error instanceof ContractError
        && /missing for the current terminal request/.test((error as Error).message),
    );

    const receipt = providerSettlementReceipt(turn, execution, dispatching);
    await assert.rejects(
      async () => {
        await publishInteractionProviderSettlement({
          journal: parentJournal,
          receipt: {
            ...receipt,
            request: { ...receipt.request, requestId: 'request-not-terminal' },
          },
        });
      },
      (error: unknown) => error instanceof ContractError
        && /not the current terminal request/.test((error as Error).message),
    );
    await assert.rejects(
      async () => {
        await publishInteractionProviderSettlement({
          journal: parentJournal,
          receipt: providerSettlementReceipt(
            turn,
            { ...execution, executionEpoch: execution.executionEpoch + 1 },
            dispatching,
          ),
        });
      },
      (error: unknown) => error instanceof ContractError
        && /active physical execution epoch/.test((error as Error).message),
    );

    // The receipt may append after physical close, and the full original value
    // is retained. The same key is idempotent; changed content is a conflict.
    const first = await publishInteractionProviderSettlement({ journal: parentJournal, receipt });
    assert.deepEqual(first.fact, receipt);
    const replay = await publishInteractionProviderSettlement({ journal: parentJournal, receipt });
    assert.deepEqual(replay.commit, first.commit);
    assert.equal((await parentJournal.readTurnSnapshot(turn)).providerSettlements.length, 1);
    await assert.rejects(
      async () => {
        await publishInteractionProviderSettlement({
          journal: parentJournal,
          receipt: {
            ...receipt,
            settlement: {
              ...receipt.settlement,
              evidenceRefs: [semanticCloseEvidence('changed-provider-settlement', scope)],
            },
          },
        });
      },
      (error: unknown) => error instanceof ContractError
        && /conflicts with the committed receipt/.test((error as Error).message),
    );

    // The control record does not reopen request or raw history after close.
    await assert.rejects(
      async () => {
        await owner.registerRequest({
          execution: parentExecutionRef(execution),
          record: parentRequestRecord(turn, scope, 'request-after-settlement', 'dispatching'),
        });
      },
      (error: unknown) => error instanceof ContractError
        && /new request lifecycle record is rejected/.test((error as Error).message),
    );
    await assert.rejects(
      async () => { await owner.acceptRawFact({ ...answerFact, producerSeq: 3 }); },
      (error: unknown) => error instanceof ContractError
        && /new raw fact is rejected/.test((error as Error).message),
    );

    // A fresh reader sees the same durable receipt and performs no append.
    const freshJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const durable = await readInteractionProviderSettlement({ journal: freshJournal, turn });
    assert.deepEqual(durable.fact, receipt);
    assert.deepEqual(durable.commit, first.commit);
    const recordCount = (await journal.replay()).length;
    await readInteractionProviderSettlement({ journal: freshJournal, turn });
    assert.equal((await journal.replay()).length, recordCount);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unclosed parent turn blocks next-turn history until its semantic checkpoint commits', async () => {
  const directory = await semanticCloseFixtureHome();
  const store = new ImmutableAssetStore(join(directory, 'assets'));
  const sink = filesystemProviderEvidenceSink(store);
  const journal = new JsonlOrganJournal(join(directory, 'organ.jsonl'));
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helperJournal = new JsonlInteractionHelperJournal(journal);
  const rawContent = providerRawContentReader(sink);
  try {
    const scopeId = 'semantic-close-history-scope';
    const turnOne = semanticCloseTurn('interaction-one', 'turn-one', scopeId, 1);
    const turnTwo = semanticCloseTurn('interaction-two', 'turn-two', scopeId, 1);
    const turnOtherScope = semanticCloseTurn('interaction-other', 'turn-other', 'other-scope', 1);
    const operationOne = id('operation', 'operation-semantic-close-one');
    const operationTwo = id('operation', 'operation-semantic-close-two');
    const scopeOne: ScopeRef = { organId: semanticCloseOrganId, operationId: operationOne };
    const scopeTwo: ScopeRef = { organId: semanticCloseOrganId, operationId: operationTwo };
    const executionOne = parentExecution(turnOne, operationOne);
    const executionTwo = parentExecution(turnTwo, operationTwo);
    const rawSentinel = 'TURN-ONE-RAW-ASSISTANT-SENTINEL';
    const rawInputSentinel = 'TURN-ONE-RAW-INPUT-SENTINEL';
    const semanticGoal = 'Explain the bounded README question';
    const inputOne = await semanticCloseAsset(
      sink, scopeOne, 'turn-one-input', `${semanticGoal}\n${rawInputSentinel}`,
    );
    const assistantOne = await semanticCloseAsset(sink, scopeOne, 'turn-one-assistant', rawSentinel);
    const ownerOne = createInteractionParentTurnRawOwner({
      turn: turnOne,
      execution: executionOne,
      scope: scopeOne,
      initialInput: inputOne,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    await ownerOne.openTurnInput();
    const recordOne = parentRequestRecord(turnOne, scopeOne, 'request-one', 'dispatching');
    await ownerOne.registerRequest({ execution: parentExecutionRef(executionOne), record: recordOne });
    await ownerOne.acceptRawFact({
      execution: parentExecutionRef(executionOne),
      scope: scopeOne,
      request: parentRequestIdentity(recordOne),
      producerSeq: 1,
      fact: {
        kind: 'content',
        contentUnitId: 'assistant-one',
        channel: 'assistant-text',
        update: 'full',
        content: assistantOne,
        complete: true,
      },
    });
    await ownerOne.acceptRawFact({
      execution: parentExecutionRef(executionOne),
      scope: scopeOne,
      request: parentRequestIdentity(recordOne),
      producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' },
    });
    await ownerOne.registerRequest({
      execution: parentExecutionRef(executionOne),
      record: parentRequestRecord(turnOne, scopeOne, 'request-one', 'settled'),
    });
    const finalOutputOne = await ownerOne.readFinalTurnOutput();
    const outcome: ExplicitTurnInterpretedOutcome = {
      kind: 'answer',
      normalizedInput: semanticGoal,
      knownFacts: [],
      answer: 'TURN-ONE-ANSWER',
      decisionRefs: ['decision://turn-one'],
    };
    const latestTurnOne: InteractionLatestTurn = {
      ...turnOne,
      entries: [{ kind: 'user-input', content: inputOne }],
    };
    const { clock } = countingClock(['2026-10-16T04:00:00.000Z']);
    // The failed closure: the session is real but its semantic close dependency
    // is unbound, so no checkpoint becomes durable and turn-one keeps its
    // recovery responsibility.
    const unbound = new ExplicitTurnHelperSession({
      identity: turnOne,
      latestTurn: latestTurnOne,
      journal: helperJournal,
      clock,
      factory: semanticCloseHelperFactory(),
    });
    await assert.rejects(
      async () => { await unbound.closeTurnSemanticCheckpoint({ finalParentOutput: finalOutputOne, outcome }); },
      (error: unknown) => error instanceof ContractError
        && /bound semantic checkpoint journal/.test((error as Error).message),
    );
    assert.equal(await helperJournal.readSemanticCheckpointExact(turnOne), null);
    await assert.rejects(
      async () => {
        await prepareScopeSemanticHistory({
          activeTurn: turnTwo,
          parentJournal,
          checkpointJournal: helperJournal,
        });
      },
      (error: unknown) => error instanceof ContractError
        && /unclosed interaction parent turn turn-one/.test((error as Error).message),
    );

    const bound = new ExplicitTurnHelperSession({
      identity: turnOne,
      latestTurn: latestTurnOne,
      journal: helperJournal,
      clock,
      factory: semanticCloseHelperFactory(),
      checkpointJournal: helperJournal,
      rawContent,
    });
    const closedOne = await bound.closeTurnSemanticCheckpoint({
      finalParentOutput: finalOutputOne,
      outcome,
    });
    assert.equal(closedOne.checkpoint.turnId, 'turn-one');
    assert.deepEqual(
      await helperJournal.readScopeSemanticCheckpoints({
        organId: semanticCloseOrganId,
        interactionScopeId: 'other-scope',
      }),
      [],
    );

    const history = await prepareScopeSemanticHistory({
      activeTurn: turnTwo,
      parentJournal,
      checkpointJournal: helperJournal,
    });
    assert.equal(history.length, 1);
    // History crosses interactionId inside the same interactionScopeId.
    assert.equal(history[0]?.interactionId, 'interaction-one');
    assert.equal(history[0]?.turnId, 'turn-one');
    // A different interactionScopeId stays isolated: no history is selected and
    // no foreign turn can block or feed the active turn.
    assert.deepEqual(
      await prepareScopeSemanticHistory({
        activeTurn: turnOtherScope,
        parentJournal,
        checkpointJournal: helperJournal,
      }),
      [],
    );

    const inputTwo = await semanticCloseAsset(sink, scopeTwo, 'turn-two-input', 'TURN-TWO-INPUT');
    const ownerTwo = createInteractionParentTurnRawOwner({
      turn: turnTwo,
      execution: executionTwo,
      scope: scopeTwo,
      initialInput: inputTwo,
      providerBinding: parentProviderBinding,
      priorCheckpoints: history,
      journal: parentJournal,
      rawContent,
    });
    await ownerTwo.openTurnInput();
    const recordTwo = parentRequestRecord(turnTwo, scopeTwo, 'request-two', 'dispatching');
    await ownerTwo.registerRequest({ execution: parentExecutionRef(executionTwo), record: recordTwo });
    const contextTwo = await ownerTwo.requestContext({
      execution: executionTwo,
      request: parentRequestIdentity(recordTwo),
      phase: 'continuation',
    });
    assert.deepEqual(contextTwo.canonical.units[0], {
      kind: 'message',
      role: 'assistant',
      text: canonicalJsonStringify({
        kind: closedOne.checkpoint.kind,
        interactionId: closedOne.checkpoint.interactionId,
        inputRevision: closedOne.checkpoint.inputRevision,
        turnId: closedOne.checkpoint.turnId,
        committedAt: closedOne.checkpoint.committedAt,
        claims: closedOne.checkpoint.claims,
        constraints: closedOne.checkpoint.constraints,
      }),
    });
    assert.deepEqual(contextTwo.canonical.units[1], {
      kind: 'message',
      role: 'user',
      text: 'TURN-TWO-INPUT',
    });
    const rendered = JSON.stringify(contextTwo.canonical.units);
    assert.equal(rendered.includes(rawSentinel), false);
    assert.equal(rendered.includes(rawInputSentinel), false);
    assert.ok(rendered.includes(`goal: ${semanticGoal}`));
    assert.ok(rendered.includes('outcome(answer): TURN-ONE-ANSWER'));

    // Raw parent history stays durable even though it never enters next-turn
    // context, and the latest identity still rejects a foreign parent output.
    assert.equal((await parentJournal.readTurnSnapshot(turnOne)).acceptedFacts.length, 2);
    await assert.rejects(
      async () => {
        await bound.closeTurnSemanticCheckpoint({
          finalParentOutput: {
            ...finalOutputOne,
            turnInput: {
              ...finalOutputOne.turnInput,
              fact: { ...finalOutputOne.turnInput.fact, turn: turnTwo },
            },
          },
          outcome,
        });
      },
      (error: unknown) => error instanceof ContractError
        && /final parent output does not match the session turn/.test((error as Error).message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parent turn input persists the authenticated owner exactly and keeps legacy records readable', async () => {
  const { journalFile, parentJournal, sink, rawContent, cleanup } = await fixture();
  try {
    const executionOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'lease-parent-owner-attestation',
      daemonGeneration: 7,
      processStartToken: 'process-start-parent-owner-attestation',
    };
    const initialInput = await writeAsset(sink, 'interaction-parent-owner-input', 'owned input');
    const owner = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      executionOwner,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    const opened = await owner.openTurnInput();
    assert.deepEqual(opened.fact.executionOwner, executionOwner);

    const reopenedJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const reopened = createInteractionParentTurnRawOwner({
      turn,
      execution,
      scope,
      initialInput,
      executionOwner,
      providerBinding: parentProviderBinding,
      journal: reopenedJournal,
      rawContent,
    });
    const replayed = await reopened.openTurnInput();
    assert.deepEqual(replayed.fact.executionOwner, executionOwner);
    assert.deepEqual(replayed.commit, opened.commit);

    const legacyTurn: InteractionTurnIdentity = {
      ...turn,
      interactionId: 'interaction-parent-legacy',
      turnId: 'turn-parent-legacy',
    };
    const legacyExecution: InteractionParentProviderExecutionIdentityRef = {
      ...execution,
      runtimeId: 'runtime-parent-legacy',
      interactionTurn: legacyTurn,
    };
    const legacyInput = await writeAsset(sink, 'interaction-parent-legacy-input', 'legacy input');
    const legacyOwner = createInteractionParentTurnRawOwner({
      turn: legacyTurn,
      execution: legacyExecution,
      scope,
      initialInput: legacyInput,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    const legacyOpened = await legacyOwner.openTurnInput();
    assert.equal(legacyOpened.fact.executionOwner, undefined);

    const legacyReopenedJournal = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile));
    const legacyReopened = createInteractionParentTurnRawOwner({
      turn: legacyTurn,
      execution: legacyExecution,
      scope,
      initialInput: legacyInput,
      providerBinding: parentProviderBinding,
      journal: legacyReopenedJournal,
      rawContent,
    });
    assert.equal((await legacyReopened.openTurnInput()).fact.executionOwner, undefined);
    await assert.rejects(legacyReopened.reconcileTurnOwner({
      previousOwner: executionOwner,
      replacementOwner: { ...executionOwner, daemonGeneration: 8 },
      isCommittedReplacement: true, reconciledAt: committedAt,
    }), /authenticated original turn owner/);
    assert.equal((await legacyReopenedJournal.readTurnSnapshot(legacyTurn)).ownerReconciliations.length, 0);
  } finally {
    await cleanup();
  }
});

// Failure basis: the recorded epoch-2 reopen RED and the partially implemented
// reconciliation omitted context/close wiring. Impact: lost confirmed tool
// effects or duplicate effects after crash. Cost: one local durable consumer.
test('parent reconciliation continues original confirmed tool facts across repeated crashes', async () => {
  const directory = await semanticCloseFixtureHome();
  const store = new ImmutableAssetStore(join(directory, 'assets'));
  const sink = filesystemProviderEvidenceSink(store);
  const journalFile = join(directory, 'organ.jsonl');
  const journal = new JsonlOrganJournal(journalFile);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const rawContent = providerRawContentReader(sink);
  try {
    const turn = semanticCloseTurn('interaction-reconcile-red', 'turn-reconcile-red');
    const operationId = id('operation', 'operation-reconcile-red');
    const scope: ScopeRef = { organId: semanticCloseOrganId, operationId };
    const executionOne = parentExecution(turn, operationId);
    const firstOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'reconcile-lease', daemonGeneration: 1, processStartToken: 'reconcile-process-1',
    };
    const secondOwner = { ...firstOwner, daemonGeneration: 2, processStartToken: 'reconcile-process-2' };
    const initialInput = await semanticCloseAsset(sink, scope, 'reconcile-red-input', 'continue the bounded question');
    const ownerOne = createInteractionParentTurnRawOwner({
      turn,
      execution: executionOne,
      executionOwner: firstOwner,
      scope,
      initialInput,
      providerBinding: parentProviderBinding,
      journal: parentJournal,
      rawContent,
    });
    await ownerOne.openTurnInput();
    const reqOne = parentRequestRecord(turn, scope, 'request-red-1', 'dispatching');
    await ownerOne.registerRequest({ execution: parentExecutionRef(executionOne), record: reqOne });
    const reqOneIdentity = parentRequestIdentity(reqOne);
    const rawArguments = await semanticCloseAsset(sink, scope, 'reconcile-red-arguments', '{"path":"README.md"}');
    const rawOutput = await semanticCloseAsset(sink, scope, 'reconcile-red-output', 'README_CONTENT');
    await ownerOne.acceptRawFact({
      execution: parentExecutionRef(executionOne),
      scope,
      request: reqOneIdentity,
      producerSeq: 1,
      fact: {
        kind: 'tool-call',
        contentUnitId: 'reconcile-red-call',
        call: {
          callId: 'call-red-1',
          toolId: 'file.read',
          arguments: { path: 'README.md' },
          continuationRef: 'continuation-red-1',
        },
        rawArguments,
        complete: true,
      },
    });
    const replacement = (epoch: number, executionOwner: OccurrenceExecutionOwner) =>
      createInteractionParentTurnRawOwner({
        turn, execution: { ...executionOne, executionEpoch: epoch }, executionOwner,
        scope, initialInput, providerBinding: parentProviderBinding,
        journal: new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile)), rawContent,
      });
    const ownerTwo = replacement(2, secondOwner);
    const reconcileTwo = {
      previousOwner: firstOwner, replacementOwner: secondOwner,
      isCommittedReplacement: true, reconciledAt: committedAt,
    };
    await assert.rejects(ownerTwo.reconcileTurnOwner(reconcileTwo), /side effect is unknown/);
    await ownerOne.acceptRawFact({
      execution: parentExecutionRef(executionOne),
      scope,
      request: reqOneIdentity,
      producerSeq: 2,
      fact: {
        kind: 'tool-result',
        contentUnitId: 'reconcile-red-result',
        callId: 'call-red-1',
        continuationRef: 'continuation-red-1',
        result: {
          ...executionOne,
          toolId: 'file.read',
          callId: 'call-red-1',
          status: 'succeeded',
          outputRefs: ['asset://reconcile-red-output'],
          evidenceRefs: [rawOutput.ref],
        },
        rawOutput,
        complete: true,
      },
    });
    await ownerOne.acceptRawFact({
      execution: parentExecutionRef(executionOne),
      scope,
      request: reqOneIdentity,
      producerSeq: 3,
      fact: { kind: 'request-complete', terminal: 'completed' },
    });
    await ownerOne.registerRequest({
      execution: parentExecutionRef(executionOne),
      record: parentRequestRecord(turn, scope, 'request-red-1', 'settled'),
    });
    await ownerOne.registerRequest({
      execution: parentExecutionRef(executionOne),
      record: parentRequestRecord(turn, scope, 'request-red-2', 'dispatching', 'request-red-1'),
    });
    await ownerOne.registerRequest({
      execution: parentExecutionRef(executionOne),
      record: parentRequestRecord(turn, scope, 'request-red-2', 'waiting', 'request-red-1'),
    });

    const before = await parentJournal.readTurnSnapshot(turn);
    await assert.rejects(ownerTwo.openTurnInput(), /conflicts with the committed turn input/);
    const reconciled = await ownerTwo.reconcileTurnOwner(reconcileTwo);
    assert.equal(reconciled.fact.mode, 'continue');
    assert.equal(reconciled.fact.effectiveExecutionEpoch, 2);
    assert.equal(reconciled.fact.remoteProviderState, 'unknown');
    assert.deepEqual(reconciled.fact.unsettledRequestIds, ['request-red-2']);
    assert.deepEqual(await ownerTwo.reconcileTurnOwner(reconcileTwo), reconciled);
    assert.deepEqual(await ownerTwo.openTurnInput(), before.turnInput);
    await assert.rejects(ownerOne.registerRequest({
      execution: executionOne, record: parentRequestRecord(turn, scope, 'stale-request', 'dispatching'),
    }), /active execution owner/);
    // The continuation anchor must come from the Runtime owner, not a
    // hand-supplied chain: the reconciled settled leaf is request-red-1.
    const continuationAnchorTwo = await ownerTwo.readContinuationParentRequest();
    assert.equal(continuationAnchorTwo?.requestId, 'request-red-1');
    const reqThree = parentRequestRecord(turn, scope, 'request-red-3', 'dispatching', continuationAnchorTwo!.requestId);
    const executionTwo = { ...executionOne, executionEpoch: 2 };
    await ownerTwo.registerRequest({ execution: executionTwo, record: reqThree });
    const contextTwo = await ownerTwo.requestContext({
      execution: executionTwo, request: parentRequestIdentity(reqThree), phase: 'continuation',
    });
    assert.deepEqual(contextTwo.canonical.units.filter((unit) => unit.kind === 'tool-call'), [{
      kind: 'tool-call', callId: 'call-red-1', toolId: 'file.read', arguments: { path: 'README.md' },
    }]);
    assert.equal(contextTwo.canonical.units.filter((unit) => unit.kind === 'tool-result').length, 1);
    assert.ok(JSON.stringify(contextTwo).includes('README_CONTENT'));
    const thirdOwner = { ...firstOwner, daemonGeneration: 3, processStartToken: 'reconcile-process-3' };
    const ownerThree = replacement(3, thirdOwner);
    const third = await ownerThree.reconcileTurnOwner({
      previousOwner: secondOwner, replacementOwner: thirdOwner,
      isCommittedReplacement: true, reconciledAt: committedAt,
    });
    assert.equal(third.fact.effectiveExecutionEpoch, 3);
    assert.deepEqual(third.fact.unsettledRequestIds, ['request-red-3']);
    // request-red-3 is now the abandoned unsettled request, so the red-1 leaf
    // remains the single settled continuation anchor for the third epoch.
    const continuationAnchorThree = await ownerThree.readContinuationParentRequest();
    assert.equal(continuationAnchorThree?.requestId, 'request-red-1');
    const reqFour = parentRequestRecord(turn, scope, 'request-red-4', 'dispatching', continuationAnchorThree!.requestId);
    const executionThree = { ...executionOne, executionEpoch: 3 };
    await ownerThree.openTurnInput();
    await ownerThree.registerRequest({ execution: executionThree, record: reqFour });
    const contextThree = await ownerThree.requestContext({
      execution: executionThree, request: parentRequestIdentity(reqFour), phase: 'continuation',
    });
    assert.deepEqual(contextThree.canonical, contextTwo.canonical);
    const assistant = await semanticCloseAsset(sink, scope, 'reconciled-answer', 'Recovered answer');
    await ownerThree.acceptRawFact({
      execution: executionThree, scope, request: parentRequestIdentity(reqFour), producerSeq: 1,
      fact: { kind: 'content', channel: 'assistant-text', contentUnitId: 'reconciled-answer',
        content: assistant, update: 'full', complete: true },
    });
    await ownerThree.acceptRawFact({
      execution: executionThree, scope, request: parentRequestIdentity(reqFour), producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' },
    });
    await ownerThree.registerRequest({ execution: executionThree,
      record: { ...reqFour, phase: 'settled' } });
    await assert.rejects(ownerThree.readReconciledTurnOutput(), /effective epoch provider close/);
    const closeEvidence = await semanticCloseAsset(sink, scope, 'reconciled-close-receipt', 'fixture provider closed epoch 3');
    const close = await ownerThree.recordProviderClose({
      providerBinding: parentProviderBinding,
      result: { state: 'closed', bindingId: parentProviderBinding.bindingId,
        providerId: parentProviderBinding.providerId, protocol: parentProviderBinding.protocol,
        evidenceRefs: [closeEvidence.ref] },
      closedAt: committedAt,
    });
    const output = await ownerThree.readReconciledTurnOutput();
    assert.equal(output.assistantText, 'Recovered answer');
    assert.deepEqual(output.resourceClose, close);
    const after = await parentJournal.readTurnSnapshot(turn);
    assert.deepEqual(after.acceptedFacts.slice(0, before.acceptedFacts.length), before.acceptedFacts);
    assert.deepEqual(after.acceptedFacts.map((entry) => entry.fact.envelope.execution.executionEpoch), [1, 1, 1, 3, 3]);
    assert.deepEqual(after.acceptedFacts.map((entry) => entry.fact.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(after.turnInput, before.turnInput);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Failure basis: r3 excludes completed tool leaves from parent-final eligibility
// and the first implementation did not verify complete assistant text. Impact:
// false final output or epoch reset on repeated takeover. Cost: one local fixture.
test('parent reconciliation reserves terminal output for complete non-tool leaves and retains the latest epoch', async () => {
  const { parentJournal, journalFile, sink, rawContent, cleanup } = await fixture();
  try {
    const initialInput = await writeAsset(sink, 'terminal-reconcile-input', 'bounded question');
    const firstOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'terminal-lease', daemonGeneration: 1, processStartToken: 'terminal-process-1',
    };
    const ownerAt = (epoch: number, generation: number) => createInteractionParentTurnRawOwner({
      turn, execution: { ...execution, executionEpoch: epoch }, scope, initialInput,
      executionOwner: { ...firstOwner, daemonGeneration: generation, processStartToken: `terminal-process-${generation}` },
      providerBinding: parentProviderBinding,
      journal: new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile)), rawContent,
    });
    const reconcile = (previous: number, replacement: number) => ({
      previousOwner: { ...firstOwner, daemonGeneration: previous, processStartToken: `terminal-process-${previous}` },
      replacementOwner: { ...firstOwner, daemonGeneration: replacement, processStartToken: `terminal-process-${replacement}` },
      isCommittedReplacement: true, reconciledAt: committedAt,
    });
    const ownerOne = ownerAt(1, 1);
    await ownerOne.openTurnInput();
    const reqOne = requestRecord('terminal-tool');
    await ownerOne.registerRequest({ execution, record: reqOne });
    const rawArguments = await writeAsset(sink, 'terminal-arguments', '{}');
    const rawOutput = await writeAsset(sink, 'terminal-output', 'confirmed');
    await ownerOne.acceptRawFact({ execution, scope, request: reqOne.request, producerSeq: 1,
      fact: { kind: 'tool-call', contentUnitId: 'terminal-call',
        call: { callId: 'terminal-call', toolId: 'file.read', arguments: {}, continuationRef: 'terminal-continuation' },
        rawArguments, complete: true } });
    await ownerOne.acceptRawFact({ execution, scope, request: reqOne.request, producerSeq: 2,
      fact: { kind: 'tool-result', contentUnitId: 'terminal-result', callId: 'terminal-call', continuationRef: 'terminal-continuation',
        result: { ...execution, callId: 'terminal-call', toolId: 'file.read', status: 'succeeded',
          outputRefs: [], evidenceRefs: [rawOutput.ref] }, rawOutput, complete: true } });
    const intermediateText = await writeAsset(sink, 'terminal-intermediate', 'I will read the file.');
    await ownerOne.acceptRawFact({ execution, scope, request: reqOne.request, producerSeq: 3,
      fact: { kind: 'content', contentUnitId: 'intermediate', channel: 'assistant-text', content: intermediateText,
        update: 'full', complete: true } });
    await ownerOne.acceptRawFact({ execution, scope, request: reqOne.request, producerSeq: 4,
      fact: { kind: 'request-complete', terminal: 'completed' } });
    await ownerOne.registerRequest({ execution, record: { ...reqOne, phase: 'settled' } });
    const ownerTwo = ownerAt(2, 2);
    const continued = await ownerTwo.reconcileTurnOwner(reconcile(1, 2));
    assert.equal(continued.fact.mode, 'continue');
    assert.deepEqual(continued.fact.unsettledRequestIds, []);
    await ownerTwo.openTurnInput();
    const executionTwo = { ...execution, executionEpoch: 2 };
    // The reconciled settled tool request is the continuation anchor read back
    // from the Runtime owner rather than a hardcoded parent id.
    const continuationAnchorTwo = await ownerTwo.readContinuationParentRequest();
    assert.equal(continuationAnchorTwo?.requestId, 'terminal-tool');
    const reqTwo = requestRecord('terminal-answer', continuationAnchorTwo!.requestId);
    await ownerTwo.registerRequest({ execution: executionTwo, record: reqTwo });
    const answer = await writeAsset(sink, 'terminal-answer', 'Final answer');
    await ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: reqTwo.request, producerSeq: 1,
      fact: { kind: 'content', contentUnitId: 'answer', channel: 'assistant-text', content: answer,
        update: 'full', complete: false } });
    await ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: reqTwo.request, producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' } });
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...reqTwo, phase: 'settled' } });
    await assert.rejects(ownerTwo.reconcileTurnOwner({ ...reconcile(2, 3), isCommittedReplacement: false }),
      /committed replacement owner/);
    await assert.rejects(ownerTwo.reconcileTurnOwner(reconcile(2, 2)), /distinct replacement owner/);
    // The ABI computes the next epoch; the caller does not guess it first.
    // Incomplete text requires continuation, never a zero-replay final.
    const incomplete = await ownerTwo.reconcileTurnOwner(reconcile(2, 3));
    assert.equal(incomplete.fact.mode, 'continue');
    assert.equal(incomplete.fact.effectiveExecutionEpoch, 3);
    const ownerThree = ownerAt(incomplete.fact.effectiveExecutionEpoch, 3);
    await ownerThree.openTurnInput();
    const executionThree = { ...execution, executionEpoch: 3 };
    const continuationAnchorThree = await ownerThree.readContinuationParentRequest();
    assert.equal(continuationAnchorThree?.requestId, 'terminal-answer');
    const reqThree = requestRecord('terminal-complete-answer', continuationAnchorThree!.requestId);
    await ownerThree.registerRequest({ execution: executionThree, record: reqThree });
    await ownerThree.acceptRawFact({ execution: executionThree, scope, request: reqThree.request, producerSeq: 1,
      fact: { kind: 'content', contentUnitId: 'complete-answer', channel: 'assistant-text', content: answer,
        update: 'full', complete: true } });
    await ownerThree.acceptRawFact({ execution: executionThree, scope, request: reqThree.request, producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' } });
    await ownerThree.registerRequest({ execution: executionThree, record: { ...reqThree, phase: 'settled' } });
    const terminal = await ownerThree.reconcileTurnOwner(reconcile(3, 4));
    assert.equal(terminal.fact.mode, 'terminal-output');
    assert.equal(terminal.fact.effectiveExecutionEpoch, 3);
    assert.equal(terminal.fact.remoteProviderState, 'unknown');
    const ownerFour = ownerAt(3, 4);
    const repeated = await ownerFour.reconcileTurnOwner(reconcile(4, 5));
    assert.equal(repeated.fact.mode, 'terminal-output');
    assert.equal(repeated.fact.effectiveExecutionEpoch, 3);
    const output = await ownerFour.readReconciledTurnOutput();
    assert.equal(output.assistantText, 'Final answer');
    assert.equal(output.resourceClose, null);
    assert.deepEqual(output.reconciliation, repeated);
    const snapshot = await parentJournal.readTurnSnapshot(turn);
    assert.equal(snapshot.resourceClose, null);
    assert.deepEqual(snapshot.ownerReconciliations.map((entry) => entry.fact.effectiveExecutionEpoch), [2, 3, 3, 3]);
    assert.deepEqual(snapshot.acceptedFacts.map((entry) => entry.fact.envelope.execution.executionEpoch), [1, 1, 1, 1, 2, 2, 3, 3]);
  } finally {
    await cleanup();
  }
});

// Failure basis: production turn explicit-interpret-0d94c7e7 has one committed
// `owner-reconciliation` (mode continue, effectiveExecutionEpoch 2) whose new
// epoch then died with only reasoning deltas and unsettled requests. Every
// closure lane refused it: abandonment holds on any reconciliation, execution
// failure holds on any reconciliation, and the durable codec rejects the append
// for the same reason. The turn therefore stays pending forever and every later
// input in the scope is refused with "requires its exact prior input".
// Impact: one crash permanently wedges explicit intake for a whole scope.
// Cost: one local Journal-backed public consumer, no daemon and no Provider.
test('parent raw owner closes the active epoch of a reconciled turn that died without terminal output', async () => {
  const { parentJournal, journalFile, sink, rawContent, cleanup } = await fixture();
  try {
    const initialInput = await writeAsset(sink, 'reconciled-dead-input', 'bounded question');
    const firstOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'reconciled-dead-lease-1', daemonGeneration: 31, processStartToken: 'reconciled-dead-process-1',
    };
    const secondOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'reconciled-dead-lease-2', daemonGeneration: 33, processStartToken: 'reconciled-dead-process-2',
    };
    const ownerAt = (epoch: number, executionOwner: OccurrenceExecutionOwner) => createInteractionParentTurnRawOwner({
      turn, execution: { ...execution, executionEpoch: epoch }, executionOwner,
      scope, initialInput, providerBinding: parentProviderBinding,
      journal: new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile)), rawContent,
    });
    const ownerOne = ownerAt(1, firstOwner);
    await ownerOne.openTurnInput();
    const reqOne = requestRecord('reconciled-dead-1');
    await ownerOne.registerRequest({ execution, record: { ...reqOne, phase: 'dispatching' } });
    await ownerOne.registerRequest({ execution, record: { ...reqOne, phase: 'dispatched' } });
    const reasoningOne = await writeAsset(sink, 'reconciled-dead-reasoning-1', 'partial reasoning');
    await ownerOne.acceptRawFact({ execution, scope, request: reqOne.request, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full',
        contentUnitId: 'reconciled-dead-reasoning-1', content: reasoningOne, complete: false } });

    // The previous owner is provably gone, so the continuation lane opens epoch 2.
    const ownerTwo = ownerAt(2, secondOwner);
    const reconciled = await ownerTwo.reconcileTurnOwner({
      previousOwner: firstOwner, replacementOwner: secondOwner,
      isCommittedReplacement: true, reconciledAt: committedAt,
    });
    assert.equal(reconciled.fact.mode, 'continue');
    assert.equal(reconciled.fact.effectiveExecutionEpoch, 2);
    await ownerTwo.openTurnInput();
    const executionTwo = { ...execution, executionEpoch: 2 };
    const reqTwo = requestRecord('reconciled-dead-2');
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...reqTwo, phase: 'dispatching' } });
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...reqTwo, phase: 'dispatched' } });
    const reasoningTwo = await writeAsset(sink, 'reconciled-dead-reasoning-2', 'partial reasoning in the continued epoch');
    await ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: reqTwo.request, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full',
        contentUnitId: 'reconciled-dead-reasoning-2', content: reasoningTwo, complete: false } });

    // The discontinued epoch can never deliver: this is the honest closure the
    // production turn never got.
    const eligibility = await ownerTwo.readExecutionFailureEligibility();
    assert.equal(eligibility.closable, true,
      `a dead continued epoch must be closable, held: ${(eligibility as { heldReason?: string }).heldReason ?? ''}`);
    const failure = await ownerTwo.closeFailedEpoch({ failedAt: committedAt });
    assert.equal(failure.fact.execution.executionEpoch, 2,
      'the closure records the epoch that actually died, never the turn input epoch');

    const snapshot = await parentJournal.readTurnSnapshot(turn);
    assert.equal(snapshot.executionFailure?.fact.execution.executionEpoch, 2);
    assert.equal(snapshot.resourceClose, null, 'the closure never fabricates a provider close');
    assert.deepEqual(snapshot.providerSettlements, [], 'the closure never fabricates a settlement');
    assert.equal(snapshot.abandonment, null, 'abandonment is the wrong lane for a reconciled turn');
    assert.deepEqual(snapshot.ownerReconciliations.map((entry) => entry.fact.effectiveExecutionEpoch), [2],
      'the committed reconciliation is never rewritten');
    // Frozen after the closure: the dead epoch cannot accept late raw history.
    await assert.rejects(ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: reqTwo.request,
      producerSeq: 2, fact: { kind: 'content', channel: 'reasoning-summary', update: 'full',
        contentUnitId: 'late', content: reasoningTwo, complete: false } }), /epoch failure/);
  } finally {
    await cleanup();
  }
});

// Failure basis: the blanket reconciliation hold must not become a generic
// "close anything" bypass. A reconciled turn whose continued epoch still
// produced a real terminal output keeps its deliverable answer, and a turn with
// an unknown tool side effect keeps that side effect open.
test('parent raw owner still refuses to close a reconciled epoch that can deliver or hides a side effect', async () => {
  const { parentJournal, journalFile, sink, rawContent, cleanup } = await fixture();
  try {
    const initialInput = await writeAsset(sink, 'reconciled-hold-input', 'bounded question');
    const firstOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'reconciled-hold-lease-1', daemonGeneration: 41, processStartToken: 'reconciled-hold-process-1',
    };
    const secondOwner: OccurrenceExecutionOwner = {
      daemonLeaseId: 'reconciled-hold-lease-2', daemonGeneration: 42, processStartToken: 'reconciled-hold-process-2',
    };
    const ownerAt = (epoch: number, executionOwner: OccurrenceExecutionOwner) => createInteractionParentTurnRawOwner({
      turn, execution: { ...execution, executionEpoch: epoch }, executionOwner,
      scope, initialInput, providerBinding: parentProviderBinding,
      journal: new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalFile)), rawContent,
    });
    const ownerOne = ownerAt(1, firstOwner);
    await ownerOne.openTurnInput();
    const reqOne = requestRecord('reconciled-hold-1');
    await ownerOne.registerRequest({ execution, record: { ...reqOne, phase: 'dispatching' } });
    await ownerOne.registerRequest({ execution, record: { ...reqOne, phase: 'dispatched' } });
    const reasoningOne = await writeAsset(sink, 'reconciled-hold-reasoning', 'partial reasoning');
    await ownerOne.acceptRawFact({ execution, scope, request: reqOne.request, producerSeq: 1,
      fact: { kind: 'content', channel: 'reasoning-summary', update: 'full',
        contentUnitId: 'reconciled-hold-reasoning', content: reasoningOne, complete: false } });
    const ownerTwo = ownerAt(2, secondOwner);
    await ownerTwo.reconcileTurnOwner({
      previousOwner: firstOwner, replacementOwner: secondOwner,
      isCommittedReplacement: true, reconciledAt: committedAt,
    });
    await ownerTwo.openTurnInput();
    const executionTwo = { ...execution, executionEpoch: 2 };
    const reqTwo = requestRecord('reconciled-hold-2');
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...reqTwo, phase: 'dispatching' } });
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...reqTwo, phase: 'waiting' } });
    // A real terminal output in the continued epoch stays deliverable.
    const answer = await writeAsset(sink, 'reconciled-hold-answer', 'Recovered answer');
    await ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: reqTwo.request, producerSeq: 1,
      fact: { kind: 'content', channel: 'assistant-text', contentUnitId: 'reconciled-hold-answer',
        content: answer, update: 'full', complete: true } });
    await ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: reqTwo.request, producerSeq: 2,
      fact: { kind: 'request-complete', terminal: 'completed' } });
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...reqTwo, phase: 'settled' } });
    const held = await ownerTwo.readExecutionFailureEligibility();
    assert.equal(held.closable, false, 'a continued epoch with a deliverable answer is never closed as failed');
    await assert.rejects(ownerTwo.closeFailedEpoch({ failedAt: committedAt }), /cannot be closed as failed/);

    // An unpaired tool call in the continued epoch hides a physical side effect.
    const toolReq = requestRecord('reconciled-hold-3', reqTwo.request.requestId);
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...toolReq, phase: 'dispatching' } });
    await ownerTwo.registerRequest({ execution: executionTwo, record: { ...toolReq, phase: 'waiting' } });
    const toolArguments = await writeAsset(sink, 'reconciled-hold-arguments', '{}');
    await ownerTwo.acceptRawFact({ execution: executionTwo, scope, request: toolReq.request, producerSeq: 3,
      fact: { kind: 'tool-call', contentUnitId: 'reconciled-hold-call',
        call: { callId: 'reconciled-hold-call', toolId: 'write_file', arguments: {}, continuationRef: 'reconciled-hold-continuation' },
        rawArguments: toolArguments, complete: true } });
    const heldTool = await ownerTwo.readExecutionFailureEligibility();
    assert.equal(heldTool.closable, false, 'an unknown tool side effect is never closed as a failed epoch');
    const preserved = await parentJournal.readTurnSnapshot(turn);
    assert.equal(preserved.executionFailure, null);
    assert.equal(preserved.resourceClose, null);
  } finally {
    await cleanup();
  }
});
