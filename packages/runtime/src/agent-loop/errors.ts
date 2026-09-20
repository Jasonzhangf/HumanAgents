import { RuntimeError } from '../nodes/errors.js';

export type AgentLoopRuntimeErrorCode =
  | 'unknown-owner'
  | 'invalid-state'
  | 'duplicate'
  | 'conflict'
  | 'budget-exhausted';

export class AgentLoopRuntimeError extends RuntimeError {
  readonly code: AgentLoopRuntimeErrorCode;

  constructor(code: AgentLoopRuntimeErrorCode, message: string) {
    super(message, { ownerRef: 'agent-loop-runtime' });
    this.name = 'AgentLoopRuntimeError';
    this.code = code;
  }
}
