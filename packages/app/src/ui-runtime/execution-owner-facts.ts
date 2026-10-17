import type {
  CompletionReadInput,
  CompletionRef,
  DurablePhaseOutcome,
  JournalCommitRef,
  ProviderExecutionIdentityRef,
  RecoveryHoldFacts,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import type { OperationCompletionJournalPort } from '../../../runtime/src/gateway/operation-completion.js';
import type { OperationControlReadback, OperationControlSelector } from '../../../runtime/src/gateway/ports.js';
import type { ContextHistoryPort } from '../../../runtime/src/checkpoints/ports.js';
import {
  NATIVE_SAVE_PHASES,
  type NativeSaveIntent,
  type NativeSaveKey,
  type NativeSavePorts,
  type NativeSaveProgressPort,
} from '../../../runtime/src/checkpoints/native-save-contract.js';
import type { TaskGrantPort } from '../../../runtime/src/admission/task-grant.js';
import type { RuntimeTaskCurrentStatePort } from '../../../runtime/src/ui-runtime/current-state.js';
import type { NativeAdmittedExecution, NativeExecutionOwnerReaders } from './native-execution.js';

export class ExecutionOwnerFactsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionOwnerFactsError';
  }
}

/** The scoped operation-control read the closure/capture owners already expose. */
export interface ExecutionOwnerControlPort {
  readControl(selector: OperationControlSelector): Promise<OperationControlReadback>;
}

/** The exact committed-checkpoint read the native save owner already exposes. */
export interface ExecutionOwnerCheckpointPort {
  readLatest(scope: ScopeRef): Promise<{ readonly checkpoint: { readonly id: { readonly value: string } } } | null>;
}

export interface ExecutionOwnerFactsInput {
  /** The actual admitted turn or resumed segment this reader is bound to. */
  readonly admitted: NativeAdmittedExecution;
  /** Exact execution identity of the admitted turn/segment. */
  readonly execution: ProviderExecutionIdentityRef;
  /** Exact native save boundary this capture is bound to. */
  readonly boundaryId: string;
  /** Shared authoritative Organ Journal object; the reader never opens a second one. */
  readonly journal: JsonlOrganJournal;
  /** OF1 Runtime current-state port. Known state supplies blockers/stages/duties; unknown holds. */
  readonly currentState: RuntimeTaskCurrentStatePort;
  /** Fresh TG1 grant read, including revocation. */
  readonly grants: TaskGrantPort;
  /** Scoped and task-wide operation control read. */
  readonly control: ExecutionOwnerControlPort;
  /** Actual completion owner over the same shared Journal. */
  readonly completion: OperationCompletionJournalPort;
  /** Exact native-save progress owner for this boundary's key. */
  readonly progress: NativeSaveProgressPort;
  /** Exact save key this reader resolves progress through, or undefined before a standard closing checkpoint candidate exists. */
  readonly saveKey: NativeSaveKey | undefined | (() => NativeSaveKey | undefined);
  /** Exact native save intent the committed phase receipts are keyed by. */
  readonly saveIntent: NativeSaveIntent | (() => NativeSaveIntent | undefined);
  /** The five exact native phase owners; committed receipts resolve through them. */
  readonly savePorts: NativeSavePorts;
  /** Exact committed checkpoint read for the capture checkpoint path. */
  readonly checkpoints: ExecutionOwnerCheckpointPort;
  /** Full I5 context owner used to bind the closure context relation. */
  readonly fullContext: ContextHistoryPort;
}

function bindingOf(input: ExecutionOwnerFactsInput) {
  return input.admitted.version === 1
    ? input.admitted.activeTurn.activeBinding
    : input.admitted.activeTurn.segmentBinding();
}

function liveBindingRef(input: ExecutionOwnerFactsInput): string {
  return input.admitted.version === 1
    ? input.admitted.activeTurn.currentBindingRef()
    : `active-turn-segment://${input.admitted.activeTurn.segmentOpened.segmentId}`;
}

