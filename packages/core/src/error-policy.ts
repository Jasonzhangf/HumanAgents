import type { NextAction } from '../../contracts/src/index.js';
import { ErrorPolicyError } from './errors.js';

export type ErrorLayer = 'background' | 'foreground';
export type ErrorDisposition = 'retry' | 'degrade' | 'wait' | 'blocked' | 'failed' | 'attention';

export interface ErrorPolicyInput {
  readonly layer: ErrorLayer;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sameCondition: boolean;
  readonly changedConditionRef?: string;
  readonly affectsUserPromise: boolean;
  readonly requiresUserInput: boolean;
  readonly recoverable: boolean;
  readonly ownerId: string;
  readonly conditionRef?: string;
  readonly escalationTarget?: string;
}

export interface ErrorPolicyDecision {
  readonly layer: ErrorLayer;
  readonly disposition: ErrorDisposition;
  readonly retryAllowed: boolean;
  readonly mustPublishAttentionBeforeSettle: boolean;
  readonly nextAction: NextAction;
  readonly ownerId: string;
  readonly conditionRef?: string;
  readonly escalationTarget?: string;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ErrorPolicyError(`${label} must be a positive safe integer`);
}

function nonEmpty(value: string | undefined, label: string): void {
  if (!value || !value.trim()) throw new ErrorPolicyError(`${label} is required`);
}

export function classifyErrorPolicy(input: ErrorPolicyInput): ErrorPolicyDecision {
  positiveInteger(input.attempt, 'attempt');
  positiveInteger(input.maxAttempts, 'maxAttempts');
  nonEmpty(input.ownerId, 'ownerId');
  if (input.changedConditionRef !== undefined) nonEmpty(input.changedConditionRef, 'changedConditionRef');

  const foreground = input.layer === 'foreground' || input.affectsUserPromise || input.requiresUserInput;
  if (foreground) {
    return {
      layer: 'foreground',
      disposition: 'attention',
      retryAllowed: false,
      mustPublishAttentionBeforeSettle: true,
      nextAction: { kind: 'recover', ref: input.escalationTarget ?? 'attention' },
      ownerId: input.ownerId,
      conditionRef: input.conditionRef,
      escalationTarget: input.escalationTarget,
    };
  }

  const boundedRetry =
    input.recoverable &&
    input.attempt < input.maxAttempts &&
    (!input.sameCondition || (input.changedConditionRef !== undefined && input.changedConditionRef.trim().length > 0));
  if (boundedRetry) {
    return {
      layer: 'background',
      disposition: 'retry',
      retryAllowed: true,
      mustPublishAttentionBeforeSettle: false,
      nextAction: { kind: 'recover', ref: input.changedConditionRef ?? input.conditionRef ?? 'retry' },
      ownerId: input.ownerId,
      conditionRef: input.conditionRef,
      escalationTarget: input.escalationTarget,
    };
  }

  if (input.recoverable && (input.conditionRef !== undefined || input.changedConditionRef !== undefined)) {
    const conditionRef = input.changedConditionRef ?? input.conditionRef;
    nonEmpty(conditionRef, 'wait condition');
    return {
      layer: 'background',
      disposition: 'wait',
      retryAllowed: false,
      mustPublishAttentionBeforeSettle: false,
      nextAction: { kind: 'wait', ref: conditionRef },
      ownerId: input.ownerId,
      conditionRef,
      escalationTarget: input.escalationTarget,
    };
  }

  if (input.recoverable) {
    nonEmpty(input.escalationTarget, 'recovery escalation target');
    return {
      layer: 'background',
      disposition: 'attention',
      retryAllowed: false,
      mustPublishAttentionBeforeSettle: false,
      nextAction: { kind: 'recover', ref: input.escalationTarget },
      ownerId: input.ownerId,
      escalationTarget: input.escalationTarget,
    };
  }

  nonEmpty(input.escalationTarget, 'failure escalation target');
  return {
    layer: 'background',
    disposition: 'failed',
    retryAllowed: false,
    mustPublishAttentionBeforeSettle: false,
    nextAction: { kind: 'stop', ref: input.escalationTarget },
    ownerId: input.ownerId,
    escalationTarget: input.escalationTarget,
  };
}
