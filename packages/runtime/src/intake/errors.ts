export type IntakeOwner = 'explicit-intake' | 'runtime-coordinator' | 'human';

export interface IntakeErrorOptions {
  readonly owner: IntakeOwner;
  readonly nextAction: string;
  readonly condition?: string;
  readonly cause?: unknown;
}

export class IntakeError extends Error {
  readonly owner: IntakeOwner;
  readonly nextAction: string;
  readonly condition?: string;

  constructor(message: string, options: IntakeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.owner = options.owner;
    this.nextAction = options.nextAction;
    this.condition = options.condition;
  }
}

export class ExplicitIntakeError extends IntakeError {
  readonly code: string;

  constructor(code: string, message: string, options: IntakeErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export class RequirementInboxError extends IntakeError {
  readonly code: string;

  constructor(code: string, message: string, options: IntakeErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
