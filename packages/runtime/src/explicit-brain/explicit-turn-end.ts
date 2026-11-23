import { createHash } from 'node:crypto';
import {
  ContractError, canonicalJsonStringify, isStandardTurnEndToolId,
  validateExplicitTurnEndInput, validateExplicitTurnEndAcceptedResult,
  validateExplicitTurnPartialResult, validateInteractionTurnIdentity,
  type ExplicitTurnEndInput, type ExplicitTurnEndAcceptedResult,
  type ExplicitTurnPartialResult, type ExplicitTurnEndValidationIssue,
  type InteractionTurnIdentity, type InteractionParentProviderExecutionIdentityRef,
  type RawAsset, type InteractionSemanticCheckpoint,
  assertProviderExecutionIdentity,
} from '../../../contracts/src/index.js';
import type { InteractionParentFinalTurnOutput, InteractionParentTurnRawJournalPort, InteractionParentTurnSnapshot } from './interaction-parent-turn-raw.js';
import type { ExplicitTurnInterpretedOutcome, InteractionSemanticCheckpointJournalPort } from './interaction-turn-session.js';

export interface ExplicitEndAttempt {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly attemptRef: string;
  readonly resumePartialRef?: string;
}
export type ExplicitEndSubmission = ExplicitTurnEndAcceptedResult | ExplicitTurnPartialResult | {
  readonly kind: 'rejected';
  readonly failedAttempt: number;
  readonly errors: readonly ExplicitTurnEndValidationIssue[];
};
export type ExplicitEndControl =
  | { readonly kind: 'attempt'; readonly attempt: ExplicitEndAttempt }
  | { readonly kind: 'submission'; readonly attempt: ExplicitEndAttempt;
      readonly requestId: string; readonly callId: string; readonly arguments: unknown;
      readonly result: ExplicitEndSubmission };

export function sameExplicitEndTurn(a: InteractionTurnIdentity, b: InteractionTurnIdentity): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}
function sameExecution(a: InteractionParentProviderExecutionIdentityRef, b: InteractionParentProviderExecutionIdentityRef): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}
function controls(snapshot: InteractionParentTurnSnapshot): readonly ExplicitEndControl[] {
  return (snapshot.endControls ?? []).map(entry => entry.fact);
}
function requireActive(snapshot: InteractionParentTurnSnapshot, attempt: ExplicitEndAttempt): void {
  const opened = snapshot.turnInput?.fact;
  if (!opened || opened.endProtocol !== 'explicit-end-v1') throw new ContractError('explicit end requires an opened v1 turn');
  const expected = { ...opened.execution,
    executionEpoch: snapshot.ownerReconciliations.at(-1)?.fact.effectiveExecutionEpoch ?? opened.execution.executionEpoch };
  if (!sameExecution(expected, attempt.execution) || !sameExplicitEndTurn(opened.turn, attempt.turn)) {
    throw new ContractError('explicit end execution/turn does not match the active parent');
  }
  if (snapshot.abandonment || snapshot.parseFailure || snapshot.executionFailure) throw new ContractError('explicit end turn is closed as failed');
}

/** Validate durable typed control facts on JSONL read; old turns have none. */
export function validateExplicitEndControl(fact: ExplicitEndControl): void {
  if (!fact || (fact.kind !== 'attempt' && fact.kind !== 'submission')) throw new ContractError('invalid explicit end control');
  const attempt = fact.attempt;
  validateInteractionTurnIdentity(attempt.turn);
  assertProviderExecutionIdentity(attempt.execution);
  if (!attempt.attemptRef?.trim() || !sameExplicitEndTurn(attempt.turn, attempt.execution.interactionTurn)) {
    throw new ContractError('invalid explicit end attempt identity');
  }
  if (fact.kind === 'submission') {
    if (!fact.requestId?.trim() || !fact.callId?.trim()) throw new ContractError('explicit end requires request/call');
    if (fact.result.kind === 'accepted') validateExplicitTurnEndAcceptedResult(fact.result);
    else if (fact.result.kind === 'partial') validateExplicitTurnPartialResult(fact.result);
    else if (fact.result.kind !== 'rejected' || ![1, 2].includes(fact.result.failedAttempt) || !fact.result.errors.length) {
      throw new ContractError('invalid explicit end rejection');
    }
    if (fact.result.kind !== 'rejected' && (fact.result.interactionId !== attempt.turn.interactionId
      || fact.result.inputRevision !== attempt.turn.inputRevision || fact.result.turnId !== attempt.turn.turnId)) {
      throw new ContractError('explicit end result does not belong to its turn');
    }
    if (fact.result.kind === 'accepted' && (fact.result.acceptedEndCall?.requestId !== fact.requestId
      || fact.result.acceptedEndCall.callId !== fact.callId
      || !sameExecution(fact.result.acceptedEndCall.execution, attempt.execution))) {
      throw new ContractError('explicit end accepted call binding mismatch');
    }
  }
}

