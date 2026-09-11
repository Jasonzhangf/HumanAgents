import { assertBusinessPayload, type BusinessPayload, type LifecycleState, type TaskId } from '@humanagent/contracts';

export type UiCommandSurface =
  | 'dashboard'
  | 'task-list'
  | 'task-detail'
  | 'task-dashboard'
  | 'observation'
  | 'memory-interaction';

export interface UiCommandBase<Surface extends UiCommandSurface, Kind extends string> {
  readonly commandId: string;
  readonly surface: Surface;
  readonly kind: Kind;
}

export type DashboardCommand =
  | UiCommandBase<'dashboard', 'navigate.task-list'>
  | (UiCommandBase<'dashboard', 'navigate.task-detail'> & { readonly taskId: TaskId })
  | UiCommandBase<'dashboard', 'navigate.new-task'>;

export type TaskListCommand =
  | (UiCommandBase<'task-list', 'navigate.task-detail'> & { readonly taskId: TaskId })
  | (UiCommandBase<'task-list', 'navigate.task-dashboard'> & { readonly taskId: TaskId })
  | (UiCommandBase<'task-list', 'set-filters'> & {
      readonly scope?: 'current' | 'decision' | 'history' | 'all';
      readonly query?: string;
      readonly status?: LifecycleState | 'all';
    });

export type TaskDetailCommand =
  | (UiCommandBase<'task-detail', 'submit-input'> & {
      readonly taskId: TaskId;
      readonly payload: BusinessPayload;
      readonly inputPreview: string;
    })
  | (UiCommandBase<'task-detail', 'confirm-draft'> & {
      readonly draftId: string;
      readonly intent: 'append' | 'change' | 'create';
      readonly taskId?: TaskId;
      readonly normalizedInput: string;
      readonly confirmedBy: string;
      readonly payloadRef: string;
    })
  | (UiCommandBase<'task-detail', 'revise-draft'> & {
      readonly draftId: string;
      readonly feedback: string;
    })
  | (UiCommandBase<'task-detail', 'choose-option'> & {
      readonly taskId: TaskId;
      readonly optionId: string;
    })
  | (UiCommandBase<'task-detail', 'custom-decision'> & {
      readonly taskId: TaskId;
      readonly text: string;
    })
  | (UiCommandBase<'task-detail', 'request-status-only'> & { readonly taskId: TaskId })
  | (UiCommandBase<'task-detail', 'answer-input-request'> & {
      readonly taskId: TaskId;
      readonly requestId: string;
      readonly payload: BusinessPayload;
    })
  | (UiCommandBase<'task-detail', 'review-skill'> & {
      readonly candidateId: string;
      readonly decision: 'approve' | 'reject' | 'revise' | 'defer';
      readonly revision?: string;
    })
  | (UiCommandBase<'task-detail', 'acknowledge-output'> & { readonly taskId: TaskId })
  | (UiCommandBase<'task-detail', 'navigate.observation'> & { readonly taskId: TaskId });

export type TaskDashboardCommand =
  | (UiCommandBase<'task-dashboard', 'open-agent-drawer'> & { readonly agentId: string })
  | UiCommandBase<'task-dashboard', 'close-agent-drawer'>
  | (UiCommandBase<'task-dashboard', 'navigate.task-detail'> & { readonly taskId: TaskId })
  | (UiCommandBase<'task-dashboard', 'navigate.observation'> & { readonly taskId: TaskId });

export type PipelineObservationCommand =
  | (UiCommandBase<'observation', 'open-node-drawer'> & { readonly nodeId: string })
  | UiCommandBase<'observation', 'close-node-drawer'>
  | (UiCommandBase<'observation', 'enter-scope'> & { readonly scopeRef: string })
  | (UiCommandBase<'observation', 'return-scope'> & { readonly stepsBack?: number })
  | (UiCommandBase<'observation', 'focus-node'> & { readonly nodeId: string });

