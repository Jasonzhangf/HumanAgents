export class CoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreError';
  }
}

export class LifecycleError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export class EpochError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'EpochError';
  }
}

export class PermissionError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export class ErrorPolicyError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorPolicyError';
  }
}

export class CheckpointError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

export class HealthError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'HealthError';
  }
}
