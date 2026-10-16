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
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
  type ProviderToolResult,
  type RawAsset,
  type RawContentReadPort,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import type {
  InteractionHelperAssignment,
  InteractionHelperResult,
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
import { createInteractionParentTurnRawOwner } from '../../../packages/runtime/src/explicit-brain/index.js';

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

interface Fixture {
  readonly journal: JsonlOrganJournal;
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
  const journal = new JsonlOrganJournal(join(directory, 'organ.jsonl'));
  return {
    journal,
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
      expectedArtifactDigests: ['sha256:child-only'],
      acceptanceCriteriaDigest: 'sha256:criteria-child-only',
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
      producedArtifactDigests: ['sha256:child-only'],
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
    await helperJournal.appendReturned({
      kind: 'returned',
      result: childResult,
      returnedAt: committedAt,
      evidenceRefs: [childEvidence],
    });
    await helperJournal.appendOwnerAccepted({
      kind: 'owner-accepted',
      result: childResult,
      acceptedBy: 'owner',
      acceptanceRef: 'acceptance://child-only',
      acceptedAt: committedAt,
      evidenceRefs: [childEvidence],
    });
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
      text: canonicalJsonStringify({ claims: checkpoint.claims, constraints: checkpoint.constraints }),
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
