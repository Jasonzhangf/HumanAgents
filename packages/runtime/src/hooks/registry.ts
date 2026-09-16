import type { AgentHookStage, AgentIoEvent } from '../agent-io/events.js';

export type AgentHookMode = 'core' | 'observation';

export interface AgentHookInput {
  readonly requestId: string;
  readonly attemptId: string;
  readonly stage: AgentHookStage;
  readonly sourceRef?: string;
  readonly correlation?: string;
  readonly payloadRef?: string;
}

export type AgentHookResult =
  | {
      readonly status: 'observed' | 'derived';
      readonly outputRefs?: readonly string[];
      readonly eventRefs?: readonly string[];
      readonly diagnostics?: readonly string[];
      readonly ownerId?: string;
    }
  | {
      readonly status: 'waiting' | 'failed';
      readonly diagnostics: readonly string[];
      readonly ownerId?: string;
      readonly nextAction?: string;
    };

export interface AgentLifecycleHook {
  readonly hookId: string;
  readonly version: string;
  readonly mode: AgentHookMode;
  readonly stages: readonly AgentHookStage[];
  onEnter?(input: AgentHookInput): Promise<AgentHookResult>;
  onExit?(input: AgentHookInput): Promise<AgentHookResult>;
}

export type HookRunResult = {
  readonly hookId: string;
  readonly hookStage: AgentHookStage;
  readonly result: AgentHookResult;
  readonly blocked: boolean;
};

export interface AgentHookRegistry {
  add(hook: AgentLifecycleHook): void;
  runStage(stage: AgentHookStage, input: Omit<AgentHookInput, 'stage'>, phase: 'enter' | 'exit'): Promise<HookRunResult[]>;
}

export function createHookRegistry(
  emit: (event: AgentIoEvent) => void | Promise<void>,
  now: () => number,
  hooks: readonly AgentLifecycleHook[] = [],
): AgentHookRegistry {
  const entries = [...hooks];
  let sequence = 0;

  function nextEvent(
    kind: AgentIoEvent['kind'],
    hookId: string,
    hookStage: AgentHookStage,
    input: AgentHookInput,
  ): AgentIoEvent {
    return {
      eventId: `hook-${kind}-${hookId}-${sequence}`,
      requestId: input.requestId,
      attemptId: input.attemptId,
      sequence: ++sequence,
      occurredAtMs: now(),
      stage: hookStage,
      kind,
      hookId,
      hookStage,
      sourceRef: input.sourceRef,
      correlation: input.correlation,
      payloadRef: input.payloadRef,
      ownerId: input.correlation,
    };
  }

  const registry = {
    add(hook: AgentLifecycleHook): void {
      entries.push(hook);
    },

    async runStage(
      stage: AgentHookStage,
      input: Omit<AgentHookInput, 'stage'>,
      phase: 'enter' | 'exit',
    ): Promise<HookRunResult[]> {
      const results: HookRunResult[] = [];
      const skip: string[] = [];
      for (const hook of entries.filter((entry) => entry.stages.includes(stage))) {
        if (skip.includes(hook.hookId)) {
          results.push({
            hookId: hook.hookId,
            hookStage: stage,
            result: { status: 'failed', diagnostics: ['core hook failed; dependent hooks were skipped'], ownerId: hook.hookId },
            blocked: true,
          });
          continue;
        }
        const fullInput: AgentHookInput = { ...input, stage };
        await emit(nextEvent('hook.started', hook.hookId, stage, fullInput));
        try {
          const handler = phase === 'enter' ? hook.onEnter : hook.onExit;
          const result = handler ? await handler(fullInput) : { status: 'observed' as const };
          const blocked = hook.mode === 'core' && (result.status === 'failed' || result.status === 'waiting');
          if (blocked) skip.push(hook.hookId);
          await emit({
            ...nextEvent('hook.completed', hook.hookId, stage, fullInput),
            diagnostics: result.diagnostics,
            ownerId: result.ownerId,
          });
          results.push({ hookId: hook.hookId, hookStage: stage, result, blocked });
        } catch (error) {
          const result: AgentHookResult = {
            status: 'failed',
            diagnostics: [error instanceof Error ? error.message : String(error)],
            ownerId: hook.hookId,
          };
          const blocked = hook.mode === 'core';
          if (blocked) skip.push(hook.hookId);
          await emit({
            ...nextEvent('hook.failed', hook.hookId, stage, fullInput),
            diagnostics: result.diagnostics,
            ownerId: result.ownerId,
            error: {
              code: 'hook.failed',
              message: result.diagnostics[0] ?? 'hook failed',
              ownerId: hook.hookId,
              retryable: false,
            },
          });
          results.push({ hookId: hook.hookId, hookStage: stage, result, blocked });
        }
      }
      return results;
    },
  };

  return registry;
}
