import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type EvidenceRef, type ProviderReadiness } from '../../../packages/contracts/src/index.js';
import {
  OrganHealthError,
  OrganHealthManager,
} from '../../../packages/runtime/src/health/index.js';

const organId = id('organ', 'health-test');
const scope = { organId };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label.replace(/[^A-Za-z0-9._-]/gu, '-')}`),
    kind: 'external',
    source: 'health-test',
    locator: label,
    scope,
  };
}

function readiness(input: {
  readonly state: ProviderReadiness['state'];
  readonly checkedAt: string;
  readonly expiresAt: string;
}): ProviderReadiness {
  return {
    bindingId: 'binding-health-test',
    providerId: 'provider-health-test',
    protocol: 'responses',
    state: input.state,
    capabilityDigest: 'sha256:health-test',
    version: 'health-test-1',
    checkedAt: input.checkedAt,
    expiresAt: input.expiresAt,
    evidenceRefs: [evidence(`${input.state}-${input.checkedAt}`)],
  };
}

test('organ health manager owns probe results and snapshot reads without re-probing', async () => {
  let probeCount = 0;
  let current = new Date('2026-09-18T12:00:00.000Z');
  const manager = new OrganHealthManager({
    organId,
    probe: {
      probe: async () => {
        probeCount += 1;
        return readiness({
          state: 'ready',
          checkedAt: current.toISOString(),
          expiresAt: new Date(current.getTime() + 60_000).toISOString(),
        });
      },
    },
    now: () => current,
  });

  const probed = await manager.probe();
  assert.equal(probed.overall, 'healthy');
  assert.equal(probeCount, 1);

  current = new Date('2026-09-18T12:00:30.000Z');
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.overall, 'healthy');
  assert.equal(probeCount, 1);

  current = new Date('2026-09-18T12:02:00.000Z');
  const expired = await manager.snapshot();
  assert.equal(expired.overall, 'unknown');
  assert.equal(expired.functions[0]?.status, 'unknown');
  assert.equal(probeCount, 1);
});

test('organ health manager compares timestamp instants instead of timestamp strings', async () => {
  const manager = new OrganHealthManager({
    organId,
    probe: {
      probe: async () => readiness({
        state: 'ready',
        checkedAt: '2026-09-18T08:59:00.000Z',
        expiresAt: '2026-09-18T10:00:40.000+01:00',
      }),
    },
    now: () => new Date('2026-09-18T10:00:30.000Z'),
  });

  const snapshot = await manager.probe();
  assert.equal(snapshot.overall, 'unknown');
  assert.equal(snapshot.functions[0]?.status, 'unknown');
});

test('organ health manager reports missing snapshot explicitly', async () => {
  const manager = new OrganHealthManager({
    organId,
    probe: {
      probe: async () => readiness({
        state: 'ready',
        checkedAt: '2026-09-18T12:00:00.000Z',
        expiresAt: '2026-09-18T12:01:00.000Z',
      }),
    },
  });

  await assert.rejects(
    () => manager.snapshot(),
    (error: unknown) => error instanceof OrganHealthError
      && error.code === 'health-snapshot-missing'
      && error.ownerId === 'humanagent.runtime.health',
  );
});

test('organ health manager classifies unavailable provider readiness through core policy', async () => {
  const manager = new OrganHealthManager({
    organId,
    probe: {
      probe: async () => readiness({
        state: 'dependency-missing',
        checkedAt: '2026-09-18T12:00:00.000Z',
        expiresAt: '2026-09-18T12:01:00.000Z',
      }),
    },
    now: () => new Date('2026-09-18T12:00:30.000Z'),
  });

  const snapshot = await manager.probe();
  assert.equal(snapshot.overall, 'unhealthy');
  assert.equal(snapshot.functions[0]?.status, 'failed');
});
