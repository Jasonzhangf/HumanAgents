import {
  validateTaskIdentityScope,
  type Checkpoint,
  type CycleId,
  type JournalCommitRef,
  type ScopeRef,
  type TaskIdentityScope,
} from '../../../contracts/src/index.js';
import { sameJournalCommitRef } from '../../../runtime/src/checkpoints/coordinator.js';
import type {
  CheckpointJournalReaderPort,
  CheckpointListQuery,
  CheckpointRecoveryBinding,
  CommittedCheckpointRecord,
  ContextHistoryPort,
  ExecutionPosition,
  NativeCheckpointJournalPort,
  SemanticHistoryPersistencePort,
} from '../../../runtime/src/checkpoints/ports.js';
import type {
  AdoptedChildSourceV1,
  AdoptedChildSourceV2,
  CommittedSemanticCheckpoint,
  SemanticHistoryExactLookupV1,
  SemanticPhaseReceiptV1,
} from '../../../runtime/src/context/semantic-history.js';
import type { ContextHistoryRecord } from '../../../contracts/src/agent-loop.js';
import type {
  NativeActiveTurnSegmentCaptureReadback,
  NativeRecoveryAssets,
  NativeRecoveryAssetsReadback,
} from '../native-recovery-assets.js';
import type { RuntimeReadResult, RuntimeReadScope } from '../../../ui/contracts/runtime.js';
import type {
  RuntimeCheckpointAdoptedChildProjection,
  RuntimeCheckpointCapabilityProjection,
  RuntimeCheckpointCaptureProjection,
  RuntimeCheckpointCaptureRead,
  RuntimeCheckpointContextProjection,
  RuntimeCheckpointContextRead,
  RuntimeCheckpointCoreClosureProjection,
  RuntimeCheckpointCurrentProjection,
  RuntimeCheckpointDetailProjection,
  RuntimeCheckpointFilter,
  RuntimeCheckpointIdentityProjection,
  RuntimeCheckpointPositionProjection,
  RuntimeCheckpointReadProjection,
  RuntimeCheckpointRecoveryBindingProjection,
  RuntimeCheckpointSemanticPhaseReceiptProjection,
  RuntimeCheckpointSemanticProjection,
  RuntimeCheckpointSemanticRead,
} from '../../../ui/contracts/checkpoint-history.js';
import type { RuntimeCommitRefProjection } from '../../../ui/contracts/runtime.js';

const OWNER_ID = 'humanagent.app.ui-runtime.checkpoint-history';

class CheckpointHistoryReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CheckpointHistoryReadError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure<T>(
  code: string,
  message: string,
  nextAction: string,
): RuntimeReadResult<T> {
  return { ok: false, failure: { code, ownerId: OWNER_ID, message, nextAction } };
}

function toCommitRef(ref: JournalCommitRef): RuntimeCommitRefProjection {
  return { commitId: ref.commitId, journalSeq: ref.journalSeq, recordDigest: ref.recordDigest };
}

function sameTaskScope(scope: ScopeRef, taskScope: TaskIdentityScope): boolean {
  return scope.organId.value === taskScope.organId.value && scope.taskId?.value === taskScope.taskId.value;
}

function sameId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return sameId(left.organId, right.organId) && sameId(left.taskId, right.taskId)
    && sameId(left.cycleId, right.cycleId) && sameId(left.operationId, right.operationId);
}

function mapCoreClosure(
  closure: CheckpointRecoveryBinding['coreClosure'],
): RuntimeCheckpointCoreClosureProjection {
  return {
    source: closure.source,
    closureReason: closure.closureReason,
    executionEpoch: closure.executionEpoch,
    committed: closure.committed,
    reentryAllowed: closure.reentryAllowed,
    pendingOperations: [...closure.pendingOperations],
    unknownOperations: [...closure.unknownOperations],
    recoveryStateRef: closure.recoveryStateRef,
    nextAction: closure.nextAction,
    closedAt: closure.closedAt,
  };
}

