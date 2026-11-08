import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProviderToolOutputStore } from '../../packages/app/src/provider-tool-execution.js';

test('provider-tool-output asset id keeps digest suffix distinct for long output ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r3-child-output-asset-'));
  try {
    const store = createProviderToolOutputStore(join(root, 'artifacts'));

    const common = 'a'.repeat(100);
    const outputId1 = `${common}0`;
    const outputId2 = `${common}1`;
    const report1 = { kind: 'provider-tool-report', sequence: 0 };
    const report2 = { kind: 'provider-tool-report', sequence: 1 };

    const first = await store.writeReport({ outputId: outputId1, report: report1 });
    const second = await store.writeReport({ outputId: outputId2, report: report2 });

    const firstRead = await store.readReport({
      outputRef: first.outputRef,
      outputDigest: first.outputDigest,
    });
    assert.deepEqual(firstRead, report1);

    const secondRead = await store.readReport({
      outputRef: second.outputRef,
      outputDigest: second.outputDigest,
    });
    assert.deepEqual(secondRead, report2);
    assert.equal(JSON.stringify(firstRead) !== JSON.stringify(secondRead), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
