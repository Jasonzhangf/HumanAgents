import type { EvidenceRef, NextAction } from '../../../contracts/src/index.js';

export class OrchestrationError extends Error {
  readonly ownerId: string;
  readonly reason: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly conditionRef?: string;

  constructor(
    message: string,
    input: {
      readonly ownerId: string;
      readonly reason: string;
      readonly nextAction: NextAction;
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly conditionRef?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: input.cause });
    this.name = 'OrchestrationError';
    this.ownerId = input.ownerId;
    this.reason = input.reason;
    this.nextAction = input.nextAction;
    this.evidenceRefs = [...input.evidenceRefs];
    this.conditionRef = input.conditionRef;
  }
}

export class OrchestrationPortError extends OrchestrationError {
  constructor(
    message: string,
    input: ConstructorParameters<typeof OrchestrationError>[1],
  ) {
    super(message, input);
    this.name = 'OrchestrationPortError';
  }
}

export class AssignmentGraphError extends OrchestrationError {
  constructor(
    message: string,
    input: ConstructorParameters<typeof OrchestrationError>[1],
  ) {
    super(message, input);
    this.name = 'AssignmentGraphError';
  }
}