function mapRecoveryBinding(
  binding: CheckpointRecoveryBinding,
): RuntimeCheckpointRecoveryBindingProjection {
  return {
    checkpointCommitRef: toCommitRef(binding.checkpointCommitRef),
    contextCommitRef: toCommitRef(binding.contextCommitRef),
    coreClosure: mapCoreClosure(binding.coreClosure),
    ...(binding.preparationRef === undefined ? {} : { preparationRef: binding.preparationRef }),
    ...(binding.turnRecoveryRef === undefined ? {} : { turnRecoveryRef: binding.turnRecoveryRef }),
    ...(binding.turnClosureRef === undefined ? {} : { turnClosureRef: binding.turnClosureRef }),
    ...(binding.alignmentRef === undefined ? {} : { alignmentRef: binding.alignmentRef }),
  };
}

function mapContext(record: ContextHistoryRecord): RuntimeCheckpointContextProjection {
  return {
    state: 'known',
    agentRuntimeId: record.agentRuntimeId,
    contextViewRef: record.contextView.contextViewRef,
    contextDigest: record.contextView.contextDigest,
    executionEpoch: record.contextView.executionEpoch,
    activeRefs: [...record.contextView.activeRefs],
    omittedRefs: [...record.contextView.omittedRefs],
    durableContextDigest: record.durableContextDigest,
    previousContextCommitRef: record.previousContextCommitRef === null
      ? null
      : toCommitRef(record.previousContextCommitRef),
    loopCheckpoint: {
      checkpointId: record.loopCheckpoint.checkpointId,
      sequence: record.loopCheckpoint.sequence,
      digest: record.loopCheckpoint.digest,
      executionEpoch: record.loopCheckpoint.executionEpoch,
      contextViewRef: record.loopCheckpoint.contextViewRef,
    },
    loopControl: {
      mode: record.loopControl.mode,
      transitionSeq: record.loopControl.transitionSeq,
      observationScopeId: record.loopControl.observationScopeId,
    },
    replacement: record.replacement === null
      ? null
      : {
          reason: record.replacement.reason,
          fromContextViewRef: record.replacement.fromContextViewRef,
          toContextViewRef: record.replacement.toContextViewRef,
          toContextDigest: record.replacement.toContextDigest,
        },
  };
}

function mapPhaseReceipt(
  receipt: SemanticPhaseReceiptV1,
): RuntimeCheckpointSemanticPhaseReceiptProjection {
  return {
    phase: receipt.phase,
    commitIdentity: receipt.commitIdentity,
    journalReceiptRef: receipt.journalReceiptRef,
    journalSeq: receipt.journalSeq,
    recordDigest: receipt.recordDigest,
    committedAt: receipt.committedAt,
    timeAuthority: receipt.timeAuthority,
  };
}

function mapAdoptedChild(
  child: AdoptedChildSourceV1 | AdoptedChildSourceV2,
): RuntimeCheckpointAdoptedChildProjection {
  const base = {
    invocationId: child.invocationId,
    childTurnId: child.childTurnId,
    deliverySeq: child.deliverySeq,
    kind: child.kind,
    refinedDelivery: child.refinedDelivery,
    preCallCheckpointRef: child.preCallCheckpointRef,
    ...(child.postReviewCheckpointRef === undefined
      ? {}
      : { postReviewCheckpointRef: child.postReviewCheckpointRef }),
  };
  return 'segmentId' in child ? { ...base, segmentId: child.segmentId } : base;
}

