import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkpointCommitIdentityV2,
  checkpointRefV2,
  id,
  type Checkpoint,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthority,
  type EvidenceRef,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import { createJsonlCheckpointJournal } from '../../packages/app/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { completeNativeCheckpoint } from '../../packages/runtime/src/checkpoints/coordinator.js';

const organ = id('organ', 'native-checkpoint-organ');
const task = id('task', 'native-checkpoint-task');
const cycle = id('cycle', 'native-checkpoint-cycle');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle };
const committedAt = '2026-10-12T04:10:00.000Z';

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `native-checkpoint-${label}`),
    kind: 'operation',
    source: 'native-checkpoint-test',
    locator: `records/${label}`,
    scope,
  };
}

function checkpoint(seq: number, previousCheckpointId: Checkpoint['previousCheckpointId']): Checkpoint {
  return {
    id: id('checkpoint', `native-checkpoint-${seq}`),
    scope,
    cycleId: cycle,
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch: 4,
    outcome: 'succeeded',
    summary: `native checkpoint ${seq}`,
    recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`completion-${seq}`)],
    next: { kind: 'continue', ref: `next-${seq}` },
  };
}

function authority(
  value = committedAt,
  samples = { count: 0 },
  authorityRef = 'native-checkpoint-authority',
): CheckpointTimeAuthority {
  return {
    source: 'harness',
    owner: 'runtime-checkpoint-control-owner',
    authorityRef,
    sampleCommittedAt: async () => {
      samples.count += 1;
      return value;
    },
  };
}

function commitInput(
  candidate: Checkpoint,
  timeAuthority: CheckpointTimeAuthority,
  previous: Checkpoint | null,
) {
  return {
    ownerId: 'runtime-checkpoint-owner',
    context: {
      scope,
      cycleId: cycle,
      executionEpoch: candidate.executionEpoch,
      directiveRevision: candidate.directiveRevision,
    },
    previous,
    checkpoint: candidate,
    timeAuthority,
  };
}

const coldReadCode = [
  "const [url, file, checkpointJson] = process.argv.slice(1);",
  "const { createJsonlCheckpointJournal } = await import(url);",
  "const journal = createJsonlCheckpointJournal({ filePath: file });",
  "const relationship = await journal.readNativeCheckpoint({ checkpoint: JSON.parse(checkpointJson) });",
  "process.stdout.write(JSON.stringify(relationship));",
].join('\n');

