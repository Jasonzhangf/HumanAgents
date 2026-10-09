import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ScopeRef } from '@humanagent/contracts';
import { AssetIntegrityError, ImmutableAssetStore, assertAssetEvidenceBinding, evidenceReference } from '../../../packages/adapters/filesystem/src/index.js';

const organ = id('organ', 'organ-a'); const task = id('task', 'task-a'); const scope: ScopeRef = { organId: organ, taskId: task };

test('writes immutable assets and validates references', async () => { const store = new ImmutableAssetStore(await mkdtemp(join(tmpdir(), 'humanagent-assets-'))); const reference = await store.write('artifact-a', new TextEncoder().encode('hello')); assert.deepEqual(await store.read(reference), new TextEncoder().encode('hello')); await assert.rejects(() => store.write('artifact-a', new TextEncoder().encode('changed')), AssetIntegrityError); await assert.rejects(() => store.read({ ...reference, digest: 'sha256:wrong' }), AssetIntegrityError); await assert.rejects(() => store.write('../escape', new Uint8Array()), AssetIntegrityError); });
test('binds evidence references and rejects digest mismatch', async () => { const store = new ImmutableAssetStore(await mkdtemp(join(tmpdir(), 'humanagent-evidence-'))); const reference = await store.write('work-result-a', new TextEncoder().encode('result')); const evidence = evidenceReference(reference, scope, 'tool'); assert.doesNotThrow(() => assertAssetEvidenceBinding(reference, evidence)); assert.deepEqual(await store.readEvidence(evidence), new TextEncoder().encode('result')); assert.throws(() => assertAssetEvidenceBinding({ ...reference, digest: 'sha256:wrong' }, evidence), AssetIntegrityError); await assert.rejects(() => store.readEvidence({ ...evidence, digest: 'sha256:wrong' }), AssetIntegrityError); });
test('recover removes provably orphaned temp files and retains live or unknown temp files', async () => { const dir = await mkdtemp(join(tmpdir(), 'humanagent-assets-recover-')); const store = new ImmutableAssetStore(dir); const reference = await store.write('keep.tmp-123', new TextEncoder().encode('keep')); await mkdir(join(dir, '.tmp'), { recursive: true }); const orphan = join(dir, '.tmp', 'orphan.999999999.abc.def.tmp'); const active = join(dir, '.tmp', `concurrent.${process.pid}.abc.def.tmp`); const unknown = join(dir, '.tmp', 'unknown.tmp'); await writeFile(orphan, new TextEncoder().encode('bad')); await writeFile(active, new TextEncoder().encode('live')); await writeFile(unknown, new TextEncoder().encode('unknown')); await writeFile(join(dir, 'root.tmp-456'), new TextEncoder().encode('retained')); await store.recover(); assert.deepEqual(await store.read(reference), new TextEncoder().encode('keep')); assert.equal((await readFile(join(dir, 'root.tmp-456'))).toString(), 'retained'); assert.equal((await readFile(active)).toString(), 'live'); assert.equal((await readFile(unknown)).toString(), 'unknown'); assert.deepEqual((await readdir(dir, { withFileTypes: true })).map((entry) => entry.name).sort(), ['.tmp', 'keep.tmp-123', 'root.tmp-456']); await assert.rejects(() => readFile(orphan), { code: 'ENOENT' }); });
test('recover does not delete the temp file of an active concurrent write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-assets-concurrent-recover-'));
  const store = new ImmutableAssetStore(dir);
  const payload = new Uint8Array(128 * 1024 * 1024);
  payload.fill(7);
  const writing = store.write('concurrent-write', payload);
  let tempName: string | undefined;
  for (let attempt = 0; attempt < 1_000 && tempName === undefined; attempt++) {
    const entries = await readdir(join(dir, '.tmp'), { withFileTypes: true }).catch(() => []);
    tempName = entries.find((entry) => entry.name.endsWith('.tmp'))?.name;
    if (tempName === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(tempName);
  await store.recover();
  assert.equal((await readdir(join(dir, '.tmp'), { withFileTypes: true })).some((entry) => entry.name === tempName), true);
  const reference = await writing;
  assert.deepEqual(await store.read(reference), payload);
});

