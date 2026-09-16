import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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