export type MemoryInteractionCommand =
  | (UiCommandBase<'memory-interaction', 'query'> & { readonly query: string; readonly limit: number })
  | (UiCommandBase<'memory-interaction', 'inspect'> & { readonly selectionRef: string })
  | (UiCommandBase<'memory-interaction', 'compare'> & {
      readonly selectionRefs: readonly [string, string];
    })
  | (UiCommandBase<'memory-interaction', 'annotate'> & {
      readonly sourceRef: string;
      readonly annotation: string;
    })
  | (UiCommandBase<'memory-interaction', 'review-skill'> & {
      readonly candidateId: string;
      readonly decision: 'approve' | 'reject' | 'revise' | 'defer';
      readonly revision?: string;
    })
  | UiCommandBase<'memory-interaction', 'navigate.task-detail'>;

export type UiCommand =
  | DashboardCommand
  | TaskListCommand
  | TaskDetailCommand
  | TaskDashboardCommand
  | PipelineObservationCommand
  | MemoryInteractionCommand;

export class UiCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiCommandError';
  }
}

const OBSERVATION_ONLY_KINDS = new Set([
  'open-node-drawer',
  'close-node-drawer',
  'enter-scope',
  'return-scope',
  'focus-node',
]);

const RUNTIME_EFFECT_KINDS = new Set([
  'submit-input',
  'confirm-draft',
  'revise-draft',
  'choose-option',
  'custom-decision',
  'request-status-only',
  'answer-input-request',
  'review-skill',
  'acknowledge-output',
  'annotate',
]);

const READ_ONLY_SURFACE_KINDS = new Set([
  'navigate.task-list',
  'navigate.task-detail',
  'navigate.task-dashboard',
  'navigate.new-task',
  'navigate.observation',
  'set-filters',
  'open-agent-drawer',
  'close-agent-drawer',
]);

function hasPayload(command: UiCommand): command is Extract<UiCommand, { readonly payload: BusinessPayload }> {
  return 'payload' in command;
}

export function validateUiCommand(command: UiCommand): void {
  if (command.surface === 'observation' && !OBSERVATION_ONLY_KINDS.has(command.kind)) {
    throw new UiCommandError('observation accepts read-only navigation and drawer commands only');
  }
  if (RUNTIME_EFFECT_KINDS.has(command.kind) && command.surface !== 'task-detail' && command.surface !== 'memory-interaction') {
    throw new UiCommandError('user decisions must stay on the explicit interaction surface');
  }
  if ((command.surface === 'dashboard' || command.surface === 'task-list' || command.surface === 'task-dashboard') && !READ_ONLY_SURFACE_KINDS.has(command.kind)) {
    throw new UiCommandError(`surface ${command.surface} only accepts navigation or view commands`);
  }
  if (hasPayload(command)) {
    try {
      assertBusinessPayload(command.payload);
    } catch (error) {
      throw new UiCommandError(error instanceof Error ? error.message : 'invalid command payload');
    }
  }
}

export function assertObservationReadOnly(command: UiCommand): asserts command is PipelineObservationCommand {
  if (command.surface !== 'observation') {
    throw new UiCommandError('expected an observation command');
  }
  validateUiCommand(command);
}

export function assertTaskInteractionCommand(command: UiCommand): asserts command is TaskDetailCommand {
  if (command.surface !== 'task-detail') {
    throw new UiCommandError('task decisions require the task-detail interaction surface');
  }
  validateUiCommand(command);
}

export function assertMemoryInteractionCommand(command: UiCommand): asserts command is MemoryInteractionCommand {
  if (command.surface !== 'memory-interaction') {
    throw new UiCommandError('memory decisions require the memory-interaction surface');
  }
  validateUiCommand(command);
}

export function isReadOnlyObservationCommand(command: UiCommand): command is PipelineObservationCommand {
  try {
    assertObservationReadOnly(command);
    return true;
  } catch {
    return false;
  }
}
