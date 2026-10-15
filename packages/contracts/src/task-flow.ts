import { ContractError } from './errors.js';

export const TASK_FLOW_KINDS = ['one-shot', 'inspection', 'long-running'] as const;

export type TaskFlowKind = (typeof TASK_FLOW_KINDS)[number];

export const TASK_FLOW_DEFINITION_VERSION = 1 as const;

export interface TaskFlowBinding {
  readonly kind: TaskFlowKind;
  readonly definitionVersion: typeof TASK_FLOW_DEFINITION_VERSION;
}

/** Initial task-flow guidance and display grouping. Not task identity or control truth. */
export interface TaskFlowGuidance {
  readonly kind: TaskFlowKind;
  readonly aim: string;
  readonly selectionGuidance: string;
  readonly displayGroups: readonly string[];
}
export function assertTaskFlowKind(kind: unknown): asserts kind is TaskFlowKind {
  if (typeof kind !== 'string' || !TASK_FLOW_KINDS.includes(kind as TaskFlowKind)) {
    throw new ContractError('invalid task flow kind');
  }
}

export function validateTaskFlowBinding(input: TaskFlowBinding): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('task flow binding must be an object');
  }
  assertTaskFlowKind(input.kind);
  if (input.definitionVersion !== TASK_FLOW_DEFINITION_VERSION) {
    throw new ContractError('unsupported task flow definition version');
  }
}