export async function beginExplicitEndAttempt(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly resumePartialRef?: string;
}): Promise<ExplicitEndAttempt> {
  let attempt: ExplicitEndAttempt = {
    turn: input.turn, execution: input.execution,
    attemptRef: `explicit-end:${encodeURIComponent(canonicalJsonStringify(input.turn))}:${input.execution.executionEpoch}`,
    ...(input.resumePartialRef === undefined ? {} : { resumePartialRef: input.resumePartialRef }),
  };
  const transaction = await input.journal.transactTurn(input.turn, snapshot => {
    requireActive(snapshot, attempt);
    const all = controls(snapshot);
    const prior = all.find(f => f.kind === 'attempt' && sameExecution(f.attempt.execution, attempt.execution));
    if (prior) {
      attempt = { ...attempt, attemptRef: prior.attempt.attemptRef };
      if (canonicalJsonStringify(prior.attempt) !== canonicalJsonStringify(attempt)) throw new ContractError('conflicting explicit end attempt');
      return { result: prior.attempt };
    }
    const latest = all.filter(f => f.kind === 'attempt').at(-1)?.attempt;
    const recovery = snapshot.ownerReconciliations.at(-1)?.fact;
    const safeContinuation = latest !== undefined
      && latest.execution.executionEpoch < attempt.execution.executionEpoch
      && recovery?.mode === 'continue'
      && recovery.effectiveExecutionEpoch === attempt.execution.executionEpoch;
    const concluded = latest !== undefined && all.some(f => f.kind === 'submission'
      && f.attempt.attemptRef === latest.attemptRef && f.result.kind !== 'rejected');
    if (safeContinuation && !concluded) {
      if (input.resumePartialRef !== latest.resumePartialRef) throw new ContractError('conflicting explicit end recovery reference');
      // Physical recovery continues the logical attempt, including its durable
      // rejection budget. Only an explicitly resumed partial starts a new one.
      attempt = { ...latest, execution: input.execution };
    } else if (input.resumePartialRef !== undefined) {
      const partial = all.find(f => f.kind === 'submission' && f.result.kind === 'partial' && f.result.partialRef === input.resumePartialRef);
      if (!partial || partial.attempt.execution.executionEpoch >= attempt.execution.executionEpoch) throw new ContractError('resume requires a prior partial of this turn');
      const resumed = all.find(f => f.kind === 'attempt' && f.attempt.resumePartialRef === input.resumePartialRef);
      if (resumed) throw new ContractError('partial already bound to another recovery execution');
    } else if (all.length) {
      throw new ContractError('new execution requires an explicit partial recovery reference');
    }
    return { append: { kind: 'explicit-end-control', turn: input.turn, execution: input.execution,
      fact: { kind: 'attempt', attempt } }, result: attempt };
  });
  return transaction.result;
}

