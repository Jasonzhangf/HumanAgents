import type { NextAction } from '../../../contracts/src/index.js';

export interface CheckpointCoordinatorErrorOptions {
  readonly ownerId?: string;
  readonly nextAction?: NextAction;
  readonly cause?: unknown;
}

const CHECKPOINT_CONTROL_OWNER = 'runtime.checkpoint-control';
const CHECKPOINT_RECOVERY_NEXT_ACTION: NextAction = { kind: 'recover', ref: 'checkpoint-control' };

export class CheckpointCoordinatorError extends Error {
  readonly ownerId: string;
  readonly nextAction: NextAction;

  constructor(message: string, options: CheckpointCoordinatorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CheckpointCoordinatorError';
    this.ownerId = options.ownerId ?? CHECKPOINT_CONTROL_OWNER;
    this.nextAction = options.nextAction ?? CHECKPOINT_RECOVERY_NEXT_ACTION;
  }
}

export class CheckpointRecallError extends CheckpointCoordinatorError {
  constructor(message: string, options: CheckpointCoordinatorErrorOptions = {}) {
    super(message, options);
    this.name = 'CheckpointRecallError';
  }
}

export class CheckpointCompletionError extends CheckpointCoordinatorError {
  constructor(message: string, options: CheckpointCoordinatorErrorOptions = {}) {
    super(message, options);
    this.name = 'CheckpointCompletionError';
  }
}

export class CheckpointSubmissionError extends CheckpointCoordinatorError {
  constructor(message: string, options: CheckpointCoordinatorErrorOptions = {}) {
    super(message, options);
    this.name = 'CheckpointSubmissionError';
  }
}

export class CheckpointClosureError extends CheckpointCoordinatorError {
  constructor(message: string, options: CheckpointCoordinatorErrorOptions = {}) {
    super(message, options);
    this.name = 'CheckpointClosureError';
  }
}
