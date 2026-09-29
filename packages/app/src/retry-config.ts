import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../../config/src/index.js';
import type {
  RetryCycleCandidateProvider,
  RetryCycleConfigSet,
} from '../../runtime/src/orchestration/retry-cycle.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.retry-config';

function bindingId(index: number, candidate: ProviderConfig): string {
  return `${candidate.binding}:${index}`;
}

export function providerRetryConfigFromEffective(
  input: {
    readonly effective: {
      readonly provider?: ProviderConfig;
      readonly execution?: {
        readonly providerRetry?: {
          readonly candidates: readonly ProviderConfig[];
        };
      };
    };
  },
): RetryCycleConfigSet | undefined {
  const candidatesConfig = input.effective.execution?.providerRetry?.candidates;
  if (candidatesConfig === undefined || candidatesConfig.length === 0) return undefined;
  const primary = input.effective.provider;
  const candidates: RetryCycleCandidateProvider[] = candidatesConfig.map((candidate, index) => {
    const binding = {
      bindingId: bindingId(index, candidate),
      providerId: candidate.provider,
      protocol: candidate.protocol,
      endpointRef: `rcc-v3:${candidate.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`,
      modelRef: candidate.model,
      configDigest: `sha256:${candidate.binding}:${candidate.baseUrl}:${candidate.protocol}:${candidate.model}`,
      capabilityDigest: primary === undefined
        ? `sha256:${candidate.provider}:capability`
        : `sha256:${primary.provider}:capability:${primary.route}`,
    };
    return {
      binding,
      admission: {
        permissionRevision: `config:${candidate.route}`,
        capabilityDigest: binding.capabilityDigest,
        readinessRef: `readiness:${binding.bindingId}`,
        leaseRef: `lease:${binding.bindingId}`,
        checkpointRef: `checkpoint:${binding.bindingId}`,
      },
    };
  });
  if (candidates.length === 0) {
    throw new AppLifecycleError(
      'retry-candidates-empty',
      'provider retry requires at least one explicit candidate binding',
      'configure execution.providerRetry.candidates with at least one RCC provider binding',
      OWNER,
    );
  }
  const configDigest = `sha256:${createHash('sha256').update(candidates.map((candidate) => candidate.binding.bindingId).join('|')).digest('hex')}`;
  return {
    configRevision: 'execution.providerRetry',
    configDigest,
    candidates,
  };
}
