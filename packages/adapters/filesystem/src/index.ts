import { createHash } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { id, type EvidenceRef, type ScopeRef } from '@humanagent/contracts';

declare module 'node:fs/promises' {
  interface FileHandle {
    sync(): Promise<void>;
  }
  function link(oldPath: string, newPath: string): Promise<void>;
}

export interface AssetReference { readonly assetId: string; readonly digest: string; readonly locator: string; readonly size: number; }

export class AssetIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'AssetIntegrityError'; }
}

function digest(data: Uint8Array): string { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }
function validateId(assetId: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) throw new AssetIntegrityError('invalid asset id'); }
function assertLocator(locator: string, expected: string): void {
  if (locator !== expected) throw new AssetIntegrityError('asset locator is outside asset store');
}
function tempLocator(root: string, assetId: string): string {
  return join(root, '.tmp', `${assetId}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`);
}

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
    const tmpRoot = join(this.root, '.tmp');
    await mkdir(tmpRoot, { recursive: true });
    const tempFile = tempLocator(this.root, assetId);
    try {
      const handle = await open(tempFile, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tempFile, locator);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        const existing = await readFile(locator);
        if (digest(existing) !== assetDigest || existing.length !== data.length) throw new AssetIntegrityError('immutable asset mismatch');
        return { assetId, digest: assetDigest, locator, size: data.length };
      }
    } catch (error) {
      await rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(tempFile, { force: true }).catch(() => undefined);
    }
    return { assetId, digest: assetDigest, locator, size: data.length };
  }

  async recover(): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(this.root, '.tmp'), { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map((entry) => rm(join(this.root, '.tmp', entry.name), { force: true })));
  }

  async read(reference: AssetReference): Promise<Uint8Array> {
    validateId(reference.assetId);
    assertLocator(reference.locator, join(this.root, reference.assetId));
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