function mapSemantic(committed: CommittedSemanticCheckpoint): RuntimeCheckpointSemanticProjection {
  const save = committed.save;
  const base = {
    state: 'known' as const,
    turn: committed.turn,
    savedAt: committed.time,
    description: committed.description,
    semantics: {
      goal: committed.semantics.goal,
      actions: committed.semantics.actions,
      result: committed.semantics.result,
      nextStep: committed.semantics.nextStep,
    },
    save: {
      checkpoint: {
        commitIdentity: save.checkpoint.receipt.commitIdentity,
        checkpointRef: save.checkpoint.receipt.checkpointRef,
        journalReceiptRef: save.checkpoint.receipt.journalReceiptRef,
        journalSeq: save.checkpoint.journalSeq,
        recordDigest: save.checkpoint.recordDigest,
        committedAt: save.checkpoint.envelope.committedAt,
        timeAuthority: save.checkpoint.envelope.timeAuthority,
      },
      contextView: mapPhaseReceipt(save.contextView),
      historyPublication: mapPhaseReceipt(save.historyPublication),
    },
    evidenceRefs: [...committed.evidenceRefs],
    adoptedChildren: committed.adoptedChildren.map(mapAdoptedChild),
    recovery: {
      recoveryStateRef: committed.recovery.recoveryStateRef,
      recoveryResponsibilityRef: committed.recovery.recoveryResponsibilityRef,
      unresolvedOperationRefs: [...committed.recovery.unresolvedOperationRefs],
      ...(committed.recovery.firstErrorRef === undefined
        ? {}
        : { firstErrorRef: committed.recovery.firstErrorRef }),
      laterErrorRefs: [...committed.recovery.laterErrorRefs],
    },
  };
  if (committed.version === 2) {
    return {
      ...base,
      version: 2,
      segment: {
        segmentId: committed.segment.opened.segmentId,
        openedCommitRef: toCommitRef(committed.segment.openedCommitRef),
      },
    };
  }
  return { ...base, version: 1 };
}

function mapCaptureV1(
  readback: NativeRecoveryAssetsReadback,
  turnRecoveryRef: string,
): RuntimeCheckpointCaptureProjection {
  return {
    state: 'known',
    turnRecoveryRef,
    capture: readback.receipt.capture,
    controlRecordCount: readback.prepared.controlRecordCount,
    recovery: {
      recoveryResponsibilityRef: readback.prepared.recovery.recoveryResponsibilityRef,
      unresolvedOperationRefs: [...readback.prepared.recovery.unresolvedOperationRefs],
      ...(readback.prepared.recovery.firstErrorRef === undefined
        ? {}
        : { firstErrorRef: readback.prepared.recovery.firstErrorRef }),
      laterErrorRefs: [...readback.prepared.recovery.laterErrorRefs],
    },
  };
}

function mapCaptureV2(
  readback: NativeActiveTurnSegmentCaptureReadback,
  turnRecoveryRef: string,
): RuntimeCheckpointCaptureProjection {
  return {
    state: 'known',
    turnRecoveryRef,
    capture: readback.receipt.capture,
    controlRecordCount: readback.prepared.controlRecordCount,
    recovery: {
      recoveryResponsibilityRef: readback.prepared.recovery.recoveryResponsibilityRef,
      unresolvedOperationRefs: [...readback.prepared.recovery.unresolvedOperationRefs],
      ...(readback.prepared.recovery.firstErrorRef === undefined
        ? {}
        : { firstErrorRef: readback.prepared.recovery.firstErrorRef }),
      laterErrorRefs: [...readback.prepared.recovery.laterErrorRefs],
    },
  };
}

function mapPosition(position: ExecutionPosition): RuntimeCheckpointPositionProjection {
  return {
    checkpointCommitRef: toCommitRef(position.checkpointCommitRef),
    contextCommitRef: toCommitRef(position.contextCommitRef),
    controlCommitRef: toCommitRef(position.controlCommitRef),
    effectiveExecutionEpoch: position.executionEpoch,
  };
}

