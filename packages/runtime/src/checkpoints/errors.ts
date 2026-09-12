export class CheckpointCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCoordinatorError';
  }
}

export class CheckpointRecallError extends CheckpointCoordinatorError {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointRecallError';
  }
}

export class CheckpointCompletionError extends CheckpointCoordinatorError {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCompletionError';
  }
}
