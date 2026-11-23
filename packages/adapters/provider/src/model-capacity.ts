import type { ProviderCallCapacity } from '../../../contracts/src/index.js';
import type { RccV3Fetch, RccV3FetchInit, RccV3FetchResponse } from './rcc-v3-transport.js';

/**
 * One call-capacity fact is resolved from the live model catalog by the exact
 * provider-reported response model. The source never guesses: an unmatched or
 * unavailable catalog stays explicitly unknown for the reader to disclose.
 */
export interface ProviderModelCapacitySource {
  capacityFor(responseModel: string | null, signal?: AbortSignal): Promise<ProviderCallCapacity>;
}

/** One model-catalog entry reduced to the capacity facts a call can report. */
export interface ModelCapacityEntry {
  /** Every identifier the catalog exposes for this entry. */
  readonly ids: readonly string[];
  readonly contextWindow: number | null;
  readonly maxContextTokens: number | null;
  readonly effectiveContextWindowPercent: number | null;
}

const IDENTITY_KEYS = ['id', 'slug', 'wire_model', 'canonical_model_id'] as const;

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reduce one `/v1/models` entry. Only identity keys and capacity fields are
 * read; no first-list-item, `default` alias or marketing bound is invented.
 */
export function modelCapacityEntry(value: unknown): ModelCapacityEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ids = IDENTITY_KEYS.flatMap((key) => (typeof record[key] === 'string' && (record[key] as string).trim().length > 0 ? [record[key] as string] : []));
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    : [];
  const allIds = [...new Set([...ids, ...aliases])];
  if (allIds.length === 0) return null;
  return {
    ids: allIds,
    contextWindow: positiveNumber(record.context_window),
    maxContextTokens: positiveNumber(record.max_context_tokens),
    effectiveContextWindowPercent: positiveNumber(record.effective_context_window_percent),
  };
}

/**
 * Match a provider-reported response model to exactly one catalog entry. The
 * match is an exact identifier match; an ambiguous or absent match is unknown.
 */
export function matchModelCapacity(
  entries: readonly ModelCapacityEntry[],
  responseModel: string | null,
): ProviderCallCapacity {
  if (responseModel === null || responseModel.trim().length === 0) return { state: 'unknown', reason: 'no-response-model' };
  const matched = entries.filter((entry) => entry.ids.includes(responseModel));
  if (matched.length !== 1) return { state: 'unknown', reason: 'model-not-in-catalog' };
  const entry = matched[0]!;
  if (entry.contextWindow === null) return { state: 'unknown', reason: 'entry-without-capacity' };
  return {
    state: 'known',
    source: 'rcc-models',
    contextWindow: entry.contextWindow,
    ...(entry.maxContextTokens === null ? {} : { maxContextTokens: entry.maxContextTokens }),
    ...(entry.effectiveContextWindowPercent === null ? {} : { effectiveContextWindowPercent: entry.effectiveContextWindowPercent }),
  };
}

export interface RccModelCatalogOptions {
  readonly baseUrl: string;
  readonly fetch?: RccV3Fetch;
  readonly maxBytes?: number;
  /** Optional diagnostics must not hold up the model terminal indefinitely. */
  readonly readTimeoutMs?: number;
}

function defaultCatalogFetch(url: string, init: RccV3FetchInit): Promise<RccV3FetchResponse> {
  return globalThis.fetch(url, init as RequestInit).then((response) => ({
    status: response.status,
    headers: response.headers,
    body: response.body === null ? null : catalogBody(response.body),
    text: () => response.text(),
  }));
}

async function* catalogBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

async function catalogText(response: RccV3FetchResponse, maxBytes: number): Promise<string> {
  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('model catalog exceeds byte limit');
    return text;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('model catalog exceeds byte limit');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Live RCC model catalog. Capacity is read per completed call from the same
 * RCC endpoint that served it. A catalog failure is isolated to this fact and
 * reported as unknown; it never fails the provider call itself.
 */
export function createRccModelCatalog(options: RccModelCatalogOptions): ProviderModelCapacitySource {
  const fetcher = options.fetch ?? defaultCatalogFetch;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const readTimeoutMs = options.readTimeoutMs ?? 1000;
  const url = new URL('/v1/models', `${options.baseUrl.replace(/\/$/, '')}/`).toString();
  return {
    async capacityFor(responseModel: string | null, signal?: AbortSignal): Promise<ProviderCallCapacity> {
      if (responseModel === null || responseModel.trim().length === 0) return { state: 'unknown', reason: 'no-response-model' };
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, readTimeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      let abortRead: (() => void) | undefined;
      try {
        if (signal?.aborted) controller.abort();
        if (controller.signal.aborted) return { state: 'unknown', reason: 'catalog-unavailable' };
        const aborted = new Promise<never>((_, reject) => {
          abortRead = () => reject(new Error('model catalog read cancelled'));
          controller.signal.addEventListener('abort', abortRead, { once: true });
        });
        const raw = await Promise.race([aborted, (async () => {
          const response = await fetcher(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
          if (response.status < 200 || response.status >= 300) throw new Error('model catalog unavailable');
          return catalogText(response, maxBytes);
        })()]);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unknown', reason: 'catalog-unavailable' };
        const record = parsed as Record<string, unknown>;
        const candidates = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null;
        if (candidates === null) return { state: 'unknown', reason: 'catalog-unavailable' };
        const entries = candidates.flatMap((candidate) => {
          const entry = modelCapacityEntry(candidate);
          return entry === null ? [] : [entry];
        });
        return matchModelCapacity(entries, responseModel);
      } catch {
        return { state: 'unknown', reason: 'catalog-unavailable' };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (abortRead !== undefined) controller.signal.removeEventListener('abort', abortRead);
        // Also release unread error/oversized response bodies and pending fetch.
        controller.abort();
      }
    },
  };
}
