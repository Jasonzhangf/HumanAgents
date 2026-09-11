import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { id, type EvidenceRef, type ScopeRef } from '@humanagent/contracts';

export interface AssetReference { readonly assetId: string; readonly digest: string; readonly locator: string; readonly size: number; }

export class AssetIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'AssetIntegrityError'; }
}

function digest(data: Uint8Array): string { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }
function validateId(assetId: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) throw new AssetIntegrityError('invalid asset id'); }

export function evidenceReference(reference: AssetReference, scope: ScopeRef, kind: EvidenceRef['kind'], source = 'filesystem'): EvidenceRef {
  validateId(reference.assetId);
  return { evidenceId: id('evidence', reference.assetId), kind, source, locator: reference.locator, digest: reference.digest, scope };
}

export function assertAssetEvidenceBinding(reference: AssetReference, evidence: EvidenceRef): void {
  validateId(reference.assetId);
  if (evidence.evidenceId.scope !== 'evidence' || evidence.evidenceId.value !== reference.assetId) throw new AssetIntegrityError('evidence id does not match asset');
  if (evidence.digest !== reference.digest || evidence.locator !== reference.locator) throw new AssetIntegrityError('evidence reference does not match asset');
}

export class ImmutableAssetStore {
  constructor(private readonly root: string) {}

  async write(assetId: string, data: Uint8Array): Promise<AssetReference> {
    validateId(assetId);
    const assetDigest = digest(data);
    const locator = join(this.root, assetId);
    await mkdir(dirname(locator), { recursive: true });
    try {
      const existing = await readFile(locator);
      if (digest(existing) !== assetDigest || existing.length !== data.length) throw new AssetIntegrityError('immutable asset mismatch');
      return { assetId, digest: assetDigest, locator, size: data.length };
    } catch (error) {
      if (error instanceof AssetIntegrityError) throw error;
    }
    const handle = await open(locator, 'wx');
    try { await handle.writeFile(data); } finally { await handle.close(); }
    return { assetId, digest: assetDigest, locator, size: data.length };
  }

  async read(reference: AssetReference): Promise<Uint8Array> {
    validateId(reference.assetId);
    const data = await readFile(join(this.root, reference.assetId));
    if (digest(data) !== reference.digest || data.length !== reference.size) throw new AssetIntegrityError('asset reference digest mismatch');
    return new Uint8Array(data);
  }

  async readEvidence(evidence: EvidenceRef): Promise<Uint8Array> {
    if (!evidence.digest || !evidence.locator) throw new AssetIntegrityError('invalid evidence reference');
    const assetId = evidence.evidenceId.value;
    validateId(assetId);
    const expectedLocator = join(this.root, assetId);
    if (evidence.locator !== expectedLocator) throw new AssetIntegrityError('evidence locator is outside asset store');
    const data = await readFile(expectedLocator);
    if (digest(data) !== evidence.digest) throw new AssetIntegrityError('evidence reference digest mismatch');
    return new Uint8Array(data);
  }
}
