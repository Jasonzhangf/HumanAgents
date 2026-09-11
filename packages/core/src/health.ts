import type { EvidenceRef, HealthState, OrganHealthSnapshot } from '../../contracts/src/index.js';
import { assertNotExpired } from '../../contracts/src/index.js';
import { HealthError } from './errors.js';

export type HealthFunctionStatus = OrganHealthSnapshot['functions'][number]['status'];
export type HealthDimension =
  | 'liveness'
  | 'readiness'
  | 'correctness'
  | 'continuity'
  | 'capacity'
  | 'dependency';

export interface HealthFunctionInput {
  readonly functionId: string;
  readonly dimension: HealthDimension;
  readonly status: HealthFunctionStatus;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly measurements?: OrganHealthSnapshot['functions'][number]['measurements'];
}

export interface HealthClassificationInput {
  readonly functions: readonly HealthFunctionInput[];
  readonly requiresAttention?: boolean;
}

export interface HealthPublisher {
  readonly actorKind: 'harness-health-manager' | 'agent' | 'plugin' | 'ui';
  readonly source: 'harness' | 'agent' | 'plugin' | 'payload';
}

const HEALTH_DIMENSIONS: readonly HealthDimension[] = [
  'liveness',
  'readiness',
  'correctness',
  'continuity',
  'capacity',
  'dependency',
];

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new HealthError(`${label} is required`);
}

export function assertHarnessHealthPublisher(publisher: HealthPublisher): void {
  if (publisher.actorKind !== 'harness-health-manager' || publisher.source !== 'harness') {
    throw new HealthError('only the Harness health manager may publish health truth');
  }
}

export function classifyHealth(input: HealthClassificationInput): HealthState {
  if (input.functions.length === 0) throw new HealthError('at least one health function is required');
  for (const fn of input.functions) {
    nonEmpty(fn.functionId, 'health function id');
    if (!HEALTH_DIMENSIONS.includes(fn.dimension)) throw new HealthError(`unknown health dimension: ${fn.dimension}`);
    if (fn.evidenceRefs.length === 0) throw new HealthError('health function evidence is required');
    for (const evidence of fn.evidenceRefs) {
      nonEmpty(evidence.source, 'health evidence source');
      nonEmpty(evidence.locator, 'health evidence locator');
    }
  }
  if (input.requiresAttention) return 'attention';
  if (input.functions.some((fn) => fn.status === 'failed')) return 'unhealthy';
  if (input.functions.some((fn) => fn.status === 'degraded')) return 'degraded';
  if (input.functions.some((fn) => fn.status === 'unknown')) return 'unknown';
  return 'healthy';
}

export function classifyHealthSnapshot(input: {
  readonly snapshot: OrganHealthSnapshot;
  readonly now?: Date;
}): HealthState {
  try {
    assertNotExpired(input.snapshot.expiresAt, input.now);
  } catch {
    return 'unknown';
  }
  return classifyHealth({
    functions: input.snapshot.functions.map((fn) => ({
      ...fn,
      dimension: 'liveness',
    })),
  });
}

export function assertHealthSnapshotOwnership(snapshot: OrganHealthSnapshot, publisher: HealthPublisher): void {
  assertHarnessHealthPublisher(publisher);
  if (!snapshot.organId.value) throw new HealthError('snapshot organ id is required');
  const checkedAt = Date.parse(snapshot.checkedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(checkedAt)) throw new HealthError('checkedAt must be a valid timestamp');
  if (!Number.isFinite(expiresAt) || expiresAt <= checkedAt) throw new HealthError('expiresAt must be later than checkedAt');
  if (snapshot.functions.length === 0) throw new HealthError('health snapshot requires function results');
  const classified = classifyHealthSnapshot({ snapshot });
  if (snapshot.overall !== classified) throw new HealthError('snapshot overall does not match classified health');
}
