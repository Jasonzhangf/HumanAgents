/**
 * Stdio JSON-RPC backend for the standard ACP v1 wire protocol.
 *
 * One `AcpStdioBackend` owns one spawned child process (the ACP server) and
 * exchanges newline-delimited JSON-RPC 2.0 frames over stdin/stdout. It is
 * transport-only: request/response correlation, frame framing and the
 * `session/update` notification stream. No domain identity lives here.
 *
 * A closed backend fails every subsequent call with `transport-closed`; a
 * JSON-RPC error response fails the matching call with the server's error
 * code. stderr is never parsed as a control signal.
 */
import { spawn, type ChildProcessLike } from 'node:child_process';
import { terminateProcess } from './terminate.js';
import {
  ACP_JSONRPC,
  decodeAcpFrame,
  encodeAcpNotification,
  encodeAcpRequest,
  isAcpResponse,
  type AcpJsonRpcNotification,
  type AcpJsonRpcRequest,
  type AcpJsonRpcResponse,
  type AcpSessionUpdateNotification,
  assertAcpSessionUpdateNotification,
} from './protocol.js';

export interface AcpStdioSpawnOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface AcpStdioBackendOptions extends AcpStdioSpawnOptions {
  /** Frame read timeout in ms. Defaults to 30s. */
  readonly timeoutMs?: number;
  /** Called for every validated `session/update` notification. */
  readonly onUpdate?: (update: AcpSessionUpdateNotification) => void;
}

/**
 * Minimal async mutex used to serialize write+await sequences on the child
 * stdin. The ACP server responds to requests in order; keeping a single
 * in-flight request per backend avoids interleaving a notification with a
 * pending request frame.
 */
class WriteLock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class AcpStdioBackendError extends Error {
  readonly code: string;
  constructor(code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AcpStdioBackendError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export class AcpStdioBackend {
  readonly process: ChildProcessLike;
  readonly onUpdate?: (update: AcpSessionUpdateNotification) => void;
  private readonly timeoutMs: number;
  private readonly lock = new WriteLock();
  private readonly pending = new Map<string | number, {
    readonly resolve: (frame: AcpJsonRpcResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly stdoutBuffer: string[] = [];
  private closed = false;

  constructor(options: AcpStdioBackendOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onUpdate = options.onUpdate;
    this.process = spawn(options.command, options.args ? [...options.args] : [], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.on('data', (chunk: unknown) => this.consumeStdout(toUtf8(chunk)));
    this.process.on('error', (error: Error) => {
      this.failAll(new AcpStdioBackendError('transport-failure', `ACP backend spawn failed: ${error.message}`, error));
    });
    // A write racing the server's exit raises EPIPE on the stream. Without a
    // listener that error is uncaught and takes the process down with it;
    // closing the connection is the only outcome a caller can take.
    this.process.stdin.on('error', () => {});
    this.process.on('close', (code: number | null, signal: string | null) => {
      this.closed = true;
      this.failAll(new AcpStdioBackendError(
        'transport-closed',
        `ACP backend exited (code=${code}, signal=${signal ?? 'none'})`,
      ));
    });
  }

  /**
   * Accumulates stdout chunks and feeds each complete line to `handleLine`.
   * This replaces `node:readline`, which is not part of the ambient surface
   * available to this package: an ACP server emits one NDJSON frame per line,
   * so a partial chunk must never be decoded on its own.
   */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer.push(chunk);
    const text = this.stdoutBuffer.join('');
    this.stdoutBuffer.length = 0;
    let rest = text;
    let newline: number;
    while ((newline = rest.indexOf('\n')) !== -1) {
      this.handleLine(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
    }
    if (rest.length > 0) this.stdoutBuffer.push(rest);
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: ReturnType<typeof decodeAcpFrame>;
    try {
      frame = decodeAcpFrame(line);
    } catch (error) {
      this.failAll(new AcpStdioBackendError('protocol-error', `invalid ACP frame from backend: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (isAcpResponse(frame)) {
      const waiter = this.pending.get(frame.id);
      if (!waiter) {
        // Unknown id: the server responded for a request this backend never
        // issued (or already timed out). Fail visible, never silently drop.
        this.failAll(new AcpStdioBackendError('protocol-error', `ACP backend responded for unknown id ${String(frame.id)}`));
        return;
      }
      clearTimeout(waiter.timer);
      this.pending.delete(frame.id);
      waiter.resolve(frame);
      return;
    }
    if (this.isUpdateNotification(frame)) {
      try {
        const update = assertAcpSessionUpdateNotification(frame.params);
        this.onUpdate?.(update);
      } catch (error) {
        this.failAll(new AcpStdioBackendError('protocol-error', `invalid session/update notification: ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }
    // Requests from the server are not supported by this client.
    this.failAll(new AcpStdioBackendError('protocol-error', `ACP backend sent an unsupported request frame: ${(frame as AcpJsonRpcRequest).method}`));
  }

  private isUpdateNotification(frame: AcpJsonRpcResponse | AcpJsonRpcNotification | AcpJsonRpcRequest): frame is AcpJsonRpcNotification {
    return !('id' in frame) && 'method' in frame && frame.method === 'session/update';
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new AcpStdioBackendError('transport-closed', 'ACP backend is already closed');
    }
  }

  /**
   * Sends a JSON-RPC request and awaits its response. The caller supplies the
   * id; correlation is strictly local to this backend.
   *
   * Only the frame write is serialized, never the response await. Holding the
   * write lock until the response arrived would keep `session/cancel` from
   * reaching a server that is still busy with this turn, so an in-flight turn
   * could not be cancelled until this request timed out.
   */
  request(method: string, params: unknown, id: string | number): Promise<AcpJsonRpcResponse> {
    this.ensureOpen();
    const frame = encodeAcpRequest(method, id, params);
    return new Promise<AcpJsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpStdioBackendError('no-response', `ACP backend did not respond to ${method} within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.lock.run(async () => {
        this.ensureOpen();
        this.process.stdin.write(frame);
      }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new AcpStdioBackendError('transport-closed', String(error)));
      });
    });
  }

  /** Sends a JSON-RPC notification (fire and forget). */
  notify(method: string, params: unknown): void {
    this.ensureOpen();
    this.process.stdin.write(encodeAcpNotification(method, params));
  }

  /**
   * Sends a notification on the backend's write lock, so a notification frame
   * is never interleaved with a request frame. `request` releases the lock
   * after writing its own frame, so this does not wait for that request to
   * answer.
   */
  async notifyAsync(method: string, params: unknown): Promise<void> {
    await this.lock.run(async () => {
      this.notify(method, params);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new AcpStdioBackendError('transport-closed', 'ACP backend closed by client'));
    this.process.stdin.end();
    await terminateProcess(this.process);
  }
}

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

export function isJsonRpcError(frame: AcpJsonRpcResponse): boolean {
  return frame.error !== undefined;
}

export function jsonRpcErrorMessage(frame: AcpJsonRpcResponse): string {
  const error = frame.error;
  if (!error) return 'unknown JSON-RPC error';
  const code = error.code;
  const label = code === ACP_JSONRPC.METHOD_NOT_FOUND ? 'method not found'
    : code === ACP_JSONRPC.INVALID_PARAMS ? 'invalid params'
    : code === ACP_JSONRPC.CANCELLED ? 'cancelled'
    : 'server error';
  return `${label} (${code}): ${error.message}`;
}
