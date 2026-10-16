import type {
  AnyProviderExecutionIdentityRef,
  ExecutionRuntimePort,
  ProviderBinding,
  ProviderExecutionIdentityRef,
} from '../../contracts/src/index.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
  type ProviderTransportSource,
} from '../../adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../adapters/filesystem/src/index.js';
import { resolveProviderCredential, type ProviderCredentialRef } from '../../config/src/index.js';

const DEFAULT_MAX_TOKENS = 4096;

/**
 * App-owned assembly input: an already resolved binding plus the validated
 * source strategy. Callers own config parsing and identity derivation. The
 * source is a typed control fact and is never inferred from the URL, the
 * model, or a response.
 */
export interface ProviderAssemblyInput {
  readonly binding: ProviderBinding;
  readonly routeRef: string;
  readonly baseUrl: string;
  readonly source: ProviderTransportSource;
  readonly credentialRef?: ProviderCredentialRef;
  readonly maxTokens?: number;
}

/**
 * Build one real ExecutionRuntimePort from resolved inputs. The source selects
 * the transport strategy (HTTP has no RCC discovery); the binding selects the
 * independent protocol codec. The transport, codec, evidence sink and adapter
 * are each constructed exactly once.
 */
export function assembleProviderExecutionPort<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(input: ProviderAssemblyInput, evidenceRoot: string): ExecutionRuntimePort<TIdentity> {
  const credential = resolveProviderCredential(input.credentialRef);
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot));
  const transport = new V3ProviderHttpTransport<TIdentity>({
    binding: input.binding,
    baseUrl: input.baseUrl,
    evidence,
    credential,
    source: input.source,
  });
  const codec = input.binding.protocol === 'anthropic'
    ? new AnthropicProviderCodec(input.maxTokens ?? DEFAULT_MAX_TOKENS)
    : input.binding.protocol === 'openai'
      ? new OpenAIChatProviderCodec()
      : new ResponsesProviderCodec();
  return new ProviderAdapter<TIdentity>({ binding: input.binding, routeRef: input.routeRef, codec, transport, evidence });
}
