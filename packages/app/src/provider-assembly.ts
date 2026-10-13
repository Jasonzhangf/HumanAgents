import type { ExecutionRuntimePort, ProviderBinding } from '../../contracts/src/index.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  createHttpProviderTransport,
  filesystemProviderEvidenceSink,
  type ProviderTransportSource,
} from '../../adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../adapters/filesystem/src/index.js';

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
  readonly maxTokens?: number;
}

/**
 * Build one real ExecutionRuntimePort from resolved inputs. The source selects
 * the transport strategy (HTTP has no RCC discovery); the binding selects the
 * independent protocol codec. The transport, codec, evidence sink and adapter
 * are each constructed exactly once.
 */
export function assembleProviderExecutionPort(input: ProviderAssemblyInput, evidenceRoot: string): ExecutionRuntimePort {
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot));
  const transport = input.source === 'http'
    ? createHttpProviderTransport({ binding: input.binding, baseUrl: input.baseUrl, evidence })
    : new V3ProviderHttpTransport({ binding: input.binding, baseUrl: input.baseUrl, evidence, source: 'rcc' });
  const codec = input.binding.protocol === 'anthropic'
    ? new AnthropicProviderCodec(input.maxTokens ?? DEFAULT_MAX_TOKENS)
    : input.binding.protocol === 'openai'
      ? new OpenAIChatProviderCodec()
      : new ResponsesProviderCodec();
  return new ProviderAdapter({ binding: input.binding, routeRef: input.routeRef, codec, transport, evidence });
}