function sameExecution(
  left: { readonly runtimeId: string; readonly executionEpoch: number },
  right: ProviderExecutionIdentityRef,
): boolean {
  return left.runtimeId === right.runtimeId && left.executionEpoch === right.executionEpoch;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function completionRefsFromEntries(entries: readonly import('../../../contracts/src/index.js').AcceptedTurnEntry[]): readonly CompletionRef[] {
  const refs: CompletionRef[] = [];
  for (const entry of entries) {
    if (!('envelope' in entry)) continue;
    const fact = entry.envelope.fact;
    if (fact.kind !== 'tool-result') continue;
    refs.push({ requestId: entry.envelope.request.requestId, producerSeq: entry.envelope.producerSeq });
  }
  return refs;
}

function notExecutedPhases(): readonly DurablePhaseOutcome[] {
  return NATIVE_SAVE_PHASES.map((phase) => ({ phase, state: 'not-executed' as const }));
}

/**
 * Production owner-facts reader for `NativeExecutionOwnerReaders`.
 *
 * Every returned fact comes from the named actual owner. The factory carries no
 * default facts, no constructor empty arrays, no synthetic completion and no
 * fabricated checkpoint. When a required source is unknown the closure read
 * returns `null` and the capture read throws, so the caller retains the
 * affected closure/reentry path instead of recording a false success.
 */
export function createExecutionOwnerReaders(input: ExecutionOwnerFactsInput): NativeExecutionOwnerReaders {
  if (!input.boundaryId.trim()) throw new ExecutionOwnerFactsError('execution owner facts require the exact boundary identity');
  const binding = bindingOf(input);
  if (!sameExecution(binding.execution, input.execution)
    || binding.scope.taskId?.value !== input.execution.taskId.value
    || binding.scope.operationId?.value !== input.execution.operationId.value) {
    throw new ExecutionOwnerFactsError('execution owner facts must bind the exact admitted execution identity');
  }
  const selector: OperationControlSelector = {
    scope: binding.scope,
    agentRuntimeId: input.execution.runtimeId,
    harnessExecutionEpoch: input.execution.executionEpoch,
  };

  async function readLivePrefix() {
    return input.admitted.version === 1
      ? await input.admitted.activeTurn.readLivePrefix(input.admitted.activeTurn.currentBindingRef())
      : await input.admitted.activeTurn.readLivePrefix();
  }

  async function knownCurrentState() {
    const read = await input.currentState.read(binding.scope);
    if (read.state !== 'known') {
      throw new ExecutionOwnerFactsError(`runtime current state is unknown: ${read.reason}`);
    }
    return read.value;
  }

  return {
    readControl: (value) => input.control.readControl(value),

    async readClosureFacts(contextCommitRef: JournalCommitRef) {
      let context;
      try {
        context = await input.fullContext.readContextCommit(binding.scope, contextCommitRef);
      } catch (error) {
        return null;
      }
      if (context.agentRuntimeId !== input.execution.runtimeId
        || context.loopCheckpoint.executionEpoch !== input.execution.executionEpoch) {
        return null;
      }
      const grant = await input.grants.readTaskGrant(binding.assignment.taskId);
      if (!grant.grant || !grant.commit) return null;
      const control = await input.control.readControl(selector);
      if (control.state !== 'complete') return null;
      const current = await input.currentState.read(binding.scope);
      if (current.state !== 'known') return null;
      const prefix = await readLivePrefix();
      const unreturnedCallRefs = unique([
        ...prefix.obligations.filter((item) => item.kind === 'request').map((item) => item.requestId),
        ...prefix.obligations.filter((item) => item.kind === 'child-invocation').map((item) => item.invocationId),
      ]);
      const unresolvedOperationRefs = unique([
        ...current.value.retainedDuties.map((duty) => duty.operationRef),
        ...control.operations.filter((operation) => !operation.result).map((operation) => operation.intent.operationId.value),
      ]);
      return {
        permission: {
          permissionRevision: String(grant.grant.revision),
          grantCommitRef: grant.commit,
          revoked: grant.grant.state !== 'granted',
        },
        hardBlockers: [...current.value.processing.hardBlockers],
        unreturnedCallRefs,
        unresolvedOperationRefs,
      };
    },

    async readCaptureReferences() {
      const prefix = await readLivePrefix();
      const current = await knownCurrentState();
      const control = await input.control.readControl(selector);
      if (control.state !== 'complete') {
        throw new ExecutionOwnerFactsError('native capture cannot replace unknown operation control with an empty recovery');
      }
      const descriptors = await input.completion.discoverExactExecution({ execution: input.execution });
      const completionLookups: CompletionReadInput[] = [];
      const unresolvedOperationRefs: string[] = current.retainedDuties.map((duty) => duty.operationRef);
      // The live accepted prefix still owes every unreturned request and every
      // unadopted child invocation. Keep the actual request/invocation identity
      // so recovery retains the real producer work instead of a synthetic id.
      for (const obligation of prefix.obligations) {
        unresolvedOperationRefs.push(
          obligation.kind === 'request' ? obligation.requestId : obligation.invocationId,
        );
      }
      for (const descriptor of descriptors) {
        completionLookups.push(descriptor);
        const readback = await input.completion.readExact(descriptor);
        if (readback.state === 'confirmed') continue;
        if (readback.state === 'unknown') {
          unresolvedOperationRefs.push(descriptor.binding.toolOperationId.value);
          continue;
        }
        throw new ExecutionOwnerFactsError('a discovered effect intent is no longer readable as an intent or completion');
      }
      for (const operation of control.operations) {
        if (!operation.result) unresolvedOperationRefs.push(operation.intent.operationId.value);
      }
      const saveKey = typeof input.saveKey === 'function' ? input.saveKey() : input.saveKey;
      const saveIntent = typeof input.saveIntent === 'function' ? input.saveIntent() : input.saveIntent;
      let durablePhases: readonly DurablePhaseOutcome[];
      let durableReceiptRefs: string[] = [];
      let firstErrorRef: string | undefined;
      let laterErrorRefs: readonly string[];
      if (saveKey === undefined) {
        if (saveIntent !== undefined) {
          throw new ExecutionOwnerFactsError('native capture has a save intent without an actual closing checkpoint key');
        }
        durablePhases = notExecutedPhases();
        firstErrorRef = current.processing.firstErrorRef;
        laterErrorRefs = current.processing.laterErrorRefs;
      } else {
        const progress = await input.progress.readExact(saveKey);
        if (progress.state === 'unknown') {
          throw new ExecutionOwnerFactsError(`native save progress is unknown: ${progress.recoveryRef}`);
        }
        durablePhases = progress.state === 'found' ? progress.progress.phases : notExecutedPhases();
        // A committed phase receipt is resolved through its own exact phase owner,
        // never copied from the progress projection. Verified exact absence stays
        // `not-executed`; a committed phase whose exact receipt is missing is an
        // explicit unknown that holds the capture.
        if (progress.state === 'found') {
          for (const phase of progress.progress.phases) {
            if (phase.state !== 'committed') continue;
            if (!saveIntent) throw new ExecutionOwnerFactsError('committed native progress has no retained save intent');
            const receipt = await input.savePorts[phase.phase].readExact(saveIntent);
            if (!receipt) {
              throw new ExecutionOwnerFactsError(
                `committed native save phase ${phase.phase} has no exact owner receipt`,
              );
            }
            if (receipt.phase !== phase.phase) {
              throw new ExecutionOwnerFactsError(
                `native save phase ${phase.phase} resolved a ${receipt.phase} receipt`,
              );
            }
            durableReceiptRefs.push(receipt.journalReceiptRef);
          }
        }
        firstErrorRef = progress.state === 'found' ? progress.progress.firstErrorRef : current.processing.firstErrorRef;
        laterErrorRefs = progress.state === 'found' ? progress.progress.laterErrorRefs : current.processing.laterErrorRefs;
      }
      const head = await input.checkpoints.readLatest(binding.scope);
      const recovery: RecoveryHoldFacts = {
        commitIdentity: liveBindingRef(input),
        ...(firstErrorRef === undefined ? {} : { firstErrorRef }),
        laterErrorRefs: [...laterErrorRefs],
        rawTurnRefs: [liveBindingRef(input)],
        unresolvedOperationRefs: unique(unresolvedOperationRefs),
        stages: [...current.processing.stages],
        durablePhases: [...durablePhases],
        durableReceiptRefs,
        recoveryResponsibilityRef: current.processing.recoveryResponsibilityRef,
      };
      return {
        completionLookups,
        recovery,
        checkpointPath: head ? [head.checkpoint.id.value] : [],
        completionRefs: completionRefsFromEntries(prefix.entries),
      };
    },
  };
}
