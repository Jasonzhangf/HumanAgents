import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
import { id, type ScopeRef } from '../../packages/contracts/src/index.js';
import { createNativeProviderSettlementReader } from '../../packages/app/src/ui-runtime/native-provider-settlement.js';
import type { RuntimeTaskProviderSettlementCapture } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { currentColdSegment } from '../../packages/runtime/src/ui-runtime/cold-execution-resume.js';

const organId = id('organ', 'native-settlement-organ');
const taskId = id('task', 'native-settlement-task');
const cycleId = id('cycle', 'native-settlement-cycle');
const operationId = id('operation', 'native-settlement-operation');
const turnId = 'active-turn-native-settlement-operation';
const providerTurnId = 'turn-native-settlement-provider';
const requestId = 'request-native-settlement-terminal';
const runtimeId = 'ui-runtime-native-settlement-operation';

function scope(): ScopeRef {
  return { organId, taskId, cycleId, operationId };
}

function ref(record: JournalRecord) {
  assert.ok(record.commitId);
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

async function appendTerminal(
  journal: JsonlOrganJournal,
  input: {
    producerSeq?: number;
    requestId?: string;
    providerTurnId?: string;
    parentRequestId?: string;
    fact?: { kind: string; terminal?: string };
  } = {},
) {
  const acceptedRequestId = input.requestId ?? requestId;
  return await journal.append({
    commitId: `accepted:${acceptedRequestId}:${input.producerSeq ?? 3}`,
    kind: 'event',
    scope: scope(),
    payload: {
      type: 'active-turn.record',
      record: {
        kind: 'accepted-fact',
        entry: {
          seq: 1,
          envelope: {
            execution: { runtimeId, executionEpoch: 1 },
            scope: scope(),
            request: {
              turnId: input.providerTurnId ?? providerTurnId,
              requestId: acceptedRequestId,
              ...(input.parentRequestId === undefined ? {} : { parentRequestId: input.parentRequestId }),
            },
            producerSeq: input.producerSeq ?? 3,
            fact: input.fact ?? { kind: 'request-complete', terminal: 'completed' },
          },
        },
      },
    },
  });
}

async function appendDrain(
  journal: JsonlOrganJournal,
  lastProducerSeq = 3,
  requests: readonly {
    readonly requestId: string;
    readonly providerTurnId?: string;
    readonly parentRequestId?: string;
    readonly lastProducerSeq: number;
  }[] = [{ requestId, lastProducerSeq }],
) {
  const boundaryId = `execution-close:${operationId.value}`;
  return await journal.append({
    commitId: `recovery-assets:${lastProducerSeq}`,
    kind: 'event',
    scope: scope(),
    payload: {
      type: 'recovery-assets.phase',
      version: 1,
      receipt: {
        receiptRef: 'recovery-assets:test',
        turnId,
        boundaryId,
        controlRecordCount: 1,
        producerDrains: [{
          execution: { runtimeId, executionEpoch: 1 },
          boundaryId,
          requests: requests.map((request) => ({
            request: {
              turnId: request.providerTurnId ?? providerTurnId,
              requestId: request.requestId,
              ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
            },
            lastProducerSeq: request.lastProducerSeq,
          })),
        }],
        completionLookups: [],
        recovery: {},
        captureRef: {},
      },
    },
  });
}

async function appendClose(journal: JsonlOrganJournal, withClose = true) {
  const binding = {
    bindingId: 'binding-native-settlement',
    providerId: 'provider-native-settlement',
    protocol: 'responses',
    endpointRef: 'endpoint://native-settlement',
    modelRef: 'model://native-settlement',
    configDigest: 'sha256:config',
    capabilityDigest: 'sha256:capability',
  };
  const preparation = await journal.append({
    commitId: 'prepared-stop:preparation',
    kind: 'event',
    scope: scope(),
    payload: {
      kind: 'prepared-execution-stop/v1',
      fact: {
        kind: 'preparation-entered',
        allocation: {
          runtimeId,
          taskId,
          operationId,
          executionEpoch: 1,
          assignmentId: 'assignment-native-settlement',
          scope: scope(),
          inputRefs: [],
          ownerId: 'humanagent.runtime',
          directiveRevision: 1,
          inputRevision: 1,
          orchestrated: false,
        },
      },
    },
  });
  const acquisition = await journal.append({
    commitId: 'prepared-stop:acquisition',
    kind: 'event',
    scope: scope(),
    payload: {
      kind: 'prepared-execution-stop/v1',
      fact: {
        kind: 'resource-acquired',
        resource: { preparation: ref(preparation), binding },
      },
    },
  });
  if (!withClose) return acquisition;
  return await journal.append({
    commitId: 'prepared-stop:close',
    kind: 'event',
    scope: scope(),
    payload: {
      kind: 'prepared-execution-stop/v1',
      fact: {
        kind: 'resource-closed',
        acquisition: ref(acquisition),
        receipt: {
          bindingId: binding.bindingId,
          providerId: binding.providerId,
          protocol: binding.protocol,
          state: 'closed',
          evidenceRefs: [],
        },
      },
    },
  });
}

async function read(journal: JsonlOrganJournal) {
  // Isolated reader contract fixture. The public-consumer suite below this
  // layer exercises the real v2 immutable asset and exact capture port.
  const records = (await journal.verify()).records;
  const drain = records.find((record) => record.payload?.['type'] === 'recovery-assets.phase');
  const interrupted = records.some((record) => record.payload?.['type'] === 'active-turn.segment-record');
  const receipt = drain?.payload?.['receipt'] as any;
  const currentSegment = drain === undefined || interrupted ? null : {
    version: 1,
    source: {
      receipt: { commitIdentity: drain.commitId!, journalSeq: drain.seq, recordDigest: drain.recordDigest,
        turnId, boundaryId: receipt.boundaryId },
      prepared: {
        body: { binding: { execution: { runtimeId, executionEpoch: 1 }, scope: scope(), assignment: { taskId } },
          cut: { pauseId: receipt.boundaryId },
          entries: records.flatMap((record) => {
            const typed = record.payload?.['record'] as any;
            return typed?.kind === 'accepted-fact' ? [{ ...typed.entry, seq: record.seq }] : [];
          }) },
        producerDrains: receipt.producerDrains,
      },
    },
  } as unknown as RuntimeTaskProviderSettlementCapture;
  return createNativeProviderSettlementReader({
    journal,
    now: () => new Date('2026-11-25T10:30:00.000Z'),
  }).read({ taskId, scope: scope(), turnId, currentSegment });
}

test('native Provider settlement derives only from the exact terminal, drain and close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-native-settlement-'));
  try {
    const journal = new JsonlOrganJournal(join(dir, 'control.jsonl'));
    await appendTerminal(journal);
    await appendDrain(journal);
    await appendClose(journal);

    assert.deepEqual(await read(journal), {
      state: 'verified',
      receipts: [{
        providerRequestId: requestId,
        state: 'settled',
        verifiedBy: 'response-stream-eof',
        verifiedAt: '2026-11-25T10:30:00.000Z',
      }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('current cold tail selects its exact v2 receipt and never the saved v1 predecessor', () => {
  const old = { version: 1, source: { receipt: { commitIdentity: 'old', turnId } } } as unknown as RuntimeTaskProviderSettlementCapture;
  const current = { version: 2, source: { receipt: { commitIdentity: 'current', segmentId: 'epoch-2' } } } as unknown as RuntimeTaskProviderSettlementCapture;
  assert.equal(currentColdSegment({ tail: { segmentId: 'epoch-2', recoveryAssetsReceiptRef: 'current' }, captures: [old, current] }), current);
  assert.equal(currentColdSegment({ tail: { segmentId: 'epoch-2', recoveryAssetsReceiptRef: 'current' }, captures: [old] }), null);
  assert.equal(currentColdSegment({ tail: { segmentId: 'epoch-2', interrupted: { openedCommitRef: refFixture(), recordsThroughCommitRef: refFixture() } }, captures: [old] }), null);
});

function refFixture() {
  return { commitId: 'interrupted', journalSeq: 1, recordDigest: 'sha256:fixture' };
}

test('native Provider settlement keeps hold when terminal, drain or close is missing or mismatched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-native-settlement-negative-'));
  try {
    const missingTerminal = new JsonlOrganJournal(join(dir, 'missing-terminal.jsonl'));
    await appendTerminal(missingTerminal, { fact: { kind: 'content' } });
    await appendDrain(missingTerminal);
    await appendClose(missingTerminal);
    assert.equal((await read(missingTerminal)).state, 'unknown');

    const mismatchedDrain = new JsonlOrganJournal(join(dir, 'mismatched-drain.jsonl'));
    await appendTerminal(mismatchedDrain);
    await appendDrain(mismatchedDrain, 4);
    await appendClose(mismatchedDrain);
    assert.equal((await read(mismatchedDrain)).state, 'unknown');

    const missingClose = new JsonlOrganJournal(join(dir, 'missing-close.jsonl'));
    await appendTerminal(missingClose);
    await appendDrain(missingClose);
    await appendClose(missingClose, false);
    assert.equal((await read(missingClose)).state, 'unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native Provider settlement uses the provider turn and never falls back from the latest drained request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-native-settlement-latest-'));
  try {
    const journal = new JsonlOrganJournal(join(dir, 'control.jsonl'));
    await appendTerminal(journal, {
      producerSeq: 3,
      requestId: 'request-native-settlement-earlier',
    });
    await appendTerminal(journal, {
      producerSeq: 5,
      requestId: 'request-native-settlement-later',
      fact: { kind: 'content' },
    });
    await appendDrain(journal, 5, [
      { requestId: 'request-native-settlement-earlier', lastProducerSeq: 3 },
      { requestId: 'request-native-settlement-later', lastProducerSeq: 5 },
    ]);
    await appendClose(journal);

    assert.deepEqual(await read(journal), {
      state: 'unknown',
      reason: 'the latest drained request does not end in an authoritative completed terminal',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an older completed stream cannot settle a newer open segment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-native-settlement-current-segment-'));
  try {
    const journal = new JsonlOrganJournal(join(dir, 'control.jsonl'));
    await appendTerminal(journal, {
      producerSeq: 3,
      requestId: 'request-native-settlement-old-complete',
    });
    await appendDrain(journal, 3, [{
      requestId: 'request-native-settlement-old-complete',
      lastProducerSeq: 3,
    }]);
    await appendClose(journal);

    await journal.append({
      commitId: 'active-turn-segment:newer-open',
      kind: 'event',
      scope: scope(),
      payload: {
        type: 'active-turn.segment-record',
        record: {
          kind: 'request',
          record: {
            request: {
              turnId: 'turn-native-settlement-newer',
              requestId: 'request-native-settlement-newer-unknown',
            },
            scope: scope(),
            phase: 'waiting',
          },
        },
      },
    });

    const readback = await read(journal);
    assert.deepEqual(readback, {
      state: 'unknown',
      reason: 'the cold source tail has no committed recovery-assets receipt; an older completed stream cannot settle the newer attempt',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native Provider settlement requires every drained prefix even when the latest request is complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-native-settlement-prefixes-'));
  try {
    const journal = new JsonlOrganJournal(join(dir, 'control.jsonl'));
    await appendTerminal(journal, {
      producerSeq: 4,
      requestId: 'request-native-settlement-earlier',
    });
    await appendTerminal(journal, {
      producerSeq: 5,
      requestId: 'request-native-settlement-later',
    });
    await appendDrain(journal, 5, [
      { requestId: 'request-native-settlement-earlier', lastProducerSeq: 3 },
      { requestId: 'request-native-settlement-later', lastProducerSeq: 5 },
    ]);
    await appendClose(journal);

    assert.deepEqual(await read(journal), {
      state: 'unknown',
      reason: 'a drained Provider request prefix is incomplete at its exact final sequence',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native Provider settlement matches the full provider request identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-native-settlement-identity-'));
  try {
    const journal = new JsonlOrganJournal(join(dir, 'control.jsonl'));
    await appendTerminal(journal, {
      producerSeq: 3,
      parentRequestId: 'request-native-settlement-parent-other',
    });
    await appendDrain(journal, 3, [{
      requestId,
      parentRequestId: 'request-native-settlement-parent-expected',
      lastProducerSeq: 3,
    }]);
    await appendClose(journal);

    assert.deepEqual(await read(journal), {
      state: 'unknown',
      reason: 'a drained Provider request prefix is incomplete at its exact final sequence',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
