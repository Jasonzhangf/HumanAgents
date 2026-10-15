import { canonicalJsonStringify } from './explicit-brain.js';
import type { OperationResult } from './tool-execution.js';
import type {
  ProviderExecutionIdentityRef,
  ScopeRef,
} from './index.js';
import { ContractError } from './errors.js';

export type Sha256Digest = `sha256:${string}`;
export type EffectIdentity = `file-write-effect:v1:${string}`;
export type CompletionCommitIdentity = `operation-completion:v1:${string}`;

export interface EffectExecutionBinding {
  readonly execution: ProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly toolOperationId: OperationResult['operationId'];
  readonly requestId: string;
  readonly callId: string;
  readonly continuationRef: string;
}

export interface FileWriteEffect {
  readonly kind: 'file.write';
  readonly effectId: EffectIdentity;
  readonly workspaceRef: string;
  readonly relativePath: string;
  readonly inputDigest: Sha256Digest;
  readonly expectedContentDigest: Sha256Digest;
}

export interface FileWriteEffectIntent {
  readonly kind: 'operation-effect-intent';
  readonly version: 1;
  readonly binding: EffectExecutionBinding;
  readonly effect: FileWriteEffect;
}

export interface FileWriteCompletionResult extends OperationResult {
  readonly status: 'succeeded';
  readonly outputRef: string;
  readonly outputDigest: string;
}

export interface FileWriteCompletionFact {
  readonly kind: 'operation-completion';
  readonly version: 1;
  readonly binding: EffectExecutionBinding;
  readonly effect: FileWriteEffect;
  readonly confirmation: {
    readonly ownerId: string;
    readonly method: 'file-readback-digest';
    readonly observedContentDigest: Sha256Digest;
  };
  readonly result: FileWriteCompletionResult;
}

export interface DurableCompletionReceipt {
  readonly commitIdentity: CompletionCommitIdentity;
  readonly commitFactDigest: Sha256Digest;
  readonly journalSeq: number;
  readonly recordDigest: Sha256Digest;
  readonly fact: FileWriteCompletionFact;
}

export interface CompletionReadInput {
  readonly commitIdentity: CompletionCommitIdentity;
  readonly binding: EffectExecutionBinding;
  readonly effectId: EffectIdentity;
}

export type CompletionReadback =
  | {
      readonly state: 'confirmed';
      readonly receipt: DurableCompletionReceipt;
    }
  | {
      readonly state: 'unknown';
      readonly intent: FileWriteEffectIntent;
      readonly nextAction: 'reconcile';
      readonly replayAllowed: false;
    }
  | {
      readonly state: 'not-found';
    };

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError(`${label} is required`);
}

function assertDigest(value: string, label: string): asserts value is Sha256Digest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new ContractError(`${label} must be a sha256 digest`);
}

function assertEffectId(value: string): asserts value is EffectIdentity {
  if (!/^file-write-effect:v1:[0-9a-f]{64}$/.test(value)) throw new ContractError('effectId is invalid');
}

export function sameEffectExecutionBinding(left: EffectExecutionBinding, right: EffectExecutionBinding): boolean {
  return left.execution.runtimeId === right.execution.runtimeId
    && left.execution.taskId.value === right.execution.taskId.value
    && left.execution.operationId.value === right.execution.operationId.value
    && left.execution.organId?.value === right.execution.organId?.value
    && left.execution.cycleId?.value === right.execution.cycleId?.value
    && left.execution.executionEpoch === right.execution.executionEpoch
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value
    && left.toolOperationId.value === right.toolOperationId.value
    && left.requestId === right.requestId
    && left.callId === right.callId
    && left.continuationRef === right.continuationRef;
}

function assertBinding(binding: EffectExecutionBinding): void {
  assertNonEmpty(binding.execution.runtimeId, 'execution runtimeId');
  assertNonEmpty(binding.execution.taskId.value, 'execution taskId');
  assertNonEmpty(binding.execution.operationId.value, 'execution operationId');
  if (!Number.isSafeInteger(binding.execution.executionEpoch) || binding.execution.executionEpoch < 1) {
    throw new ContractError('execution epoch must be a positive safe integer');
  }
  assertNonEmpty(binding.scope.organId.value, 'scope organId');
  assertNonEmpty(binding.scope.taskId?.value ?? '', 'scope taskId');
  assertNonEmpty(binding.scope.cycleId?.value ?? '', 'scope cycleId');
  assertNonEmpty(binding.toolOperationId.value, 'tool operation id');
  assertNonEmpty(binding.requestId, 'requestId');
  assertNonEmpty(binding.callId, 'callId');
  assertNonEmpty(binding.continuationRef, 'continuationRef');
  if (binding.scope.operationId?.value !== binding.toolOperationId.value) {
    throw new ContractError('scope operationId must equal toolOperationId');
  }
  if (binding.execution.operationId.value === binding.toolOperationId.value) {
    throw new ContractError('toolOperationId must differ from the parent execution operationId');
  }
  if (binding.scope.taskId?.value !== binding.execution.taskId.value) {
    throw new ContractError('scope taskId must equal execution taskId');
  }
  if (binding.execution.organId !== undefined && binding.execution.organId.value !== binding.scope.organId.value) {
    throw new ContractError('scope organId must equal execution organId');
  }
  if (binding.execution.cycleId !== undefined && binding.execution.cycleId.value !== binding.scope.cycleId?.value) {
    throw new ContractError('scope cycleId must equal execution cycleId');
  }
}