export async function submitExplicitTurnEnd(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly attempt: ExplicitEndAttempt;
  readonly requestId: string;
  readonly callId: string;
  readonly arguments: unknown;
}): Promise<ExplicitEndSubmission> {
  const { attempt } = input;
  const tx = await input.journal.transactTurn<ExplicitEndSubmission>(attempt.turn, snapshot => {
    const all = controls(snapshot);
    if (!all.some(f => f.kind === 'attempt' && canonicalJsonStringify(f.attempt) === canonicalJsonStringify(attempt))) {
      throw new ContractError('explicit end attempt was not admitted');
    }
    const submissions = all.filter((f): f is Extract<ExplicitEndControl, { kind: 'submission' }> =>
      f.kind === 'submission' && f.attempt.attemptRef === attempt.attemptRef);
    const prior = submissions.find(f => f.requestId === input.requestId && f.callId === input.callId);
    if (prior) {
      if (canonicalJsonStringify(prior.arguments) !== canonicalJsonStringify(input.arguments)) throw new ContractError('conflicting explicit end call replay');
      return { result: prior.result };
    }
    requireActive(snapshot, attempt);
    if (submissions.some(f => f.result.kind !== 'rejected')) throw new ContractError('explicit end attempt already concluded');
    if (snapshot.resourceClose?.fact.execution.executionEpoch === attempt.execution.executionEpoch) throw new ContractError('explicit end submission follows resource close');
    const raw = snapshot.acceptedFacts.find(({ fact: { envelope } }) =>
      envelope.execution.runtimeId === attempt.execution.runtimeId
      && envelope.execution.executionEpoch === attempt.execution.executionEpoch && envelope.request.requestId === input.requestId
      && envelope.fact.kind === 'tool-call' && envelope.fact.call.callId === input.callId);
    if (!raw || raw.fact.envelope.fact.kind !== 'tool-call'
      || !isStandardTurnEndToolId(raw.fact.envelope.fact.call.toolId)
      || canonicalJsonStringify(raw.fact.envelope.fact.call.arguments) !== canonicalJsonStringify(input.arguments)
      || !snapshot.requests.some(({ fact }) => fact.request.requestId === input.requestId)) {
      throw new ContractError('explicit end requires the exact committed parent request/tool call');
    }
    let result: ExplicitEndSubmission;
    try {
      validateExplicitTurnEndInput(input.arguments as ExplicitTurnEndInput);
      const valid = input.arguments as ExplicitTurnEndInput;
      result = { kind: 'accepted', interactionId: attempt.turn.interactionId, inputRevision: attempt.turn.inputRevision,
        turnId: attempt.turn.turnId, decision: valid.decision, checkpointRecord: valid.checkpointRecord,
        ...(valid.capsule === undefined ? {} : { capsule: valid.capsule }),
        acceptedEndCall: { requestId: input.requestId, callId: input.callId, execution: attempt.execution } };
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      const errors = [{ path: error.message, message: `${error.message}: 请按结束工具契约修正该字段后重试。` }];
      const failedAttempt = submissions.length + 1;
      result = failedAttempt < 3 ? { kind: 'rejected', failedAttempt, errors } : {
        kind: 'partial', partialRef: `${attempt.attemptRef}:partial`, interactionId: attempt.turn.interactionId,
        inputRevision: attempt.turn.inputRevision, turnId: attempt.turn.turnId,
        failedAttempt: 3, maxAttempts: 3, errors, recoverable: true,
        userMessage: '本次回复未能完成整理。可以继续原轮处理。',
        ...(attempt.resumePartialRef === undefined ? {} : { resumePartialRef: attempt.resumePartialRef }),
        ...(snapshot.turnInput!.fact.priorCheckpoints.at(-1) === undefined ? {} : {
          lastCheckpointRef: snapshot.turnInput!.fact.priorCheckpoints.at(-1)!.turnId }),
      };
    }
    const fact: ExplicitEndControl = { kind: 'submission', attempt, requestId: input.requestId,
      callId: input.callId, arguments: input.arguments, result };
    return { append: { kind: 'explicit-end-control', turn: attempt.turn, execution: attempt.execution, fact }, result };
  });
  return tx.result;
}

