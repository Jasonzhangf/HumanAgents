import { ContractError } from '../../../contracts/src/index.js';

export type DshAdapterErrorCode =
  | 'dependency-missing'
  | 'capability-unavailable'
  | 'configuration-invalid'
  | 'identity-mismatch'
  | 'transport-failure';

export type DshAdapterNextAction = { readonly kind: 'continue' | 'wait' | 'stop' | 'recover'; readonly ref?: string };

export class DshAdapterError extends ContractError {
  readonly code: DshAdapterErrorCode;
  readonly ownerId: string;
  readonly nextAction: DshAdapterNextAction;

  constructor(code: DshAdapterErrorCode, message: string, ownerId: string, nextAction: DshAdapterNextAction = { kind: 'recover', ref: ownerId }) {
    super(message);
    this.name = 'DshAdapterError';
    this.code = code;
    this.ownerId = ownerId;
    this.nextAction = nextAction;
  }
}
