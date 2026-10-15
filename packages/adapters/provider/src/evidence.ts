import { createHash } from 'node:crypto';
import { ImmutableAssetStore, evidenceReference } from '../../filesystem/src/index.js';
import {
  ContractError,
  assertSameScope,
  type EvidenceRef,
  type RawAssetView,
  type RawContentReadPort,
  type ScopeRef,
} from '../../../contracts/src/index.js';

export interface ProviderEvidenceWrite {
  readonly scope: ScopeRef;
  readonly kind: EvidenceRef['kind'];
  readonly type: string;
  readonly locator: string;
  readonly content: unknown;
}

export interface ProviderEvidenceSink {
  readonly write: (input: ProviderEvidenceWrite) => Promise<EvidenceRef>;
  readonly read: (ref: EvidenceRef) => Promise<Uint8Array>;
}

function sanitizeRefPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function contentString(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export function filesystemProviderEvidenceSink(
  store: ImmutableAssetStore,
  source = 'humanagent.provider-adapter',
): ProviderEvidenceSink {
  return {
    async write(input) {
      const content = contentString(input.content);
      const digest = createHash('sha256').update(content).digest('hex');
      const assetId = `provider-${digest.slice(0, 16)}-${sanitizeRefPart(input.type)}-${sanitizeRefPart(input.locator)}`.slice(0, 128);
      const reference = await store.write(assetId, new TextEncoder().encode(content));
      return evidenceReference(reference, input.scope, input.kind, source);
    },
    async read(ref) {
      return store.readEvidence(ref);
    },
  };
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireStringField(value: unknown, field: string, label: string): string {
  const record = requireObject(value, label);
  const fieldValue = record[field];
  if (typeof fieldValue !== 'string') {
    throw new ContractError(`${label} is missing string field ${field}`);
  }
  return fieldValue;
}

function requireTextArray(value: unknown, field: string, label: string): string {
  const record = requireObject(value, label);
  const entries = record[field];
  if (!Array.isArray(entries)) {
    throw new ContractError(`${label} is missing array field ${field}`);
  }
  return entries
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => typeof entry.text === 'string')
    .map((entry) => entry.text as string)
    .join('');
}

/** Interpret a stored immutable asset through a closed raw view. No arbitrary path. */
function readRawView(bytes: Uint8Array, view: RawAssetView): Uint8Array {
  if (view.kind === 'utf8-text') return bytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ContractError(`raw asset is not valid JSON for view ${view.kind}`);
  }
  switch (view.kind) {
    case 'text-field':
      return encodeText(requireStringField(parsed, view.field, 'raw asset'));
    case 'arguments':
      return encodeText(requireStringField(parsed, 'arguments', 'raw asset'));
    case 'thinking-field':
      return encodeText(requireStringField(parsed, view.field, 'raw asset'));
    case 'content-part': {
      const record = requireObject(parsed, 'raw asset');
      const content = record.content;
      if (!Array.isArray(content)) throw new ContractError('raw asset content must be an array for content-part view');
      const part = content[view.partIndex];
      if (part === undefined) throw new ContractError(`raw asset content part ${view.partIndex} does not exist`);
      return encodeText(requireStringField(part, 'text', `raw asset content part ${view.partIndex}`));
    }
    case 'reasoning-item':
      return encodeText(requireTextArray(parsed, view.selector === 'summary' ? 'summary' : 'content', 'raw asset'));
  }
}

/**
 * Fixed-view reader over the existing evidence sink. The sink owns locator and
 * digest validation; this reader adds the caller scope check and the closed view
 * interpretation. It never returns a summary, descriptor or fallback content.
 */
export function providerRawContentReader(sink: ProviderEvidenceSink): RawContentReadPort {
  return {
    async read(input) {
      assertSameScope(input.scope, input.content.ref.scope);
      const bytes = await sink.read(input.content.ref);
      return readRawView(bytes, input.content.view);
    },
  };
}