export async function readExplicitEndRecovery(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly turn: InteractionTurnIdentity;
  readonly partialRef: string;
}): Promise<{
  readonly attempt: ExplicitEndAttempt; readonly partial: ExplicitTurnPartialResult;
  readonly failures: readonly ExplicitEndSubmission[]; readonly initialInput: RawAsset;
  readonly priorCheckpoints: readonly InteractionSemanticCheckpoint[];
  readonly resumedAttempt?: ExplicitEndAttempt;
}> {
  const snapshot = await input.journal.readTurnSnapshot(input.turn);
  const all = controls(snapshot);
  const failed = all.find((f): f is Extract<ExplicitEndControl, { kind: 'submission' }> =>
    f.kind === 'submission' && f.result.kind === 'partial' && f.result.partialRef === input.partialRef);
  if (!failed || failed.result.kind !== 'partial' || !snapshot.turnInput) throw new ContractError('partial not found in this interaction turn');
  const resumed = all.filter(f => f.kind === 'attempt' && f.attempt.resumePartialRef === input.partialRef).at(-1)?.attempt;
  return { attempt: failed.attempt, partial: failed.result,
    ...(resumed === undefined ? {} : { resumedAttempt: resumed }),
    failures: all.filter((f): f is Extract<ExplicitEndControl, { kind: 'submission' }> =>
      f.kind === 'submission' && f.attempt.attemptRef === failed.attempt.attemptRef).map(f => f.result),
    initialInput: snapshot.turnInput.fact.initialInput, priorCheckpoints: snapshot.turnInput.fact.priorCheckpoints };
}

/** Cold read of the latest attempt's conclusion. Rejections remain in failure memory. */
export async function readExplicitEndOutcome(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly turn: InteractionTurnIdentity;
}): Promise<ExplicitTurnEndAcceptedResult | ExplicitTurnPartialResult | null> {
  const all = controls(await input.journal.readTurnSnapshot(input.turn));
  const attempt = all.filter(f => f.kind === 'attempt').at(-1)?.attempt;
  const end = all.find(f => f.kind === 'submission' && f.attempt.attemptRef === attempt?.attemptRef && f.result.kind !== 'rejected');
  return end?.kind === 'submission' && end.result.kind !== 'rejected' ? end.result : null;
}

/** Rebuild the readable leaf index from committed checkpoints in this interaction. */
export interface ExplicitTurnCheckpointLeaf {
  readonly turnId: string;
  readonly action: string;
  readonly result: string;
  readonly detail: ExplicitTurnEndAcceptedResult['decision'] | ExplicitTurnEndAcceptedResult['capsule'];
  readonly priorCheckpointRefs: readonly string[];
  readonly committedAt: string;
  readonly evidenceRefs: readonly ExplicitTurnCheckpointLeafEvidenceRef[];
  readonly semanticAssetRefs: readonly ExplicitTurnCheckpointLeafEvidenceRef[];
}

type ExplicitTurnCheckpointLeafEvidenceRef = InteractionSemanticCheckpoint['evidenceRefs'][number];

export async function readExplicitTurnCheckpointIndex(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly checkpoints: Pick<InteractionSemanticCheckpointJournalPort, 'readSemanticCheckpointExact'>;
  readonly turn: InteractionTurnIdentity;
}): Promise<readonly ExplicitTurnCheckpointLeaf[]> {
  const snapshot = await input.journal.readTurnSnapshot(input.turn);
  const committed = await input.checkpoints.readSemanticCheckpointExact(input.turn);
  if (!committed) return [];
  for (const fact of controls(snapshot)) {
    if (fact.kind !== 'submission' || fact.result.kind !== 'accepted') continue;
    const result = fact.result;
    if (!result.checkpointRecord) continue;
    return [{
      turnId: result.turnId,
      action: result.checkpointRecord.index.action,
      result: result.checkpointRecord.index.result,
      detail: result.capsule ?? result.decision,
      priorCheckpointRefs: snapshot.turnInput?.fact.priorCheckpoints.map(checkpoint => checkpoint.turnId) ?? [],
      committedAt: committed.checkpoint.committedAt,
      evidenceRefs: committed.checkpoint.evidenceRefs,
      semanticAssetRefs: committed.checkpoint.semanticAssetRefs,
    }];
  }
  return [];
}

export interface ExplicitTurnCheckpointIndexNode {
  readonly id: string;
  readonly kind: 'leaf' | 'group';
  readonly label: string;
  readonly children: readonly string[];
  readonly checkpoint?: ExplicitTurnCheckpointLeaf;
}

export interface ExplicitTurnCheckpointIndexDirectory {
  readonly roots: readonly string[];
  readonly nodes: readonly ExplicitTurnCheckpointIndexNode[];
}

