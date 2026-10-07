import { spawn, type ChildProcessLike } from 'node:child_process';
import { AcpAdapterError } from './errors.js';
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
 * DSH runtime adaptor (shim).
 *
 * DeepSeek Harness ships no ACP server. Its CLI (`dsh --profile headless
 * --json`) answers ONE task and exits: the task is either a positional
 * argument or is read from stdin until EOF, the run events are emitted as
 * newline-delimited JSON on stdout, and the final answer arrives in the
 * `final` event's `text`. It is not a persistent stdin server — writing a
 * prompt without EOF blocks forever, which is why this adaptor runs one
 * process per turn rather than keeping a session process alive.
 *
 * - `open` probes nothing and mints a shim session id. A shim session has no
 *   server-side counterpart: it is a correlation label for the run.
 * - `submit` spawns `dsh --profile headless --json "<prompt>"`, reads the run
 *   events, and returns `final.text`. Success is exit 0 plus
 *   `turn_end.reason.kind === 'completed'`. The persisted DSH session id from
 *   the `session` event is passed back as `--session-id` on the next turn, so
 *   later turns adopt the same persisted DSH Session instead of minting a new
 *   one. Adopting the record does not by itself replay earlier turns into the
 *   model context: on this DSH build a resumed session still answers as if the
 *   conversation had just started. The adaptor therefore claims session
 *   adoption only, never conversational memory.
 * - `cancel` kills the in-flight child. Killing the process is the honest
 *   cancellation primitive for a one-shot CLI; the resulting rejection is
 *   surfaced by `submit`, never swallowed.
 * - `load` is unsupported and fails closed rather than pretending to resume an
 *   ACP session.
 *
 * Events are parsed with a strict decoder: an unknown `type` fails the turn
 * visibly instead of being dropped.
 */

const OWNER = 'humanagent.acp-runtime.dsh';
const VERSION = 'dsh-0.2.x';
export const DSH_DEFAULT_ARGS = ['--profile', 'headless', '--json'] as const;

interface DshRunState {
  readonly runtimeId: string;
  readonly sessionId: string;
  stderr: string;
  finalText: string;
  turnEndReason?: unknown;
  activeChild?: ChildProcessLike;
  /** Executable and working directory recorded at open time; submit reuses them. */
  command: string;
  cwd: string;
  /** Persisted DSH Session id from the `session` event; resumed on the next turn. */
  dshSessionId?: string;
  activeTimeout?: ReturnType<typeof setTimeout>;
  resolveResult?: (result: { readonly exitCode: number; readonly text: string; readonly reason?: unknown }) => void;
  rejectResult?: (error: Error) => void;
}

/** Sessions exist only as shim correlation labels; there is no server side. */
const sessions = new Map<string, DshRunState>();

/** Decodes a raw stream chunk; no `Buffer`/`TextDecoder` dependency is assumed. */
function toUtf8(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (Array.isArray(chunk)) return chunk.map((value) => String(value)).join('');
  if (typeof chunk === 'object' && chunk !== null) {
    const converted = (chunk as { toString(encoding: string): string }).toString('utf8');
    if (typeof converted === 'string') return converted;
  }
  return String(chunk);
}

function turnError(state: DshRunState, code: 'protocol-error' | 'transport-failure', message: string, ref: string): void {
  if (state.rejectResult) state.rejectResult(new AcpAdapterError({
    code,
    message,
    ownerId: OWNER,
    nextAction: { kind: 'recover', ref: `${OWNER}/${ref}` },
    evidenceRefs: [],
  }));
}

/**
 * Accumulates stdout chunks and feeds each complete line to `handleLine`. This
 * replaces `node:readline`, which is not part of the ambient surface available
 * to this package: `dsh --json` emits one JSON object per line, so a partial
 * chunk must never be parsed on its own.
 */
function consumeStdout(state: DshRunState, chunk: string, buffer: string[]): void {
  buffer.push(chunk);
  const text = buffer.join('');
  buffer.length = 0;
  let rest = text;
  let newline: number;
  while ((newline = rest.indexOf('\n')) !== -1) {
    handleLine(state, rest.slice(0, newline));
    rest = rest.slice(newline + 1);
  }
  if (rest.length > 0) buffer.push(rest);
}

