import { AcpAdapterError } from './errors.js';
import { AcpStdioBackend, isJsonRpcError, jsonRpcErrorMessage } from './backend.js';
import {
  ACP_JSONRPC,
  ACP_PROTOCOL_VERSION,
  assertAcpInitializeResult,
  assertAcpNewSessionResult,
  assertAcpPromptResult,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpSessionUpdateNotification,
  type AcpStopReason,
} from './protocol.js';
import type {
  AcpRuntimeAdaptor,
  AcpRuntimeCancelInput,
  AcpRuntimeCancelResult,
  AcpRuntimeCloseInput,
  AcpRuntimeCloseResult,
  AcpRuntimeLoadInput,
  AcpRuntimeOpenInput,
  AcpRuntimeOpenResult,
  AcpRuntimeSession,
  AcpRuntimeSubmitInput,
  AcpRuntimeSubmitResult,
} from './runtime.js';

/**
 * opencode runtime adaptor.
 *
 * opencode ships a standard ACP v1 server (`opencode acp`) over stdio, so this
 * adaptor is `direct`: it uses `AcpStdioBackend` and speaks the real wire
 * protocol. Nothing is shimmed.
 *
 * `--pure` is passed by default because the runtime must not depend on
 * external plugins resolving at agent-runtime boot time. Callers may override
 * `args` to drop it.
 *
 * The final answer for a turn is the concatenation of every
 * `agent_message_chunk` text block delivered as a `session/update`
 * notification before `session/prompt` resolves. ACP `session/prompt` does
 * not echo the answer in its result object, so the adaptor accumulates.
 *
 * `session/cancel` is a notification: the server sends no response frame. The
 * authoritative confirmation of a cancel is the in-flight `session/prompt`
 * settling with `stopReason: 'cancelled'`. If no turn is in flight there is
 * nothing to cancel and the adaptor reports `accepted: false` rather than
 * inventing an acknowledgement.
 *
 * Session ids minted by opencode (`ses_*`) stay inside this adaptor. They are
 * returned to `AcpClientDriver` only as correlation evidence.
 */

const OWNER = 'humanagent.acp-runtime.opencode';
const VERSION = 'opencode-1.18.x';
export const OPENCODE_DEFAULT_ARGS = ['acp', '--pure'] as const;

interface OpenState {
  readonly backend: AcpStdioBackend;
  readonly runtimeId: string;
  readonly sessionId: string;
  text: string;
  inFlightPrompt: Promise<SettledPrompt> | undefined;
}

interface SettledPrompt {
  readonly ok: boolean;
  readonly stopReason?: AcpStopReason;
  readonly cancelled: boolean;
  readonly error?: Error;
}

const sessions = new Map<string, OpenState>();
let requestSequence = 0;

export interface OpencodeRuntimeOptions {
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly version?: string;
  readonly capabilities?: readonly string[];
}

