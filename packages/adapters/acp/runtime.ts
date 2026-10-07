import type {
  AcpNewSessionResult,
  AcpPromptResult,
} from './protocol.js';

/**
 * Session seam shared by every ACP runtime adaptor.
 *
 * `AcpClientDriver` is the single owner of the ACP v1 conversation and of the
 * `AgentDriver` mapping. A runtime adaptor owns only what is needed to produce
 * a live ACP session for one HumanAgent execution: how to reach the server,
 * which protocol variant it speaks, and what evidence it can cite.
 *
 * A runtime that cannot speak ACP implements this seam against its native
 * protocol and declares that once, in `capabilities`. This seam is the entire
 * contract surface: no runtime adaptor may reach into `AcpClientDriver`
 * internals, and no domain identity may be minted here.
 *
 * Cancellation is owned by the adaptor's `cancel` method, not by a callback:
 * a `direct` runtime sends the ACP `session/cancel` request, and a `shim`
 * runtime that has no native cancel stops its own process. Killing the process
 * is the honest cancellation primitive for a one-shot CLI.
 */

export interface AcpRuntimeSubmitResult extends AcpPromptResult {
  /** Final assistant text for this turn, already assembled by the runtime. */
  readonly outputText: string;
}

export interface AcpRuntimeCloseResult {
  /** Whether the runtime reported the session as actually closed. */
  readonly closed: boolean;
}

export interface AcpRuntimeCancelResult {
  /** Whether the runtime acknowledged the cancellation request. */
  readonly accepted: boolean;
}

export interface AcpRuntimeAdaptor {
  /**
   * Runtime identifier used as the `driverRef` in HumanAgent config. Whether the
   * runtime speaks ACP v1 on the wire or bridges a native protocol is stated
   * once, in `capabilities`, and reaches HumanAgent through the driver.
   */
  readonly runtime: 'opencode' | 'antigravity' | 'dsh';
  readonly version: string;

  /** Runtime-owned capabilities, mapped into HumanAgent capability names. */
  readonly capabilities: readonly string[];

  /** Establishes the ACP session. Must validate `initialize` protocolVersion. */
  open(input: AcpRuntimeOpenInput): Promise<AcpRuntimeOpenResult>;

  /** Runs one prompt turn and resolves when the turn settles. */
  submit(input: AcpRuntimeSubmitInput): Promise<AcpRuntimeSubmitResult>;

  /** Cancels the in-flight turn. Must not report stopped from acceptance alone. */
  cancel(input: AcpRuntimeCancelInput): Promise<AcpRuntimeCancelResult>;

  /** Releases the session and the underlying process. */
  close(input: AcpRuntimeCloseInput): Promise<AcpRuntimeCloseResult>;
}

export interface AcpRuntimeOpenInput {
  readonly runtimeId: string;
  readonly workspace: string;
  /** ACP server spawn target. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly sessionIdFor?: (runtimeId: string) => string;
}

/**
 * What a runtime must hand back after opening a session. Only the session id
 * crosses the seam: the driver owns the ACP conversation, and the adaptor keeps
 * its own handshake result, process reference and protocol variant private.
 */
export type AcpRuntimeOpenResult = AcpNewSessionResult;

export interface AcpRuntimeSubmitInput {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly messageId: string;
  readonly timeoutMs?: number;
}

export interface AcpRuntimeCancelInput {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly timeoutMs?: number;
}

export interface AcpRuntimeCloseInput {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly timeoutMs?: number;
}