function handleLine(state: DshRunState, line: string): void {
  if (line.trim().length === 0) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    turnError(state, 'protocol-error', 'dsh headless emitted a non-JSON line', 'bad-frame');
    return;
  }
  const record = event as {
    readonly type?: unknown;
    readonly phase?: unknown;
    readonly reason?: unknown;
    readonly text?: unknown;
    readonly message?: unknown;
    readonly sessionId?: unknown;
  };
  switch (record.type) {
    case 'status':
      if (record.phase === 'turn_end') state.turnEndReason = record.reason;
      break;
    case 'final':
      if (typeof record.text === 'string') state.finalText = record.text;
      break;
    case 'session':
      if (typeof record.sessionId === 'string') state.dshSessionId = record.sessionId;
      break;
    case 'text':
    case 'thinking':
    case 'tool_call':
    case 'tool_result':
      // Projection events for observation; not needed for the final answer.
      break;
    case 'error':
      turnError(state, 'transport-failure',
        typeof record.message === 'string' ? record.message : 'dsh headless reported an error event',
        'error-event');
      break;
    default:
      turnError(state, 'protocol-error',
        `dsh headless emitted an unknown event type: ${String(record.type)}`,
        'unknown-event');
      break;
  }
}

export interface DshRuntimeOptions {
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly version?: string;
  readonly capabilities?: readonly string[];
}