export function createOpencodeRuntime(options: OpencodeRuntimeOptions = {}): AcpRuntimeAdaptor {
  const args = options.args ?? [...OPENCODE_DEFAULT_ARGS];
  const timeoutMs = options.timeoutMs ?? 300_000;
  const capabilities = options.capabilities ?? ['opencode', 'acp.direct', 'acp.tool-call'];

  function requireState(sessionId: string): OpenState {
    const state = sessions.get(sessionId);
    if (!state) {
      throw new AcpAdapterError({
        code: 'session-not-found',
        message: 'opencode runtime has no open ACP session',
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/session-missing` },
        evidenceRefs: [],
      });
    }
    return state;
  }

  function chunkText(block: AcpContentBlock): string {
    if (block.type !== 'text' || typeof block.text !== 'string') return '';
    return block.text;
  }

  return {
    runtime: 'opencode',
    version: options.version ?? VERSION,
    capabilities,

    async open(input: AcpRuntimeOpenInput): Promise<AcpRuntimeOpenResult> {
      const openTimeout = input.timeoutMs ?? timeoutMs;
      const nextId = (): string => `ha-${input.runtimeId}-${++requestSequence}`;

      const spawnArgs = input.args ?? args;
      const backend = new AcpStdioBackend({
        command: input.command,
        ...(spawnArgs.length > 0 ? { args: spawnArgs } : {}),
        cwd: input.workspace,
        timeoutMs: openTimeout,
        onUpdate: (notification: AcpSessionUpdateNotification) => {
          const state = sessions.get(notification.sessionId);
          if (!state) return;
          if (notification.update.sessionUpdate === 'agent_message_chunk') {
            state.text += chunkText(notification.update.content);
          }
        },
      });

      try {
        const initialized = await backend.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
          },
          clientInfo: {
            name: 'humanagent',
            title: 'HumanAgent ACP client',
            version: options.version ?? VERSION,
          },
        }, nextId());
        if (isJsonRpcError(initialized)) {
          throw new AcpAdapterError({
            code: 'protocol-error',
            message: `opencode initialize failed: ${jsonRpcErrorMessage(initialized)}`,
            ownerId: OWNER,
            nextAction: { kind: 'recover', ref: `${OWNER}/initialize` },
            evidenceRefs: [],
          });
        }
        assertAcpInitializeResult(initialized.result, 'initialize');

        const created = await backend.request('session/new', {
          cwd: input.workspace,
          mcpServers: [],
        }, nextId());
        if (isJsonRpcError(created)) {
          throw new AcpAdapterError({
            code: 'transport-failure',
            message: `opencode session/new failed: ${jsonRpcErrorMessage(created)}`,
            ownerId: OWNER,
            nextAction: { kind: 'recover', ref: `${OWNER}/session-new` },
            evidenceRefs: [],
          });
        }
        const session: AcpNewSessionResult = assertAcpNewSessionResult(created.result, 'session/new');

        const state: OpenState = {
          backend,
          runtimeId: input.runtimeId,
          sessionId: session.sessionId,
          text: '',
          inFlightPrompt: undefined,
        };
        sessions.set(session.sessionId, state);

        return { sessionId: session.sessionId };
      } catch (error) {
        await backend.close().catch(() => undefined);
        throw error;
      }
    },

    async load(_input: AcpRuntimeLoadInput): Promise<AcpRuntimeSession> {
      throw new AcpAdapterError({
        code: 'capability-unavailable',
        message: 'opencode runtime does not support loading a prior ACP session in this adapter',
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/load-not-supported` },
        evidenceRefs: [],
      });
    },

    async submit(input: AcpRuntimeSubmitInput): Promise<AcpRuntimeSubmitResult> {
      const state = requireState(input.sessionId);
      const previousText = state.text;
      const promptId = `ha-prompt-${++requestSequence}`;

      const settle: Promise<SettledPrompt> = (async (): Promise<SettledPrompt> => {
        try {
          const frame = await state.backend.request('session/prompt', {
            sessionId: state.sessionId,
            messageId: input.messageId,
            prompt: [{ type: 'text', text: input.prompt }],
          }, promptId);
          const rpcError = frame.error;
          if (rpcError !== undefined) {
            return {
              ok: false,
              cancelled: rpcError.code === ACP_JSONRPC.CANCELLED,
              error: new Error(jsonRpcErrorMessage(frame)),
            };
          }
          const result: AcpPromptResult = assertAcpPromptResult(frame.result, 'session/prompt');
          return { ok: true, stopReason: result.stopReason, cancelled: result.stopReason === 'cancelled' };
        } catch (error) {
          return { ok: false, cancelled: false, error: error instanceof Error ? error : new Error(String(error)) };
        } finally {
          state.inFlightPrompt = undefined;
        }
      })();
      state.inFlightPrompt = settle;

      const settled: SettledPrompt = await settle;

      if (!settled.ok) {
        state.text = previousText;
        if (settled.cancelled) {
          return { stopReason: 'cancelled', outputText: '' };
        }
        throw new AcpAdapterError({
          code: 'transport-failure',
          message: settled.error instanceof Error ? settled.error.message : 'opencode session/prompt failed',
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/prompt` },
          evidenceRefs: [],
          cause: settled.error,
        });
      }

      const stopReason: AcpStopReason = assertAcpPromptResult({
        stopReason: settled.stopReason,
      }, 'session/prompt').stopReason;
      return {
        stopReason,
        outputText: state.text.slice(previousText.length),
        userMessageId: input.messageId,
      };
    },

    async cancel(input: AcpRuntimeCancelInput): Promise<AcpRuntimeCancelResult> {
      const state = requireState(input.sessionId);
      const cancelTimeout = input.timeoutMs ?? timeoutMs;
      const inFlight = state.inFlightPrompt;
      // session/cancel is a notification: the server sends no response frame.
      await state.backend.notifyAsync('session/cancel', { sessionId: state.sessionId }).catch(() => undefined);
      if (inFlight === undefined) {
        // No turn to cancel. Do not invent an acknowledgement.
        return { accepted: false };
      }
      const settled = await waitForPrompt(inFlight, cancelTimeout);
      if (settled === undefined) {
        throw new AcpAdapterError({
          code: 'no-response',
          message: `opencode did not settle after session/cancel within ${cancelTimeout}ms`,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/cancel-timeout` },
          evidenceRefs: [],
        });
      }
      const cancelled = settled.cancelled || !settled.ok;
      return { accepted: cancelled };
    },

    async close(input: AcpRuntimeCloseInput): Promise<AcpRuntimeCloseResult> {
      const state = sessions.get(input.sessionId);
      if (!state) return { closed: false };
      sessions.delete(input.sessionId);
      try {
        if (state.backend.process.exitCode === null) {
          await state.backend.notifyAsync('session/close', { sessionId: state.sessionId });
        }
      } catch {
        // session/close is best effort; the process close below is authoritative.
      }
      try {
        await state.backend.close();
      } catch (error) {
        throw new AcpAdapterError({
          code: 'transport-closed',
          message: error instanceof Error ? error.message : 'opencode backend close failed',
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/close` },
          evidenceRefs: [],
          cause: error,
        });
      }
      return { closed: true };
    },
  };
}

/** Waits for a prompt to settle, returning `undefined` on timeout. */
function waitForPrompt(prompt: Promise<SettledPrompt>, timeoutMs: number): Promise<SettledPrompt | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([prompt, timed]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
