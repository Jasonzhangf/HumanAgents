export class AppLifecycleError extends Error {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;

  constructor(code: string, message: string, nextAction: string, ownerId = 'host') {
    super(message);
    this.name = 'AppLifecycleError';
    this.code = code;
    this.ownerId = ownerId;
    this.nextAction = nextAction;
  }
}
