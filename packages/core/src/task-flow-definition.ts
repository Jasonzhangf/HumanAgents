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
    displayGroups: ['Dynamic Work', 'Turn Checkpoint', 'Planner Alignment'],
    layout: 'turn-closure-loop',
    stages: [
      {
        stageId: 'dynamic-work',
        title: '轮内动态选择区',
        summary: '探索、规划、审查和执行由编排者按需选择，可重复且不要求固定顺序。',
        role: 'dynamic-choice-region',
        group: 'Dynamic Work',
        dynamicChoices: ['探索', '规划', '审查', '执行'],
      },
      {
        stageId: 'turn-checkpoint',
        title: '轮末检查点',
        summary: '每个结束的轮次先记录目标、动作、结果和预期下一步。',
        role: 'mandatory-turn-checkpoint',
        group: 'Turn Checkpoint',
      },
      {
        stageId: 'planner-alignment',
        title: '轮末规划对齐',
        summary: '检查点之后由规划器核对目标，并决定完成、失败或继续。',
        role: 'mandatory-planner-alignment',
        group: 'Planner Alignment',
      },
    ],
    dependencies: [
      { fromStageId: 'dynamic-work', toStageId: 'turn-checkpoint' },
      { fromStageId: 'turn-checkpoint', toStageId: 'planner-alignment' },
    ],
    loops: [
      {
        kind: 'turn-iteration',
        title: '轮次迭代',
        fromStageId: 'planner-alignment',
        toStageId: 'dynamic-work',
        summary: '未完成则开启下一轮。',
        stopCondition: '任务完成或失败。',
      },
    ],
  },
  inspection: {
    kind: 'inspection',
    aim: 'Emit check-ID result occurrences for the same check definition, keep findings separate from necessary action, and retain history.',
    selectionGuidance: 'Select methods and roles dynamically; no fixed explore/plan/execute/review chain is required.',
    displayGroups: ['Occurrence Trigger', 'Dynamic Work', 'Turn Checkpoint', 'Planner Alignment'],
    layout: 'occurrence-and-turn-closure-loop',
    stages: [
      {
        stageId: 'occurrence-trigger',
        title: '巡检触发',
        summary: '绑定本轮巡检的触发来源和历史基线。',
        role: 'occurrence-trigger',
        group: 'Occurrence Trigger',
      },
      {
        stageId: 'dynamic-work',
        title: '轮内动态选择区',
        summary: '探索、规划、审查和执行由编排者按需选择，可重复且不要求固定顺序。',
        role: 'dynamic-choice-region',
        group: 'Dynamic Work',
        dynamicChoices: ['探索', '规划', '审查', '执行'],
      },
      {
        stageId: 'turn-checkpoint',
        title: '轮末检查点',
        summary: '每个结束的轮次先记录目标、动作、结果和预期下一步。',
        role: 'mandatory-turn-checkpoint',
        group: 'Turn Checkpoint',
      },
      {
        stageId: 'planner-alignment',
        title: '轮末规划对齐',
        summary: '检查点之后由规划器核对目标，并决定完成、失败或继续。',
        role: 'mandatory-planner-alignment',
        group: 'Planner Alignment',
      },
    ],
    dependencies: [
      { fromStageId: 'occurrence-trigger', toStageId: 'dynamic-work' },
      { fromStageId: 'dynamic-work', toStageId: 'turn-checkpoint' },
      { fromStageId: 'turn-checkpoint', toStageId: 'planner-alignment' },
    ],
    loops: [
      {
        kind: 'turn-iteration',
        title: '轮次迭代',
        fromStageId: 'planner-alignment',
        toStageId: 'dynamic-work',
        summary: '同一巡检轮次内继续。',
        stopCondition: '当前巡检轮次结束或任务失败。',
      },
      {
        kind: 'occurrence-repetition',
        title: '巡检重复',
        fromStageId: 'planner-alignment',
        toStageId: 'occurrence-trigger',
        summary: '下一次定时或事件触发开启新的巡检轮次，并与历史基线对比。',
        stopCondition: '巡检定义停用或触发条件不再满足。',
      },
    ],
  },
  'long-running': {
    kind: 'long-running',
    aim: 'Complete one whole-goal part per current revision; use applicable review, standard closure, and the Planner to update the whole-task plan.',
    selectionGuidance: 'Select methods and roles dynamically; no fixed explore/plan/execute/review chain is required.',
    displayGroups: ['Dynamic Work', 'Turn Checkpoint', 'Planner Alignment'],
    layout: 'turn-closure-loop',
    stages: [
      {
        stageId: 'dynamic-work',
        title: '轮内动态选择区',
        summary: '探索、规划、审查和执行由编排者按需选择，可重复且不要求固定顺序。',
        role: 'dynamic-choice-region',
        group: 'Dynamic Work',
        dynamicChoices: ['探索', '规划', '审查', '执行'],
      },
      {
        stageId: 'turn-checkpoint',
        title: '轮末检查点',
        summary: '每个结束的轮次先记录目标、动作、结果和预期下一步。',
        role: 'mandatory-turn-checkpoint',
        group: 'Turn Checkpoint',
      },
      {
        stageId: 'planner-alignment',
        title: '轮末规划对齐与计划演进',
        summary: '检查点之后由规划器核对目标并演进后续计划，再决定完成、失败或继续。',
        role: 'mandatory-planner-alignment',
        group: 'Planner Alignment',
      },
    ],
    dependencies: [
      { fromStageId: 'dynamic-work', toStageId: 'turn-checkpoint' },
      { fromStageId: 'turn-checkpoint', toStageId: 'planner-alignment' },
    ],
    loops: [
      {
        kind: 'turn-iteration',
        title: '轮次迭代',
        fromStageId: 'planner-alignment',
        toStageId: 'dynamic-work',
        summary: '持续驱动后续轮次与阶段。',
        stopCondition: '任务完成或失败。',
      },
    ],
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
  return {
    ...guidance,
    displayGroups: [...guidance.displayGroups],
    stages: guidance.stages.map((stage) => ({
      ...stage,
      ...(stage.dynamicChoices === undefined ? {} : { dynamicChoices: [...stage.dynamicChoices] }),
    })),
    dependencies: guidance.dependencies.map((dependency) => ({ ...dependency })),
    loops: guidance.loops.map((loop) => ({ ...loop })),
  };
}

/** Legacy bindings remain absent and are never defaulted to one-shot. */
export function resolveTaskFlowGuidanceFromBinding(binding?: TaskFlowBinding): TaskFlowGuidance | undefined {
  if (binding === undefined) return undefined;
  return resolveTaskFlowGuidance(binding);
}
