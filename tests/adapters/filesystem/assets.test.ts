import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ScopeRef } from '@humanagent/contracts';
import { AssetIntegrityError, ImmutableAssetStore, assertAssetEvidenceBinding, evidenceReference } from '../../../packages/adapters/filesystem/src/index.js';

const organ = id('organ', 'organ-a'); const task = id('task', 'task-a'); const scope: ScopeRef = { organId: organ, taskId: task };

test('writes immutable assets and validates references', async () => { const store = new ImmutableAssetStore(await mkdtemp(join(tmpdir(), 'humanagent-assets-'))); const reference = await store.write('artifact-a', new TextEncoder().encode('hello')); assert.deepEqual(await store.read(reference), new TextEncoder().encode('hello')); await assert.rejects(() => store.write('artifact-a', new TextEncoder().encode('changed')), AssetIntegrityError); await assert.rejects(() => store.read({ ...reference, digest: 'sha256:wrong' }), AssetIntegrityError); await assert.rejects(() => store.write('../escape', new Uint8Array()), AssetIntegrityError); });
test('binds evidence references and rejects digest mismatch', async () => { const store = new ImmutableAssetStore(await mkdtemp(join(tmpdir(), 'humanagent-evidence-'))); const reference = await store.write('work-result-a', new TextEncoder().encode('result')); const evidence = evidenceReference(reference, scope, 'tool'); assert.doesNotThrow(() => assertAssetEvidenceBinding(reference, evidence)); assert.deepEqual(await store.readEvidence(evidence), new TextEncoder().encode('result')); assert.throws(() => assertAssetEvidenceBinding({ ...reference, digest: 'sha256:wrong' }, evidence), AssetIntegrityError); await assert.rejects(() => store.readEvidence({ ...evidence, digest: 'sha256:wrong' }), AssetIntegrityError); });