export function createDshRuntime(options: DshRuntimeOptions = {}): AcpRuntimeAdaptor {
  const args = options.args ?? [...DSH_DEFAULT_ARGS];
  const timeoutMs = options.timeoutMs ?? 300_000;
  const capabilities = options.capabilities ?? ['dsh', 'acp.shim', 'headless-json'] as const;

  function requireState(sessionId: string): DshRunState {
    const state = sessions.get(sessionId);
    if (!state) {
      throw new AcpAdapterError({
        code: 'session-not-found',
        message: 'dsh runtime has no open session',
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/session-missing` },
        evidenceRefs: [],
      });
    }
    return state;
  }

  function clearActive(state: DshRunState): void {
    if (state.activeTimeout !== undefined) clearTimeout(state.activeTimeout);
    state.activeTimeout = undefined;
    state.activeChild = undefined;
    state.resolveResult = undefined;
    state.rejectResult = undefined;
  }

  return {
    runtime: 'dsh',
    kind: 'shim',
    version: options.version ?? VERSION,
    evidenceRef: `${OWNER}/headless-json`,
    capabilities: [...capabilities],

    async open(input: AcpRuntimeOpenInput): Promise<AcpRuntimeOpenResult> {
      // One process per turn: there is nothing to warm up and no ACP session to
      // open on the other side.
      const sessionId = input.sessionIdFor
        ? input.sessionIdFor(input.runtimeId)
        : `ha-${input.runtimeId}-dsh`;
      sessions.set(sessionId, {
        runtimeId: input.runtimeId,
        sessionId,
        command: input.command,
        cwd: input.cwd ?? options.cwd ?? input.workspace,
        stderr: '',
        finalText: '',
      });
      return {
        sessionId,
        initialize: {
          protocolVersion: 1,
          agentInfo: { name: 'dsh', version: VERSION },
        },
        implementation: { name: 'dsh', version: VERSION },
        capabilities: {},
        protocol: 'shim',
        backendRef: `${OWNER}/oneshot`,
      };
    },

    async load(_input: AcpRuntimeLoadInput): Promise<AcpRuntimeSession> {
      throw new AcpAdapterError({
        code: 'capability-unavailable',
        message: 'dsh headless one-shot has no resumable ACP session; load is not supported',
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/load-not-supported` },
        evidenceRefs: [],
      });
    },

    async submit(input: AcpRuntimeSubmitInput): Promise<AcpRuntimeSubmitResult> {
      const state = requireState(input.sessionId);
      if (state.activeChild !== undefined) {
        throw new AcpAdapterError({
          code: 'identity-mismatch',
          message: 'dsh headless has an in-flight turn; a second submit is not supported',
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/one-shot` },
          evidenceRefs: [],
        });
      }
      state.stderr = '';
      state.finalText = '';
      state.turnEndReason = undefined;
      // A fresh session starts with no --session-id; later turns resume the
      // DSH Session minted by the first turn.
      const perTurnArgs = state.dshSessionId !== undefined
        ? [...args, '--session-id', state.dshSessionId, input.prompt]
        : [...args, input.prompt];
      const child = spawn(state.command, perTurnArgs, {
        cwd: state.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      state.activeChild = child;
      const buffer: string[] = [];
      child.stdout.on('data', (chunk: unknown) => consumeStdout(state, toUtf8(chunk), buffer));
      child.stderr.on('data', (chunk: unknown) => { state.stderr += toUtf8(chunk); });
      child.on('close', (code: number | null, signal: string | null) => {
        const exitCode = code ?? (signal !== null ? 1 : 1);
        state.resolveResult?.({ exitCode, text: state.finalText, reason: state.turnEndReason });
        clearActive(state);
      });
      child.on('error', (error: Error) => {
        state.rejectResult?.(new AcpAdapterError({
          code: 'transport-failure',
          message: `dsh spawn failed: ${error.message}`,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/spawn` },
          evidenceRefs: [],
          cause: error,
        }));
        clearActive(state);
      });

      const result = await new Promise<{ readonly exitCode: number; readonly text: string; readonly reason?: unknown }>((resolve, reject) => {
        state.resolveResult = resolve;
        state.rejectResult = reject;
        state.activeTimeout = setTimeout(() => {
          clearActive(state);
          if (child.exitCode === null) child.kill('SIGKILL');
          reject(new AcpAdapterError({
            code: 'no-response',
            message: `dsh headless did not finish within ${input.timeoutMs ?? timeoutMs}ms`,
            ownerId: OWNER,
            nextAction: { kind: 'recover', ref: `${OWNER}/timeout` },
            evidenceRefs: [],
          }));
        }, input.timeoutMs ?? timeoutMs);
      });

      const reasonKind = (result.reason as { readonly kind?: unknown } | undefined)?.kind;
      const failed = result.exitCode !== 0
        || (reasonKind !== undefined && reasonKind !== 'completed');
      if (failed) {
        const detail = result.reason !== undefined
          ? JSON.stringify(result.reason).slice(0, 400)
          : (state.stderr.trim().slice(-400) || `exit ${result.exitCode}`);
        throw new AcpAdapterError({
          code: 'transport-failure',
          message: `dsh headless turn failed: ${detail}`,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/turn-failed` },
          evidenceRefs: [],
        });
      }
      if (result.text.length === 0) {
        throw new AcpAdapterError({
          code: 'protocol-error',
          message: 'dsh headless returned an empty final answer',
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/empty-final` },
          evidenceRefs: [],
        });
      }
      return {
        stopReason: 'end_turn',
        outputText: result.text,
        userMessageId: input.messageId,
      };
    },

    async cancel(input: AcpRuntimeCancelInput): Promise<AcpRuntimeCancelResult> {
      const state = requireState(input.sessionId);
      const child = state.activeChild;
      if (child === undefined || child.exitCode !== null) {
        return { accepted: false, evidenceRef: `${OWNER}/cancel/${state.sessionId}/no-active` };
      }
      child.kill('SIGTERM');
      // The submit promise rejects; the driver must not report stopped until the
      // session is closed.
      return { accepted: true, evidenceRef: `${OWNER}/cancel/${state.sessionId}` };
    },

    async close(input: AcpRuntimeCloseInput): Promise<AcpRuntimeCloseResult> {
      const state = sessions.get(input.sessionId);
      if (!state) return { closed: false };
      sessions.delete(input.sessionId);
      const child = state.activeChild;
      if (child !== undefined && child.exitCode === null) child.kill('SIGTERM');
      return { closed: true, evidenceRef: `${OWNER}/close/${state.sessionId}` };
    },
  };
}
