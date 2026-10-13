import { RccV3ProviderTransport, type RccV3ProviderTransportOptions } from './rcc-v3-transport.js';

export {
  RccV3ProviderTransport as V3ProviderHttpTransport,
  createRccV3ProviderTransport as createV3ProviderHttpTransport,
} from './rcc-v3-transport.js';
export type {
  RccV3Fetch as V3ProviderFetch,
  RccV3FetchInit as V3ProviderFetchInit,
  RccV3FetchResponse as V3ProviderFetchResponse,
  RccV3ProviderTransportOptions as V3ProviderHttpTransportOptions,
  ProviderTransportSource,
} from './rcc-v3-transport.js';

/**
 * Direct HTTP source entry. It reuses the one request/stream/resource
 * implementation, but selects the `http` source strategy: no RCC discovery
 * probe and no RCC servertool normalization. Callers that need the legacy RCC
 * behavior construct `V3ProviderHttpTransport` without a source.
 */
export function createHttpProviderTransport(options: Omit<RccV3ProviderTransportOptions, 'source'>): RccV3ProviderTransport {
  return new RccV3ProviderTransport({ ...options, source: 'http' });
}
