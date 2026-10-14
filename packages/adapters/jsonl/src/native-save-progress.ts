import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import { validateJournalCommitRef, type JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  NATIVE_SAVE_PHASES,
  isNativeSegmentSaveIntentV2,
  nativeSegmentSaveIntentDigestV2,
  nativeSegmentSaveKeyDigestV2,
  type NativeSaveIntent,
  type NativeSaveKey,
  type NativeSaveProgress,
  type NativeSaveProgressPort,
} from '../../../runtime/src/checkpoints/native-save-contract.js';
import { JournalCommitConflictError, JournalIntegrityError, type JournalRecord, type JsonlOrganJournal } from './index.js';

const INTENT = 'native-save-intent';
const PROGRESS = 'native-save-progress';

interface StoredIntent {
  readonly version: 1;
  readonly keyDigest: string;
  readonly inputFingerprint: string;
  readonly ownerId: string;
  readonly recoveryResponsibilityRef: string;
  readonly rawTurnRefs: readonly string[];
  readonly completeIntent?: NativeSaveIntent;
  readonly initial: Omit<NativeSaveProgress, 'intentCommitRef'>;
}

interface StoredProgress {
  readonly version: 1;
  readonly keyDigest: string;
  readonly progressDigest: string;
  readonly progress: NativeSaveProgress;
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify({ domain, value })).digest('hex')}`;
}

async function keyDigest(key: NativeSaveKey): Promise<string> {
  return 'version' in key && key.version === 2
    ? nativeSegmentSaveKeyDigestV2(key)
    : digest('humanagent.native-save-key.v1', key);
}

function commitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) throw new JournalIntegrityError('native save requires a committed record');
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertProgress(value: unknown): asserts value is NativeSaveProgress {
  if (typeof value !== 'object' || value === null) throw new JournalIntegrityError('native save progress is not decodable');
  const progress = value as Partial<NativeSaveProgress>;
  if (!progress.key?.turn || !progress.key.checkpoint?.id || !progress.key.checkpoint.scope
    || typeof progress.key.boundaryId !== 'string' || typeof progress.intentDigest !== 'string'
    || (progress.firstErrorRef !== undefined && typeof progress.firstErrorRef !== 'string')
    || !strings(progress.laterErrorRefs) || !strings(progress.unresolvedOperationRefs)
    || !Array.isArray(progress.phases)
    || !progress.phases.every((phase) => phase && NATIVE_SAVE_PHASES.includes(phase.phase)
      && ['committed', 'failed', 'unknown', 'not-executed'].includes(phase.state)
      && (phase.state !== 'committed' || typeof phase.receiptRef === 'string'))) {
    throw new JournalIntegrityError('native save progress is not decodable');
  }
  if (!progress.intentCommitRef) throw new JournalIntegrityError('native save progress has no intent receipt');
  validateJournalCommitRef(progress.intentCommitRef);
}

async function decodeIntent(record: JournalRecord): Promise<StoredIntent & { readonly initial: NativeSaveProgress }> {
  const value = record.payload?.intent as Partial<StoredIntent> | undefined;
  if (!value || value.version !== 1 || typeof value.keyDigest !== 'string'
    || typeof value.inputFingerprint !== 'string' || typeof value.ownerId !== 'string'
    || typeof value.recoveryResponsibilityRef !== 'string' || !strings(value.rawTurnRefs)) {
    throw new JournalIntegrityError('native save intent is not decodable');
  }
  const initial = { ...value.initial, intentCommitRef: commitRef(record) };
  assertProgress(initial);
  if (await keyDigest(initial.key) !== value.keyDigest) {
    throw new JournalIntegrityError('native save intent identity is inconsistent');
  }
  if (value.completeIntent) {
    const fingerprint = isNativeSegmentSaveIntentV2(value.completeIntent)
      ? await nativeSegmentSaveIntentDigestV2(value.completeIntent)
      : digest('humanagent.native-save-input.v1', value.completeIntent);
    if (fingerprint !== value.inputFingerprint
      || canonicalJsonStringify(value.completeIntent.key) !== canonicalJsonStringify(initial.key)) {
      throw new JournalIntegrityError('native save complete intent conflicts with its immutable fingerprint');
    }
  }
  return { version: 1, keyDigest: value.keyDigest, inputFingerprint: value.inputFingerprint,
    ownerId: value.ownerId, recoveryResponsibilityRef: value.recoveryResponsibilityRef,
    rawTurnRefs: value.rawTurnRefs, initial,
    ...(value.completeIntent === undefined ? {} : { completeIntent: value.completeIntent }) };
}

async function decodeProgress(record: JournalRecord): Promise<StoredProgress> {
  const value = record.payload?.progress as Partial<StoredProgress> | undefined;
  if (!value || value.version !== 1 || typeof value.keyDigest !== 'string' || typeof value.progressDigest !== 'string') {
    throw new JournalIntegrityError('native save progress envelope is not decodable');
  }
  assertProgress(value.progress);
  if (await keyDigest(value.progress.key) !== value.keyDigest
    || digest('humanagent.native-save-progress.v1', value.progress) !== value.progressDigest) {
    throw new JournalIntegrityError('native save progress identity is inconsistent');
  }
  return { version: 1, keyDigest: value.keyDigest, progressDigest: value.progressDigest, progress: value.progress };
}

async function exact(records: readonly JournalRecord[], locator: string): Promise<{
  readonly intentRecord?: JournalRecord;
  readonly intent?: StoredIntent;
  readonly progress?: NativeSaveProgress;
}> {
  let intentRecord: JournalRecord | undefined;
  let intent: StoredIntent | undefined;
  let progress: NativeSaveProgress | undefined;
  for (const record of records) {
    if (record.kind !== 'event') continue;
    if (record.payload?.type === INTENT) {
      const stored = await decodeIntent(record);
      if (stored.keyDigest !== locator) continue;
      if (intent) throw new JournalIntegrityError('duplicate native save intent');
      intentRecord = record;
      intent = stored;
      progress = stored.initial;
    } else if (record.payload?.type === PROGRESS) {
      const stored = await decodeProgress(record);
      if (stored.keyDigest !== locator) continue;
      if (!intentRecord || !intent) throw new JournalIntegrityError('native save progress has no intent');
      assertBinding(stored.progress, intentRecord, intent);
      if (progress?.firstErrorRef !== undefined && stored.progress.firstErrorRef !== progress.firstErrorRef) {
        throw new JournalIntegrityError('native save progress replaced the first error');
      }
      progress = stored.progress;
    }
  }
  return { intentRecord, intent, progress };
}

function assertBinding(progress: NativeSaveProgress, record: JournalRecord, intent: StoredIntent): void {
  if (canonicalJsonStringify(progress.intentCommitRef) !== canonicalJsonStringify(commitRef(record))
    || canonicalJsonStringify(progress.key) !== canonicalJsonStringify(intent.initial.key)
    || progress.intentDigest !== intent.initial.intentDigest) {
    throw new JournalIntegrityError('native save progress does not match the original intent');
  }
}

/** Control projections share the supplied Organ Journal; phase receipts remain stage-owner truth. */
export function createJsonlNativeSaveProgressPort({ journal }: { readonly journal: JsonlOrganJournal }): NativeSaveProgressPort {
  return {
    async begin(intent: NativeSaveIntent) {
      const locator = await keyDigest(intent.key);
      const fingerprint = isNativeSegmentSaveIntentV2(intent)
        ? await nativeSegmentSaveIntentDigestV2(intent)
        : digest('humanagent.native-save-input.v1', intent);
      const commitId = `native-save-intent:v1:${locator.slice(7)}`;
      return journal.transaction(async ({ records }) => {
        const saved = await exact(records, locator);
        if (saved.intent && saved.intentRecord) {
          if (saved.intent.inputFingerprint !== fingerprint || saved.intent.initial.intentDigest !== intent.inputIntentDigest) {
            throw new JournalCommitConflictError(commitId, saved.intentRecord);
          }
          return commitRef(saved.intentRecord);
        }
        return null;
      }, async (existing, append) => {
        if (existing) return existing;
        // The initial projection is formed on read from the actual append receipt.
        const record = await append({ commitId, kind: 'event', scope: intent.key.turn.scopeRef,
          payload: { type: INTENT, intent: {
            version: 1, keyDigest: locator, inputFingerprint: fingerprint,
            ownerId: intent.ownerId, recoveryResponsibilityRef: intent.recoveryResponsibilityRef,
            rawTurnRefs: intent.rawTurnRefs,
            completeIntent: intent,
            initial: {
              key: intent.key, intentDigest: intent.inputIntentDigest,
              phases: NATIVE_SAVE_PHASES.map((phase) => ({ phase, state: 'not-executed' })),
              ...(intent.firstErrorRef === undefined ? {} : { firstErrorRef: intent.firstErrorRef }),
              laterErrorRefs: intent.laterErrorRefs, unresolvedOperationRefs: intent.unresolvedOperationRefs,
            },
          } },
        });
        return commitRef(record);
      });
    },
    async readIntentExact(key) {
      try {
        const verification = await journal.verify();
        if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'journal is corrupt');
        const saved = await exact(verification.records, await keyDigest(key));
        if (saved.intent && saved.intentRecord) {
          if (!saved.intent.completeIntent) return { state: 'unknown', recoveryRef: 'native-save:legacy-intent-incomplete' };
          return { state: 'found', intent: structuredClone(saved.intent.completeIntent), commitRef: commitRef(saved.intentRecord) };
        }
        const last = verification.records.at(-1);
        return { state: 'absent', verifiedThrough: last ? commitRef(last) : null };
      } catch (error) {
        return { state: 'unknown', recoveryRef: `native-save:unknown:${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async readExact(key) {
      try {
        const locator = await keyDigest(key);
        const verification = await journal.verify();
        if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'journal is corrupt');
        const saved = await exact(verification.records, locator);
        if (saved.progress) return { state: 'found', progress: saved.progress };
        const last = verification.records.at(-1);
        return { state: 'absent', verifiedThrough: last ? commitRef(last) : null };
      } catch (error) {
        return { state: 'unknown', recoveryRef: `native-save:unknown:${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async recordProgress(progress) {
      assertProgress(progress);
      const locator = await keyDigest(progress.key);
      const progressDigest = digest('humanagent.native-save-progress.v1', progress);
      const commitId = `native-save-progress:v1:${locator.slice(7)}:${progressDigest.slice(7)}`;
      return journal.transaction(async ({ records }) => {
        const saved = await exact(records, locator);
        if (!saved.intentRecord || !saved.intent) throw new JournalIntegrityError('native save progress has no intent');
        assertBinding(progress, saved.intentRecord, saved.intent);
        if (saved.progress?.firstErrorRef !== undefined && progress.firstErrorRef !== saved.progress.firstErrorRef) {
          throw new JournalIntegrityError('native save progress cannot replace the first error');
        }
        const existing = records.find((record) => record.commitId === commitId);
        return existing ? commitRef(existing) : null;
      }, async (existing, append) => {
        if (existing) return existing;
        return commitRef(await append({ commitId, kind: 'event', scope: progress.key.turn.scopeRef,
          payload: { type: PROGRESS, progress: { version: 1, keyDigest: locator, progressDigest, progress } },
        }));
      });
    },
  };
}
