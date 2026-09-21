import type { RuntimePaths } from '../../../config/src/index.js';
import { AppLifecycleError } from '../errors.js';
import { readDaemonLease, type SupervisorControlEndpoint } from './supervisor.js';

const SERVE_OWNER = 'humanagent.app.serve';

export interface DaemonRestartReceipt {
  readonly requestId: string;
  readonly acceptedAt: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly observerOnly: true;
}

function isProcessAlive(pid: number): boolean {
  try {
    (process as unknown as { kill(pid: number, signal: number): void }).kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function endpointUrl(endpoint: SupervisorControlEndpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `http://${host}:${endpoint.port}/api/runtime/restart`;
}

function asRemoteError(body: unknown, fallback: { readonly code: string; readonly message: string; readonly nextAction: string }): AppLifecycleError {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as { readonly error?: unknown }).error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const value = error as Record<string, unknown>;
      if (typeof value.code === 'string' && typeof value.ownerId === 'string' && typeof value.nextAction === 'string' && typeof value.message === 'string') {
        return new AppLifecycleError(value.code, value.message, value.nextAction, value.ownerId);
      }
    }
  }
  return new AppLifecycleError(fallback.code, fallback.message, fallback.nextAction, SERVE_OWNER);
}

export async function requestDaemonRestart(paths: RuntimePaths): Promise<DaemonRestartReceipt> {
  const lease = await readDaemonLease(paths);
  if (lease === undefined) {
    throw new AppLifecycleError(
      'daemon-restart.owner-missing',
      'no active serve owner was found for this workspace',
      'start humanagent serve in the original CLI before requesting restart',
      SERVE_OWNER,
    );
  }
  if (lease.ownerId !== SERVE_OWNER) {
    throw new AppLifecycleError(
      'daemon-restart.owner-mismatch',
      `daemon lease belongs to ${lease.ownerId}, not the serve owner`,
      'use the command that owns this daemon lease or stop it through its owner',
      lease.ownerId,
    );
  }
  if (lease.disposedAt) {
    throw new AppLifecycleError(
      'daemon-restart.owner-disposed',
      'the serve owner has already disposed its daemon lease',
      'start a new serve owner before requesting restart',
      SERVE_OWNER,
    );
  }
  if (!isProcessAlive(lease.pid)) {
    throw new AppLifecycleError(
      'daemon-restart.owner-stale',
      `serve owner process ${lease.pid} is no longer running`,
      'inspect the stale lease and perform an explicit crash takeover only after confirming the owner is stopped',
      SERVE_OWNER,
    );
  }
  const endpoint = lease.controlEndpoint;
  if (endpoint === undefined) {
    throw new AppLifecycleError(
      'daemon-restart.endpoint-missing',
      'the active serve owner has not published its control endpoint',
      'upgrade or restart the serve owner once, then retry this command',
      SERVE_OWNER,
    );
  }

  let response: Response;
  try {
    response = await fetch(endpointUrl(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ leaseId: lease.leaseId, generation: lease.generation }),
    });
  } catch (error) {
    throw new AppLifecycleError(
      'daemon-restart.request-failed',
      `could not reach the active serve owner: ${error instanceof Error ? error.message : String(error)}`,
      'confirm the original serve CLI is still running and retry restart there',
      SERVE_OWNER,
      error,
    );
  }

  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch (error) {
    throw new AppLifecycleError(
      'daemon-restart.response-invalid',
      `serve owner returned a non-JSON restart response (${response.status})`,
      'inspect the original serve CLI output and retry after repairing its control endpoint',
      SERVE_OWNER,
      error,
    );
  }
  if (!response.ok) {
    throw asRemoteError(body, {
      code: 'daemon-restart.rejected',
      message: `serve owner rejected restart (${response.status})`,
      nextAction: 'inspect the original serve CLI output before retrying',
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppLifecycleError(
      'daemon-restart.response-invalid',
      'serve owner returned an invalid restart receipt',
      'inspect the original serve CLI output and retry after repairing its control endpoint',
      SERVE_OWNER,
    );
  }
  const receipt = body as Record<string, unknown>;
  if (
    typeof receipt.requestId !== 'string'
    || typeof receipt.acceptedAt !== 'string'
    || receipt.ownerId !== SERVE_OWNER
    || receipt.leaseId !== lease.leaseId
    || receipt.generation !== lease.generation
  ) {
    throw new AppLifecycleError(
      'daemon-restart.response-invalid',
      'serve owner returned a restart receipt for a different owner or lease',
      'inspect the original serve CLI output and retry after repairing the control endpoint',
      SERVE_OWNER,
    );
  }
  return {
    requestId: receipt.requestId,
    acceptedAt: receipt.acceptedAt,
    ownerId: SERVE_OWNER,
    leaseId: lease.leaseId,
    generation: lease.generation,
    observerOnly: true,
  };
}