export function explicitTurnCheckpointLeafNode(checkpoint: ExplicitTurnCheckpointLeaf): ExplicitTurnCheckpointIndexNode {
  return {
    id: `checkpoint:${encodeURIComponent(checkpoint.turnId)}`,
    kind: 'leaf',
    label: `${checkpoint.action}；${checkpoint.result}`,
    children: [],
    checkpoint,
  };
}

export function explicitTurnCheckpointGroupId(children: readonly string[]): string {
  if (children.length < 2) {
    throw new ContractError('checkpoint index group requires at least two children');
  }
  // A parent identifier stays bounded when its children are themselves index groups.
  return `checkpoint-index:${createHash('sha256').update(canonicalJsonStringify(children)).digest('hex')}`;
}

export function planExplicitCheckpointGroups(
  leaves: readonly ExplicitTurnCheckpointLeaf[], groupSize: number, windowLimit: number,
) {
  if (!Number.isSafeInteger(groupSize) || groupSize < 2) throw new ContractError('checkpoint index groupSize must be at least 2');
  if (!Number.isSafeInteger(windowLimit) || windowLimit < 1) throw new ContractError('checkpoint index windowLimit must be positive');
  const leafNodes = leaves.map(explicitTurnCheckpointLeafNode);
  const groups: { id: string; children: string[] }[] = [];
  let level = leafNodes.map(node => node.id);
  while (level.length > windowLimit) {
    const nextLevel: string[] = [];
    for (let offset = 0; offset < level.length; offset += groupSize) {
      const children = level.slice(offset, offset + groupSize);
      if (children.length === 1) {
        nextLevel.push(children[0]!);
      } else {
        const id = explicitTurnCheckpointGroupId(children);
        groups.push({ id, children });
        nextLevel.push(id);
      }
    }
    level = nextLevel;
  }
  return { leafNodes, groups, roots: level };
}

/** Build a stable, ordered, read-only tree from committed leaves; labels are supplied by a model port. */
export function buildExplicitTurnCheckpointIndexDirectory(input: {
  readonly leaves: readonly ExplicitTurnCheckpointLeaf[];
  readonly groupSize: number;
  readonly windowLimit?: number;
  readonly labels: readonly string[];
}): ExplicitTurnCheckpointIndexDirectory {
  const { leafNodes, groups, roots } = planExplicitCheckpointGroups(input.leaves, input.groupSize, input.windowLimit ?? 1);
  if (groups.length !== input.labels.length) throw new ContractError('checkpoint index requires one model label per group');
  const nodes = groups.map((group, index): ExplicitTurnCheckpointIndexNode => {
    const label = input.labels[index];
    if (typeof label !== 'string' || !label.trim()) throw new ContractError('checkpoint index model label is empty');
    return { ...group, kind: 'group', label };
  });
  return { roots, nodes: [...leafNodes, ...nodes] };
}

/** Expand stable references in bounded slices without changing checkpoint state. */
export function expandExplicitTurnCheckpointIndex(input: {
  readonly directory: ExplicitTurnCheckpointIndexDirectory;
  readonly nodeId: string;
  readonly offset?: number;
  readonly limit: number;
}): { readonly node: ExplicitTurnCheckpointIndexNode; readonly children: readonly ExplicitTurnCheckpointIndexNode[]; readonly nextOffset?: number } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.offset ?? 0) || (input.offset ?? 0) < 0) {
    throw new ContractError('checkpoint index expansion requires a non-negative offset and positive limit');
  }
  const byId = new Map(input.directory.nodes.map(node => [node.id, node]));
  const node = byId.get(input.nodeId);
  if (!node) throw new ContractError('checkpoint index node not found');
  const offset = input.offset ?? 0;
  const children = node.children.slice(offset, offset + input.limit).map(id => {
    const child = byId.get(id);
    if (!child) throw new ContractError(`checkpoint index child is missing: ${id}`);
    return child;
  });
  const next = offset + children.length;
  return { node, children, ...(next < node.children.length ? { nextOffset: next } : {}) };
}

