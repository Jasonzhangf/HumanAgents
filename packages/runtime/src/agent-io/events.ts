import type {
  AgentControlBlock,
  AgentIoClosure,
  AgentIoProviderBinding,
} from './types.js';

export type AgentHookStage =
  | 'request.created'
  | 'request.admitted'
  | 'request.before-dispatch'
  | 'request.dispatched'
  | 'attempt.started'
  | 'prompt.rendered'
  | 'response.received'
  | 'response.decoded'
  | 'control.decoded'
  | 'tool-intent.decoded'
  | 'memory-candidate.decoded'
  | 'result.mapped'
  | 'context.committed'
  | 'request.settled';

export type AgentIoEventKind =
  | 'request.created'
  | 'request.admitted'
  | 'request.before-dispatch'
  | 'request.dispatched'
  | 'attempt.started'
  | 'prompt.rendered'
  | 'agent.delta.received'
  | 'agent.output.received'
  | 'response.decoded'
  | 'control.decoded'
  | 'tool-intent.decoded'
  | 'memory-candidate'
  | 'stream.gap'
  | 'transport.eof'
  | 'protocol.repair'
  | 'protocol.noncompliant'
  | 'watchdog.stopped'
  | 'hook.started'
  | 'hook.completed'
  | 'hook.failed'
  | 'request.settled';

export type AgentIoEvent = {
  readonly eventId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly occurredAtMs: number;
  readonly stage: AgentHookStage;
  readonly kind: AgentIoEventKind;
  readonly sourceRef?: string;
  readonly correlation?: string;
  readonly payloadRef?: string;
  readonly ownerId?: string;
  readonly providerBinding?: Readonly<AgentIoProviderBinding>;
  readonly control?: Readonly<Partial<AgentControlBlock>>;
  readonly toolIntentRef?: string;
  readonly memoryCandidateRef?: string;
  readonly diagnostics?: readonly string[];
  readonly closure?: Readonly<AgentIoClosure>;
  readonly hookId?: string;
  readonly hookStage?: AgentHookStage;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly ownerId: string;
    readonly retryable: boolean;
    readonly nextAction?: string;
  };
};