function assertFileWriteEffect(effect: FileWriteEffect): void {
  if (effect.kind !== 'file.write') throw new ContractError('effect kind must be file.write');
  assertEffectId(effect.effectId);
  assertNonEmpty(effect.workspaceRef, 'workspaceRef');
  assertNonEmpty(effect.relativePath, 'relativePath');
  assertDigest(effect.inputDigest, 'inputDigest');
  assertDigest(effect.expectedContentDigest, 'expectedContentDigest');
}

export function validateFileWriteEffectIntent(input: FileWriteEffectIntent): void {
  if (input.kind !== 'operation-effect-intent' || input.version !== 1) {
    throw new ContractError('operation effect intent identity is invalid');
  }
  assertBinding(input.binding);
  assertFileWriteEffect(input.effect);
}

export function validateFileWriteCompletionFact(input: FileWriteCompletionFact): void {
  if (input.kind !== 'operation-completion' || input.version !== 1) {
    throw new ContractError('operation completion fact identity is invalid');
  }
  assertBinding(input.binding);
  assertFileWriteEffect(input.effect);
  assertNonEmpty(input.confirmation.ownerId, 'confirmation ownerId');
  if (input.confirmation.method !== 'file-readback-digest') throw new ContractError('confirmation method is invalid');
  assertDigest(input.confirmation.observedContentDigest, 'observedContentDigest');
  if (input.confirmation.observedContentDigest !== input.effect.expectedContentDigest) {
    throw new ContractError('observed content digest must equal expected content digest');
  }
  if (input.result.status !== 'succeeded') throw new ContractError('completion result must be succeeded');
  if (input.result.operationId.value !== input.binding.toolOperationId.value) {
    throw new ContractError('result operationId must equal toolOperationId');
  }
  assertNonEmpty(input.result.outputRef, 'result outputRef');
  assertDigest(input.result.outputDigest, 'result outputDigest');
  if (!Number.isFinite(Date.parse(input.result.completedAt))) throw new ContractError('result completedAt is invalid');
  for (const evidenceRef of input.result.evidenceRefs) {
    assertNonEmpty(evidenceRef.evidenceId.value, 'result evidence id');
  }
}

export async function validateDurableCompletionReceipt(input: DurableCompletionReceipt): Promise<void> {
  if (!/^operation-completion:v1:[0-9a-f]{64}$/.test(input.commitIdentity)) {
    throw new ContractError('completion commitIdentity is invalid');
  }
  assertDigest(input.commitFactDigest, 'commitFactDigest');
  assertDigest(input.recordDigest, 'recordDigest');
  if (!Number.isSafeInteger(input.journalSeq) || input.journalSeq < 1) throw new ContractError('journalSeq is invalid');
  validateFileWriteCompletionFact(input.fact);
  if (await completionCommitIdentity(input.fact.binding, input.fact.effect.effectId) !== input.commitIdentity) {
    throw new ContractError('completion commitIdentity does not match the fact binding');
  }
}

export async function fileWriteEffectId(binding: EffectExecutionBinding): Promise<EffectIdentity> {
  const digest = await createDigest({
    domain: 'humanagent.file-write-effect.v1',
    execution: binding.execution,
    scope: binding.scope,
    toolOperationId: binding.toolOperationId,
    requestId: binding.requestId,
    callId: binding.callId,
    continuationRef: binding.continuationRef,
  });
  return `file-write-effect:v1:${digest}`;
}

export async function completionCommitIdentity(binding: EffectExecutionBinding, effectId: EffectIdentity): Promise<CompletionCommitIdentity> {
  const digest = await createDigest({
    domain: 'humanagent.operation-completion.v1',
    binding,
    effectId,
  });
  return `operation-completion:v1:${digest}`;
}

async function createDigest(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJsonStringify(value));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
