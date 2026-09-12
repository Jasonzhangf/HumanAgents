import {
  classifyErrorPolicy,
  type ErrorPolicyInput,
  type ErrorPolicyDecision,
} from '../../../core/src/index.js';
import type { Attention, ScopeRef } from '../../../contracts/src/index.js';
import { publishRequiredAttention, type AttentionPort, type AttentionReceipt } from './attention.js';
import { ControlError } from './control-command.js';

export interface SupervisionInput extends ErrorPolicyInput {
  readonly issueId: string;
  readonly scope: ScopeRef;
  readonly message: string;
  readonly evidenceRefs: Attention['evidenceRefs'];
}

export interface SupervisionDecision {
  readonly policy: ErrorPolicyDecision;
  readonly ownerId: string;
  readonly nextAction: ErrorPolicyDecision['nextAction'];
  readonly conditionRef?: string;
  readonly escalationTarget?: string;
  readonly attention?: Attention;
  readonly attentionReceipt?: AttentionReceipt;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new ControlError(`${label} is required`);
  return value;
}

function attentionFor(input: SupervisionInput): Attention {
  return {
    attentionId: required(input.issueId, 'issue id'),
    scope: input.scope,
    severity: input.requiresUserInput || !input.recoverable ? 'blocker' : 'attention',
    state: 'open',
    message: required(input.message, 'attention message'),
    evidenceRefs: input.evidenceRefs,
  };
}

export async function superviseFailure(
  input: SupervisionInput,
  attentionPort?: AttentionPort,
): Promise<SupervisionDecision> {
  const policy = classifyErrorPolicy(input);
  const base = {
    policy,
    ownerId: policy.ownerId,
    nextAction: policy.nextAction,
    conditionRef: policy.conditionRef,
    escalationTarget: policy.escalationTarget,
  };
  if (policy.disposition === 'retry' && policy.nextAction.ref === 'retry') {
    throw new ControlError('retry requires an explicit changed condition or condition reference');
  }
  if (policy.layer !== 'foreground') return base;
  if (!attentionPort) throw new ControlError('foreground failure requires an attention port');
  const attention = attentionFor(input);
  const attentionReceipt = await publishRequiredAttention(attentionPort, attention);
  return { ...base, attention, attentionReceipt };
}
