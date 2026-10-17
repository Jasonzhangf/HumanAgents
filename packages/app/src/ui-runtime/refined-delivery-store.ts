import { randomUUID } from 'node:crypto';

import {
  evidenceReference,
  type ImmutableAssetStore,
} from '../../../adapters/filesystem/src/index.js';
import {
  filesystemProviderEvidenceSink,
  providerRawContentReader,
} from '../../../adapters/provider/src/evidence.js';
import type {
  RawAsset,
} from '../../../contracts/src/index.js';
import type {
  RefinedDeliveryStore,
} from '../../../runtime/src/ui-runtime/coordinator.js';

/**
 * Durable `RefinedDeliveryStore` over the existing immutable asset root. The
 * producer still owns payload encoding and the Journal return; this adapter only
 * persists the bytes it is handed and resolves them back through the descriptor
 * it returned. The write side goes straight to `ImmutableAssetStore` because the
 * evidence sink stringifies its content; the read side reuses the existing sink
 * and reader so a cold read performs no decoding.
 */
export function createFilesystemRefinedDeliveryStore(
  assets: ImmutableAssetStore,
): RefinedDeliveryStore {
  const reader = providerRawContentReader(filesystemProviderEvidenceSink(assets));
  return {
    async store(input): Promise<RawAsset> {
      const reference = await assets.write(`refined-delivery-${randomUUID()}`, input.bytes);
      return {
        ref: evidenceReference(reference, input.scope, 'operation'),
        view: { kind: 'utf8-text' },
      };
    },
    read: (asset) => reader.read({ scope: asset.ref.scope, content: asset }),
  };
}
