import type { AgentProviderComposition } from './agent-driver-composition.js';
import { assertProviderReadinessBinding, type ProviderReadiness } from '../../contracts/src/index.js';
import type { AnyProviderExecutionIdentityRef, ProviderExecutionIdentityRef } from '../../contracts/src/index.js';
import { canStartProviderRequest } from './provider-admission.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.agent-provider-admission';

/**
 * Admits the selected agent provider from its actual composed readiness. The
 * selected composition is the only binding probed; the shared/default
 * readiness is never substituted. The existing request-start predicate decides
 * from the typed source and that same readiness, and successful admission
 * returns the readiness unchanged without a second control store or grant.
 */
export async function admitAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(
  composition: AgentProviderComposition<TIdentity>,
): Promise<ProviderReadiness> {
  const readiness = await composition.port.probe(composition.binding);
  assertProviderReadinessBinding(readiness, composition.binding);
  const requestable = canStartProviderRequest(composition.source, readiness);
  if (requestable) return readiness;
  const failure = readiness.failure;
  throw new AppLifecycleError(
    'provider-request-rejected',
    failure ? failure.message : `provider ${composition.binding.bindingId} is not requestable from ${composition.source}`,
    failure?.nextAction?.ref ?? readiness.nextAction?.ref ?? 'inspect provider readiness evidence',
    failure?.ownerId ?? readiness.ownerId ?? OWNER,
    failure,
  );
}
