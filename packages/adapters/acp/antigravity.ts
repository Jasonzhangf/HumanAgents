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
 * Antigravity runtime adaptor (shim).
 *
 * Antigravity does not ship an ACP server: neither `language_server` nor the
 * app bundle contains `session/prompt` / `session/new` / ACP v1 frames, and
 * the app's wire surface is HTTPS/gRPC, not a text entry point. It does ship
 * a one-shot CLI, `agy`, whose `-p/--print` non-interactive mode returns the
 * final answer. This adaptor bridges that native surface onto the shared ACP
 * session seam:
 *
 * - `open` validates that `agy` is executable (probe) and mints a HumanAgent
 *   session id; Antigravity has no server-side session to open.
 * - `submit` runs `agy -p '<prompt>' --output-format json` once, parses
 *   `.response`, and maps `status: "SUCCESS"` + exit 0 to `end_turn`.
 * - `cancel` kills the in-flight child process. Killing the process is the
 *   honest cancellation primitive for a one-shot CLI; the resulting submit
 *   rejection is surfaced as a cancellation, never swallowed as success.
 * - `load` is unsupported (one-shot CLI has no resumable session), and the
 *   adaptor must fail closed, not pretend to resume.
 *
 * The shim is the entire contract surface: no ACP/domain identity is minted
 * here, and HumanAgent owns runtimeId / taskId / epoch / assignment.
 */

const OWNER = 'humanagent.acp-runtime.antigravity';
const VERSION = 'antigravity-cli-1.3.x';
const JSON_OUTPUT_FORMAT = 'json';

interface RunOneShotResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
}

interface OpenState {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly workspace: string;
  /** Executable resolved at open time from the ACP open request. */
  readonly command: string;
  active?: ChildProcessLike;
}


const sessions = new Map<string, OpenState>();

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

