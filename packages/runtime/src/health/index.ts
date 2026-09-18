import {
  assertNotExpired,
  type EvidenceRef,
  type OrganHealthSnapshot,
  type OrganId,
  type ProviderReadiness,
} from '../../../contracts/src/index.js';
import {
  assertHealthSnapshotOwnership,
  classifyHealth,
  classifyHealthSnapshot,
} from '../../../core/src/health.js';

const OWNER_ID = 'humanagent.runtime.health';

export interface OrganHealthProbePort {
  probe(): Promise<ProviderReadiness>;
}

export interface OrganHealthManagerOptions {
  readonly organId: OrganId;
  readonly probe: OrganHealthProbePort;
  readonly now?: () => Date;
}

export class OrganHealthManager {
  private snapshotValue?: OrganHealthSnapshot;

  constructor(private readonly options: OrganHealthManagerOptions) {}

  async probe(): Promise<OrganHealthSnapshot> {
    const readiness = await this.options.probe.probe();
    const snapshot = this.fromReadiness(readiness);
    this.snapshotValue = snapshot;
    return structuredClone(snapshot);
  }

  async snapshot(): Promise<OrganHealthSnapshot> {
    const snapshot = this.snapshotValue;
    if (!snapshot) {
      throw new OrganHealthError(
        'health-snapshot-missing',
        'health snapshot has not been produced by a probe',
        'run a health probe before requesting the snapshot',
        OWNER_ID,
      );
    }
    return structuredClone({
      ...snapshot,
      overall: classifyHealthSnapshot({ snapshot, now: this.now() }),
    });
  }

  private fromReadiness(readiness: ProviderReadiness): OrganHealthSnapshot {
    const status = readinessExpired(readiness, this.now())
      ? 'unknown'
      : readinessStatus(readiness.state);
    const overall = classifyHealth({
      functions: [{
        functionId: `provider:${readiness.providerId}:${readiness.bindingId}`,
        dimension: 'readiness',
        status,
        evidenceRefs: readiness.evidenceRefs,
        measurements: [
          { name: 'providerState', value: readiness.state },
          ...(readiness.version ? [{ name: 'providerVersion', value: readiness.version }] : []),
        ],
      }],
    });
    const snapshot: OrganHealthSnapshot = {
      organId: this.options.organId,
      checkedAt: readiness.checkedAt,
      expiresAt: readiness.expiresAt,
      overall,
      functions: [{
        functionId: `provider:${readiness.providerId}:${readiness.bindingId}`,
        status,
        measurements: [
          { name: 'providerState', value: readiness.state },
          ...(readiness.version ? [{ name: 'providerVersion', value: readiness.version }] : []),
        ],
        evidenceRefs: readiness.evidenceRefs,
      }],
    };
    assertHealthSnapshotOwnership(snapshot, {
      actorKind: 'harness-health-manager',
      source: 'harness',
    }, this.now());
    return snapshot;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class OrganHealthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
    readonly ownerId = OWNER_ID,
  ) {
    super(message);
    this.name = 'OrganHealthError';
  }
}

function readinessStatus(state: ProviderReadiness['state']): OrganHealthSnapshot['functions'][number]['status'] {
  switch (state) {
    case 'ready':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'unknown':
      return 'unknown';
    case 'not-ready':
    case 'capability-unavailable':
    case 'dependency-missing':
      return 'failed';
  }
}

function readinessExpired(readiness: ProviderReadiness, now: Date): boolean {
  try {
    assertNotExpired(readiness.expiresAt, now);
    return false;
  } catch {
    return true;
  }
}

export function healthEvidenceRefs(snapshot: OrganHealthSnapshot): readonly EvidenceRef[] {
  return snapshot.functions.flatMap((fn) => fn.evidenceRefs);
}
