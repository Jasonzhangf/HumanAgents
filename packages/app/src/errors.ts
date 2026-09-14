export class AppLifecycleError extends Error {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, nextAction: string, ownerId = 'host', cause?: unknown) {
    super(message);
    this.name = 'AppLifecycleError';
    this.code = code;
    this.ownerId = ownerId;
    this.nextAction = nextAction;
    this.cause = cause;
  }
}