async function mapIdentity(
  record: CommittedCheckpointRecord,
  native: Pick<NativeCheckpointJournalPort, 'readNativeCheckpoint'> | undefined,
): Promise<RuntimeCheckpointIdentityProjection> {
  const base = {
    checkpointId: record.checkpoint.id,
    seq: record.checkpoint.seq,
    previousCheckpointId: record.checkpoint.previousCheckpointId,
    cycleId: record.checkpoint.cycleId,
    directiveRevision: record.checkpoint.directiveRevision,
    originalExecutionEpoch: record.checkpoint.executionEpoch,
    outcome: record.checkpoint.outcome,
    summary: record.checkpoint.summary,
    next: record.checkpoint.next,
    recoveryStateRef: record.checkpoint.recoveryStateRef,
    evidenceRefs: record.checkpoint.evidenceRefs,
    commitRef: toCommitRef(record.commitRef),
  };
  if (native === undefined) {
    return { ...base, committedAtUnavailableReason: 'native checkpoint receipt reader is not bound' };
  }
  try {
    const relationship = await native.readNativeCheckpoint({
      checkpoint: { id: record.checkpoint.id, scope: record.checkpoint.scope },
    });
    if (relationship === null) {
      return { ...base, committedAtUnavailableReason: 'no native checkpoint receipt exists for this identity' };
    }
    return {
      ...base,
      committedAt: relationship.envelope.committedAt,
      timeAuthority: relationship.envelope.timeAuthority,
    };
  } catch (error) {
    return { ...base, committedAtUnavailableReason: errorMessage(error) };
  }
}

async function readContext(
  contexts: Pick<ContextHistoryPort, 'readContextCommit'>,
  taskScope: TaskIdentityScope,
  commitRef: JournalCommitRef,
): Promise<RuntimeCheckpointContextRead> {
  try {
    const record = await contexts.readContextCommit(taskScope, commitRef);
    if (!sameTaskScope(record.scope, taskScope)) {
      return { state: 'unavailable', reason: 'context record is outside the requested task scope' };
    }
    return mapContext(record);
  } catch (error) {
    return { state: 'unavailable', reason: errorMessage(error) };
  }
}

async function readSemantic(
  semantic: CheckpointHistoryReaderDependencies['semantic'],
  taskScope: TaskIdentityScope,
  checkpoint: Pick<Checkpoint, 'id' | 'scope'>,
): Promise<RuntimeCheckpointSemanticRead> {
  if (semantic === undefined) {
    return { state: 'unavailable', reason: 'semantic history reader is not bound' };
  }
  const lookups = await semantic.listCompletedTurnLookups(checkpoint.scope);
  const matches: SemanticHistoryExactLookupV1[] = lookups.filter((lookup) =>
    sameId(lookup.checkpoint.id, checkpoint.id)
    && sameScope(lookup.checkpoint.scope, checkpoint.scope)
    && sameTaskScope(lookup.checkpoint.scope, taskScope));
  if (matches.length === 0) {
    return { state: 'unavailable', reason: 'no committed semantic publication for this checkpoint' };
  }
  if (matches.length > 1) {
    throw new CheckpointHistoryReadError(
      'checkpoint-history.semantic-ambiguous',
      `checkpoint ${checkpoint.id.value} has ${matches.length} committed semantic publications`,
    );
  }
  const lookup = matches[0]!;
  // The enumerator can return a full Checkpoint; the exact public port accepts identity only.
  const committed = await semantic.readCommittedSemanticCheckpoint({
    scope: lookup.scope,
    checkpoint: { id: lookup.checkpoint.id, scope: lookup.checkpoint.scope },
    publicationReceiptRef: lookup.publicationReceiptRef,
  });
  if (committed === null) {
    return {
      state: 'unavailable',
      reason: 'semantic publication exists but its exact committed read is absent',
    };
  }
  return mapSemantic(committed);
}

