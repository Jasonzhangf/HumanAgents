import type {
  AnyProviderExecutionIdentityRef,
  BusinessPayload,
  ProviderExecutionIdentityRef,
  ProviderRequestIdentityRef,
  ProviderToolStatus,
} from './index.js';

/**
 * Provider request-context boundary.
 *
 * The Runtime materializer (D-M) turns accepted current-turn facts and exact
 * semantic history into the named units below. The Provider driver and codecs
 * consume those units per protocol. The shape is deliberately narrow: it
 * carries the canonical business content of exactly one request. Transient
 * orientation is separate, and control, identity, grant, save and segment
 * facts never live here.
 */

/** One canonical conversational message. */
export interface ProviderRequestContextMessageUnit {
  readonly kind: 'message';
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** One accepted tool call, bound to its real call identity. */
export interface ProviderRequestContextToolCallUnit {
  readonly kind: 'tool-call';
  readonly callId: string;
  readonly toolId: string;
  readonly arguments: BusinessPayload;
}

/** One accepted tool result, paired to its call by `callId`. */
export interface ProviderRequestContextToolResultUnit {
  readonly kind: 'tool-result';
  readonly callId: string;
  readonly toolId: string;
  readonly output: string;
  readonly status: ProviderToolStatus;
}

export type ProviderRequestContextUnit =
  | ProviderRequestContextMessageUnit
  | ProviderRequestContextToolCallUnit
  | ProviderRequestContextToolResultUnit;

/** The canonical context of exactly one provider request. */
export interface ProviderRequestContext {
  readonly units: readonly ProviderRequestContextUnit[];
}

/**
 * Transient request-scoped orientation. It enters exactly the current request
 * and is never part of the canonical context or the next request.
 */
export interface RequestScopedInstructions {
  readonly text: string;
}

/** The Runtime materializer output consumed by one provider request. */
export interface MaterializedRequestInput {
  readonly canonical: ProviderRequestContext;
  readonly instructions?: RequestScopedInstructions;
}

/** Which provider request boundary the hook is materializing. */
export type ProviderRequestContextPhase = 'initial' | 'continuation';

export interface ProviderRequestContextHookInput<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly execution: TIdentity;
  readonly request: ProviderRequestIdentityRef;
  readonly phase: ProviderRequestContextPhase;
}

/**
 * Fresh materialization hook. The driver awaits it before the initial request
 * and before every tool continuation, after durable request registration and
 * before the external side effect. A hook failure stops the request.
 */
export type ProviderRequestContextHook<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = (
  input: ProviderRequestContextHookInput<TIdentity>,
) => Promise<MaterializedRequestInput>;