test('recover rejects ENOTDIR when .tmp is a file and leaves it unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-assets-recover-enotdir-'));
  const store = new ImmutableAssetStore(dir);
  const tmpPath = join(dir, '.tmp');
  const original = new TextEncoder().encode('preserve this non-directory entry');
  try {
    await writeFile(tmpPath, original);
    await assert.rejects(() => store.recover(), (error: unknown) => (error as { code?: string }).code === 'ENOTDIR');
    assert.deepEqual(Uint8Array.from(await readFile(tmpPath)), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recover accepts a missing .tmp directory without recreating it or changing existing assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-assets-recover-missing-tmp-'));
  const store = new ImmutableAssetStore(dir);
  const bytes = new TextEncoder().encode('existing asset stays intact');
  try {
    const reference = await store.write('existing-asset', bytes);
    await rm(join(dir, '.tmp'), { recursive: true, force: true });
    await store.recover();
    assert.deepEqual(await store.read(reference), bytes);
    await assert.rejects(() => readdir(join(dir, '.tmp'), { withFileTypes: true }), (error: unknown) => (error as { code?: string }).code === 'ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recover rejects ENOENT when the asset store root is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-assets-recover-missing-root-'));
  const store = new ImmutableAssetStore(dir);
  try {
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(() => store.recover(), (error: unknown) => (error as { code?: string }).code === 'ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('asset publication failure is visible and retry preserves committed assets', async () => {
  const fixtureParent = '/Users/fanzhang/.humanagent/test-fixtures/native-reasoning-f1-j-i1/';
  await mkdir(fixtureParent, { recursive: true });
  const fixture = await mkdtemp(join(fixtureParent, 'asset-publication-'));
  const assetRoot = join(fixture, 'assets');
  const keepId = 'keep-asset';
  const blockedId = 'blocked-asset';
  const keepBytes = new TextEncoder().encode('previously committed asset');
  const blockedBytes = new TextEncoder().encode('retry this asset after unblocking');
  const sentinelBytes = new TextEncoder().encode('preserve publication blocker');
  const digestOf = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let cleanupResult = 'pending';
  try {
    const initialStore = new ImmutableAssetStore(assetRoot);
    const keepReference = await initialStore.write(keepId, keepBytes);
    const keepDigest = keepReference.digest;
    assert.equal(keepDigest, digestOf(keepBytes));

    const blockedLocator = join(assetRoot, blockedId);
    const sentinelPath = join(blockedLocator, 'sentinel.txt');
    await mkdir(blockedLocator, { recursive: true });
    await writeFile(sentinelPath, sentinelBytes);

    let returnedReference: Awaited<ReturnType<ImmutableAssetStore['write']>> | undefined;
    await assert.rejects(
      async () => { returnedReference = await initialStore.write(blockedId, blockedBytes); },
      (error: unknown) => (error as { code?: string }).code === 'EISDIR',
      'blocked publication must reject visibly with EISDIR',
    );
    assert.equal(returnedReference, undefined, 'failed write must not return an AssetReference');
    assert.deepEqual((await readdir(blockedLocator, { withFileTypes: true })).map((entry) => entry.name), ['sentinel.txt']);
    assert.deepEqual(Uint8Array.from(await readFile(sentinelPath)), sentinelBytes);
    assert.deepEqual(await initialStore.read(keepReference), keepBytes);
    assert.equal(keepReference.digest, keepDigest);
    assert.equal(digestOf(await initialStore.read(keepReference)), keepDigest);
    assert.deepEqual(await readdir(join(assetRoot, '.tmp'), { withFileTypes: true }), []);

    await new ImmutableAssetStore(assetRoot).recover();
    assert.deepEqual((await readdir(blockedLocator, { withFileTypes: true })).map((entry) => entry.name), ['sentinel.txt']);
    assert.deepEqual(Uint8Array.from(await readFile(sentinelPath)), sentinelBytes);
    assert.deepEqual(await new ImmutableAssetStore(assetRoot).read(keepReference), keepBytes);
    assert.equal(digestOf(await new ImmutableAssetStore(assetRoot).read(keepReference)), keepDigest);
    assert.deepEqual(await readdir(join(assetRoot, '.tmp'), { withFileTypes: true }), []);

    await rm(blockedLocator, { recursive: true });
    const retryStore = new ImmutableAssetStore(assetRoot);
    const retryReference = await retryStore.write(blockedId, blockedBytes);
    const retryDigest = digestOf(blockedBytes);
    assert.deepEqual(retryReference, {
      assetId: blockedId,
      digest: retryDigest,
      locator: blockedLocator,
      size: blockedBytes.length,
    });
    assert.deepEqual(await retryStore.read(retryReference), blockedBytes);
    const evidence = evidenceReference(retryReference, scope, 'tool');
    assert.equal(evidence.digest, retryDigest);
    assert.deepEqual(await retryStore.readEvidence(evidence), blockedBytes);
    assert.deepEqual(await retryStore.write(blockedId, blockedBytes), retryReference);
    assert.deepEqual(await retryStore.read(retryReference), blockedBytes);
    assert.deepEqual(await retryStore.read(keepReference), keepBytes);
    assert.deepEqual(await readdir(join(assetRoot, '.tmp'), { withFileTypes: true }), []);
    console.log(JSON.stringify({ fixture, failure: 'EISDIR', returnedReference: false, blockerPreserved: true, keepAssetDigest: keepDigest, recoveryPreserved: true, retryDigest, readAndEvidenceMatch: true, repeatedWriteStable: true, temporaryEntries: [] }));
  } finally {
    await rm(fixture, { recursive: true, force: true });
    cleanupResult = 'removed';
    console.log(JSON.stringify({ fixture, cleanup: cleanupResult }));
  }
});
