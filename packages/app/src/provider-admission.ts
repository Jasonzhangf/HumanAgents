import type { ProviderReadiness } from '../../contracts/src/index.js';
import type { ProviderTransportSource } from '../../adapters/provider/src/index.js';

/**
 * App-owned provider request admission: may this configured source start a
 * Provider request given its actual bound readiness? This is Provider
 * requestability only. It is not permission, business completion, or a
 * substitute for the mandatory task grant, budget, identity and lease checks
 * that callers still perform.
 *
 * `ready`/`degraded` keep the existing admission behavior. A direct HTTP source
 * has no discovery contract, so its real probe returns `unknown` with the typed
 * `continue -> http.start` next action; that expected uncertainty is requestable
 * while the state stays `unknown`. Any other `unknown` or non-ready state is not.
 *
 * The decision reads only the typed source and readiness. It never derives
 * admission from health text, endpoint strings, logs or metadata.
 */
export function canStartProviderRequest(source: ProviderTransportSource, readiness: ProviderReadiness): boolean {
  if (readiness.state === 'ready' || readiness.state === 'degraded') return true;
  return source === 'http'
    && readiness.state === 'unknown'
    && readiness.nextAction?.kind === 'continue'
    && readiness.nextAction.ref === 'http.start';
}
