import { createHash } from 'node:crypto';
import { ImmutableAssetStore, evidenceReference } from '../../filesystem/src/index.js';
import type { EvidenceRef, ScopeRef } from '../../../contracts/src/index.js';

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
      const assetId = `provider-${sanitizeRefPart(input.type)}-${sanitizeRefPart(input.locator)}-${digest.slice(0, 12)}`.slice(0, 128);
      const reference = await store.write(assetId, new TextEncoder().encode(content));
      return evidenceReference(reference, input.scope, input.kind, source);
    },
    async read(ref) {
      return store.readEvidence(ref);
    },
  };
}