async function readCapture(
  capture: CheckpointHistoryReaderDependencies['capture'],
  turnRecoveryRef: string,
  version: 1 | 2,
): Promise<RuntimeCheckpointCaptureRead> {
  if (capture === undefined) {
    return { state: 'unavailable', reason: 'recovery capture reader is not bound' };
  }
  try {
    if (version === 2) {
      return mapCaptureV2(await capture.readSegmentRecoveryAssetsExact(turnRecoveryRef), turnRecoveryRef);
    }
    return mapCaptureV1(await capture.readRecoveryAssetsExact(turnRecoveryRef), turnRecoveryRef);
  } catch (error) {
    return { state: 'unavailable', reason: errorMessage(error) };
  }
}

export interface CheckpointHistorySemanticReader
  extends Pick<SemanticHistoryPersistencePort, 'readCommittedSemanticCheckpoint'> {
  listCompletedTurnLookups(scope: ScopeRef): Promise<readonly SemanticHistoryExactLookupV1[]>;
}

export interface CheckpointHistoryReaderDependencies {
  readonly checkpoints: Pick<
    CheckpointJournalReaderPort,
    'readCommitted' | 'listCommitted' | 'readExecutionPosition' | 'readCheckpointRecoveryBinding'
  >;
  readonly contexts: Pick<ContextHistoryPort, 'readContextCommit'>;
  readonly semantic?: CheckpointHistorySemanticReader;
  readonly native?: Pick<NativeCheckpointJournalPort, 'readNativeCheckpoint'>;
  readonly capture?: Pick<NativeRecoveryAssets, 'readRecoveryAssetsExact' | 'readSegmentRecoveryAssetsExact'>;
}

export interface CheckpointHistoryReadInput {
  readonly scope: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly taskScope: TaskIdentityScope;
  readonly list: {
    readonly cursor?: string;
    readonly limit: number;
    readonly directiveRevision?: number;
    readonly executionEpoch?: number;
    readonly cycleId?: CycleId;
    readonly occurrenceRef?: string;
  };
  readonly viewed?: {
    readonly checkpointId?: Checkpoint['id'];
    readonly commitRef?: JournalCommitRef;
  };
}

export interface CheckpointHistoryReader {
  read(input: CheckpointHistoryReadInput): Promise<RuntimeReadResult<RuntimeCheckpointReadProjection>>;
}

