import type { Attention } from '../../../contracts/src/index.js';
import { ControlError } from './control-command.js';

export interface AttentionReceipt {
  readonly attentionId: string;
  readonly delivered: true;
}

export interface AttentionPort {
  publish(input: Attention): Promise<AttentionReceipt>;
  resolve(input: Attention): Promise<AttentionReceipt>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  Object.freeze(value);
  return value;
}

export async function publishRequiredAttention(port: AttentionPort, attention: Attention): Promise<AttentionReceipt> {
  if (attention.state !== 'open' && attention.state !== 'recovering') {
    throw new ControlError('foreground attention must be open or recovering');
  }
  const attentionId = attention.attentionId;
  const submitted = deepFreeze(structuredClone(attention));
  const receipt = await port.publish(submitted);
  if (!receipt.delivered || receipt.attentionId !== attentionId) {
    throw new ControlError('attention publication was not acknowledged');
  }
  return receipt;
}

export async function resolveAttention(port: AttentionPort, attention: Attention): Promise<AttentionReceipt> {
  if (attention.state !== 'resolved') throw new ControlError('attention resolution requires resolved state');
  const attentionId = attention.attentionId;
  const submitted = deepFreeze(structuredClone(attention));
  const receipt = await port.resolve(submitted);
  if (!receipt.delivered || receipt.attentionId !== attentionId) {
    throw new ControlError('attention resolution was not acknowledged');
  }
  return receipt;
}