function runOneShot(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  onChild: (child: ChildProcessLike) => void,
): Promise<RunOneShotResult> {
  return new Promise<RunOneShotResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    // Track a timeout kill explicitly: a signal alone cannot tell a client
    // timeout from a SIGTERM raised by something else.
    let timedOut = false;
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child);
    child.stdout.on('data', (chunk: unknown) => { stdout += toUtf8(chunk); });
    child.stderr.on('data', (chunk: unknown) => { stderr += toUtf8(chunk); });
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(new AcpAdapterError({
        code: 'transport-failure',
        message: `antigravity CLI spawn failed: ${error.message}`,
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/spawn` },
        evidenceRefs: [],
        cause: error,
      }));
    });
    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 1 : 1), stdout, stderr, killed: timedOut });
    });
  });
}

export interface AntigravityRuntimeOptions {
  readonly timeoutMs?: number;
  readonly version?: string;
  readonly capabilities?: readonly string[];
}

export function createAntigravityRuntime(options: AntigravityRuntimeOptions = {}): AcpRuntimeAdaptor {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const capabilities = options.capabilities ?? ['antigravity', 'acp.shim', 'one-shot'] as const;

  function requireState(sessionId: string): OpenState {
    const state = sessions.get(sessionId);
    if (!state) {
      throw new AcpAdapterError({
        code: 'session-not-found',
        message: 'antigravity runtime has no open session',
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/session-missing` },
        evidenceRefs: [],
      });
    }
    return state;
  }

  return {
    runtime: 'antigravity',
    kind: 'shim',
    version: options.version ?? VERSION,
    evidenceRef: `${OWNER}/cliprompt`,
    capabilities: [...capabilities],

    async open(input: AcpRuntimeOpenInput): Promise<AcpRuntimeOpenResult> {
      const probe = await runOneShot(input.command, ['--version'], input.workspace, 15_000, () => undefined)
        .catch(() => ({ exitCode: -1, stdout: '', stderr: 'spawn failed', killed: false }));
      if (probe.exitCode !== 0) {
        throw new AcpAdapterError({
          code: 'capability-unavailable',
          message: `antigravity CLI is not available: ${probe.stderr.trim().slice(0, 300) || probe.stdout.trim().slice(0, 300) || `exit ${probe.exitCode}`}`,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/not-installed` },
          evidenceRefs: [],
        });
      }
      const sessionId = input.sessionIdFor
        ? input.sessionIdFor(input.runtimeId)
        : `ha-${input.runtimeId}-shim`;
      const state: OpenState = { runtimeId: input.runtimeId, sessionId, workspace: input.workspace, command: input.command };
      sessions.set(sessionId, state);
      return {
        sessionId,
        initialize: {
          protocolVersion: 1,
          agentInfo: { name: 'antigravity', version: VERSION },
        },
        implementation: { name: 'antigravity', version: VERSION },
        capabilities: {},
        protocol: 'shim',
        backendRef: `${OWNER}/humanagent/acp-shim/${sessionId}`,
      };
    },

    async load(_input: AcpRuntimeLoadInput): Promise<AcpRuntimeSession> {
      throw new AcpAdapterError({
        code: 'capability-unavailable',
        message: 'antigravity one-shot CLI has no resumable session; load is not supported',
        ownerId: OWNER,
        nextAction: { kind: 'recover', ref: `${OWNER}/load-not-supported` },
        evidenceRefs: [],
      });
    },

    async submit(input: AcpRuntimeSubmitInput): Promise<AcpRuntimeSubmitResult> {
      const state = requireState(input.sessionId);
      const args = ['-p', input.prompt, '--output-format', JSON_OUTPUT_FORMAT];
      const run = await runOneShot(state.command, args, state.workspace, input.timeoutMs ?? timeoutMs, (child) => { state.active = child; });
      if (run.killed) {
        throw new AcpAdapterError({
          code: 'no-response',
          message: 'antigravity prompt was killed by client timeout',
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/timeout` },
          evidenceRefs: [],
        });
      }
      if (run.exitCode !== 0) {
        throw new AcpAdapterError({
          code: 'transport-failure',
          message: `antigravity CLI failed (exit ${run.exitCode}): ${run.stderr.trim().slice(0, 400) || run.stdout.trim().slice(0, 400)}`,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/prompt-failed` },
          evidenceRefs: [],
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(run.stdout.trim());
      } catch {
        throw new AcpAdapterError({
          code: 'protocol-error',
          message: 'antigravity CLI returned non-JSON output for --output-format json',
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/bad-output` },
          evidenceRefs: [],
        });
      }
      const record = parsed as { status?: unknown; response?: unknown; error?: unknown };
      if (record.status !== 'SUCCESS' || typeof record.response !== 'string' || record.response.length === 0) {
        throw new AcpAdapterError({
          code: 'transport-failure',
          message: `antigravity CLI returned status ${String(record.status)}: ${record.error ? JSON.stringify(record.error) : record.status === 'SUCCESS' ? 'empty response' : 'missing response'}`,
          ownerId: OWNER,
          nextAction: { kind: 'recover', ref: `${OWNER}/unexpected-status` },
          evidenceRefs: [],
        });
      }
      return {
        stopReason: 'end_turn',
        outputText: record.response.replace(/\n$/, ''),
        userMessageId: input.messageId,
      };
    },

    async cancel(input: AcpRuntimeCancelInput): Promise<AcpRuntimeCancelResult> {
      const state = requireState(input.sessionId);
      if (state.active && state.active.exitCode === null) {
        state.active.kill('SIGTERM');
        // The submit promise rejects with a transport failure; the acceptance
        // is real (the process was killed). The driver must not treat this as
        // `stopped` until the session is closed.
        return { accepted: true, evidenceRef: `${OWNER}/cancel/${state.sessionId}` };
      }
      return { accepted: false, evidenceRef: `${OWNER}/cancel/${state.sessionId}/no-active` };
    },

    async close(input: AcpRuntimeCloseInput): Promise<AcpRuntimeCloseResult> {
      const state = sessions.get(input.sessionId);
      if (!state) return { closed: false };
      sessions.delete(input.sessionId);
      if (state.active && state.active.exitCode === null) {
        state.active.kill('SIGTERM');
      }
      return { closed: true, evidenceRef: `${OWNER}/close/${state.sessionId}` };
    },
  };
}