export function createCheckpointHistoryReader(
  deps: CheckpointHistoryReaderDependencies,
): CheckpointHistoryReader {
  async function resolveExact(
    taskScope: TaskIdentityScope,
    target: NonNullable<CheckpointHistoryReadInput['viewed']>,
  ): Promise<CommittedCheckpointRecord> {
    let located: CommittedCheckpointRecord | undefined;
    if (target.commitRef !== undefined) {
      const result = await deps.checkpoints.listCommitted({ scope: taskScope,
        cursor: String(target.commitRef.journalSeq - 1), limit: 1 });
      located = result.checkpoints[0];
      if (located === undefined || !sameJournalCommitRef(located.commitRef, target.commitRef)
        || (target.checkpointId !== undefined && !sameId(located.checkpoint.id, target.checkpointId))) {
        throw new CheckpointHistoryReadError('checkpoint-history.viewed-receipt-mismatch',
          'target receipt and checkpoint identity do not match a committed checkpoint in this task');
      }
    } else {
      if (target.checkpointId === undefined) {
        throw new CheckpointHistoryReadError('checkpoint-history.viewed-partial',
          'viewed target provides neither checkpoint id nor physical receipt');
      }
      let cursor: string | undefined;
      do {
        const page = await deps.checkpoints.listCommitted({ scope: taskScope, limit: 64,
          ...(cursor === undefined ? {} : { cursor }) });
        for (const record of page.checkpoints) {
          if (!sameId(record.checkpoint.id, target.checkpointId)) continue;
          if (located !== undefined) {
            throw new CheckpointHistoryReadError('checkpoint-history.viewed-ambiguous',
              `checkpoint ${target.checkpointId.value} has multiple committed scopes; supply its physical receipt`);
          }
          located = record;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      if (located === undefined) {
        throw new CheckpointHistoryReadError('checkpoint-history.viewed-unknown',
          `no committed checkpoint ${target.checkpointId.value} in this task scope`);
      }
    }
    if (!sameTaskScope(located.checkpoint.scope, taskScope)) {
      throw new CheckpointHistoryReadError('checkpoint-history.scope-mismatch',
        'located checkpoint is outside the requested task scope');
    }
    const exact = await deps.checkpoints.readCommitted(located.checkpoint.scope, located.checkpoint.id);
    if (exact === null || !sameJournalCommitRef(exact.commitRef, located.commitRef)
      || !sameId(exact.checkpoint.id, located.checkpoint.id)
      || !sameScope(exact.checkpoint.scope, located.checkpoint.scope)) {
      throw new CheckpointHistoryReadError('checkpoint-history.read-failed',
        'exact checkpoint read does not match its located metadata receipt and scope');
    }
    return exact;
  }

  async function buildDetail(
    taskScope: TaskIdentityScope,
    record: CommittedCheckpointRecord,
  ): Promise<RuntimeCheckpointDetailProjection> {
    const identity = await mapIdentity(record, deps.native);
    const binding = await deps.checkpoints.readCheckpointRecoveryBinding(taskScope, record.commitRef);
    if (binding !== null && !sameJournalCommitRef(binding.checkpointCommitRef, record.commitRef)) {
      throw new CheckpointHistoryReadError(
        'checkpoint-history.read-failed',
        `recovery binding for ${record.checkpoint.id.value} does not carry its exact checkpoint receipt`,
      );
    }
    const recoveryBinding: RuntimeCheckpointDetailProjection['recoveryBinding'] = binding === null
      ? { state: 'unavailable', reason: 'checkpoint has no committed recovery binding' }
      : mapRecoveryBinding(binding);
    const context: RuntimeCheckpointContextRead = binding === null
      ? { state: 'unavailable', reason: 'checkpoint has no committed recovery binding' }
      : await readContext(deps.contexts, taskScope, binding.contextCommitRef);
    const semantic = await readSemantic(deps.semantic, taskScope, record.checkpoint);
    const capture: RuntimeCheckpointCaptureRead = binding?.turnRecoveryRef === undefined
      ? { state: 'unavailable', reason: 'checkpoint has no bound turn capture' }
      : semantic.state !== 'known'
        ? { state: 'unavailable', reason: 'bound capture descriptor version is unavailable without semantic publication' }
        : await readCapture(
        deps.capture,
        binding.turnRecoveryRef,
        semantic.version,
      );
    return { identity, recoveryBinding, context, semantic, capture };
  }

  return {
    async read(input): Promise<RuntimeReadResult<RuntimeCheckpointReadProjection>> {
      const { scope, taskScope, list, viewed } = input;
      try {
        validateTaskIdentityScope(taskScope);
      } catch (error) {
        return failure(
          'checkpoint-history.scope-mismatch',
          errorMessage(error),
          'supply the canonical task identity scope for this task before reading checkpoint history',
        );
      }
      if (taskScope.taskId.value !== scope.taskId.value) {
        return failure(
          'checkpoint-history.scope-mismatch',
          `task identity scope ${taskScope.taskId.value} does not match read scope task ${scope.taskId.value}`,
          'bind the read scope and the task identity scope to the same canonical task',
        );
      }
      if (!Number.isSafeInteger(list.limit) || list.limit < 1) {
        return failure(
          'checkpoint-history.list-invalid',
          'checkpoint list limit must be a positive safe integer',
          'provide a positive checkpoint list limit',
        );
      }
      if (list.cursor !== undefined && list.cursor.trim() === '') {
        return failure(
          'checkpoint-history.list-invalid',
          'checkpoint list cursor must be a non-empty journal sequence',
          'restart the enumeration without a cursor',
        );
      }
      if (list.occurrenceRef !== undefined) {
        return failure(
          'checkpoint-history.occurrence-unavailable',
          'occurrence checkpoint filter is unavailable: no occurrence binding producer',
          'omit the occurrence filter or produce the occurrence binding first',
        );
      }

      let position: ExecutionPosition | null;
      try {
        position = await deps.checkpoints.readExecutionPosition(taskScope);
      } catch (error) {
        return failure(
          'checkpoint-history.read-failed',
          errorMessage(error),
          'restore the authoritative checkpoint execution-position read for this task scope',
        );
      }

      let currentRecord: CommittedCheckpointRecord | null = null;
      let current: RuntimeCheckpointCurrentProjection;
      try {
        currentRecord = position === null ? null
          : await resolveExact(taskScope, { commitRef: position.checkpointCommitRef });
        current = position === null || currentRecord === null
          ? { state: 'unknown', reason: 'no committed recovery binding defines a current execution position' }
          : {
            state: 'known',
            identity: await mapIdentity(currentRecord, deps.native),
            position: mapPosition(position),
            context: await readContext(deps.contexts, taskScope, position.contextCommitRef),
          };
      } catch (error) {
        return failure('checkpoint-history.read-failed', errorMessage(error),
          'restore the exact committed checkpoint referenced by the authoritative current position');
      }

      const query: CheckpointListQuery = {
        scope: taskScope,
        limit: list.limit,
        ...(list.cursor === undefined ? {} : { cursor: list.cursor }),
        ...(list.directiveRevision === undefined ? {} : { directiveRevision: list.directiveRevision }),
        ...(list.executionEpoch === undefined ? {} : { executionEpoch: list.executionEpoch }),
        ...(list.cycleId === undefined ? {} : { cycleId: list.cycleId }),
      };
      let listed: readonly CommittedCheckpointRecord[];
      let nextCursor: string | undefined;
      try {
        const result = await deps.checkpoints.listCommitted(query);
        listed = result.checkpoints;
        nextCursor = result.nextCursor;
      } catch (error) {
        return failure(
          'checkpoint-history.read-failed',
          errorMessage(error),
          'restore the authoritative checkpoint list read for this task scope',
        );
      }
      const checkpoints: RuntimeCheckpointIdentityProjection[] = [];
      for (const record of listed) {
        if (!sameTaskScope(record.checkpoint.scope, taskScope)) {
          return failure(
            'checkpoint-history.scope-mismatch',
            `committed checkpoint ${record.checkpoint.id.value} is outside the requested task scope`,
            'read checkpoint history only from the task identity scope that owns these records',
          );
        }
        checkpoints.push(await mapIdentity(record, deps.native));
      }

      let viewedDetail: RuntimeCheckpointDetailProjection | null = null;
      try {
        const committed = viewed === undefined ? currentRecord : await resolveExact(taskScope, viewed);
        if (committed !== null) {
          viewedDetail = await buildDetail(taskScope, committed);
        }
      } catch (error) {
        const code = error instanceof CheckpointHistoryReadError
          ? error.code
          : 'checkpoint-history.read-failed';
        return failure(code, errorMessage(error),
          'supply an exact committed target and restore its authoritative detail readers');
      }

      const capabilities: Partial<Record<RuntimeCheckpointFilter, RuntimeCheckpointCapabilityProjection>> = {
        directiveRevision: { state: 'available' },
        executionEpoch: { state: 'available' },
        cycleId: { state: 'available' },
        occurrenceRef: { state: 'unavailable', reason: 'no occurrence binding producer exists yet' },
      };

      return {
        ok: true,
        value: {
          surface: 'runtime-checkpoint-history',
          scope,
          current,
          viewed: viewedDetail,
          checkpoints,
          ...(nextCursor === undefined ? {} : { nextCursor }),
          capabilities,
        },
      };
    },
  };
}
