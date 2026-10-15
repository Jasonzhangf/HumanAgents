import { createHash } from 'node:crypto';
import { ImmutableAssetStore } from '../../adapters/filesystem/src/index.js';
import { createJsonlNativeSaveProgressPort } from '../../adapters/jsonl/src/native-save-progress.js';
import { createNativeBoundarySaveController } from '../../runtime/src/checkpoints/boundary-save.js';
import { readResumedSegmentSemanticTurnContext } from '../../runtime/src/context/semantic-turn-context-reader.js';
import type { ActiveTurnSegmentContext } from '../../runtime/src/context/active-turn-context.js';
import type { ProviderRequestContextHook, ProviderRequestContextUnit } from '../../contracts/src/provider-request-context.js';
import {
  isNativeSegmentSaveIntentV2,
  type NativeSaveIntent,
  type NativeSavePhase,
  type NativeSavePhaseReceipt,
  type NativeSavePorts,
  type NativeSegmentSaveIntentV2,
} from '../../runtime/src/checkpoints/native-save-contract.js';
import { activeTurnSegmentCommitId, validateResumedTurnSegmentOpened, type ResumedTurnSegmentOpened,
  type NativeSegmentSaveSourceV2, type PreparedActiveTurnSegmentCaptureV2 } from '../../contracts/src/active-turn-segments.js';
import {
  createNativeRecoveryAssets,
  segmentRecoveryAssetsReceiptRef,
} from './native-recovery-assets.js';
import type { OperationCompletionJournalPort } from '../../runtime/src/gateway/operation-completion.js';
import {
  canonicalJsonStringify,
  checkpointCommitIdentityV2,
  checkpointIntentDigestV1,
  checkpointRefV2,
  scopeDigest,
  validateCheckpointCommitEnvelopeV1,
  validateCheckpointReceiptRelationship,
  type CanonicalUtcInstant,
  type CheckpointCommitIdentityV2,
  type CheckpointCommitEnvelopeV1,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthority,
  type CheckpointTimeAuthorityMetadata,
  type RawContentReadPort,
} from '../../contracts/src/index.js';
import type {
  NativeCheckpointCommitRequest,
  NativeCheckpointJournalPort,
  SemanticContextViewCommitRequest,
  SemanticContextViewCommitRequestV2,
  SemanticHistoryPersistencePort,
  SemanticHistoryPublicationCommitRequest,
  SemanticHistoryPublicationCommitRequestV2,
} from '../../runtime/src/checkpoints/ports.js';
import type { ActiveTurnJournalPort, ActiveTurnSegmentJournalPort, ActiveTurnSegmentJournalRecord } from '../../runtime/src/context/active-turn-journal.js';
import {
  buildSemanticContextViewBodyV1,
  buildSemanticContextViewBodyV2,
  buildSemanticHistoryPublicationBodyV1,
  buildSemanticHistoryPublicationBodyV2,
  contextViewIdentityV1,
  contextViewIntentDigestV1,
  contextViewIntentDigestV2,
  encodeSemanticAssetBodyV1,
  historyPublicationIdentityV1,
  historyPublicationIntentDigestV1,
  historyPublicationIntentDigestV2,
  projectAdmittedTurnIdentityV1,
  projectCommittedSemanticCheckpointV1,
  projectCommittedSemanticCheckpointV2,
  semanticAssetDigestV1,
  semanticAssetIdV1,
  validateSemanticContextViewBodyV1,
  validateSemanticContextViewBody,
  validateSemanticHistoryExactLookupV1,
  validateSemanticHistoryPublicationBodyV1,
  validateSemanticHistoryPublicationBody,
  type AdoptedChildSourceV1,
  type AdoptedChildSourceV2,
  type CommittedSemanticCheckpointV1,
  type CommittedSemanticCheckpoint,
  type FourPartSemanticViewV1,
  type SemanticAssetDescriptorV1,
  type SemanticContextViewBodyV1,
  type SemanticContextViewBodyV2,
  type SemanticHistoryDigestV1,
  type SemanticHistoryExactLookupV1,
  type SemanticHistoryPublicationBodyV1,
  type SemanticHistoryPublicationBodyV2,
  type SemanticPhase,
  type SemanticPhaseReceiptV1,
} from '../../runtime/src/context/semantic-history.js';
import { materializeAdoptedChildSource } from '../../runtime/src/context/semantic-history-adoption.js';
import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import { decodeActiveTurnRecords } from '../../adapters/jsonl/src/active-turn.js';
import type {
  Checkpoint,
  ContextHistoryRecord,
  ContextReplacement,
  ContextView,
  EvidenceRef,
  ScopeRef,
} from '../../contracts/src/index.js';
import type {
  CheckpointAppendRequest,
  CheckpointAppendReceipt,
  CheckpointChainVerification,
  CheckpointClosurePort,
  CheckpointJournalPort,
  CheckpointListQuery,
  CheckpointListResult,
  CheckpointRecoveryBinding,
  CheckpointReentryAdmissionPort,
  CommittedCheckpointRecord,
  ContextHistoryPort,
  ContextHistoryReadQuery,
  ContextHistoryReadResult,
  ExecutionPosition,
  ExecutionIncarnationRef,
  JournalCommitRef,
  LatestCheckpointRecord,
} from '../../runtime/src/checkpoints/ports.js';
import {
  assertDeadEndRecord,
  assertInteractionClosure,
  assertPlannerAlignmentRecord,
  assertReentryRecord,
  assertTurnClosureRecord,
  assertTurnRecoveryRecord,
  sameCheckpointClosureRecord,
  sameReentryRecord,
  checkpointClosurePreparationId,
  type ClosureRecord,
  type CheckpointClosureRecord,
} from '../../runtime/src/checkpoints/closure.js';
import {
  assertConditionalReentryRecord,
  CONDITIONAL_REENTRY_SCHEMA_VERSION,
  conditionalReentryIdentity,
  type ConditionalReentryRecord,
  type ReentryFence,
} from '../../runtime/src/checkpoints/conditional-reentry.js';
import { scopeContains } from '../../runtime/src/events/index.js';
import { assertContextHistoryRecord, checkpointCommitId,
  matchesExecutionIncarnationFence } from '../../runtime/src/checkpoints/coordinator.js';
import { assertCheckpointClosureCommitted } from '../../core/src/index.js';
import { AppLifecycleError } from './errors.js';

const CHECKPOINT_EVIDENCE_PREFIX = 'humanagent://checkpoint/';
const CHECKPOINT_CLOSURE_PAYLOAD_KIND = 'checkpoint-closure';
const CONTEXT_HISTORY_PAYLOAD_KIND = 'context-history';

const SEMANTIC_HISTORY_CONTEXT_VIEW_KIND = 'native-semantic-context-view';
const SEMANTIC_HISTORY_PUBLICATION_KIND = 'native-semantic-history-publication';

interface ParsedJournalReceipt {
  readonly scopeDigest: string;
  readonly seq: number;
  readonly digestHex: string;
}

function parseJournalReceipt(receiptRef: string): ParsedJournalReceipt {
  const match = /^humanagent:\/\/journal-record\/v1\/([0-9a-f]{64})\/(\d+)\/([0-9a-f]{64})$/.exec(receiptRef);
  const seq = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(seq) || seq < 1) {
    throw new AppLifecycleError(
      'semantic-history-receipt-invalid',
      `semantic history receipt is not an actual journal receipt: ${receiptRef}`,
      'use the receipt returned by the durable commit',
      'app-checkpoint-journal',
    );
  }
  return { scopeDigest: match[1]!, seq, digestHex: match[3]! };
}

