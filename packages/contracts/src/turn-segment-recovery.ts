import { ContractError } from './errors.js';
import { isCanonicalInstant } from './time.js';

export type ProviderSettleState = 'not-sent' | 'stopped' | 'settled' | 'unknown';
export type ProviderSettleVerification =
  | 'lease-process-exit-reconcile'
  | 'provider-adapter-stop-ack'
  | 'response-stream-eof';

export interface ProviderSettleReceipt {
  readonly providerRequestId: string | null;
  readonly state: ProviderSettleState;
  readonly verifiedBy: ProviderSettleVerification;
  readonly verifiedAt: string;
}

export type ToolEffectState =
  | 'dispatched-effect-unknown'
  | 'effect-committed'
  | 'effect-failed-clean'
  | 'reconciled';

export interface ToolEffectLedgerEntry {
  readonly callId: string;
  readonly toolCallId?: string;
  readonly turnId?: string;
  readonly boundPlanStepId: string;
  readonly toolName: string;
  readonly effectPolicy: 'readonly' | 'mutating';
  readonly argsDigest?: string;
  readonly idempotencyKey: string;
  readonly state: ToolEffectState;
  readonly outputArtifactRef: string | null;
  readonly dispatchedAt?: string;
  readonly settledAt?: string | null;
  readonly reconciliationNote?: string | null;
}

export type TurnSegmentRecoveryOutcome =
  | 'recovery-auto-resumed'
  | 'recovery-hold-effect-unknown'
  | 'stopped';

export interface TurnSegmentRecoveryFact {
  readonly taskId: string;
  readonly operationId: string;
  readonly turnId: string;
  readonly executionEpoch: number;
  readonly segmentSeq: number;
  readonly predecessorCheckpointId: string | null;
  readonly planRevisionId: string | null;
  readonly recoveryResponsibilityOwner: 'humanagent.runtime';
  readonly providerSettleReceipt: ProviderSettleReceipt;
  readonly toolEffects: readonly ToolEffectLedgerEntry[];
  readonly recoveryOutcome: TurnSegmentRecoveryOutcome;
  readonly outcome?: TurnSegmentRecoveryOutcome;
  readonly recoveryCheckpointRef?: string;
  readonly unknownMutatingCallIds?: readonly string[];
  readonly recordedAt?: string;
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requireSequence(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

export function validateProviderSettleReceipt(receipt: ProviderSettleReceipt): void {
  if (!receipt || typeof receipt !== 'object') {
    throw new ContractError('provider settle receipt must be an object');
  }
  if (!['not-sent', 'stopped', 'settled', 'unknown'].includes(receipt.state)) {
    throw new ContractError(`unsupported provider settle state: ${String(receipt.state)}`);
  }
  if (![
    'lease-process-exit-reconcile',
    'provider-adapter-stop-ack',
    'response-stream-eof',
  ].includes(receipt.verifiedBy)) {
    throw new ContractError(`unsupported provider settle verification: ${String(receipt.verifiedBy)}`);
  }
  if (receipt.state === 'not-sent') {
    if (receipt.providerRequestId !== null) {
      throw new ContractError('not-sent provider settle receipt cannot carry a provider request id');
    }
  } else if (receipt.state === 'unknown') {
    if (receipt.providerRequestId !== null) {
      requireText(receipt.providerRequestId, 'provider settle request id');
    }
  } else {
    requireText(receipt.providerRequestId, 'provider settle request id');
  }
  if (!isCanonicalInstant(receipt.verifiedAt)) {
    throw new ContractError('provider settle verifiedAt must be a canonical instant');
  }
}

export function validateToolEffectLedgerEntry(entry: ToolEffectLedgerEntry): void {
  if (!entry || typeof entry !== 'object') throw new ContractError('tool effect ledger entry must be an object');
  requireText(entry.callId, 'tool effect call id');
  requireText(entry.boundPlanStepId, 'tool effect bound plan step id');
  requireText(entry.toolName, 'tool effect tool name');
  if (entry.effectPolicy !== 'readonly' && entry.effectPolicy !== 'mutating') {
    throw new ContractError(`unsupported tool effect policy: ${String(entry.effectPolicy)}`);
  }
  requireText(entry.idempotencyKey, 'tool effect idempotency key');
  if (![
    'dispatched-effect-unknown',
    'effect-committed',
    'effect-failed-clean',
    'reconciled',
  ].includes(entry.state)) {
    throw new ContractError(`unsupported tool effect state: ${String(entry.state)}`);
  }
  if (entry.outputArtifactRef !== null) requireText(entry.outputArtifactRef, 'tool effect output artifact ref');
}

/** Deterministic recovery branch: only an unknown mutating effect requires hold. */
export function decideTurnSegmentRecovery(
  toolEffects: readonly ToolEffectLedgerEntry[],
): Exclude<TurnSegmentRecoveryOutcome, 'stopped'> {
  if (!Array.isArray(toolEffects)) throw new ContractError('turn segment tool effects must be an array');
  for (const entry of toolEffects) validateToolEffectLedgerEntry(entry);
  return toolEffects.some((entry) => (
    entry.effectPolicy === 'mutating' && entry.state === 'dispatched-effect-unknown'
  ))
    ? 'recovery-hold-effect-unknown'
    : 'recovery-auto-resumed';
}

export function validateTurnSegmentRecoveryFact(fact: TurnSegmentRecoveryFact): void {
  if (!fact || typeof fact !== 'object') throw new ContractError('turn segment recovery fact must be an object');
  requireText(fact.taskId, 'recovery task id');
  requireText(fact.operationId, 'recovery operation id');
  requireText(fact.turnId, 'recovery turn id');
  requireSequence(fact.executionEpoch, 'recovery execution epoch');
  requireSequence(fact.segmentSeq, 'recovery segment sequence');
  if (fact.predecessorCheckpointId !== null) {
    requireText(fact.predecessorCheckpointId, 'recovery predecessor checkpoint id');
  }
  if (fact.planRevisionId !== null) requireText(fact.planRevisionId, 'recovery plan revision id');
  if (fact.recoveryResponsibilityOwner !== 'humanagent.runtime') {
    throw new ContractError('recovery responsibility owner must be humanagent.runtime');
  }
  validateProviderSettleReceipt(fact.providerSettleReceipt);
  if (!Array.isArray(fact.toolEffects)) throw new ContractError('turn segment tool effects must be an array');
  const callIds = new Set<string>();
  for (const entry of fact.toolEffects) {
    validateToolEffectLedgerEntry(entry);
    if (callIds.has(entry.callId)) throw new ContractError('turn segment tool effect call ids must be unique');
    callIds.add(entry.callId);
  }
  if (![
    'recovery-auto-resumed',
    'recovery-hold-effect-unknown',
    'stopped',
  ].includes(fact.recoveryOutcome)) {
    throw new ContractError(`unsupported turn segment recovery outcome: ${String(fact.recoveryOutcome)}`);
  }
  if (fact.recoveryOutcome !== 'stopped' && fact.recoveryOutcome !== decideTurnSegmentRecovery(fact.toolEffects)) {
    throw new ContractError('turn segment recovery outcome does not match effect safety state');
  }
}
