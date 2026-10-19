import { ContractError } from './errors.js';

export const TASK_FLOW_KINDS = ['one-shot', 'inspection', 'long-running'] as const;

export type TaskFlowKind = (typeof TASK_FLOW_KINDS)[number];

export const TASK_FLOW_DEFINITION_VERSION = 1 as const;

export interface TaskFlowBinding {
  readonly kind: TaskFlowKind;
  readonly definitionVersion: typeof TASK_FLOW_DEFINITION_VERSION;
}

export type TaskFlowStageRole =
  | 'occurrence-trigger'
  | 'dynamic-choice-region'
  | 'mandatory-turn-checkpoint'
  | 'mandatory-planner-alignment';

export type TaskFlowLayoutMode =
  | 'turn-closure-loop'
  | 'occurrence-and-turn-closure-loop';

export type TaskFlowLoopKind = 'turn-iteration' | 'occurrence-repetition';

export interface TaskFlowStageGuidance {
  readonly stageId: string;
  readonly title: string;
  readonly summary: string;
  readonly role: TaskFlowStageRole;
  readonly group: string;
  readonly dynamicChoices?: readonly string[];
}

export interface TaskFlowStageDependency {
  readonly fromStageId: string;
  readonly toStageId: string;
}

export interface TaskFlowLoopGuidance {
  readonly kind: TaskFlowLoopKind;
  readonly title: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly summary: string;
  readonly stopCondition: string;
}

/** Initial task-flow guidance and display grouping. Not task identity or control truth. */
export interface TaskFlowGuidance {
  readonly kind: TaskFlowKind;
  readonly aim: string;
  readonly selectionGuidance: string;
  readonly displayGroups: readonly string[];
  readonly layout: TaskFlowLayoutMode;
  readonly stages: readonly TaskFlowStageGuidance[];
  readonly dependencies: readonly TaskFlowStageDependency[];
  readonly loops: readonly TaskFlowLoopGuidance[];
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
