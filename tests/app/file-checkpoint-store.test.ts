import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type Checkpoint, type EvidenceRef, type ScopeRef } from '../../packages/contracts/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { FileCheckpointStore } from '../../packages/app/src/ui-runtime/index.js';

const organId = id('organ', 'organ-ui-checkpoint-store-test');

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `checkpoint-store-${label}`),
    kind: 'operation',
    source: 'file-checkpoint-store-test',
    locator: `test://${label}`,
    scope,
  };
}

function checkpoint(
  scope: ScopeRef,
  idValue: string,
  seq: number,
  previousCheckpointId: Checkpoint['previousCheckpointId'],
): Checkpoint {
  return {
    id: id('checkpoint', idValue),
    scope,
    cycleId: scope.cycleId!,
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded',
    summary: `${scope.operationId?.value} checkpoint ${seq}`,
    recoveryStateRef: evidence(`${scope.operationId?.value}-${seq}-recovery`, scope),
    evidenceRefs: [evidence(`${scope.operationId?.value}-${seq}-evidence`, scope)],
    next: { kind: 'continue', ref: 'test://next' },
  };
}

async function appendCheckpoint(store: FileCheckpointStore, value: Checkpoint): Promise<void> {
  await store.append({ ownerId: 'file-checkpoint-store-test', commitId: checkpointCommitId(value), checkpoint: value });
}

test('readLatest keeps predecessors in their operation chain when checkpoint ids collide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-file-checkpoint-store-'));
  const store = new FileCheckpointStore(join(root, 'checkpoints.jsonl'));
  const taskId = id('task', 'checkpoint-store-task');
  const cycleId = id('cycle', 'checkpoint-store-cycle');
  const scopeA: ScopeRef = { organId, taskId, cycleId, operationId: id('operation', 'operation-a') };
  const scopeB: ScopeRef = { organId, taskId, cycleId, operationId: id('operation', 'operation-b') };

  const checkpointA1 = checkpoint(scopeA, 'shared-predecessor', 1, null);
  const checkpointA2 = checkpoint(scopeA, 'operation-a-latest', 2, checkpointA1.id);
  const checkpointB1 = checkpoint(scopeB, 'shared-predecessor', 1, null);
  const checkpointB2 = checkpoint(scopeB, 'operation-b-latest', 2, checkpointB1.id);
  await appendCheckpoint(store, checkpointA1);
  await appendCheckpoint(store, checkpointA2);
  await appendCheckpoint(store, checkpointB1);
  await appendCheckpoint(store, checkpointB2);

  const latestA = await store.readLatest(scopeA);
  assert.equal(latestA?.checkpoint.id.value, checkpointA2.id.value);
  assert.equal(latestA?.previous?.id.value, checkpointA1.id.value);
  assert.equal(latestA?.previous?.scope.operationId?.value, scopeA.operationId!.value);

  const latestB = await store.readLatest(scopeB);
  assert.equal(latestB?.checkpoint.id.value, checkpointB2.id.value);
  assert.equal(latestB?.previous?.id.value, checkpointB1.id.value);
  assert.equal(latestB?.previous?.scope.operationId?.value, scopeB.operationId!.value);
});