async function coldRead(
  filePath: string,
  checkpointIdentity: Pick<Checkpoint, 'id' | 'scope'>,
): Promise<CheckpointReceiptRelationshipV1 | null> {
  const appModuleUrl = new URL('../../packages/app/src/index.js', import.meta.url).href;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      coldReadCode,
      appModuleUrl,
      filePath,
      JSON.stringify({ id: checkpointIdentity.id, scope: checkpointIdentity.scope }),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `cold reader exited with ${code ?? 'unknown status'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as CheckpointReceiptRelationshipV1 | null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('native checkpoint commit returns the persisted relationship and exact cold read finds it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-native-checkpoint-public-'));
  const filePath = join(root, 'organ.jsonl');
  try {
    const journal = new JsonlOrganJournal(filePath);
    const seed = await journal.append({ kind: 'event', scope, payload: { seed: true } });
    const first = checkpoint(1, null);
    const firstRelationship = await completeNativeCheckpoint(
      createJsonlCheckpointJournal({ filePath }),
      commitInput(first, authority(), null),
    );

    const identity = await checkpointCommitIdentityV2({ checkpoint: first });
    assert.equal(firstRelationship.checkpointSeq, 1);
    assert.equal(firstRelationship.journalSeq, seed.seq + 1);
    assert.equal(firstRelationship.envelope.identity, identity);
    assert.equal(firstRelationship.receipt.commitIdentity, identity);
    assert.equal(firstRelationship.receipt.checkpointRef, checkpointRefV2(identity));
    assert.match(firstRelationship.recordDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(firstRelationship.envelope.committedAt, committedAt);
    assert.match(
      firstRelationship.receipt.journalReceiptRef,
      /^humanagent:\/\/journal-record\/v1\/[0-9a-f]{64}\/2\/[0-9a-f]{64}$/,
    );

    const records = await journal.replay();
    const nativeRecords = records.filter((record) =>
      record.kind === 'checkpoint' && record.nativeCheckpointEnvelope?.identity === identity);
    assert.equal(nativeRecords.length, 1);
    assert.equal(nativeRecords[0]?.recordDigest, firstRelationship.recordDigest);

    const second = checkpoint(2, first.id);
    const secondRelationship = await completeNativeCheckpoint(
      createJsonlCheckpointJournal({ filePath }),
      commitInput(second, authority('2026-10-12T04:11:00.000Z'), first),
    );
    assert.equal(secondRelationship.checkpointSeq, 2);
    assert.equal(secondRelationship.journalSeq, seed.seq + 2);

    assert.deepEqual(await coldRead(filePath, first), firstRelationship);
    assert.equal(
      await createJsonlCheckpointJournal({ filePath }).readNativeCheckpoint({
        checkpoint: { id: id('checkpoint', 'never-committed'), scope },
      }),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native checkpoint commit reuses the same intent and rejects a conflicting intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-native-checkpoint-idempotent-'));
  const filePath = join(root, 'organ.jsonl');
  try {
    const samples = { count: 0 };
    const first = checkpoint(1, null);
    const timeAuthority = authority(committedAt, samples);
    const firstRelationship = await completeNativeCheckpoint(
      createJsonlCheckpointJournal({ filePath }),
      commitInput(first, timeAuthority, null),
    );

    const retry = await completeNativeCheckpoint(
      createJsonlCheckpointJournal({ filePath }),
      commitInput(first, timeAuthority, null),
    );
    assert.deepEqual(retry, firstRelationship);
    assert.equal(samples.count, 1);
    assert.equal((await new JsonlOrganJournal(filePath).replay()).length, 1);

    await assert.rejects(
      () => completeNativeCheckpoint(
        createJsonlCheckpointJournal({ filePath }),
        commitInput({ ...first, summary: 'conflicting native checkpoint' }, timeAuthority, null),
      ),
      /different intent/,
    );
    await assert.rejects(
      () => completeNativeCheckpoint(
        createJsonlCheckpointJournal({ filePath }),
        commitInput(first, authority(committedAt, { count: 0 }, 'different-authority'), null),
      ),
      /different intent/,
    );
    assert.equal((await new JsonlOrganJournal(filePath).replay()).length, 1);

    const competingSamples = { count: 0 };
    const second = checkpoint(2, first.id);
    const competingAuthority = authority('2026-10-12T04:12:00.000Z', competingSamples);
    const [left, right] = await Promise.all([
      completeNativeCheckpoint(
        createJsonlCheckpointJournal({ filePath }),
        commitInput(second, competingAuthority, first),
      ),
      completeNativeCheckpoint(
        createJsonlCheckpointJournal({ filePath }),
        commitInput(second, competingAuthority, first),
      ),
    ]);
    assert.deepEqual(left, right);
    assert.equal(competingSamples.count, 1);
    assert.equal((await new JsonlOrganJournal(filePath).replay()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native checkpoint read and write failures remain explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-native-checkpoint-failure-'));
  try {
    const missingFile = join(root, 'missing', 'organ.jsonl');
    assert.equal(
      await createJsonlCheckpointJournal({ filePath: missingFile }).readNativeCheckpoint({
        checkpoint: { id: id('checkpoint', 'native-checkpoint-missing'), scope },
      }),
      null,
    );

    const corruptFile = join(root, 'corrupt', 'organ.jsonl');
    const corruptJournal = new JsonlOrganJournal(corruptFile);
    const corruptCheckpoint = checkpoint(1, null);
    await completeNativeCheckpoint(
      createJsonlCheckpointJournal({ filePath: corruptFile }),
      commitInput(corruptCheckpoint, authority(), null),
    );
    const raw = await readFile(corruptFile, 'utf8');
    const corrupted = JSON.parse(raw.trim()) as Record<string, unknown>;
    corrupted.checkpoint = {
      ...(corrupted.checkpoint as Record<string, unknown>),
      summary: 'corrupted native checkpoint bytes',
    };
    await writeFile(corruptFile, `${JSON.stringify(corrupted)}\n`, 'utf8');
    await assert.rejects(
      () => createJsonlCheckpointJournal({ filePath: corruptFile }).readNativeCheckpoint({
        checkpoint: corruptCheckpoint,
      }),
      /journal record digest mismatch|checkpoint journal is invalid/,
    );
    assert.equal((await corruptJournal.verify()).valid, false);

    const legacyFile = join(root, 'legacy', 'organ.jsonl');
    const legacyCheckpoint = checkpoint(1, null);
    await createJsonlCheckpointJournal({ filePath: legacyFile }).append({
      ownerId: 'legacy-owner',
      commitId: 'legacy-checkpoint-commit',
      checkpoint: legacyCheckpoint,
    });
    await assert.rejects(
      () => createJsonlCheckpointJournal({ filePath: legacyFile }).commitNativeCheckpoint({
        ownerId: 'runtime-checkpoint-owner',
        checkpoint: legacyCheckpoint,
        timeAuthority: authority(),
      }),
      /legacy checkpoint record occupies native identity/,
    );
    await assert.rejects(
      () => createJsonlCheckpointJournal({ filePath: legacyFile }).readNativeCheckpoint({
        checkpoint: legacyCheckpoint,
      }),
      /checkpoint record has no native envelope/,
    );
    assert.equal((await new JsonlOrganJournal(legacyFile).replay()).length, 1);

    const blockedFile = join(root, 'blocked', 'organ.jsonl');
    await mkdir(blockedFile, { recursive: true });
    await assert.rejects(
      () => completeNativeCheckpoint(
        createJsonlCheckpointJournal({ filePath: blockedFile }),
        commitInput(checkpoint(1, null), authority(), null),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
