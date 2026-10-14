import {
  validateTaskFlowBinding,
  type TaskFlowBinding,
  type TaskFlowGuidance,
} from '../../contracts/src/index.js';

const TASK_FLOW_GUIDANCE: Record<TaskFlowBinding['kind'], TaskFlowGuidance> = {
  'one-shot': {
    kind: 'one-shot',
    aim: 'Return one result after the confirmed deliverable and applicable review or standard closure.',
    selectionGuidance: 'Select methods and roles dynamically; no fixed explore/plan/execute/review chain is required.',
    displayGroups: ['Deliverable', 'Review', 'Closure'],
  },
  inspection: {
    kind: 'inspection',
    aim: 'Emit check-ID result occurrences for the same check definition, keep findings separate from necessary action, and retain history.',
    selectionGuidance: 'Select methods and roles dynamically; no fixed explore/plan/execute/review chain is required.',
    displayGroups: ['Check Definition', 'Results', 'Findings', 'Action', 'History'],
  },
  'long-running': {
    kind: 'long-running',
    aim: 'Complete one whole-goal part per current revision; use applicable review, standard closure, and the Planner to update the whole-task plan.',
    selectionGuidance: 'Select methods and roles dynamically; no fixed explore/plan/execute/review chain is required.',
    displayGroups: ['Current Part', 'Review', 'Closure', 'Plan Update'],
  },
};

/**
 * Guidance is initial task-flow guidance and display grouping only. It is not
 * a user-editable registry, execution plan, task identity, control truth, or
 * a required explore/plan/execute/review role chain.
 */
export function resolveTaskFlowGuidance(binding: TaskFlowBinding): TaskFlowGuidance {
  validateTaskFlowBinding(binding);
  const guidance = TASK_FLOW_GUIDANCE[binding.kind];
  return { ...guidance, displayGroups: [...guidance.displayGroups] };
}

/** Legacy bindings remain absent and are never defaulted to one-shot. */
export function resolveTaskFlowGuidanceFromBinding(binding?: TaskFlowBinding): TaskFlowGuidance | undefined {
  if (binding === undefined) return undefined;
  return resolveTaskFlowGuidance(binding);
}