/** The existing session remains the sole checkpoint writer. */
export async function assertExplicitEndCheckpointBoundary(input: {
  readonly journal?: InteractionParentTurnRawJournalPort;
  readonly identity: InteractionTurnIdentity;
  readonly finalParentOutput: InteractionParentFinalTurnOutput;
  readonly acceptedEnd?: ExplicitTurnEndAcceptedResult;
  readonly outcome: ExplicitTurnInterpretedOutcome;
  /** App resource ownership; borrowing never attests a physical close. */
  readonly providerOwnership?: 'owned' | 'borrowed';
}): Promise<ExplicitTurnEndAcceptedResult | undefined> {
  if (input.finalParentOutput.turnInput.fact.endProtocol === undefined) {
    if (input.acceptedEnd !== undefined) throw new ContractError('explicit end receipt cannot upgrade a legacy turn');
    return undefined;
  }
  if (!input.journal) throw new ContractError('explicit end checkpoint requires parent journal');
  const snapshot = await input.journal.readTurnSnapshot(input.identity);
  if (snapshot.turnInput?.commit.commitId !== input.finalParentOutput.turnInput.commit.commitId) throw new ContractError('explicit end checkpoint input mismatch');
  const latestAttempt = controls(snapshot).filter(f => f.kind === 'attempt').at(-1)?.attempt;
  const end = controls(snapshot).find((f): f is Extract<ExplicitEndControl, { kind: 'submission' }> =>
    f.kind === 'submission' && f.attempt.attemptRef === latestAttempt?.attemptRef && f.result.kind === 'accepted');
  if (!end || end.result.kind !== 'accepted' || !input.acceptedEnd
    || canonicalJsonStringify(end.result) !== canonicalJsonStringify(input.acceptedEnd)) {
    throw new ContractError('explicit end checkpoint requires the durable accepted receipt; partial cannot advance');
  }
  const finalEpoch = snapshot.ownerReconciliations.at(-1)?.fact.effectiveExecutionEpoch
    ?? end.attempt.execution.executionEpoch;
  // An accepted decision survives drain-only owner recovery. Its original
  // call stays immutable; completion, settlement and close belong to the
  // effective physical epoch, never to the failed drain being ignored.
  requireActive(snapshot, { ...end.attempt, execution: { ...end.attempt.execution, executionEpoch: finalEpoch } });
  const { structuredProposal, ...base } = input.outcome.kind === 'requirement'
    ? input.outcome : { ...input.outcome, structuredProposal: undefined };
  const decision = input.outcome.kind === 'requirement' ? { ...base, proposal: structuredProposal } : base;
  // taskFlow is routing configuration, not part of the semantic outcome.
  const { taskFlow: _taskFlow, ...expected } = end.result.decision.kind === 'requirement'
    ? end.result.decision : { ...end.result.decision, taskFlow: undefined };
  if (canonicalJsonStringify(expected) !== canonicalJsonStringify(decision)) throw new ContractError('explicit end checkpoint outcome differs from accepted decision');
  const final = input.finalParentOutput;
  const completion = snapshot.acceptedFacts.find(f => f.commit.commitId === final.requestCompleteCommit.commitId);
  if (!completion || completion.fact.envelope.fact.kind !== 'request-complete'
    || completion.fact.envelope.fact.terminal !== 'completed'
    || completion.fact.envelope.execution.executionEpoch !== finalEpoch
    || completion.fact.envelope.request.requestId !== final.terminalRequest.request.requestId) {
    throw new ContractError('explicit end checkpoint requires the real completed final request');
  }
  const latestRequests = new Map(snapshot.requests.map(f => [f.fact.request.requestId, f.fact]));
  const ignored = new Set(snapshot.ownerReconciliations.flatMap(f => f.fact.unsettledRequestIds));
  if ([...latestRequests.values()].some(r => !ignored.has(r.request.requestId) && r.phase !== 'settled')) throw new ContractError('explicit end checkpoint requires request drain');
  if ((input.providerOwnership !== 'borrowed'
      && (!snapshot.resourceClose || snapshot.resourceClose.fact.execution.executionEpoch !== finalEpoch))
    || !snapshot.providerSettlements.some(f => f.fact.request.requestId === final.terminalRequest.request.requestId
      && f.fact.settlement.executionEpoch === finalEpoch
      && f.fact.settlement.state === 'succeeded')) {
    throw new ContractError('explicit end checkpoint requires provider settle and close');
  }
  return end.result;
}