function assertSemanticRecordDigest(value: string): SemanticHistoryDigestV1 {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new AppLifecycleError(
      'semantic-history-record-digest-invalid',
      `semantic history journal record digest is invalid: ${value}`,
      'preserve the committed journal and repair its integrity before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  return value as SemanticHistoryDigestV1;
}

function exactSemanticJournalRecord(
  records: readonly JournalRecord[],
  seq: number,
  digestHex: string,
): JournalRecord | undefined {
  return records.find((record) => record.seq === seq && record.recordDigest === `sha256:${digestHex}`);
}

function sameSemanticPhaseReceipt(left: SemanticPhaseReceiptV1, right: SemanticPhaseReceiptV1): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

async function assertCompleteSegmentAdoptions(input: {
  readonly segment: NativeSegmentSaveSourceV2;
  readonly children: readonly AdoptedChildSourceV2[];
  readonly records: readonly ActiveTurnSegmentJournalRecord[];
  readonly rawContent: RawContentReadPort;
}): Promise<void> {
  const invocations = input.records.filter((record) => record.kind === 'child-invocation').map((record) => record.record);
  const adopted = new Map(invocations.filter((record) => record.adoptedResultSeq !== undefined).map((record) => [record.invocationId, record]));
  if (adopted.size !== input.children.length) throw new Error('native semantic selectors omit or duplicate an actual adopted child');
  for (const source of input.children) {
    const invocation = adopted.get(source.invocationId);
    const delivery = input.records.filter((record) => record.kind === 'child-delivery').map((record) => record.entry)
      .find((entry) => entry.invocationId === source.invocationId && entry.seq === source.deliverySeq);
    if (source.segmentId !== input.segment.opened.segmentId
      || canonicalJsonStringify(source.parentTurn) !== canonicalJsonStringify(projectAdmittedTurnIdentityV1(input.segment.originalAdmittedTurn))
      || !invocation || !delivery || invocation.childTurnId !== source.childTurnId
      || invocation.adoptedResultSeq !== source.deliverySeq || invocation.binding.kind !== source.kind
      || invocation.checkpointReceiptRef !== source.preCallCheckpointRef
      || invocation.postReviewCheckpointRef !== source.postReviewCheckpointRef || delivery.kind !== source.kind
      || canonicalJsonStringify(delivery.refinedDelivery) !== canonicalJsonStringify(source.refinedDelivery)) {
      throw new Error('semantic adopted child does not match the exact segment delivery');
    }
    adopted.delete(source.invocationId);
    const bytes = await input.rawContent.read({ scope: source.refinedDelivery.ref.scope, content: source.refinedDelivery });
    if (source.refinedDelivery.ref.digest !== undefined
      && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== source.refinedDelivery.ref.digest) {
      throw new Error('semantic adopted child asset digest mismatch');
    }
  }
}

function decodeSemanticAssetBody(bytes: Uint8Array): FourPartSemanticViewV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      `semantic asset is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
      'preserve the committed semantic asset and repair its bytes before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset body must be an object',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  const body = parsed as Record<string, unknown>;
  if (body['version'] !== 1) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset version must be 1',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  const semantics = body['semantics'];
  if (typeof semantics !== 'object' || semantics === null || Array.isArray(semantics)) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset semantics must be an object',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  const four = semantics as Record<string, unknown>;
  const fields = ['goal', 'actions', 'result', 'nextStep'] as const;
  if (Object.keys(four).length !== fields.length || fields.some((field) => !Object.hasOwn(four, field))) {
    throw new AppLifecycleError(
      'semantic-history-asset-invalid',
      'semantic asset must carry exactly goal, actions, result and nextStep',
      'repair the committed semantic asset before reading semantic history',
      'app-checkpoint-journal',
    );
  }
  for (const field of fields) {
    const value = four[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppLifecycleError(
        'semantic-history-asset-invalid',
        `semantic asset ${field} must be a non-empty string`,
        'repair the committed semantic asset before reading semantic history',
        'app-checkpoint-journal',
      );
    }
  }
  return {
    goal: four['goal'] as string,
    actions: four['actions'] as string,
    result: four['result'] as string,
    nextStep: four['nextStep'] as string,
  };
}

/**
 * App persistence owner for the two semantic-history phases. It binds the
 * authoritative Organ Journal, the immutable semantic asset store, the native
 * checkpoint-v2 reader and the declared parent active-turn replay source. It
 * reconstructs every phase receipt from the actual committed record and never
 * derives publication from the latest checkpoint or from an asset that exists
 * without a durable adoption.
 */
interface SemanticHistoryReadDependencies {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
  readonly artifactsRoot: string;
  readonly activeTurnJournalFor: (turnId: string) => Pick<ActiveTurnJournalPort, 'replay'>;
  readonly segmentJournalFor?: (turnId: string) => Pick<ActiveTurnSegmentJournalPort, 'readSegmentRecords'>;
  readonly rawContent: RawContentReadPort;
}

/** The same verified history reads, without a clock or any publication capability. */
export function createJsonlSemanticHistoryReader(input: SemanticHistoryReadDependencies) {
  const port = semanticHistoryJournal(input);
  return {
    listCompletedTurnLookups: port.listCompletedTurnLookups,
    readCommittedSemanticCheckpoint: port.readCommittedSemanticCheckpoint,
  };
}

export function createJsonlSemanticHistoryJournal(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
  readonly artifactsRoot: string;
  readonly activeTurnJournal: ActiveTurnJournalPort;
  readonly segmentJournal?: ActiveTurnSegmentJournalPort;
  readonly rawContent: RawContentReadPort;
  readonly timeAuthority: CheckpointTimeAuthority;
}): SemanticHistoryPersistencePort & {
  listCompletedTurnLookups(scope: ScopeRef): Promise<readonly SemanticHistoryExactLookupV1[]>;
} {
  return semanticHistoryJournal({ ...input,
    activeTurnJournalFor: () => input.activeTurnJournal,
    ...(input.segmentJournal === undefined ? {} : { segmentJournalFor: () => input.segmentJournal! }),
  });
}

function semanticHistoryJournal(input: SemanticHistoryReadDependencies & {
  readonly timeAuthority?: CheckpointTimeAuthority;
}): SemanticHistoryPersistencePort & {
  listCompletedTurnLookups(scope: ScopeRef): Promise<readonly SemanticHistoryExactLookupV1[]>;
} {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'semantic-history-journal-invalid',
      'semantic history journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  if (!input.artifactsRoot.trim()) {
    throw new AppLifecycleError(
      'semantic-history-assets-invalid',
      'semantic history asset root is required',
      'provide the canonical immutable asset root',
      'app-checkpoint-journal',
    );
  }
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);
  const assets = new ImmutableAssetStore(input.artifactsRoot);
  const checkpoints = createJsonlCheckpointJournal({ filePath: input.filePath, journal });
  function writeAuthority(): CheckpointTimeAuthority {
    if (input.timeAuthority === undefined) throw new Error('readonly semantic history has no publication authority');
    return input.timeAuthority;
  }

  async function verifiedRecords(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'semantic-history-journal-corrupt',
        verification.error ?? 'semantic history journal is invalid',
        'preserve the checkpoint journal and repair its committed history before publishing or reading semantic history',
        'app-checkpoint-journal',
      );
    }
    return verification.records;
  }

  function identityCollision(commitId: string, record: JournalRecord): never {
    throw new AppLifecycleError(
      'semantic-history-identity-collision',
      `semantic history identity ${commitId} is occupied by a non-matching journal record at seq ${record.seq}`,
      'preserve the committed record and use the original intent or a new checkpoint identity',
      'app-checkpoint-journal',
    );
  }

  async function phaseReceipt(receiptInput: {
    readonly record: JournalRecord;
    readonly phase: SemanticPhase;
    readonly identity: string;
    readonly committedAt: CanonicalUtcInstant;
    readonly authority: CheckpointTimeAuthorityMetadata;
    readonly scope: ScopeRef;
  }): Promise<SemanticPhaseReceiptV1> {
    const recordDigest = assertSemanticRecordDigest(receiptInput.record.recordDigest);
    const scopeHash = await scopeDigest(receiptInput.scope);
    return {
      phase: receiptInput.phase,
      commitIdentity: receiptInput.identity,
      journalReceiptRef: `humanagent://journal-record/v1/${scopeHash}/${receiptInput.record.seq}/${recordDigest.slice('sha256:'.length)}`,
      journalSeq: receiptInput.record.seq,
      recordDigest,
      committedAt: receiptInput.committedAt,
      timeAuthority: {
        source: receiptInput.authority.source,
        owner: receiptInput.authority.owner,
        authorityRef: receiptInput.authority.authorityRef,
      },
    };
  }

  async function contextViewBody(record: JournalRecord): Promise<SemanticContextViewBodyV1 | SemanticContextViewBodyV2> {
    if (record.kind !== 'event' || record.payload?.['kind'] !== SEMANTIC_HISTORY_CONTEXT_VIEW_KIND) {
      throw new AppLifecycleError(
        'semantic-history-record-kind-mismatch',
        `journal record ${record.seq} is not a native semantic context-view event`,
        'preserve the committed journal and resolve the identity collision before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    await validateSemanticContextViewBody(record.payload);
    const body = record.payload as unknown as SemanticContextViewBodyV1 | SemanticContextViewBodyV2;
    if (record.commitId !== body.identity) {
      throw new AppLifecycleError(
        'semantic-history-record-identity-mismatch',
        `context-view record ${record.seq} commit identity does not match its body identity`,
        'preserve the committed journal and repair the context-view record before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    return body;
  }

  async function publicationBody(record: JournalRecord): Promise<SemanticHistoryPublicationBodyV1 | SemanticHistoryPublicationBodyV2> {
    if (record.kind !== 'event' || record.payload?.['kind'] !== SEMANTIC_HISTORY_PUBLICATION_KIND) {
      throw new AppLifecycleError(
        'semantic-history-record-kind-mismatch',
        `journal record ${record.seq} is not a native semantic history-publication event`,
        'preserve the committed journal and resolve the identity collision before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    await validateSemanticHistoryPublicationBody(record.payload);
    const body = record.payload as unknown as SemanticHistoryPublicationBodyV1 | SemanticHistoryPublicationBodyV2;
    if (record.commitId !== body.identity) {
      throw new AppLifecycleError(
        'semantic-history-record-identity-mismatch',
        `history-publication record ${record.seq} commit identity does not match its body identity`,
        'preserve the committed journal and repair the publication record before reading semantic history',
        'app-checkpoint-journal',
      );
    }
    return body;
  }

  const port = {
    /** Verified owner enumeration for cold context; absence is established by Journal verification. */
    async listCompletedTurnLookups(scope: ScopeRef): Promise<readonly SemanticHistoryExactLookupV1[]> {
      const result: SemanticHistoryExactLookupV1[] = [];
      for (const record of await verifiedRecords()) {
        if (!sameScope(record.scope, scope) || record.kind !== 'event'
          || record.payload?.['kind'] !== SEMANTIC_HISTORY_PUBLICATION_KIND) continue;
        const body = await publicationBody(record);
        const receipt = await phaseReceipt({ record, phase: 'history-publication', identity: body.identity,
          committedAt: body.committedAt, authority: body.timeAuthority, scope });
        result.push({ scope, checkpoint: body.checkpoint.checkpoint,
          publicationReceiptRef: receipt.journalReceiptRef });
      }
      return result;
    },
    async commitContextView(request: SemanticContextViewCommitRequest | SemanticContextViewCommitRequestV2): Promise<SemanticPhaseReceiptV1> {
      const authority = writeAuthority();
      const timeAuthority: CheckpointTimeAuthorityMetadata = {
        source: authority.source, owner: authority.owner, authorityRef: authority.authorityRef,
      };
      if (!request.ownerId.trim()) {
        throw new AppLifecycleError(
          'semantic-history-owner-missing',
          'semantic context-view commit requires an owner',
          'provide the runtime semantic-history owner',
          'app-checkpoint-journal',
        );
      }
      const accepted = request.accepted;
      const turn = projectAdmittedTurnIdentityV1(accepted.version === 2 ? accepted.segment.originalAdmittedTurn : accepted.admittedTurn);
      const scope = accepted.checkpoint.checkpoint.scope;
      const identity = await contextViewIdentityV1({ turn, checkpoint: accepted.checkpoint.checkpoint });

      const bytes = encodeSemanticAssetBodyV1(accepted.semantics);
      const digest = await semanticAssetDigestV1(accepted.semantics);
      const reference = await assets.write(semanticAssetIdV1(digest), bytes);
      if (reference.digest !== digest || reference.size !== bytes.length) {
        throw new AppLifecycleError(
          'semantic-history-asset-mismatch',
          'immutable semantic asset does not match its projected bytes',
          'repair the immutable asset store before publishing semantic history',
          'app-checkpoint-journal',
        );
      }
      const descriptor: SemanticAssetDescriptorV1 = {
        assetId: reference.assetId,
        digest: reference.digest as SemanticHistoryDigestV1,
        locator: reference.locator,
        size: reference.size,
      };
      const expectedIntent = accepted.version === 2 ? await contextViewIntentDigestV2({
        segment: accepted.segment,
        checkpoint: accepted.checkpoint,
        acceptance: accepted.acceptance,
        semanticAsset: descriptor,
        adoptedChildren: accepted.adoptedChildren,
        evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
        recovery: accepted.recovery,
      }) : await contextViewIntentDigestV1({
        turn,
        checkpoint: accepted.checkpoint,
        acceptance: accepted.acceptance,
        semanticAsset: descriptor,
        adoptedChildren: accepted.adoptedChildren,
        evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
        recovery: accepted.recovery,
      });

      return await journal.transaction<{ readonly existing?: JournalRecord }, SemanticPhaseReceiptV1>(
        ({ records }) => ({ existing: records.find((record) => record.commitId === identity) }),
        async ({ existing }, append) => {
          if (existing) {
            const persisted = await contextViewBody(existing);
            if (persisted.identity !== identity) identityCollision(identity, existing);
            if (persisted.intentDigest !== expectedIntent) {
              throw new AppLifecycleError(
                'semantic-history-intent-conflict',
                `context-view identity is already committed with a different intent: ${identity}`,
                'preserve the committed view and use the original intent or a new checkpoint identity',
                'app-checkpoint-journal',
              );
            }
            return await phaseReceipt({
              record: existing,
              phase: 'context-view',
              identity,
              committedAt: persisted.committedAt,
              authority: persisted.timeAuthority,
              scope,
            });
          }
          const committedAt = await authority.sampleCommittedAt();
          const body = accepted.version === 2
            ? await buildSemanticContextViewBodyV2({ accepted, semanticAsset: descriptor, committedAt, timeAuthority })
            : await buildSemanticContextViewBodyV1({ accepted, semanticAsset: descriptor, committedAt, timeAuthority });
          const appended = await append({ commitId: identity, kind: 'event', scope, payload: body as unknown as Record<string, unknown> });
          return await phaseReceipt({
            record: appended,
            phase: 'context-view',
            identity,
            committedAt: body.committedAt,
            authority: body.timeAuthority,
            scope,
          });
        },
      );
    },

    async commitContextViewV2(request: SemanticContextViewCommitRequestV2): Promise<SemanticPhaseReceiptV1> {
      return port.commitContextView(request);
    },

    async commitHistoryPublication(request: SemanticHistoryPublicationCommitRequest | SemanticHistoryPublicationCommitRequestV2): Promise<SemanticPhaseReceiptV1> {
      if (!request.ownerId.trim()) {
        throw new AppLifecycleError(
          'semantic-history-owner-missing',
          'semantic history-publication commit requires an owner',
          'provide the runtime semantic-history owner',
          'app-checkpoint-journal',
        );
      }
      const scope = request.checkpoint.checkpoint.scope;
      const identity = await historyPublicationIdentityV1({
        turn: request.turn,
        checkpoint: request.checkpoint.checkpoint,
      });
      const expectedIntent = 'segment' in request ? await historyPublicationIntentDigestV2(request) : await historyPublicationIntentDigestV1({
        turn: request.turn,
        checkpoint: request.checkpoint,
        contextView: request.contextView,
      });
      const viewReceipt = parseJournalReceipt(request.contextView.receipt.journalReceiptRef);
      const scopeHash = await scopeDigest(scope);
      if (viewReceipt.scopeDigest !== scopeHash) {
        throw new AppLifecycleError(
          'semantic-history-phase-scope-mismatch',
          'context-view receipt scope does not match the publication checkpoint scope',
          'read the actual context-view receipt for this checkpoint before publishing',
          'app-checkpoint-journal',
        );
      }

      return await journal.transaction<
        { readonly existing?: JournalRecord; readonly view?: JournalRecord },
        SemanticPhaseReceiptV1
      >(
        ({ records }) => ({
          existing: records.find((record) => record.commitId === identity),
          view: exactSemanticJournalRecord(records, viewReceipt.seq, viewReceipt.digestHex),
        }),
        async ({ existing, view }, append) => {
          if (!view) {
            throw new AppLifecycleError(
              'semantic-history-context-view-missing',
              `context-view receipt is not committed: ${request.contextView.receipt.journalReceiptRef}`,
              'commit the exact context view before publishing semantic history',
              'app-checkpoint-journal',
            );
          }
          if (!sameScope(view.scope, scope)) {
            throw new AppLifecycleError(
              'semantic-history-phase-scope-mismatch',
              'context-view record scope does not match the publication checkpoint scope',
              'read the actual context-view receipt for this checkpoint before publishing',
              'app-checkpoint-journal',
            );
          }
          const viewBody = await contextViewBody(view);
          if (viewBody.identity !== request.contextView.identity) {
            throw new AppLifecycleError(
              'semantic-history-phase-identity-mismatch',
              'context-view receipt does not carry the referenced view identity',
              'read the actual context-view receipt before publishing',
              'app-checkpoint-journal',
            );
          }
          const actualViewReceipt = await phaseReceipt({
            record: view,
            phase: 'context-view',
            identity: viewBody.identity,
            committedAt: viewBody.committedAt,
            authority: viewBody.timeAuthority,
            scope: viewBody.checkpoint.checkpoint.scope,
          });
          if (!sameSemanticPhaseReceipt(actualViewReceipt, request.contextView.receipt)) {
            throw new AppLifecycleError(
              'semantic-history-phase-receipt-mismatch',
              'context-view receipt does not match the committed context-view record',
              'read the actual context-view receipt before publishing',
              'app-checkpoint-journal',
            );
          }
          if (existing) {
            const persisted = await publicationBody(existing);
            if (persisted.identity !== identity) identityCollision(identity, existing);
            if (persisted.intentDigest !== expectedIntent) {
              throw new AppLifecycleError(
                'semantic-history-intent-conflict',
                `history-publication identity is already committed with a different intent: ${identity}`,
                'preserve the committed publication and use the original intent or a new checkpoint identity',
                'app-checkpoint-journal',
              );
            }
            return await phaseReceipt({
              record: existing,
              phase: 'history-publication',
              identity,
              committedAt: persisted.committedAt,
              authority: persisted.timeAuthority,
              scope,
            });
          }
          const authority = writeAuthority();
          const timeAuthority: CheckpointTimeAuthorityMetadata = {
            source: authority.source, owner: authority.owner, authorityRef: authority.authorityRef,
          };
          const committedAt = await authority.sampleCommittedAt();
          const body = 'segment' in request
            ? await buildSemanticHistoryPublicationBodyV2({ ...request, committedAt, timeAuthority })
            : await buildSemanticHistoryPublicationBodyV1({ ...request, committedAt, timeAuthority });
          const appended = await append({ commitId: identity, kind: 'event', scope, payload: body as unknown as Record<string, unknown> });
          return await phaseReceipt({
            record: appended,
            phase: 'history-publication',
            identity,
            committedAt: body.committedAt,
            authority: body.timeAuthority,
            scope,
          });
        },
      );
    },

    async commitHistoryPublicationV2(request: SemanticHistoryPublicationCommitRequestV2): Promise<SemanticPhaseReceiptV1> {
      return port.commitHistoryPublication(request);
    },

    async readContextViewByIdentity(request: { readonly scope: ScopeRef; readonly identity: string }) {
      const record = (await verifiedRecords()).find((record) => record.commitId === request.identity);
      if (!record) return null;
      if (!sameScope(record.scope, request.scope)) throw new Error('context view identity scope mismatch');
      return contextViewBody(record);
    },

    async readHistoryPublicationByIdentity(request: { readonly scope: ScopeRef; readonly identity: string }) {
      const record = (await verifiedRecords()).find((record) => record.commitId === request.identity);
      if (!record) return null;
      if (!sameScope(record.scope, request.scope)) throw new Error('history publication identity scope mismatch');
      return publicationBody(record);
    },

    async readContextView(request: {
      readonly scope: ScopeRef;
      readonly contextViewReceiptRef: string;
    }): Promise<SemanticContextViewBodyV1 | SemanticContextViewBodyV2 | null> {
      const parsed = parseJournalReceipt(request.contextViewReceiptRef);
      if (parsed.scopeDigest !== await scopeDigest(request.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'context-view receipt scope does not match the requested scope',
          'request the exact context view by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const records = await verifiedRecords();
      const record = exactSemanticJournalRecord(records, parsed.seq, parsed.digestHex);
      if (!record) return null;
      if (!sameScope(record.scope, request.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'context-view record scope does not match the requested scope',
          'request the exact context view by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      return await contextViewBody(record);
    },

    async readCommittedSemanticCheckpoint(
      lookup: SemanticHistoryExactLookupV1,
    ): Promise<CommittedSemanticCheckpoint | null> {
      validateSemanticHistoryExactLookupV1(lookup);
      const records = await verifiedRecords();
      const parsed = parseJournalReceipt(lookup.publicationReceiptRef);
      if (parsed.scopeDigest !== await scopeDigest(lookup.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'publication receipt scope does not match the requested scope',
          'request the exact publication by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const publicationRecord = exactSemanticJournalRecord(records, parsed.seq, parsed.digestHex);
      if (!publicationRecord) return null;
      if (!sameScope(publicationRecord.scope, lookup.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'publication record scope does not match the requested scope',
          'request the exact publication by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const publication = await publicationBody(publicationRecord);
      const expectedPublicationIdentity = await historyPublicationIdentityV1({
        turn: publication.turn,
        checkpoint: publication.checkpoint.checkpoint,
      });
      if (publication.identity !== expectedPublicationIdentity) {
        throw new AppLifecycleError(
          'semantic-history-body-identity-mismatch',
          'publication identity does not match its turn and checkpoint',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (publication.checkpoint.checkpoint.id.scope !== lookup.checkpoint.id.scope
        || publication.checkpoint.checkpoint.id.value !== lookup.checkpoint.id.value
        || !sameScope(publication.checkpoint.checkpoint.scope, lookup.checkpoint.scope)) {
        throw new AppLifecycleError(
          'semantic-history-lookup-checkpoint-mismatch',
          'publication does not reference the requested checkpoint',
          'request the exact publication for this checkpoint',
          'app-checkpoint-journal',
        );
      }

      const viewParsed = parseJournalReceipt(publication.contextView.receipt.journalReceiptRef);
      const viewRecord = exactSemanticJournalRecord(records, viewParsed.seq, viewParsed.digestHex);
      if (!viewRecord) {
        throw new AppLifecycleError(
          'semantic-history-context-view-missing',
          `publication references an uncommitted context view: ${publication.contextView.receipt.journalReceiptRef}`,
          'preserve the committed journal and repair the missing context-view record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (!sameScope(viewRecord.scope, lookup.scope)) {
        throw new AppLifecycleError(
          'semantic-history-receipt-scope-mismatch',
          'context-view record scope does not match the requested scope',
          'request the exact publication by its committed scope and receipt',
          'app-checkpoint-journal',
        );
      }
      const view = await contextViewBody(viewRecord);
      if (view.identity !== publication.contextView.identity) {
        throw new AppLifecycleError(
          'semantic-history-phase-identity-mismatch',
          'publication context-view identity does not match the committed context view',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      const actualViewReceipt = await phaseReceipt({
        record: viewRecord,
        phase: 'context-view',
        identity: view.identity,
        committedAt: view.committedAt,
        authority: view.timeAuthority,
        scope: view.checkpoint.checkpoint.scope,
      });
      if (!sameSemanticPhaseReceipt(actualViewReceipt, publication.contextView.receipt)) {
        throw new AppLifecycleError(
          'semantic-history-phase-receipt-mismatch',
          'publication context-view receipt does not match the committed context view',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }

      const checkpointRelationship = await checkpoints.readNativeCheckpoint({
        checkpoint: view.checkpoint.checkpoint,
      });
      if (!checkpointRelationship) {
        throw new AppLifecycleError(
          'semantic-history-checkpoint-missing',
          `semantic view references an uncommitted native checkpoint: ${view.checkpoint.checkpoint.id.value}`,
          'preserve the committed journal and repair the checkpoint record before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (canonicalJsonStringify(checkpointRelationship) !== canonicalJsonStringify(view.checkpoint)) {
        throw new AppLifecycleError(
          'semantic-history-checkpoint-mismatch',
          'semantic view checkpoint binding does not match the committed native checkpoint',
          'preserve the committed journal and repair the checkpoint binding before reading semantic history',
          'app-checkpoint-journal',
        );
      }
      if (canonicalJsonStringify(publication.checkpoint) !== canonicalJsonStringify(checkpointRelationship)
        || canonicalJsonStringify(publication.turn) !== canonicalJsonStringify(view.turn)) {
        throw new AppLifecycleError(
          'semantic-history-publication-binding-mismatch',
          'publication does not bind the committed context view turn and checkpoint',
          'preserve the committed journal and repair the publication record before reading semantic history',
          'app-checkpoint-journal',
        );
      }

      const semantics = decodeSemanticAssetBody(await assets.read(view.semanticAsset));
      if (view.version === 2) {
        if (publication.version !== 2 || canonicalJsonStringify(publication.segment) !== canonicalJsonStringify(view.segment)) {
          throw new Error('semantic publication segment mismatch');
        }
        if (!input.segmentJournalFor) throw new Error('segment Journal is required for semantic v2 cold read');
        const segmentRecords = await input.segmentJournalFor(view.turn.turnId).readSegmentRecords({
          businessTurnId: view.turn.turnId,
          segmentId: view.segment.opened.segmentId,
        });
        await assertCompleteSegmentAdoptions({ segment: view.segment, children: view.adoptedChildren, records: segmentRecords, rawContent: input.rawContent });
        return projectCommittedSemanticCheckpointV2({
          turn: view.turn,
          segment: view.segment,
          checkpoint: checkpointRelationship,
          contextView: actualViewReceipt,
          historyPublication: await phaseReceipt({
            record: publicationRecord, phase: 'history-publication', identity: publication.identity,
            committedAt: publication.committedAt, authority: publication.timeAuthority, scope: lookup.scope,
          }),
          semantics,
          evidenceRefs: view.evidenceRefs,
          adoptedChildren: view.adoptedChildren,
          recovery: view.recovery,
        });
      }
      if (publication.version !== 1) throw new Error('semantic publication version mismatch');
      const adoptedChildren: AdoptedChildSourceV1[] = [];
      const activeTurnRecords = await input.activeTurnJournalFor(view.turn.turnId).replay();
      for (const source of view.adoptedChildren) {
        const materialized = await materializeAdoptedChildSource({
          source,
          records: activeTurnRecords,
          rawContent: input.rawContent,
        });
        const expectedDigest = materialized.source.refinedDelivery.ref.digest;
        if (expectedDigest !== undefined) {
          const actualDigest = `sha256:${createHash('sha256').update(materialized.bytes).digest('hex')}`;
          if (actualDigest !== expectedDigest) {
            throw new AppLifecycleError(
              'semantic-history-adoption-asset-mismatch',
              `adopted refinement bytes do not match their descriptor: ${materialized.source.invocationId}`,
              'repair the refined delivery asset before reading semantic history',
              'app-checkpoint-journal',
            );
          }
        }
        adoptedChildren.push(materialized.source);
      }

      return await projectCommittedSemanticCheckpointV1({
        turn: view.turn,
        checkpoint: checkpointRelationship,
        contextView: actualViewReceipt,
        historyPublication: await phaseReceipt({
          record: publicationRecord,
          phase: 'history-publication',
          identity: publication.identity,
          committedAt: publication.committedAt,
          authority: publication.timeAuthority,
          scope: lookup.scope,
        }),
        semantics,
        evidenceRefs: view.evidenceRefs,
        adoptedChildren,
        recovery: view.recovery,
      });
    },
  };
  return port;
}

/** Five real phase adapters. Progress projects receipts from these same Journal owners. */
export function createJsonlNativeSegmentSave(input: {
  readonly filePath: string;
  readonly journal: JsonlOrganJournal;
  readonly artifactsRoot: string;
  readonly activeTurnJournal: ActiveTurnJournalPort;
  readonly segmentJournal: ActiveTurnSegmentJournalPort;
  /** Actual shared completion port; recovery-assets cold reads resolve real completion truth through it. */
  readonly completionJournal?: OperationCompletionJournalPort;
  readonly rawContent: RawContentReadPort;
  readonly timeAuthority: CheckpointTimeAuthority;
  /** Exact frozen producer capture, selected by the intent's pre-existing captureRef. */
  readonly readPreparedCapture: (captureRef: string) => Promise<PreparedActiveTurnSegmentCaptureV2>;
  /** Runtime closure owner supplies the actual closure decision after checkpoint commit. */
  readonly prepareClosure: (intent: NativeSegmentSaveIntentV2, checkpoint: CheckpointReceiptRelationshipV1) => Promise<CheckpointClosureRecord>;
}) {
  const journal = input.journal;
  const checkpoints = createJsonlCheckpointJournal({ filePath: input.filePath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath: input.filePath, journal });
  const recovery = createNativeRecoveryAssets({ journalPath: input.filePath, journal, assetRoot: input.artifactsRoot,
    ...(input.completionJournal === undefined ? {} : { completionJournal: input.completionJournal }) });
  const semantic = createJsonlSemanticHistoryJournal({ ...input, journal });
  const progress = createJsonlNativeSaveProgressPort({ journal });

  function segmentIntent(intent: NativeSaveIntent): NativeSegmentSaveIntentV2 {
    if (!isNativeSegmentSaveIntentV2(intent)) throw new Error('segment save requires a version 2 intent');
    return intent;
  }

  async function checkpoint(intent: NativeSegmentSaveIntentV2) {
    const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: intent.key.checkpoint });
    if (!relationship) throw new Error('native stage requires the exact committed checkpoint');
    return relationship;
  }

  async function receipt(phase: NativeSavePhase, intent: NativeSegmentSaveIntentV2, record: JournalRecord,
    committedAt: string, authority: CheckpointTimeAuthorityMetadata): Promise<NativeSavePhaseReceipt> {
    if (!record.commitId || !sameScope(record.scope, intent.key.turn.scopeRef)) throw new Error('native phase record identity/scope mismatch');
    return {
      phase, commitIdentity: record.commitId,
      journalReceiptRef: `humanagent://journal-record/v1/${await scopeDigest(record.scope)}/${record.seq}/${record.recordDigest.slice(7)}`,
      journalSeq: record.seq, recordDigest: record.recordDigest, committedAt,
      intentDigest: intent.inputIntentDigest, timeAuthority: authority,
    };
  }

  async function capture(intent: NativeSegmentSaveIntentV2) {
    const prepared = await input.readPreparedCapture(intent.recoveryAssets.captureRef);
    if (prepared.body.segmentId !== intent.source.opened.segmentId
      || prepared.body.cut.pauseId !== intent.key.boundaryId
      || canonicalJsonStringify(prepared.body.binding) !== canonicalJsonStringify(intent.source.opened.binding)) {
      throw new Error('native capture does not match the fixed segment source');
    }
    const ref = segmentRecoveryAssetsReceiptRef({
      businessTurnId: intent.key.turn.turnId, segmentId: prepared.body.segmentId,
      boundaryId: intent.key.boundaryId, cut: prepared.body.cut,
      captureDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(prepared.body)).digest('hex')}`,
      controlRecordCount: prepared.controlRecordCount,
    });
    return { prepared, ref };
  }

  async function exact(phase: NativeSavePhase, value: NativeSaveIntent): Promise<NativeSavePhaseReceipt | null> {
    const intent = segmentIntent(value);
    if (phase === 'recovery-assets') {
      const selected = await capture(intent);
      const record = (await verifiedJournalRecords(journal)).find((record) => record.commitId === selected.ref);
      if (!record) return null;
      const read = await recovery.readSegmentRecoveryAssetsExact(selected.ref);
      return receipt(phase, intent, record, read.prepared.body.cut.frozenAt, intent.checkpoint.timeAuthority);
    }
    if (phase === 'checkpoint') {
      const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: intent.key.checkpoint });
      if (!relationship) return null;
      const record = (await verifiedJournalRecords(journal)).find((record) => record.commitId === relationship.envelope.identity);
      if (!record) throw new Error('native checkpoint receipt has no Journal record');
      return receipt(phase, intent, record, relationship.envelope.committedAt, relationship.envelope.timeAuthority);
    }
    const relationship = await checkpoint(intent);
    if (phase === 'closure') {
      const closure = await closures.read(intent.closure.closureId);
      if (!closure) return null;
      if (!('closureKind' in closure) || closure.closureKind !== 'checkpoint'
        || closure.checkpointId.value !== intent.key.checkpoint.id.value
        || closure.source !== intent.closure.source || closure.summary !== intent.closure.closureSummary
        || canonicalJsonStringify(closure.evidenceRefs) !== canonicalJsonStringify(intent.closure.closureEvidenceRefs)) {
        throw new Error('native closure does not match the fixed closure selectors');
      }
      const record = (await verifiedJournalRecords(journal)).find((record) => record.commitId === closureJournalCommitId(closure.closureId));
      if (!record) throw new Error('native closure has no Journal record');
      return receipt(phase, intent, record, relationship.envelope.committedAt, relationship.envelope.timeAuthority);
    }
    const key = { turn: intent.key.turn, checkpoint: intent.key.checkpoint };
    const identity = phase === 'context-view' ? await contextViewIdentityV1(key) : await historyPublicationIdentityV1(key);
    const body = phase === 'context-view'
      ? await semantic.readContextViewByIdentity!({ scope: intent.key.turn.scopeRef, identity: await contextViewIdentityV1(key) })
      : await semantic.readHistoryPublicationByIdentity!({ scope: intent.key.turn.scopeRef, identity: await historyPublicationIdentityV1(key) });
    if (!body) return null;
    const record = (await verifiedJournalRecords(journal)).find((record) => record.commitId === identity);
    if (!record) throw new Error('semantic phase body has no Journal record');
    return receipt(phase, intent, record, body.committedAt, body.timeAuthority);
  }

  async function commit(phase: NativeSavePhase, value: NativeSaveIntent): Promise<NativeSavePhaseReceipt> {
    const intent = segmentIntent(value);
    if (phase === 'recovery-assets') {
      const selected = await capture(intent);
      await recovery.writeSegmentCapturePhase({ businessTurnId: intent.key.turn.turnId,
        segmentId: intent.key.segment.segmentId, boundaryId: intent.key.boundaryId, prepared: selected.prepared });
    } else if (phase === 'checkpoint') {
      await checkpoints.commitNativeCheckpoint({ ownerId: intent.ownerId,
        checkpoint: intent.checkpoint.checkpoint, timeAuthority: input.timeAuthority });
    } else if (phase === 'closure') {
      const closure = await input.prepareClosure(intent, await checkpoint(intent));
      await closures.commit(closure);
    } else if (phase === 'context-view') {
      await semantic.commitContextViewV2!({ ownerId: intent.ownerId, accepted: {
        version: 2, segment: intent.source, checkpoint: await checkpoint(intent),
        acceptance: intent.contextView.acceptance, semantics: intent.contextView.semantics,
        adoptedChildren: intent.contextView.adoptedChildren, recovery: intent.contextView.recovery,
      } });
    } else {
      const view = await exact('context-view', intent);
      if (!view) throw new Error('history publication requires an actual context-view receipt');
      await semantic.commitHistoryPublicationV2!({ ownerId: intent.ownerId, turn: intent.key.turn, segment: intent.source,
        checkpoint: await checkpoint(intent), contextView: {
          identity: await contextViewIdentityV1({ turn: intent.key.turn, checkpoint: intent.key.checkpoint }),
          receipt: { phase: 'context-view', commitIdentity: view.commitIdentity, journalReceiptRef: view.journalReceiptRef,
            journalSeq: view.journalSeq, recordDigest: assertSemanticRecordDigest(view.recordDigest),
            committedAt: view.committedAt, timeAuthority: view.timeAuthority },
        } });
    }
    const actual = await exact(phase, intent);
    if (!actual) throw new Error(`native ${phase} owner returned without an exact receipt`);
    return actual;
  }

  const ports: NativeSavePorts = {
    'recovery-assets': { commit: (intent) => commit('recovery-assets', intent), readExact: (intent) => exact('recovery-assets', intent) },
    checkpoint: { commit: (intent) => commit('checkpoint', intent), readExact: (intent) => exact('checkpoint', intent) },
    closure: { commit: (intent) => commit('closure', intent), readExact: (intent) => exact('closure', intent) },
    'context-view': { commit: (intent) => commit('context-view', intent), readExact: (intent) => exact('context-view', intent) },
    'history-publication': { commit: (intent) => commit('history-publication', intent), readExact: (intent) => exact('history-publication', intent) },
  };
  const controller = createNativeBoundarySaveController(progress, ports);
  return { ports, progress, semantic, controller: {
    async run(value: NativeSaveIntent) {
      const intent = segmentIntent(value);
      const initial = await input.segmentJournal.readInitialSegmentCapture(intent.key.turn.turnId);
      const opened = (await input.segmentJournal.readSegments(intent.key.turn.turnId))
        .find((record) => record.segmentId === intent.key.segment.segmentId);
      const openedRecord = (await verifiedJournalRecords(journal)).find((record) =>
        record.commitId === activeTurnSegmentCommitId(intent.key.segment.segmentId, 'segment-opened'));
      if (!initial || !opened || !openedRecord
        || canonicalJsonStringify(initial.body.binding.admittedTurn) !== canonicalJsonStringify(intent.source.originalAdmittedTurn)
        || canonicalJsonStringify(initial.bindingCommitRef) !== canonicalJsonStringify(intent.source.originalBusinessTurnRef.bindingCommitRef)
        || canonicalJsonStringify(opened) !== canonicalJsonStringify(intent.source.opened)
        || canonicalJsonStringify(journalCommitRef(openedRecord)) !== canonicalJsonStringify(intent.source.openedCommitRef)) {
        throw new Error('native save source does not match the actual original binding and opened segment');
      }
      if (canonicalJsonStringify(intent.contextView.source) !== canonicalJsonStringify(intent.source)
        || canonicalJsonStringify(intent.recoveryAssets.source) !== canonicalJsonStringify(intent.source)) {
        throw new Error('native phase selectors do not match the fixed segment source');
      }
      await assertCompleteSegmentAdoptions({ segment: intent.source, children: intent.contextView.adoptedChildren,
        records: await input.segmentJournal.readSegmentRecords({ businessTurnId: intent.key.turn.turnId, segmentId: intent.key.segment.segmentId }),
        rawContent: input.rawContent });
      return controller.run(intent);
    },
  } };
}

/** Fresh async hook over the live Runtime owner plus exact Journal history. */
export function createNativeSegmentRequestContext(input: {
  readonly activeTurn: ActiveTurnSegmentContext;
  readonly segmentJournal: ActiveTurnSegmentJournalPort;
  readonly history: SemanticHistoryPersistencePort;
  readonly priorCompletedTurns: readonly SemanticHistoryExactLookupV1[];
  readonly rawContent: RawContentReadPort;
  readonly rules: readonly string[];
  readonly orientation: (request: Parameters<ProviderRequestContextHook>[0]) => Promise<string | undefined>;
}): ProviderRequestContextHook {
  return async (request) => {
    const binding = input.activeTurn.segmentBinding();
    if (request.execution.runtimeId !== binding.execution.runtimeId
      || request.execution.executionEpoch !== binding.execution.executionEpoch
      || request.execution.taskId.value !== binding.assignment.taskId.value) {
      throw new Error('request context execution does not match the live segment');
    }
    const turnId = binding.businessTurnRef.businessTurnId;
    const initial = await input.segmentJournal.readInitialSegmentCapture(turnId);
    if (!initial) throw new Error('request context requires the actual original capture');
    const resolved = await readResumedSegmentSemanticTurnContext({
      history: input.history,
      priorCompletedTurns: input.priorCompletedTurns,
      segment: { chain: { businessTurnRef: binding.businessTurnRef, initial: initial.body,
        segments: await input.segmentJournal.readSegments(turnId) },
        exactReads: input.segmentJournal,
        live: { prefix: await input.activeTurn.readLivePrefix(), rawContent: input.rawContent } },
      runtimeId: binding.execution.runtimeId, scope: binding.scope, assignment: binding.assignment,
      rules: input.rules, orientation: await input.orientation(request),
    });
    const units: ProviderRequestContextUnit[] = [];
    const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const message of resolved.context.messages) {
      if (message.kind === 'semantic-turn-prefix') {
        units.push({ kind: 'message', role: 'user', text: canonicalJsonStringify({
          objective: message.objective, rules: message.rules, successCriteria: message.successCriteria,
          failureCriteria: message.failureCriteria, incompleteCriteria: message.incompleteCriteria,
        }) });
      } else if (message.kind === 'semantic-checkpoint') {
        units.push({ kind: 'message', role: 'assistant', text: canonicalJsonStringify({
          goal: message.checkpoint.goal, actions: message.checkpoint.did,
          result: message.checkpoint.result, nextStep: message.checkpoint.next,
        }) });
      } else if (message.kind === 'refined-child') {
        units.push({ kind: 'message', role: 'assistant', text: text(message.bytes) });
      } else {
        const unit = message.message;
        if (unit.kind === 'initial-input') units.push({ kind: 'message', role: 'user', text: text(unit.bytes) });
        else if (unit.kind === 'content') units.push({ kind: 'message', role: 'assistant', text: text(unit.bytes) });
        else if (unit.kind === 'tool-call') units.push({ kind: 'tool-call', callId: unit.callId, toolId: unit.toolId, arguments: unit.arguments });
        else units.push({ kind: 'tool-result', callId: unit.callId, toolId: unit.toolId, output: text(unit.rawOutput), status: unit.status });
      }
    }
    return { canonical: { units }, ...(resolved.instructions === undefined ? {} : { instructions: resolved.instructions }) };
  };
}

export function checkpointEvidenceText(checkpoint: Checkpoint): string {
  return JSON.stringify(checkpoint);
}

export function checkpointEvidenceDigest(checkpoint: Checkpoint): string {
  return `sha256:${createHash('sha256').update(checkpointEvidenceText(checkpoint)).digest('hex')}`;
}

export function checkpointEvidenceLocator(checkpoint: Pick<Checkpoint, 'id'>): string {
  return `${CHECKPOINT_EVIDENCE_PREFIX}${checkpoint.id.value}`;
}

export function checkpointClosureEvidenceLocator(closureId: string): string {
  return `humanagent://checkpoint-closure/${closureId}`;
}

export function checkpointClosureEvidenceText(closure: ClosureRecord): string {
  return JSON.stringify(closure);
}

export function checkpointClosureEvidenceDigest(closure: ClosureRecord): string {
  return `sha256:${createHash('sha256').update(checkpointClosureEvidenceText(closure)).digest('hex')}`;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function canonicalScope(scope: ScopeRef): Record<string, unknown> {
  return {
    organId: { scope: scope.organId.scope, value: scope.organId.value },
    taskId: scope.taskId ? { scope: scope.taskId.scope, value: scope.taskId.value } : null,
    cycleId: scope.cycleId ? { scope: scope.cycleId.scope, value: scope.cycleId.value } : null,
    operationId: scope.operationId ? { scope: scope.operationId.scope, value: scope.operationId.value } : null,
  };
}

/** The typed Journal commit reference of one already-committed record. */
function journalCommitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw new AppLifecycleError(
      'checkpoint-journal-record-uncommitted',
      `journal record ${record.seq} carries no commit id`,
      'recommit the record through a typed commit identity before reading its reference',
      'app-checkpoint-journal',
    );
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

async function verifiedJournalRecords(journal: JsonlOrganJournal): Promise<readonly JournalRecord[]> {
  const verification = await journal.verify();
  if (!verification.valid) {
    throw new AppLifecycleError(
      'checkpoint-journal-corrupt',
      verification.error ?? 'checkpoint journal is invalid',
      'preserve the checkpoint journal and repair its committed history before reading',
      'app-checkpoint-journal',
    );
  }
  return verification.records;
}

function checkpointIndex(records: readonly JournalRecord[]): Map<string, Checkpoint> {
  const index = new Map<string, Checkpoint>();
  for (const record of records) {
    if (record.kind === 'checkpoint' && record.checkpoint) {
      index.set(`${record.checkpoint.id.scope}:${record.checkpoint.id.value}`, record.checkpoint);
    }
  }
  return index;
}

function resolvePreviousCheckpoint(index: Map<string, Checkpoint>, checkpoint: Checkpoint): Checkpoint | null {
  if (checkpoint.previousCheckpointId === null) return null;
  const previous = index.get(`${checkpoint.previousCheckpointId.scope}:${checkpoint.previousCheckpointId.value}`);
  if (!previous) {
    throw new AppLifecycleError(
      'checkpoint-journal-corrupt',
      `checkpoint ${checkpoint.id.value} predecessor ${checkpoint.previousCheckpointId.value} is not committed`,
      'preserve the checkpoint journal and repair its committed chain',
      'app-checkpoint-journal',
    );
  }
  return previous;
}

export function conditionalReentryFromRecord(record: JournalRecord): ConditionalReentryRecord | null {
  const closure = closureFromRecord(record);
  if (!closure || !('closureKind' in closure) || closure.closureKind !== 'reentry') return null;
  if (!('schemaVersion' in closure) || closure.schemaVersion !== CONDITIONAL_REENTRY_SCHEMA_VERSION) return null;
  return closure as ConditionalReentryRecord;
}

function inTask(scope: ScopeRef, taskScope: ScopeRef): boolean {
  return scope.organId.value === taskScope.organId.value
    && scope.taskId?.value === taskScope.taskId?.value;
}

/** Typed committed segment carrier, shared by the canonical fold and durable floor read. */
export function segmentOpenedFromRecord(record: JournalRecord): ResumedTurnSegmentOpened | null {
  if (record.kind !== 'event' || record.payload?.['type'] !== 'active-turn.segment-record') return null;
  const value = record.payload['record'];
  if (!value || typeof value !== 'object' || (value as { readonly kind?: unknown }).kind !== 'segment-opened') return null;
  validateResumedTurnSegmentOpened(value);
  if (record.commitId !== activeTurnSegmentCommitId(value.segmentId, 'segment-opened')
    || !sameScope(record.scope, value.binding.scope)) {
    throw bindingCorrupt('committed segment carrier identity or scope does not match its binding');
  }
  return value;
}

/** Physical receipt comes from the verified carrier; no string-derived receipt. */
export async function readCommittedNativeSegmentSource(input: {
  readonly journal: JsonlOrganJournal;
  readonly originalAdmittedTurn: NativeSegmentSaveSourceV2['originalAdmittedTurn'];
  readonly opened: ResumedTurnSegmentOpened;
}): Promise<NativeSegmentSaveSourceV2> {
  const verification = await input.journal.verify();
  if (!verification.valid) throw bindingCorrupt(verification.error ?? 'segment Journal verification failed');
  const commitId = activeTurnSegmentCommitId(input.opened.segmentId, 'segment-opened');
  const record = verification.records.find((entry) => entry.commitId === commitId);
  const opened = record ? segmentOpenedFromRecord(record) : null;
  if (!record || !opened || canonicalJsonStringify(opened) !== canonicalJsonStringify(input.opened)) {
    throw bindingCorrupt('exact segment-opened physical carrier is absent or conflicts');
  }
  exactJournalRecord(verification.records, opened.businessTurnRef.bindingCommitRef);
  const original = decodeActiveTurnRecords(verification.records, opened.businessTurnRef.businessTurnId)
    .find((entry) => entry.kind === 'binding-opened');
  if (!original || original.kind !== 'binding-opened'
    || canonicalJsonStringify(original.binding.admittedTurn) !== canonicalJsonStringify(input.originalAdmittedTurn)) {
    throw bindingCorrupt('segment source original business admission is absent or conflicts');
  }
  return { originalAdmittedTurn: input.originalAdmittedTurn, originalBusinessTurnRef: opened.businessTurnRef,
    opened, openedCommitRef: journalCommitRef(record) };
}

/**
 * One execution-position fold for ordinary context publications and the
 * conditional record that owns a nested restored context, plus a committed
 * segment's exact-checkpoint incarnation handoff. The enclosing
 * physical reentry receipt is the context/control receipt for later writes.
 */
export function foldExecutionPositionFromRecords(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  base: ExecutionPosition,
): ExecutionPosition {
  let position = base;
  let context = contextHistoryFromRecord(exactJournalRecord(records, position.contextCommitRef));
  if (!context) throw bindingCorrupt('execution position context is missing');
  let pending: ResumedTurnSegmentOpened | null = null;
  for (const record of records) {
    if (!inTask(record.scope, taskScope)) continue;
    const segment = segmentOpenedFromRecord(record);
    if (segment && sameScope(segment.binding.scope, context.scope)
      && segment.binding.execution.executionEpoch > position.executionEpoch) {
      if (pending) throw bindingCorrupt('successor segment context is pending before another segment opened');
      const predecessor = segment.predecessor.segmentId === segment.businessTurnRef.businessTurnId
        ? segment.businessTurnRef.execution
        : records.filter((candidate) => candidate.seq < record.seq)
          .map(segmentOpenedFromRecord)
          .find((candidate) => candidate?.segmentId === segment.predecessor.segmentId
            && candidate.businessTurnRef.businessTurnId === segment.businessTurnRef.businessTurnId)?.binding.execution;
      if (!predecessor || predecessor.runtimeId !== context.agentRuntimeId
        || predecessor.executionEpoch !== position.executionEpoch) {
        throw bindingCorrupt('successor segment does not follow the canonical context incarnation');
      }
      pending = segment;
      continue;
    }
    if (record.seq <= position.controlCommitRef.journalSeq) continue;
    const transition = conditionalReentryFromRecord(record);
    if (transition) {
      if (pending) throw bindingCorrupt('successor segment context is pending before conditional reentry');
      if (!sameCommitRef(transition.expectedCurrentControlCommitRef, position.controlCommitRef)
        || transition.previousExecutionEpoch !== position.executionEpoch) {
        throw bindingCorrupt('conditional execution-position chain conflicts');
      }
      const ref = journalCommitRef(record);
      position = {
        checkpointCommitRef: transition.sourceCheckpointCommitRef,
        contextCommitRef: ref,
        controlCommitRef: ref,
        executionEpoch: transition.newExecutionEpoch,
      };
      context = transition.restoredContext;
      continue;
    }
    const candidate = contextHistoryFromRecord(record);
    if (!candidate) continue;
    if (pending) {
      const predecessor = candidate.loopCheckpoint.predecessor;
      if (sameScope(candidate.scope, pending.binding.scope)
        && candidate.agentRuntimeId === pending.binding.execution.runtimeId
        && candidate.contextView.executionEpoch === pending.binding.execution.executionEpoch
        && candidate.loopCheckpoint.executionEpoch === pending.binding.execution.executionEpoch
        && predecessor?.checkpointId.scope === context.loopCheckpoint.checkpointId.scope
        && predecessor.checkpointId.value === context.loopCheckpoint.checkpointId.value
        && predecessor.digest === context.loopCheckpoint.digest) {
        const ref = journalCommitRef(record);
        position = { ...position, executionEpoch: pending.binding.execution.executionEpoch,
          contextCommitRef: ref, controlCommitRef: ref };
        context = candidate;
        pending = null;
      }
      continue;
    }
    if (sameScope(candidate.scope, context.scope)
      && candidate.agentRuntimeId === context.agentRuntimeId
      && candidate.contextView.executionEpoch === position.executionEpoch
      && sameCommitRef(candidate.previousContextCommitRef ?? null, position.contextCommitRef)) {
      const ref = journalCommitRef(record);
      position = { ...position, contextCommitRef: ref, controlCommitRef: ref };
      context = candidate;
    }
  }
  if (pending) throw bindingCorrupt(`successor segment ${pending.segmentId} context is pending or has no exact predecessor checkpoint`);
  return position;
}

export function contextHistoryFromRecord(record: JournalRecord): ContextHistoryRecord | null {
  const transition = conditionalReentryFromRecord(record);
  if (transition) return transition.restoredContext;
  const payload = record.payload;
  if (payload?.['kind'] !== CONTEXT_HISTORY_PAYLOAD_KIND) return null;
  const value = payload['record'];
  if (
    typeof value !== 'object'
    || value === null
    || (value as { readonly kind?: unknown }).kind !== 'context-history'
  ) {
    throw new AppLifecycleError(
      'context-history-corrupt',
      `context history record ${record.seq} is malformed`,
      'preserve the checkpoint journal and repair the context history record before recovery',
      'app-checkpoint-journal',
    );
  }
  try { assertContextHistoryRecord(value as ContextHistoryRecord); }
  catch (error) {
    throw new AppLifecycleError('context-history-corrupt', error instanceof Error ? error.message : 'invalid context history',
      'preserve the Journal and repair the context body', 'app-checkpoint-journal');
  }
  return value as ContextHistoryRecord;
}

/** Canonical context identity hashed into a bounded Journal commit key. */
function contextHistoryCommitId(record: ContextHistoryRecord): string {
  const identity = JSON.stringify({
    scope: canonicalScope(record.scope),
    agentRuntimeId: record.agentRuntimeId,
    executionEpoch: record.contextView.executionEpoch,
    contextViewRef: record.contextView.contextViewRef,
    replacementId: record.replacement?.replacementId ?? null,
    predecessor: record.previousContextCommitRef?.commitId ?? null,
  });
  return `context-history:${createHash('sha256').update(identity).digest('hex')}`;
}

function latestContextRecord(
  records: readonly JournalRecord[],
  scope: ScopeRef,
  agentRuntimeId: string,
): JournalRecord | null {
  return [...records].reverse().find((record) => {
    const value = contextHistoryFromRecord(record);
    return value !== null && value.agentRuntimeId === agentRuntimeId && sameScope(value.scope, scope);
  }) ?? null;
}

export async function readCommittedCheckpoint(input: {
  readonly filePath: string;
  readonly scope: ScopeRef;
  readonly checkpointId: Checkpoint['id'];
}): Promise<{ readonly checkpoint: Checkpoint; readonly recordDigest: string }> {
  const journal = new JsonlOrganJournal(input.filePath);
  const verification = await journal.verify();
  if (!verification.valid) {
    throw new AppLifecycleError(
      'checkpoint-journal-corrupt',
      verification.error ?? 'checkpoint journal is invalid',
      'preserve the checkpoint journal and repair its committed history before publishing a memory boundary',
      'app-checkpoint-journal',
    );
  }
  const record = verification.records.find((candidate) =>
    candidate.kind === 'checkpoint'
    && candidate.checkpoint !== undefined
    && candidate.checkpoint.id.value === input.checkpointId.value
    && sameScope(candidate.checkpoint.scope, input.scope));
  if (!record?.checkpoint) {
    throw new AppLifecycleError(
      'checkpoint-evidence-missing',
      `checkpoint is not committed: ${input.checkpointId.value}`,
      'commit the checkpoint before publishing a memory boundary',
      'app-checkpoint-journal',
    );
  }
  return { checkpoint: record.checkpoint, recordDigest: record.recordDigest };
}

export async function readCheckpointEvidence(input: {
  readonly filePath: string;
  readonly scope: ScopeRef;
  readonly evidence: EvidenceRef;
}): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }> {
  const journal = new JsonlOrganJournal(input.filePath);
  const verification = await journal.verify();
  if (!verification.valid) {
    throw new AppLifecycleError(
      'checkpoint-journal-corrupt',
      verification.error ?? 'checkpoint journal is invalid',
      'preserve the checkpoint journal and repair its committed history before reading evidence',
      'app-checkpoint-journal',
    );
  }
  const record = verification.records.find((candidate) =>
    candidate.kind === 'checkpoint'
    && candidate.checkpoint !== undefined
    && scopeContains(input.scope, candidate.checkpoint.scope)
    && checkpointEvidenceLocator(candidate.checkpoint) === input.evidence.locator);
  if (!record?.checkpoint) {
    throw new AppLifecycleError(
      'checkpoint-evidence-missing',
      `checkpoint evidence is unavailable: ${input.evidence.locator}`,
      'refresh the checkpoint event from the authoritative journal',
      'app-checkpoint-journal',
    );
  }
  return {
    sourceRef: checkpointEvidenceLocator(record.checkpoint),
    sourceDigest: checkpointEvidenceDigest(record.checkpoint),
    text: checkpointEvidenceText(record.checkpoint),
  };
}

/**
 * Adapts the authoritative append-only Organ Journal to the checkpoint
 * coordinator port. This is the only app-side checkpoint persistence path;
 * SessionStore records only reference checkpoint ids and never become a
 * second source of task state.
 */
export function createJsonlCheckpointJournal(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
}): NativeCheckpointJournalPort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'checkpoint-journal-invalid',
      'checkpoint journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  async function verifyJournal(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'checkpoint-journal-corrupt',
        verification.error ?? 'checkpoint journal is invalid',
        'preserve the checkpoint journal and repair its committed history before committing or reading a checkpoint',
        'app-checkpoint-journal',
      );
    }
    return verification.records;
  }

  function nativeRecord(records: readonly JournalRecord[], commitIdentity: string): JournalRecord | undefined {
    return records.find((record) => record.commitId === commitIdentity);
  }

  function sameCheckpointIdentity(
    record: JournalRecord,
    checkpoint: Pick<Checkpoint, 'id' | 'scope'>,
  ): boolean {
    return record.kind === 'checkpoint'
      && record.checkpoint !== undefined
      && record.checkpoint.id.scope === checkpoint.id.scope
      && record.checkpoint.id.value === checkpoint.id.value
      && sameScope(record.checkpoint.scope, checkpoint.scope);
  }

  async function committedNativeRelationship(
    record: JournalRecord,
    expectedIdentity: CheckpointCommitIdentityV2,
  ): Promise<CheckpointReceiptRelationshipV1> {
    const checkpoint = record.checkpoint;
    const envelope = record.nativeCheckpointEnvelope;
    if (!checkpoint || !envelope) {
      throw new AppLifecycleError(
        'checkpoint-native-envelope-missing',
        `checkpoint record is not a native checkpoint-v2 commit: ${expectedIdentity}`,
        'preserve the committed record; do not upgrade legacy checkpoint evidence in place',
        'app-checkpoint-journal',
      );
    }
    await validateCheckpointCommitEnvelopeV1(envelope, { checkpoint, identity: expectedIdentity });
    const relationship: CheckpointReceiptRelationshipV1 = {
      checkpoint,
      envelope,
      receipt: {
        commitIdentity: expectedIdentity,
        checkpointRef: checkpointRefV2(expectedIdentity),
        journalReceiptRef: `humanagent://journal-record/v1/${await scopeDigest(checkpoint.scope)}/${record.seq}/${record.recordDigest.slice('sha256:'.length)}`,
        committedAt: envelope.committedAt,
        timeAuthority: envelope.timeAuthority,
      },
      checkpointSeq: checkpoint.seq,
      journalSeq: record.seq,
      recordDigest: record.recordDigest as CheckpointReceiptRelationshipV1['recordDigest'],
    };
    await validateCheckpointReceiptRelationship(relationship);
    return relationship;
  }

  function latestCheckpoint(records: readonly JournalRecord[], scope: ScopeRef): LatestCheckpointRecord | null {
    const checkpoints = records.filter((record) =>
      record.kind === 'checkpoint'
      && record.scope.organId.value === scope.organId.value
      && record.scope.taskId?.value === scope.taskId?.value
      && record.scope.cycleId?.value === scope.cycleId?.value
      && record.scope.operationId?.value === scope.operationId?.value);
    const latest = checkpoints.at(-1);
    if (!latest?.checkpoint) return null;
    const previous = checkpoints.at(-2)?.checkpoint ?? null;
    return {
      checkpoint: latest.checkpoint,
      previous,
      recordDigest: latest.recordDigest,
    };
  }

  return {
    async verify(scope: ScopeRef): Promise<CheckpointChainVerification> {
      const verification = await journal.verify();
      if (!verification.valid) {
        return {
          valid: false,
          reason: verification.error ?? 'journal verification failed',
        };
      }
      // The physical chain is verified across every scope above; a filtered
      // per-scope adjacency check is invalid once other scopes interleave.
      return { valid: true };
    },

    async readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null> {
      const verification = await journal.verify();
      if (!verification.valid) {
        throw new AppLifecycleError(
          'checkpoint-journal-corrupt',
          verification.error ?? 'checkpoint journal is invalid',
          'preserve the journal and repair its committed tail before recovery',
          'app-checkpoint-journal',
        );
      }
      return latestCheckpoint(verification.records, scope);
    },

    async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
      if (!input.ownerId.trim()) {
        throw new AppLifecycleError(
          'checkpoint-owner-missing',
          'checkpoint append requires an owner',
          'provide the runtime checkpoint owner',
          'app-checkpoint-journal',
        );
      }
      const record = await journal.transaction(
        ({ records }) => {
          assertPublicationNotFenced(records, {
            scope: input.checkpoint.scope,
            executionEpoch: input.checkpoint.executionEpoch,
          }, 'checkpoint publication');
          return { checkpoint: input.checkpoint };
        },
        async (_plan, append) => append({
          commitId: input.commitId,
          kind: 'checkpoint',
          scope: input.checkpoint.scope,
          checkpoint: input.checkpoint,
        }),
      );
      if (!record.checkpoint) {
        throw new AppLifecycleError(
          'checkpoint-append-mismatch',
          'journal append did not return the committed checkpoint',
          'inspect the checkpoint journal owner',
          'app-checkpoint-journal',
        );
      }
      return {
        checkpointId: record.checkpoint.id,
        seq: record.checkpoint.seq,
        recordDigest: record.recordDigest,
      };
    },

    async commitNativeCheckpoint(input: NativeCheckpointCommitRequest): Promise<CheckpointReceiptRelationshipV1> {
      if (!input.ownerId.trim()) {
        throw new AppLifecycleError(
          'checkpoint-owner-missing',
          'native checkpoint commit requires an owner',
          'provide the runtime checkpoint owner',
          'app-checkpoint-journal',
        );
      }
      const identity = await checkpointCommitIdentityV2({ checkpoint: input.checkpoint });
      const timeAuthority: CheckpointTimeAuthorityMetadata = {
        source: input.timeAuthority.source,
        owner: input.timeAuthority.owner,
        authorityRef: input.timeAuthority.authorityRef,
      };
      const intentDigest = await checkpointIntentDigestV1({
        checkpoint: input.checkpoint,
        timeAuthority,
      });

      return await journal.transaction<
        { readonly native?: JournalRecord; readonly legacy?: JournalRecord },
        CheckpointReceiptRelationshipV1
      >(
        ({ records }) => {
          const native = nativeRecord(records, identity);
          return {
            native,
            legacy: native === undefined
              ? records.find((record) => sameCheckpointIdentity(record, input.checkpoint))
              : undefined,
          };
        },
        async ({ native, legacy }, append) => {
          if (native) {
            if (native.nativeCheckpointEnvelope?.intentDigest !== intentDigest) {
              throw new AppLifecycleError(
                'checkpoint-native-conflict',
                `checkpoint identity is already committed with a different intent: ${identity}`,
                'preserve the committed native checkpoint and use the original intent or a new checkpoint identity',
                'app-checkpoint-journal',
              );
            }
            return await committedNativeRelationship(native, identity);
          }
          if (legacy) {
            throw new AppLifecycleError(
              'checkpoint-native-envelope-missing',
              `legacy checkpoint record occupies native identity: ${identity}`,
              'preserve the legacy record and choose a new checkpoint identity',
              'app-checkpoint-journal',
            );
          }

          const committedAt = await input.timeAuthority.sampleCommittedAt();
          const envelope: CheckpointCommitEnvelopeV1 = {
            version: 1,
            identity,
            committedAt,
            timeAuthority,
            intentDigest,
          };
          const appended = await append({
            commitId: identity,
            kind: 'checkpoint',
            scope: input.checkpoint.scope,
            checkpoint: input.checkpoint,
            nativeCheckpointEnvelope: envelope,
          });
          return await committedNativeRelationship(appended, identity);
        },
      );
    },

    async readNativeCheckpoint(input: {
      readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
    }): Promise<CheckpointReceiptRelationshipV1 | null> {
      const identity = await checkpointCommitIdentityV2({ checkpoint: input.checkpoint });
      const records = await verifyJournal();
      const existing = nativeRecord(records, identity);
      if (existing) return await committedNativeRelationship(existing, identity);
      if (records.some((record) => sameCheckpointIdentity(record, input.checkpoint))) {
        throw new AppLifecycleError(
          'checkpoint-native-envelope-missing',
          `checkpoint record has no native envelope: ${identity}`,
          'preserve the legacy record and do not treat it as a native checkpoint-v2 commit',
          'app-checkpoint-journal',
        );
      }
      return null;
    },

    async readCommitted(scope: ScopeRef, checkpointId: Checkpoint['id']): Promise<CommittedCheckpointRecord | null> {
      const records = await verifiedJournalRecords(journal);
      const record = [...records].reverse().find((candidate) =>
        candidate.kind === 'checkpoint'
        && candidate.checkpoint !== undefined
        && candidate.checkpoint.id.scope === checkpointId.scope
        && candidate.checkpoint.id.value === checkpointId.value
        && sameScope(candidate.checkpoint.scope, scope));
      if (!record?.checkpoint) return null;
      return {
        checkpoint: record.checkpoint,
        previous: resolvePreviousCheckpoint(checkpointIndex(records), record.checkpoint),
        commitRef: journalCommitRef(record),
      };
    },

    async listCommitted(query: CheckpointListQuery): Promise<CheckpointListResult> {
      if (query.occurrenceRef !== undefined) {
        throw new AppLifecycleError(
          'checkpoint-occurrence-unavailable',
          'occurrence checkpoint filter is unavailable: no occurrence binding producer',
          'omit the occurrence filter or produce the occurrence binding first',
          'app-checkpoint-journal',
        );
      }
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
        throw new AppLifecycleError(
          'checkpoint-list-limit-invalid',
          'checkpoint list limit must be a positive safe integer',
          'provide a positive checkpoint list limit',
          'app-checkpoint-journal',
        );
      }
      const cursor = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new AppLifecycleError(
          'checkpoint-list-cursor-invalid',
          'checkpoint list cursor must be a non-negative journal sequence',
          'restart the enumeration without a cursor',
          'app-checkpoint-journal',
        );
      }
      const records = await verifiedJournalRecords(journal);
      const index = checkpointIndex(records);
      const matches = records.filter((record) => {
        const checkpoint = record.kind === 'checkpoint' ? record.checkpoint : undefined;
        if (!checkpoint) return false;
        if (!scopeContains(query.scope, checkpoint.scope)) return false;
        if (query.directiveRevision !== undefined && checkpoint.directiveRevision !== query.directiveRevision) return false;
        if (query.executionEpoch !== undefined && checkpoint.executionEpoch !== query.executionEpoch) return false;
        if (query.cycleId !== undefined && (
          checkpoint.cycleId.scope !== query.cycleId.scope || checkpoint.cycleId.value !== query.cycleId.value
        )) return false;
        return true;
      });
      const afterCursor = matches.filter((record) => record.seq > cursor);
      const page = afterCursor.slice(0, query.limit);
      const checkpoints: CommittedCheckpointRecord[] = page.map((record) => {
        const checkpoint = record.checkpoint as Checkpoint;
        return {
          checkpoint,
          previous: resolvePreviousCheckpoint(index, checkpoint),
          commitRef: journalCommitRef(record),
        };
      });
      const last = page.at(-1);
      return {
        checkpoints,
        ...(afterCursor.length > page.length && last ? { nextCursor: String(last.seq) } : {}),
      };
    },

    async readExecutionPosition(taskScope: ScopeRef): Promise<ExecutionPosition | null> {
      const records = await verifiedJournalRecords(journal);
      const bindingRecord = [...records].reverse().find((record) => {
        const closure = closureFromRecord(record);
        return closure !== null
          && 'closureKind' in closure
          && closure.closureKind === 'checkpoint'
          && closure.recoveryBinding !== undefined
          && scopeContains(taskScope, record.scope);
      });
      if (!bindingRecord) return null;
      const closure = closureFromRecord(bindingRecord);
      if (!closure || !('closureKind' in closure) || closure.closureKind !== 'checkpoint' || !closure.recoveryBinding) {
        return null;
      }
      const binding = closure.recoveryBinding;
      assertRecoveryBinding(records, bindingRecord, closure);
      return foldExecutionPositionFromRecords(records, taskScope, {
        checkpointCommitRef: binding.checkpointCommitRef,
        contextCommitRef: binding.contextCommitRef,
        executionEpoch: binding.coreClosure.executionEpoch,
        controlCommitRef: journalCommitRef(bindingRecord),
      });
    },

    async readCheckpointRecoveryBinding(
      scope: ScopeRef,
      checkpointCommitRef: JournalCommitRef,
    ): Promise<CheckpointRecoveryBinding | null> {
      const records = await verifiedJournalRecords(journal);
      const record = [...records].reverse().find((candidate) => {
        const closure = closureFromRecord(candidate);
        return closure !== null && 'closureKind' in closure && closure.closureKind === 'checkpoint'
          && closure.recoveryBinding?.checkpointCommitRef.commitId === checkpointCommitRef.commitId
          && scopeContains(scope, candidate.scope);
      });
      if (!record) return null;
      const closure = closureFromRecord(record);
      if (!closure || !('closureKind' in closure) || closure.closureKind !== 'checkpoint' || !closure.recoveryBinding) return null;
      if (!sameCommitRef(closure.recoveryBinding.checkpointCommitRef, checkpointCommitRef)) {
        throw bindingCorrupt('requested checkpoint receipt conflicts with the bound receipt');
      }
      assertRecoveryBinding(records, record, closure);
      return structuredClone(closure.recoveryBinding);
    },
  };
}

function isClosureRecord(value: unknown): value is ClosureRecord {
  if (typeof value !== 'object' || value === null) return false;
  const closureKind = (value as { readonly closureKind?: unknown }).closureKind;
  return closureKind === undefined
    || closureKind === 'checkpoint'
    || closureKind === 'checkpoint-closure-preparation'
    || closureKind === 'interaction'
    || closureKind === 'reentry'
    || closureKind === 'turn-closure'
    || closureKind === 'turn-recovery'
    || closureKind === 'planner-alignment';
}

function identityOfClosure(closure: ClosureRecord): string {
  return 'closureId' in closure ? closure.closureId : closure.deadEndRef;
}

function closureJournalCommitId(identity: string): string {
  // Closure identities remain canonical evidence refs; the journal commit key
  // is a bounded idempotency key and may need to represent longer identities.
  return `journal-closure:${createHash('sha256').update(identity).digest('hex')}`;
}

function assertClosureRecord(closure: ClosureRecord): void {
  try {
    if (!('closureKind' in closure)) {
      assertDeadEndRecord(closure);
      return;
    }
    if (closure.closureKind === 'checkpoint') {
      if (!closure.closureId.trim()) throw new Error('checkpoint closure id is required');
      if (closure.compatibilityVersion !== 1 && closure.compatibilityVersion !== 2) {
        throw new Error('checkpoint closure compatibility version is unsupported');
      }
      return;
    }
    if (closure.closureKind === 'checkpoint-closure-preparation') {
      if (!closure.closureId.trim() || !closure.checkpointDigest.trim()
        || !closure.scope.organId.value.trim() || !closure.coreClosure.closedAt.trim()) {
        throw new Error('checkpoint closure preparation is malformed');
      }
      return;
    }
    if (closure.closureKind === 'interaction') {
      assertInteractionClosure(closure);
      return;
    }
    if (closure.closureKind === 'reentry') {
      assertReentryRecord(closure);
      if ('schemaVersion' in closure) {
        if (closure.schemaVersion !== CONDITIONAL_REENTRY_SCHEMA_VERSION) {
          throw new Error('conditional reentry schemaVersion is unsupported');
        }
        if (closure.closureId !== conditionalReentryIdentity(closure.command)) {
          throw new Error('conditional reentry command identity conflicts');
        }
        assertConditionalReentryRecord({
          record: closure as ConditionalReentryRecord,
          targetExecutionEpoch: closure.checkpointExecutionEpoch,
          currentExecutionEpoch: closure.previousExecutionEpoch,
          permissionRevision: closure.coreReentry.permissionRevision,
          command: closure.command,
          restoredContext: closure.restoredContext,
        });
      }
      return;
    }
    if (closure.closureKind === 'turn-closure') {
      assertTurnClosureRecord(closure);
      return;
    }
    if (closure.closureKind === 'turn-recovery') {
      assertTurnRecoveryRecord(closure);
      return;
    }
    assertPlannerAlignmentRecord(closure);
  } catch (error) {
    throw new AppLifecycleError(
      'checkpoint-closure-corrupt',
      error instanceof Error ? error.message : 'checkpoint closure is invalid',
      'preserve the checkpoint journal and repair the closure record before recovery',
      'app-checkpoint-journal',
    );
  }
}

export function closureFromRecord(record: JournalRecord): ClosureRecord | null {
  const payload = record.payload;
  if (payload?.['kind'] !== CHECKPOINT_CLOSURE_PAYLOAD_KIND) return null;
  const closure = payload['closure'];
  if (!isClosureRecord(closure)) {
    throw new AppLifecycleError(
      'checkpoint-closure-corrupt',
      `checkpoint closure record ${record.seq} is malformed`,
      'preserve the checkpoint journal and repair the closure record before recovery',
      'app-checkpoint-journal',
    );
  }
  assertClosureRecord(closure);
  if ('scope' in closure && !sameScope(record.scope, closure.scope)) {
    throw bindingCorrupt('closure payload scope differs from its Journal scope');
  }
  return closure;
}

function closureMatches(left: ClosureRecord, right: ClosureRecord): boolean {
  if (!('closureKind' in left) || !('closureKind' in right)) {
    return !('closureKind' in left)
      && !('closureKind' in right)
      && left.deadEndRef === right.deadEndRef
      && left.scope.organId.value === right.scope.organId.value
      && left.scope.taskId?.value === right.scope.taskId?.value
      && left.scope.cycleId?.value === right.scope.cycleId?.value
      && left.scope.operationId?.value === right.scope.operationId?.value
      && left.failedPathRefs.length === right.failedPathRefs.length
      && left.failedPathRefs.every((ref, index) => ref === right.failedPathRefs[index])
      && left.conclusion === right.conclusion
      && left.invalidatedAssumptions.length === right.invalidatedAssumptions.length
      && left.invalidatedAssumptions.every((assumption, index) => assumption === right.invalidatedAssumptions[index])
      && left.evidenceRefs.length === right.evidenceRefs.length
      && left.evidenceRefs.every((ref, index) => JSON.stringify(ref) === JSON.stringify(right.evidenceRefs[index]))
      && JSON.stringify(left.suggestedAlternatives) === JSON.stringify(right.suggestedAlternatives);
  }
  if (left.closureKind !== right.closureKind) return false;
  if (left.closureKind === 'checkpoint-closure-preparation' && right.closureKind === 'checkpoint-closure-preparation') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (left.closureKind === 'checkpoint' && right.closureKind === 'checkpoint') {
    return sameCheckpointClosureRecord(left, right);
  }
  if (left.closureKind === 'reentry' && right.closureKind === 'reentry') {
    return sameReentryRecord(left, right);
  }
  if (left.closureKind === 'interaction' && right.closureKind === 'interaction') {
    return left.closureId === right.closureId
      && left.scope.organId.value === right.scope.organId.value
      && left.scope.taskId?.value === right.scope.taskId?.value
      && left.scope.cycleId?.value === right.scope.cycleId?.value
      && left.scope.operationId?.value === right.scope.operationId?.value
      && left.reason === right.reason
      && JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs)
      && JSON.stringify(left.next) === JSON.stringify(right.next);
  }
  if (left.closureKind === 'turn-closure' && right.closureKind === 'turn-closure') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (left.closureKind === 'turn-recovery' && right.closureKind === 'turn-recovery') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (left.closureKind === 'planner-alignment' && right.closureKind === 'planner-alignment') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function checkpointScope(records: readonly JournalRecord[], checkpointId: Checkpoint['id']): ScopeRef | null {
  const record = [...records].reverse().find((candidate) =>
    candidate.kind === 'checkpoint'
    && candidate.checkpoint?.id.scope === checkpointId.scope
    && candidate.checkpoint.id.value === checkpointId.value);
  return record?.checkpoint?.scope ?? null;
}

function bindingCorrupt(message: string): AppLifecycleError {
  return new AppLifecycleError('checkpoint-recovery-binding-corrupt', message,
    'preserve the Journal and repair the exact closure relationship before recovery', 'app-checkpoint-journal');
}

function committedReentryFences(records: readonly JournalRecord[]): readonly ReentryFence[] {
  const fences: ReentryFence[] = [];
  for (const record of records) {
    const transition = conditionalReentryFromRecord(record);
    if (transition) fences.push(...transition.fencedBindings);
  }
  return fences;
}

function assertPublicationNotFenced(
  records: readonly JournalRecord[],
  candidate: ExecutionIncarnationRef,
  label: string,
): void {
  if (!matchesExecutionIncarnationFence(committedReentryFences(records), candidate)) return;
  throw new AppLifecycleError(
    'checkpoint-incarnation-fenced',
    `${label} belongs to a fenced execution incarnation`,
    'publish from the current admitted incarnation or record actual settlement through its owner',
    'app-checkpoint-journal',
  );
}

function sameCommitRef(left: JournalCommitRef | null, right: JournalCommitRef | null): boolean {
  return left?.commitId === right?.commitId && left?.journalSeq === right?.journalSeq && left?.recordDigest === right?.recordDigest;
}

export function exactJournalRecord(records: readonly JournalRecord[], ref: JournalCommitRef): JournalRecord {
  const record = records.find((candidate) => candidate.commitId === ref.commitId);
  if (!record || !sameCommitRef(journalCommitRef(record), ref)) {
    throw bindingCorrupt(`exact Journal receipt is unavailable or conflicts: ${ref.commitId}`);
  }
  return record;
}

/** Frozen P4 relation validation. Latest records never supply missing facts. */
export function assertRecoveryBinding(records: readonly JournalRecord[], closureRecord: JournalRecord, closure: CheckpointClosureRecord): void {
  const binding = closure.recoveryBinding!;
  const checkpointRecord = exactJournalRecord(records, binding.checkpointCommitRef);
  const checkpoint = checkpointRecord.checkpoint;
  const contextRecord = exactJournalRecord(records, binding.contextCommitRef);
  const context = contextHistoryFromRecord(contextRecord);
  const preparationRecord = records.find((record) => {
    const value = closureFromRecord(record);
    return value && 'closureKind' in value && value.closureKind === 'checkpoint-closure-preparation'
      && value.closureId === binding.preparationRef;
  });
  const preparation = preparationRecord ? closureFromRecord(preparationRecord) : null;
  if (!checkpoint || !context || !preparationRecord || !preparation
    || !('closureKind' in preparation) || preparation.closureKind !== 'checkpoint-closure-preparation') {
    throw bindingCorrupt('binding is missing its exact checkpoint, context or preparation');
  }
  if (!sameScope(closureRecord.scope, checkpoint.scope)
    || !sameScope(checkpointRecord.scope, checkpoint.scope)
    || !sameScope(contextRecord.scope, context.scope)
    || !sameScope(context.scope, checkpoint.scope)
    || !sameScope(preparation.scope, checkpoint.scope)
    || JSON.stringify(preparation.checkpointId) !== JSON.stringify(checkpoint.id)
    || JSON.stringify(closure.checkpointId) !== JSON.stringify(checkpoint.id)
    || JSON.stringify(binding.coreClosure.checkpointId) !== JSON.stringify(checkpoint.id)
    || closure.source !== preparation.coreClosure.source
    || closure.outcome !== checkpoint.outcome || closure.summary !== checkpoint.summary
    || JSON.stringify(closure.next) !== JSON.stringify(checkpoint.next)
    || JSON.stringify(closure.reentry) !== JSON.stringify(preparation.reentry)
    || preparation.checkpointClosureId !== closure.closureId
    || preparation.closureId !== checkpointClosurePreparationId(checkpoint)
    || closure.closureId !== `checkpoint-closure:${checkpointCommitId(checkpoint)}`
    || preparation.checkpointDigest !== checkpointEvidenceDigest(checkpoint)
    || !sameCommitRef(preparation.contextCommitRef, binding.contextCommitRef)
    || !sameScope(preparation.operationSelector.scope, checkpoint.scope)
    || !sameScope(preparation.operationControl.scope, checkpoint.scope)
    || preparation.operationControl.state !== 'complete'
    || (preparation.operationSelector.agentRuntimeId !== undefined && preparation.operationSelector.agentRuntimeId !== context.agentRuntimeId)
    || (preparation.operationSelector.harnessExecutionEpoch !== undefined && preparation.operationSelector.harnessExecutionEpoch !== checkpoint.executionEpoch)
    || context.loopCheckpoint.executionEpoch !== checkpoint.executionEpoch
    || context.contextView.executionEpoch !== checkpoint.executionEpoch
    || binding.coreClosure.executionEpoch !== checkpoint.executionEpoch
    || JSON.stringify(binding.coreClosure) !== JSON.stringify({ ...preparation.coreClosure, committed: true })
    || preparationRecord.seq >= closureRecord.seq || checkpointRecord.seq >= closureRecord.seq
    || contextRecord.seq >= preparationRecord.seq) {
    throw bindingCorrupt('checkpoint/context/preparation/closure scope, body, receipt or runtime epoch conflicts');
  }
  for (const ref of [preparation.operationControl.coverageCommitRef, preparation.operationControl.currentControlCommitRef]) {
    const control = exactJournalRecord(records, ref);
    if (control.seq >= preparationRecord.seq || !scopeContains(control.scope, checkpoint.scope)) {
      throw bindingCorrupt('closure preparation operation-control provenance conflicts');
    }
  }
  const grant = exactJournalRecord(records, preparation.permission.grantCommitRef);
  if (!preparation.permission.permissionRevision.trim() || grant.seq >= preparationRecord.seq
    || !scopeContains(grant.scope, checkpoint.scope)) {
    throw bindingCorrupt('closure preparation permission provenance conflicts');
  }
  try { assertCheckpointClosureCommitted(binding.coreClosure); }
  catch (error) { throw bindingCorrupt(error instanceof Error ? error.message : 'invalid committed Core closure'); }
}

export function createJsonlCheckpointClosurePort(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
}): CheckpointClosurePort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'checkpoint-closure-invalid',
      'checkpoint closure journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  async function records(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'checkpoint-journal-corrupt',
        verification.error ?? 'checkpoint journal is invalid',
        'preserve the checkpoint journal and repair its committed history before reading closures',
        'app-checkpoint-journal',
      );
    }
    return verification.records;
  }

  return {
    async commit(closure: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
      assertClosureRecord(closure);
      const identity = identityOfClosure(closure);
      return journal.transaction(({ records: allRecords }) => {
        const existing = allRecords.find((record) => {
          const stored = closureFromRecord(record);
          return stored !== null && identityOfClosure(stored) === identity;
        });
        if (existing && !closureMatches(closureFromRecord(existing)!, closure)) {
          throw new AppLifecycleError(
            'checkpoint-closure-conflict',
            `checkpoint closure id is already committed with different content: ${identity}`,
            'reconcile the existing closure before retrying',
            'app-checkpoint-journal',
          );
        }
        const scope = 'scope' in closure ? closure.scope
          : closure.closureKind === 'checkpoint' && closure.recoveryBinding
            ? exactJournalRecord(allRecords, closure.recoveryBinding.checkpointCommitRef).checkpoint?.scope
            : 'identity' in closure ? closure.identity.scopeRef
              : closure.closureKind === 'planner-alignment' ? closure.alignment.identity.scopeRef
                : checkpointScope(allRecords, closure.checkpointId);
        if (!scope) throw new AppLifecycleError(
          'checkpoint-closure-scope-missing',
          `closure ${identity} does not carry a journal scope`,
          'commit the referenced checkpoint before committing its closure',
          'app-checkpoint-journal',
        );
        if ('closureKind' in closure && closure.closureKind === 'checkpoint' && closure.recoveryBinding) {
          assertPublicationNotFenced(allRecords, {
            scope,
            executionEpoch: closure.recoveryBinding.coreClosure.executionEpoch,
          }, 'checkpoint closure publication');
        }
        return { existing, scope };
      }, async (plan, append) => {
        if (!plan.existing) await append({
        commitId: closureJournalCommitId(identity),
        kind: 'event',
        scope: plan.scope,
        payload: { kind: CHECKPOINT_CLOSURE_PAYLOAD_KIND, closure },
        });
        return { closureId: identity, committed: true };
      });
    },
    async read(closureId: string): Promise<ClosureRecord | null> {
      const allRecords = await records();
      for (const record of [...allRecords].reverse()) {
        const closure = closureFromRecord(record);
        if (closure && identityOfClosure(closure) === closureId) return structuredClone(closure);
      }
      return null;
    },
  };
}

export function createCheckpointReentryAdmissionPort(input: {
  readonly admitRecovery?: (request: {
    readonly checkpoint: Checkpoint;
    readonly previousExecutionEpoch: number;
    readonly newExecutionEpoch: number;
  }) => Promise<boolean> | boolean;
} = {}): CheckpointReentryAdmissionPort {
  return {
    async admit(request) {
      if (!request.closure.reentry.allowed && input.admitRecovery === undefined) {
        return {
          allowed: false,
          reason: request.closure.reentry.reason,
          ...(request.closure.reentry.blockedBy ? { blockedBy: request.closure.reentry.blockedBy } : {}),
        };
      }
      if (input.admitRecovery !== undefined) {
        const allowed = await input.admitRecovery({
          checkpoint: request.checkpoint,
          previousExecutionEpoch: request.previousExecutionEpoch,
          newExecutionEpoch: request.newExecutionEpoch,
        });
        if (!allowed) {
          return {
            allowed: false,
            reason: 'recovery admission denied',
            blockedBy: ['recovery-admission'],
          };
        }
      }
      return { allowed: true, reason: 'recovery admission approved' };
    },
  };
}

/**
 * Adapts the same authoritative append-only Organ Journal to the context history
 * port. Commit compares the expected context head under the existing journal
 * transaction lock, reads the exact committed body back and never substitutes the
 * latest record. The transient request instruction never enters this record.
 */
export function createJsonlContextHistoryPort(input: { readonly filePath: string; readonly journal?: JsonlOrganJournal }): ContextHistoryPort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'context-history-journal-invalid',
      'context history journal path is required',
      'provide the runtime checkpoint journal path',
      'app-checkpoint-journal',
    );
  }
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  return {
    async commit(record: ContextHistoryRecord, expectedCurrentContextCommitRef: JournalCommitRef | null): Promise<JournalCommitRef> {
      assertContextHistoryRecord(record);
      const commitId = contextHistoryCommitId(record);
      return journal.transaction<{ readonly existing: JournalRecord | null }, JournalCommitRef>(
        ({ records }) => {
          const existing = records.find((candidate) => candidate.commitId === commitId) ?? null;
          if (existing) {
            const stored = contextHistoryFromRecord(existing);
            if (!stored || JSON.stringify(stored) !== JSON.stringify(record)) {
              throw new AppLifecycleError(
                'context-history-conflict',
                `context history identity is already committed with different content: ${commitId}`,
                'resolve the existing context commit before retrying',
                'app-checkpoint-journal',
              );
            }
            return { existing };
          }
          assertPublicationNotFenced(records, {
            scope: record.scope,
            agentRuntimeId: record.agentRuntimeId,
            executionEpoch: record.contextView.executionEpoch,
          }, 'context publication');
          const current = latestContextRecord(records, record.scope, record.agentRuntimeId);
          const currentRef = current ? journalCommitRef(current) : null;
          if (!sameCommitRef(currentRef, expectedCurrentContextCommitRef)
            || !sameCommitRef(record.previousContextCommitRef ?? null, currentRef)) {
            throw new AppLifecycleError(
              'context-history-head-conflict',
              `context history head changed before commit for ${record.contextView.contextViewRef}`,
              'read the current context head and retry with the exact expected predecessor',
              'app-checkpoint-journal',
            );
          }
          return { existing: null };
        },
        async (plan, append) => {
          if (plan.existing) return journalCommitRef(plan.existing);
          const appended = await append({
            commitId,
            kind: 'event',
            scope: record.scope,
            payload: { kind: CONTEXT_HISTORY_PAYLOAD_KIND, record },
          });
          return journalCommitRef(appended);
        },
      );
    },

    async readContextCommit(scope: ScopeRef, commitRef: JournalCommitRef): Promise<ContextHistoryRecord> {
      const records = await verifiedJournalRecords(journal);
      const record = records.find((candidate) => candidate.commitId === commitRef.commitId);
      if (!record) {
        throw new AppLifecycleError(
          'context-history-missing',
          `context history commit is not present: ${commitRef.commitId}`,
          'retry the exact context identity before selecting another context',
          'app-checkpoint-journal',
        );
      }
      if (record.seq !== commitRef.journalSeq || record.recordDigest !== commitRef.recordDigest) {
        throw new AppLifecycleError(
          'context-history-corrupt',
          `context history commit does not match its reference: ${commitRef.commitId}`,
          'preserve the journal and repair the context history record',
          'app-checkpoint-journal',
        );
      }
      const value = contextHistoryFromRecord(record);
      if (!value) {
        throw new AppLifecycleError(
          'context-history-corrupt',
          `commit ${commitRef.commitId} is not a context history record`,
          'preserve the journal and repair the context history record',
          'app-checkpoint-journal',
        );
      }
      if (!scopeContains(scope, value.scope)) {
        throw new AppLifecycleError(
          'context-history-scope-mismatch',
          `context history commit ${commitRef.commitId} is outside the requested scope`,
          'request the context history with its own task scope',
          'app-checkpoint-journal',
        );
      }
      return value;
    },

    async readContextHistory(query: ContextHistoryReadQuery): Promise<ContextHistoryReadResult> {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
        throw new AppLifecycleError(
          'context-history-limit-invalid',
          'context history limit must be a positive safe integer',
          'provide a positive context history limit',
          'app-checkpoint-journal',
        );
      }
      const cursor = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new AppLifecycleError(
          'context-history-cursor-invalid',
          'context history cursor must be a non-negative journal sequence',
          'restart the context history read without a cursor',
          'app-checkpoint-journal',
        );
      }
      const records = await verifiedJournalRecords(journal);
      const matching = records.filter((record) => {
        const value = contextHistoryFromRecord(record);
        if (!value) return false;
        if (!scopeContains(query.scope, value.scope)) return false;
        if (query.agentRuntimeId !== undefined && value.agentRuntimeId !== query.agentRuntimeId) return false;
        if (query.contextViewRef !== undefined && value.contextView.contextViewRef !== query.contextViewRef) return false;
        return true;
      });
      const afterCursor = matching.filter((record) => record.seq > cursor);
      const page = afterCursor.slice(0, query.limit);
      const views: ContextView[] = [];
      const replacements: ContextReplacement[] = [];
      for (const record of page) {
        const value = contextHistoryFromRecord(record);
        if (!value) continue;
        views.push(value.contextView);
        if (value.replacement) replacements.push(value.replacement);
      }
      const head = matching.at(-1) ?? null;
      const last = page.at(-1);
      return {
        views,
        replacements,
        currentContextCommitRef: head ? journalCommitRef(head) : null,
        ...(afterCursor.length > page.length && last ? { nextCursor: String(last.seq) } : {}),
      };
    },
  };
}
