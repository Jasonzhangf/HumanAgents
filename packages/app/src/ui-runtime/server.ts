import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import {
  id,
  validateExecutionPolicyDefinition,
  validateInteractionDecision,
  type ExecutionPolicyDefinition,
  type InteractionRequestKind,
  type InteractionTraceKind,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { RequirementIntent } from '../../../contracts/src/index.js';
import { boundedErrorCause, UiRuntimeApiError } from './errors.js';
import type { UiRuntimeService } from './service.js';
import type { RuntimeSseEvent } from '../../../ui/contracts/runtime.js';
import type { DaemonRestartReceipt } from '../supervisor/restart-client.js';
import { AppLifecycleError } from '../errors.js';
import {
  AccessControlError,
  isAccessControlError,
  type AccessControlService,
  type AccessSession,
  type SessionVerification,
} from './access-control.js';

const APP_OWNER = 'humanagent.app';

export interface UiRuntimeServerOptions {
  readonly service: UiRuntimeService;
  readonly accessControl: AccessControlService;
  readonly uiRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly restart?: (input: {
    readonly leaseId: string;
    readonly generation: number;
  }) => DaemonRestartReceipt;
  readonly identity?: () => {
    readonly leaseId: string;
    readonly generation: number;
    readonly pid: number;
    readonly processStartToken: string;
  };
  /**
   * Read-only projection of the due-time patrol. Absent means this runtime was
   * started without a patrol, which the route reports as unsupported.
   */
  readonly schedulerStatus?: () => Promise<unknown>;
}

export interface UiRuntimeServer {
  readonly server: Server;
  readonly url: string;
  readonly listenAddress: string;
  readonly family: string;
  readonly port: number;
  close(): Promise<ListenerShutdownReceipt>;
}

export interface ListenerShutdownReceipt {
  readonly activeSseEnded: number;
  readonly subscriptionsClosed: number;
  readonly heartbeatsCleared: number;
  readonly authTimersCleared: number;
  readonly credentialWatchClosed: boolean;
  readonly serverClosed: boolean;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(payload);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (isAccessControlError(error)) {
    writeJson(response, error.httpStatus, {
      error: {
        code: error.code,
        ownerId: error.ownerId,
        message: error.message,
        nextAction: error.nextAction,
      },
    });
    return;
  }
  if (error instanceof UiRuntimeApiError) {
    writeJson(response, error.httpStatus, { error: error.toBody() });
    return;
  }
  if (error instanceof AppLifecycleError) {
    const cause = boundedErrorCause(error.cause);
    writeJson(response, 409, {
      error: {
        code: error.code,
        ownerId: error.ownerId,
        message: error.message,
        nextAction: error.nextAction,
        ...(cause === undefined ? {} : { cause }),
      },
    });
    return;
  }
  const cause = boundedErrorCause(error instanceof Error ? error.cause : undefined);
  writeJson(response, 500, {
    error: {
      code: 'ui-runtime.unexpected',
      ownerId: APP_OWNER,
      message: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect the runtime error and retry from a new operation',
      ...(cause === undefined ? {} : { cause }),
    },
  });
}

function sessionError(verification: SessionVerification): AccessControlError {
  if (verification.state === 'missing') {
    return new AccessControlError('auth.session.missing', 'browser session is required', 'open the login page and pair this browser', 401);
  }
  if (verification.state === 'expired') {
    return new AccessControlError('auth.session.expired', 'browser session has expired', 'open the login page and pair this browser again', 401);
  }
  return new AccessControlError('auth.session.invalid', 'browser session is invalid', 'open the login page and pair this browser again', 401);
}

async function requireSession(accessControl: AccessControlService, request: IncomingMessage): Promise<AccessSession> {
  const cookie = request.headers.cookie;
  const verification = await accessControl.verifySession(Array.isArray(cookie) ? cookie[0] : cookie);
  if (verification.state !== 'valid') throw sessionError(verification);
  return verification.session;
}

function requireOrigin(accessControl: AccessControlService, request: IncomingMessage): void {
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  if (!accessControl.validateOrigin(origin, host)) {
    throw new AccessControlError('auth.origin.invalid', 'request Origin does not match the listener origin', 'retry the mutation from the same UI origin', 403);
  }
}

function isMutation(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'DELETE';
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (Array.isArray(header)) return undefined;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requireSupervisor(
  accessControl: AccessControlService,
  request: IncomingMessage,
  identity: UiRuntimeServerOptions['identity'],
): { readonly leaseId: string; readonly generation: number } {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new AccessControlError('auth.supervisor.forbidden', 'supervisor endpoints are loopback-only', 'run the command on the serve host', 403);
  }
  if (!identity) {
    throw new UiRuntimeApiError(
      'daemon-identity.unsupported',
      APP_OWNER,
      'this runtime is not hosted by a supervisor with an identity endpoint',
      'request identity from the original humanagent serve owner',
      501,
    );
  }
  const active = identity();
  const token = bearerToken(request);
  if (!accessControl.verifySupervisorToken(token, active.leaseId, active.generation)) {
    throw new AccessControlError('auth.supervisor.required', 'valid supervisor authentication is required', 'run the command through the active serve owner', 401);
  }
  return { leaseId: active.leaseId, generation: active.generation };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk as Uint8Array);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UiRuntimeApiError('request.invalid', APP_OWNER, 'request body must be a JSON object', 'send a JSON object body');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UiRuntimeApiError) throw error;
    throw new UiRuntimeApiError('request.invalid-json', APP_OWNER, 'request body is not valid JSON', 'send a JSON object body');
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new UiRuntimeApiError('request.missing-field', APP_OWNER, `request field ${key} is required`, `provide a non-empty ${key}`);
  }
  return value;
}

function requirePrompt(body: Record<string, unknown>): string {
  const value = body.prompt;
  if (typeof value !== 'string' || !value.trim()) {
    throw new UiRuntimeApiError('execution.input.required', APP_OWNER, 'request field prompt is required', 'provide a non-empty prompt', 400);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be a non-empty string`, `provide a valid ${key}`);
  }
  return value;
}

function requirePositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be a positive safe integer`, `provide a positive ${key}`);
  }
  return value as number;
}

function requireStringArray(body: Record<string, unknown>, key: string): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be a string array`, `provide ${key} as a string array`);
  }
  return value;
}

function requireRecord(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be an object`, `provide ${key} as an object`);
  }
  return value as Record<string, unknown>;
}

function requireRequirementIntent(body: Record<string, unknown>, key: string): RequirementIntent {
  const value = requireString(body, key);
  if (value !== 'append' && value !== 'change' && value !== 'create') {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be append, change, or create`, `provide a valid ${key}`);
  }
  return value;
}

const INTERACTION_REQUEST_KINDS: ReadonlySet<InteractionRequestKind> = new Set([
  'new-task-create',
  'new-task-preview',
  'existing-task-change',
  'status-query',
  'clarification',
  'refinement',
]);

function optionalInteractionRequestKind(body: Record<string, unknown>): InteractionRequestKind | undefined {
  const value = body.requestKind;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !INTERACTION_REQUEST_KINDS.has(value as InteractionRequestKind)) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field requestKind is not a typed interaction request kind', 'provide a valid requestKind');
  }
  return value as InteractionRequestKind;
}

function optionalExecutionPolicy(body: Record<string, unknown>): ExecutionPolicyDefinition | undefined {
  const value = body.executionPolicy;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field executionPolicy must be an object', 'provide a typed execution policy');
  }
  try {
    validateExecutionPolicyDefinition(value as ExecutionPolicyDefinition);
  } catch (error) {
    throw new UiRuntimeApiError(
      'request.invalid-field',
      APP_OWNER,
      `request field executionPolicy is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'provide a valid execution policy',
    );
  }
  return value as ExecutionPolicyDefinition;
}

function writeSse(response: ServerResponse, event: RuntimeSseEvent): void {
  response.write(`id: ${event.eventId}\n`);
  response.write(`event: ${event.kind}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function serveStatic(response: ServerResponse, uiRoot: string, pathname: string): Promise<void> {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(uiRoot, relativePath));
  try {
    const rootReal = await realpath(uiRoot);
    const targetReal = await realpath(target);
    const rel = relative(rootReal, targetReal);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      writeError(response, new UiRuntimeApiError('static.forbidden', APP_OWNER, 'static path escapes the UI root', 'request a file inside the UI root', 403));
      return;
    }
    const content = await readFile(targetReal);
    response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(targetReal)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(content);
  } catch {
    writeError(response, new UiRuntimeApiError('static.not-found', APP_OWNER, `static file not found: ${relativePath}`, 'request an existing UI file', 404));
  }
}

type SseCloseReason = 'terminal' | 'client' | 'server.shutdown' | 'auth.invalidated' | 'auth.unavailable' | 'write-failure';

interface ActiveSse {
  readonly response: ServerResponse;
  readonly session: AccessSession;
  close(reason: SseCloseReason): Promise<void>;
}

function createSseRegistry() {
  const active = new Set<ActiveSse>();
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let authTimersCleared = 0;
  let authControl: AccessControlService | undefined;
  const clearAuthTimer = (recordRelease: boolean): void => {
    if (authTimer === undefined) return;
    clearTimeout(authTimer);
    authTimer = undefined;
    if (recordRelease) authTimersCleared += 1;
  };
  return {
    get size() {
      return active.size;
    },
    get entries() {
      return [...active];
    },
    add(entry: ActiveSse): void {
      active.add(entry);
    },
    delete(entry: ActiveSse): void {
      active.delete(entry);
      if (active.size === 0) {
        clearAuthTimer(true);
        return;
      }
      if (authControl) this.scheduleAuthRevalidation(authControl);
    },
    async closeWhere(predicate: (entry: ActiveSse) => boolean, reason: SseCloseReason): Promise<number> {
      const selected = [...active].filter(predicate);
      await Promise.all(selected.map((entry) => entry.close(reason)));
      return selected.length;
    },
    async closeAll(reason: SseCloseReason): Promise<number> {
      const selected = [...active];
      await Promise.all(selected.map((entry) => entry.close(reason)));
      return selected.length;
    },
    async revalidateNow(accessControl: AccessControlService): Promise<number> {
      let currentGeneration: number;
      try {
        currentGeneration = await accessControl.readPersistedGeneration();
      } catch (error) {
        await this.closeAll('auth.unavailable');
        throw error;
      }
      return this.closeWhere(
        (entry) => entry.session.sessionGeneration !== currentGeneration || accessControl.isExpired(entry.session),
        'auth.invalidated',
      );
    },
    scheduleAuthRevalidation(accessControl: AccessControlService): void {
      authControl = accessControl;
      clearAuthTimer(false);
      const delayMs = accessControl.nextExpiryDelayMs([...active].map((entry) => entry.session));
      if (delayMs === undefined) return;
      authTimer = setTimeout(() => {
        authTimer = undefined;
        void this.revalidateNow(accessControl).then(
          () => {
            if (active.size > 0) this.scheduleAuthRevalidation(accessControl);
          },
          () => {
            void this.closeAll('auth.unavailable');
          },
        );
      }, delayMs);
      authTimer.unref?.();
    },
    clearAuthRevalidation(): number {
      const cleared = authTimersCleared;
      clearAuthTimer(true);
      return authTimersCleared - cleared;
    },
  };
}

export async function startUiRuntimeServer(options: UiRuntimeServerOptions): Promise<UiRuntimeServer> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '0.0.0.0' && host !== '::' && host !== '127.0.0.1' && host !== '::1') {
    throw new UiRuntimeApiError('ui-server.host.forbidden', APP_OWNER, 'ui runtime server host must be 0.0.0.0, ::, 127.0.0.1, or ::1', 'choose a supported listener wildcard or loopback host');
  }
  const service = options.service;
  const accessControl = options.accessControl;
  const sseRegistry = createSseRegistry();
  accessControl.startCredentialWatch(
    () => sseRegistry.revalidateNow(accessControl).then(() => undefined),
    async (error) => {
      await sseRegistry.closeAll('auth.unavailable');
      throw error;
    },
  );
  let closing = false;
  let closeReceipt: ListenerShutdownReceipt | undefined;
  let closePromise: Promise<ListenerShutdownReceipt> | undefined;
  const server = createServer((request, response) => {
    void handleRequest(request, response, service, accessControl, sseRegistry, () => closing, options.uiRoot, options.restart, options.identity, options.schedulerStatus)
      .catch((error) => {
        writeError(response, error);
      });
  });
  let bound: { readonly address: string; readonly family: string; readonly port: number };
  try {
    bound = await new Promise<{ readonly address: string; readonly family: string; readonly port: number }>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('ui runtime server did not bind a TCP port'));
          return;
        }
        resolve({ address: address.address, family: address.family, port: address.port });
      });
    });
  } catch (error) {
    await accessControl.closeCredentialWatch().catch(() => undefined);
    throw error;
  }
  const urlHost = bound.address.includes(':') ? `[${bound.address}]` : bound.address;
  const url = `http://${urlHost}:${bound.port}`;
  return {
    server,
    url,
    listenAddress: bound.address,
    family: bound.family,
    port: bound.port,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        let credentialWatchClosed = false;
        let credentialWatchError: unknown;
        try {
          credentialWatchClosed = await accessControl.closeCredentialWatch();
        } catch (error) {
          credentialWatchError = error;
        }
        const authTimersCleared = sseRegistry.clearAuthRevalidation();
        const activeSseEnded = await sseRegistry.closeAll('server.shutdown');
        server.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        closeReceipt = {
          activeSseEnded,
          subscriptionsClosed: activeSseEnded,
          heartbeatsCleared: activeSseEnded,
          authTimersCleared,
          credentialWatchClosed,
          serverClosed: true,
        };
        if (credentialWatchError !== undefined) throw credentialWatchError;
        return closeReceipt;
      })();
      return closePromise;
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: UiRuntimeService,
  accessControl: AccessControlService,
  sseRegistry: ReturnType<typeof createSseRegistry>,
  isClosing: () => boolean,
  uiRoot: string,
  restart?: UiRuntimeServerOptions['restart'],
  identity?: UiRuntimeServerOptions['identity'],
  schedulerStatus?: UiRuntimeServerOptions['schedulerStatus'],
): Promise<void> {
  const method = request.method ?? 'GET';
  try {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      writeError(response, new UiRuntimeApiError(
        'request.target.invalid',
        APP_OWNER,
        'request target is not a valid URL',
        'send an absolute origin-form request target',
        400,
      ));
      return;
    }
    const path = url.pathname;
    if (path === '/api/liveness' && method === 'GET') {
      writeJson(response, 200, { status: 'alive', service: 'humanagent.ui-runtime' });
      return;
    }
    if (path === '/api/auth/session' && method === 'GET') {
      const cookie = request.headers.cookie;
      const verification = await accessControl.verifySession(Array.isArray(cookie) ? cookie[0] : cookie);
      writeJson(response, 200, verification.state === 'valid'
        ? { authenticated: true, expiresAt: new Date(verification.session.expiresAt).toISOString() }
        : { authenticated: false });
      return;
    }
    if (path === '/api/auth/pair' && method === 'POST') {
      requireOrigin(accessControl, request);
      const body = await readBody(request);
      const session = await accessControl.consumePairingCode(requireString(body, 'code'));
      writeJson(response, 200, {
        authenticated: true,
        expiresAt: new Date(session.expiresAt).toISOString(),
      }, { 'set-cookie': accessControl.sessionCookie(session) });
      return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      await requireSession(accessControl, request);
      requireOrigin(accessControl, request);
      await accessControl.logout();
      await sseRegistry.revalidateNow(accessControl);
      writeJson(response, 200, { authenticated: false }, { 'set-cookie': accessControl.clearSessionCookie() });
      return;
    }
    if (path === '/api/health/probe' && method === 'GET') {
      writeJson(response, 405, {
        error: {
          code: 'request.method-not-allowed',
          ownerId: APP_OWNER,
          message: 'health probe requires POST',
          nextAction: 'send an authenticated same-origin POST request',
        },
      }, { allow: 'POST' });
      return;
    }
    if (path === '/api/auth/pair/challenge' && method === 'POST') {
      requireSupervisor(accessControl, request, identity);
      const body = await readBody(request);
      const leaseId = requireString(body, 'leaseId');
      const generation = requirePositiveInteger(body, 'generation');
      const active = identity!();
      if (leaseId !== active.leaseId || generation !== active.generation) {
        throw new AccessControlError('auth.supervisor.forbidden', 'pairing challenge does not match the active supervisor lease', 'read the active daemon lease and retry pairing', 403);
      }
      const challenge = accessControl.createPairingChallenge(leaseId, generation);
      writeJson(response, 200, {
        code: challenge.code,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
      });
      return;
    }
    const supervisorControlled = (
      (path === '/api/runtime/identity' && method === 'GET')
      || (path === '/api/runtime/restart' && method === 'POST')
    );
    if (path === '/api/runtime/identity' && method === 'GET') {
      requireSupervisor(accessControl, request, identity);
    }
    if (path === '/api/runtime/restart' && method === 'POST') {
      requireSupervisor(accessControl, request, identity);
    }
    if (path.startsWith('/api/') && !supervisorControlled) {
      const session = await requireSession(accessControl, request);
      if (isMutation(method)) requireOrigin(accessControl, request);
      if (path === '/api/executions/' || path.startsWith('/api/executions/')) {
        if (isClosing()) {
          throw new UiRuntimeApiError('ui-server.closing', APP_OWNER, 'runtime listener is shutting down', 'reconnect after the service is ready', 503);
        }
      }
    }
    if (path === '/api/runtime/status' && method === 'GET') {
      writeJson(response, 200, service.status());
      return;
    }
    if (path === '/api/runtime/scheduler' && method === 'GET') {
      if (schedulerStatus === undefined) {
        throw new UiRuntimeApiError(
          'scheduler.unsupported',
          APP_OWNER,
          'this runtime was started without a due-time patrol',
          'start the runtime through the supervisor-owned serve entry',
          501,
        );
      }
      writeJson(response, 200, await schedulerStatus());
      return;
    }
    // The only production entry to the persisted plan control edge. The plan is
    // named by its own id; the expected revisions are read from the authoritative
    // snapshot inside the service, so a client cannot declare a revision.
    const planControl = /^\/api\/plans\/([^/]+)\/control$/.exec(path);
    if (planControl && method === 'POST') {
      const body = await readBody(request);
      const action = requireString(body, 'action');
      if (action !== 'pause' && action !== 'resume' && action !== 'cancel-future') {
        throw new UiRuntimeApiError(
          'execution-plan.action-unsupported',
          APP_OWNER,
          action === 'modify'
            ? 'the modify action has no production entry: no confirmationRef collection surface exists'
            : `unsupported execution plan control action: ${action}`,
          'use pause, resume or cancel-future',
          400,
        );
      }
      writeJson(response, 200, await service.controlExecutionPlan(decodeURIComponent(planControl[1]!), {
        action,
        idempotencyKey: requireString(body, 'idempotencyKey'),
        requestedAt: requireString(body, 'requestedAt'),
      }));
      return;
    }
    if (path === '/api/runtime/identity' && method === 'GET') {
      if (identity === undefined) {
        throw new UiRuntimeApiError(
          'daemon-identity.unsupported',
          APP_OWNER,
          'this runtime is not hosted by a supervisor with an identity endpoint',
          'request identity from the original humanagent serve owner',
          501,
        );
      }
      writeJson(response, 200, identity());
      return;
    }
    if (path === '/api/runtime/restart' && method === 'POST') {
      if (restart === undefined) {
        throw new UiRuntimeApiError(
          'daemon-restart.unsupported',
          APP_OWNER,
          'this runtime is not hosted by a restart-capable serve owner',
          'request restart from the original humanagent serve owner',
          501,
        );
      }
      const body = await readBody(request);
      const leaseId = requireString(body, 'leaseId');
      const generation = requirePositiveInteger(body, 'generation');
      writeJson(response, 202, restart({ leaseId, generation }));
      return;
    }
    if (path === '/api/health/probe' && method === 'POST') {
      writeJson(response, 200, await service.healthProbe());
      return;
    }
    if (path === '/api/health/snapshot' && method === 'GET') {
      writeJson(response, 200, await service.healthSnapshot());
      return;
    }
    if (path === '/api/memory/summary' && method === 'GET') {
      const namespace = url.searchParams.get('namespace');
      if (namespace === 'global') {
        throw new UiRuntimeApiError(
          'memory-capability-denied',
          'memory-coordinator',
          'global memory access requires an authorized cross-project grant',
          'request a cross-project grant or use the project namespace',
          409,
        );
      }
      if (namespace !== null && namespace !== 'project' && namespace !== 'global') {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'summary field namespace must be project or global', 'provide project or global');
      }
      writeJson(response, 200, await service.memorySummary({
        ...(namespace === null ? {} : { namespace }),
        ...(url.searchParams.get('query') === null ? {} : { query: url.searchParams.get('query')! }),
        ...(url.searchParams.get('limit') === null ? {} : { limit: requirePositiveInteger({ limit: Number(url.searchParams.get('limit')) }, 'limit') }),
      }));
      return;
    }
    if (path === '/api/memory/query' && method === 'GET') {
      const namespace = url.searchParams.get('namespace');
      if (namespace === 'global') {
        throw new UiRuntimeApiError(
          'memory-capability-denied',
          'memory-coordinator',
          'global memory access requires an authorized cross-project grant',
          'request a cross-project grant or use the project namespace',
          409,
        );
      }
      if (namespace !== null && namespace !== 'project' && namespace !== 'global') {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'query field namespace must be project or global', 'provide project or global');
      }
      writeJson(response, 200, await service.memoryQuery({
        ...(namespace === null ? {} : { namespace }),
        query: url.searchParams.get('query') ?? '',
        ...(url.searchParams.get('limit') === null ? {} : { limit: requirePositiveInteger({ limit: Number(url.searchParams.get('limit')) }, 'limit') }),
      }));
      return;
    }
    if (path === '/api/memory/inspect' && method === 'POST') {
      const body = await readBody(request);
      writeJson(response, 200, await service.memoryInspect({
        sourceRef: requireString(body, 'sourceRef'),
        sourceDigest: requireString(body, 'sourceDigest'),
      }));
      return;
    }
    if (path === '/api/memory/compare' && method === 'POST') {
      const body = await readBody(request);
      writeJson(response, 200, await service.memoryCompare({
        leftRef: requireString(body, 'leftRef'),
        rightRef: requireString(body, 'rightRef'),
      }));
      return;
    }
    if (path === '/api/memory/review' && method === 'POST') {
      const body = await readBody(request);
      const decision = requireString(body, 'decision');
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'defer') {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field decision must be approve, reject, or defer', 'provide a valid review decision');
      }
      writeJson(response, 200, await service.reviewSkillCandidate({
        candidateId: requireString(body, 'candidateId'),
        decision,
        decisionReason: requireString(body, 'decisionReason'),
      }));
      return;
    }
    if (path === '/api/dashboard' && method === 'GET') {
      writeJson(response, 200, service.dashboard());
      return;
    }
    if (path === '/api/tasks' && method === 'GET') {
      writeJson(response, 200, service.listTasks());
      return;
    }
    if (path === '/api/tasks' && method === 'POST') {
      const body = await readBody(request);
      const created = service.createTask({
        title: typeof body.title === 'string' ? body.title : undefined,
        directive: typeof body.directive === 'string' ? body.directive : undefined,
      });
      writeJson(response, 201, created);
      return;
    }
    if (path === '/api/tasks/bulk' && method === 'POST') {
      const body = await readBody(request);
      const action = requireString(body, 'action');
      if (action !== 'delete' && action !== 'stop') {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field action must be delete or stop', 'provide a supported bulk task action');
      }
      const taskIds = requireStringArray(body, 'taskIds');
      if (taskIds.length === 0) {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field taskIds must not be empty', 'select at least one task');
      }
      writeJson(response, 200, await service.bulkTaskAction(taskIds.map((taskId) => id('task', taskId)), action));
      return;
    }
    if (path === '/api/explicit/inputs' && method === 'POST') {
      const body = await readBody(request);
      const channel = requireString(body, 'channel');
      if (channel === 'control') {
        throw new UiRuntimeApiError(
          'explicit-brain.control.unsupported',
          APP_OWNER,
          'control commands require the formal control operation API',
          'use the runtime control operation endpoint',
          501,
        );
      }
      if (channel !== 'business') {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field channel must be business', 'provide business');
      }
      const inputRevision = body.inputRevision === undefined ? 1 : requirePositiveInteger(body, 'inputRevision');
      const requestKind = optionalInteractionRequestKind(body);
      const interactionId = await service.receiveExplicitInput({
        sourceRef: requireString(body, 'sourceRef'),
        rawInput: requireString(body, 'rawInput'),
        channel,
        ...(requestKind === undefined ? {} : { requestKind }),
      }, inputRevision);
      writeJson(response, 201, { interactionId });
      return;
    }
    if (path === '/api/explicit/decision' && method === 'POST') {
      const body = await readBody(request);
      try {
        validateInteractionDecision(body);
      } catch (error) {
        throw new UiRuntimeApiError(
          'request.invalid-field',
          APP_OWNER,
          error instanceof Error ? error.message : String(error),
          'provide a complete typed explicit brain decision',
          400,
        );
      }
      writeJson(response, 200, await service.executeExplicitDecision(body));
      return;
    }
    const explicitInterpretation = /^\/api\/explicit\/interactions\/([^/]+)\/interpret$/.exec(path);
    if (explicitInterpretation && method === 'POST') {
      writeJson(response, 200, await service.interpretExplicitInput({
        interactionId: decodeURIComponent(explicitInterpretation[1]!),
      }));
      return;
    }
    const explicitRefinement = /^\/api\/explicit\/interactions\/([^/]+)\/refine$/.exec(path);
    if (explicitRefinement && method === 'POST') {
      const body = await readBody(request);
      const instructionRef = optionalString(body, 'instructionRef') ?? 'user-edit';
      const idempotencyKey = optionalString(body, 'idempotencyKey');
      writeJson(response, 200, await service.refineExplicitDraft(decodeURIComponent(explicitRefinement[1]!), {
        draftId: requireString(body, 'draftId'),
        baseRevisionVersion: requirePositiveInteger(body, 'baseRevisionVersion'),
        requestedRevisionHash: requireString(body, 'requestedRevisionHash'),
        fields: requireRecord(body, 'fields'),
        instructionRef,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }));
      return;
    }
    const explicitRegeneration = /^\/api\/explicit\/interactions\/([^/]+)\/regenerate$/.exec(path);
    if (explicitRegeneration && method === 'POST') {
      const body = await readBody(request);
      const instruction = optionalString(body, 'instruction');
      writeJson(response, 200, await service.regenerateExplicitDraft(
        decodeURIComponent(explicitRegeneration[1]!),
        instruction,
      ));
      return;
    }
    const explicitClarification = /^\/api\/explicit\/interactions\/([^/]+)\/clarification$/.exec(path);
    if (explicitClarification && method === 'POST') {
      const body = await readBody(request);
      writeJson(response, 200, await service.answerExplicitClarification({
        interactionId: decodeURIComponent(explicitClarification[1]!),
        answer: requireString(body, 'answer'),
      }));
      return;
    }
    const explicitInteraction = /^\/api\/explicit\/interactions\/([^/]+)$/.exec(path);
    if (explicitInteraction && method === 'GET') {
      writeJson(response, 200, await service.inspectExplicitInteraction(decodeURIComponent(explicitInteraction[1]!)));
      return;
    }
    const explicitRejection = /^\/api\/explicit\/interactions\/([^/]+)\/reject$/.exec(path);
    if (explicitRejection && method === 'POST') {
      const body = await readBody(request);
      const interactionId = decodeURIComponent(explicitRejection[1]!);
      const reason = requireString(body, 'reason');
      const rejectionId = optionalString(body, 'rejectionId');
      const closedAt = optionalString(body, 'closedAt');
      const current = await service.inspectExplicitInteraction(interactionId);
      if (current.revision !== undefined) {
        // A typed draft closes through the revision owner so the closure is
        // durable and the exact revision can never be submitted afterwards.
        const closure = await service.rejectExplicitDraftRevision(interactionId, {
          reason,
          ...(rejectionId === undefined ? {} : { rejectionId }),
          ...(closedAt === undefined ? {} : { closedAt }),
        });
        writeJson(response, 200, { interactionId, state: 'rejected', closure });
        return;
      }
      writeJson(response, 200, await service.rejectExplicitInteraction(interactionId, reason));
      return;
    }
    const explicitMatching = /^\/api\/explicit\/interactions\/([^/]+)\/matching$/.exec(path);
    if (explicitMatching && method === 'POST') {
      await service.beginExplicitMatching(decodeURIComponent(explicitMatching[1]!));
      writeJson(response, 202, { interactionId: decodeURIComponent(explicitMatching[1]!) });
      return;
    }
    const explicitMatch = /^\/api\/explicit\/interactions\/([^/]+)\/match$/.exec(path);
    if (explicitMatch && method === 'POST') {
      const body = await readBody(request);
      const matchedTasks = body.matchedTasks;
      if (!Array.isArray(matchedTasks)) {
        throw new UiRuntimeApiError('request.missing-field', APP_OWNER, 'request field matchedTasks is required', 'provide matchedTasks');
      }
      await service.recordExplicitMatch(decodeURIComponent(explicitMatch[1]!), {
        normalizedInput: requireString(body, 'normalizedInput'),
        matchedTasks: matchedTasks.map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'matchedTasks entries must be objects', 'provide typed matched tasks');
          }
          const task = entry as Record<string, unknown>;
          const relation = requireString(task, 'relation');
          if (relation !== 'current' && relation !== 'related' && relation !== 'historical') {
            throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'matched task relation is invalid', 'provide current, related, or historical');
          }
          return {
            taskId: id('task', requireString(task, 'taskId')),
            relation,
            status: requireString(task, 'status'),
          };
        }),
        knownFacts: requireStringArray(body, 'knownFacts'),
      });
      writeJson(response, 202, { interactionId: decodeURIComponent(explicitMatch[1]!) });
      return;
    }
    const explicitProposal = /^\/api\/explicit\/interactions\/([^/]+)\/proposal$/.exec(path);
    if (explicitProposal && method === 'POST') {
      const body = await readBody(request);
      await service.proposeExplicitRequirement(decodeURIComponent(explicitProposal[1]!), {
        proposedIntent: requireRequirementIntent(body, 'proposedIntent'),
        proposal: requireString(body, 'proposal'),
        ...(body.decisionRefs === undefined ? {} : { decisionRefs: requireStringArray(body, 'decisionRefs') }),
      });
      writeJson(response, 202, { interactionId: decodeURIComponent(explicitProposal[1]!) });
      return;
    }
    const explicitStatus = /^\/api\/explicit\/interactions\/([^/]+)\/status-only$/.exec(path);
    if (explicitStatus && method === 'POST') {
      writeJson(response, 200, await service.completeExplicitStatusQuery(decodeURIComponent(explicitStatus[1]!)));
      return;
    }
    const explicitConfirmation = /^\/api\/explicit\/interactions\/([^/]+)\/confirmation$/.exec(path);
    if (explicitConfirmation && method === 'POST') {
      const body = await readBody(request);
      const executionPolicy = optionalExecutionPolicy(body);
      const goal = optionalString(body, 'goal');
      const scope = optionalString(body, 'scope');
      const idempotencyKey = optionalString(body, 'idempotencyKey');
      const draftRevisionVersion = body.draftRevisionVersion === undefined ? undefined : requirePositiveInteger(body, 'draftRevisionVersion');
      const draftRevisionHash = optionalString(body, 'draftRevisionHash');
      const receipt = await service.confirmExplicitRequirement({
        interactionId: decodeURIComponent(explicitConfirmation[1]!),
        draftId: requireString(body, 'draftId'),
        inputRevision: requirePositiveInteger(body, 'inputRevision'),
        confirmationRef: requireString(body, 'confirmationRef'),
        confirmedBy: requireString(body, 'confirmedBy'),
        confirmedAt: requireString(body, 'confirmedAt'),
        payloadRef: requireString(body, 'payloadRef'),
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
        ...(goal === undefined ? {} : { goal }),
        ...(scope === undefined ? {} : { scope }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(draftRevisionVersion === undefined ? {} : { draftRevisionVersion }),
        ...(draftRevisionHash === undefined ? {} : { draftRevisionHash }),
        ...(body.deliverables === undefined ? {} : { deliverables: requireStringArray(body, 'deliverables') }),
        ...(body.constraints === undefined ? {} : { constraints: requireStringArray(body, 'constraints') }),
      });
      writeJson(response, 200, receipt);
      return;
    }
    if (path === '/api/explicit/dispatch-next' && method === 'POST') {
      const dispatched = await service.dispatchNextExplicitRequirement();
      writeJson(response, 202, {
        ...dispatched,
        taskId: dispatched.taskId.value,
        operationId: dispatched.operationId.value,
      });
      return;
    }
    const taskDashboard = /^\/api\/tasks\/([^/]+)\/dashboard$/.exec(path);
    if (taskDashboard && method === 'GET') {
      writeJson(response, 200, await service.taskDashboardWithPlan(id('task', decodeURIComponent(taskDashboard[1]!))));
      return;
    }
    const taskObservation = /^\/api\/tasks\/([^/]+)\/observation$/.exec(path);
    if (taskObservation && method === 'GET') {
      const selected = url.searchParams.get('node') ?? undefined;
      const scope = url.searchParams.get('scope') ?? undefined;
      writeJson(response, 200, service.observation(id('task', decodeURIComponent(taskObservation[1]!)), selected, scope));
      return;
    }
    const taskHistory = /^\/api\/tasks\/([^/]+)\/history$/.exec(path);
    if (taskHistory && method === 'GET') {
      const limitParam = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const search = url.searchParams.get('search') ?? undefined;
      const kinds = url.searchParams.getAll('kind');
      const limit = limitParam === null ? 20 : Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new UiRuntimeApiError(
          'history.limit.invalid',
          APP_OWNER,
          'history limit must be an integer from 1 to 500',
          'send a valid history limit',
          400,
        );
      }
      const result = service.history(id('task', decodeURIComponent(taskHistory[1]!)), {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(search === undefined ? {} : { search }),
        ...(kinds.length === 0 ? {} : { filter: { kinds: kinds as InteractionTraceKind[] } }),
      });
      writeJson(response, result.ok ? 200 : 409, result);
      return;
    }
    const taskExecutions = /^\/api\/tasks\/([^/]+)\/executions$/.exec(path);
    if (taskExecutions && method === 'POST') {
      const body = await readBody(request);
      const mode = requireString(body, 'mode');
      if (mode !== 'fake' && mode !== 'rcc') {
        throw new UiRuntimeApiError('execution.mode.invalid', APP_OWNER, 'execution mode must be explicitly fake or rcc', 'select fake or rcc mode');
      }
      if (mode !== service.status().mode) {
        throw new UiRuntimeApiError('execution.mode.mismatch', APP_OWNER, `runtime is running in ${service.status().mode} mode`, `restart the runtime in ${mode} mode`);
      }
      const started = service.startExecution(id('task', decodeURIComponent(taskExecutions[1]!)), { prompt: requirePrompt(body) });
      writeJson(response, 202, { operationId: started.operationId.value, executionEpoch: started.executionEpoch });
      return;
    }
    const taskStop = /^\/api\/tasks\/([^/]+)\/stop$/.exec(path);
    if (taskStop && method === 'POST') {
      const result = await service.stop(id('task', decodeURIComponent(taskStop[1]!)));
      writeJson(response, 202, result);
      return;
    }
    const taskStopRetry = /^\/api\/tasks\/([^/]+)\/stop\/retry$/.exec(path);
    if (taskStopRetry && method === 'POST') {
      const result = await service.retryStop(id('task', decodeURIComponent(taskStopRetry[1]!)));
      writeJson(response, 202, result);
      return;
    }
    const taskDetail = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskDetail && method === 'PATCH') {
      const body = await readBody(request);
      if (body.directive !== undefined) {
        throw new UiRuntimeApiError(
          'task.directive.edit.requires-explicit-brain',
          APP_OWNER,
          'task directive changes must go through the explicit brain interaction',
          'open the task interaction and confirm the proposed change',
          409,
        );
      }
      const title = body.title === undefined ? undefined : requireString(body, 'title');
      if (title === undefined) {
        throw new UiRuntimeApiError('request.missing-field', APP_OWNER, 'task update requires title', 'provide a task title to update');
      }
      writeJson(response, 200, service.updateTask(id('task', decodeURIComponent(taskDetail[1]!)), { title }));
      return;
    }
    if (taskDetail && method === 'DELETE') {
      writeJson(response, 200, await service.deleteTask(id('task', decodeURIComponent(taskDetail[1]!))));
      return;
    }
    if (taskDetail && method === 'GET') {
      writeJson(response, 200, service.taskDetail(id('task', decodeURIComponent(taskDetail[1]!))));
      return;
    }
    const executionEvents = /^\/api\/executions\/([^/]+)\/events$/.exec(path);
    if (executionEvents && method === 'GET') {
      const operationId = id('operation', decodeURIComponent(executionEvents[1]!));
      service.operationTask(operationId);
      const cookie = request.headers.cookie;
      const verification = await accessControl.verifySession(Array.isArray(cookie) ? cookie[0] : cookie);
      if (verification.state !== 'valid') throw sessionError(verification);
      if (isClosing()) {
        throw new UiRuntimeApiError('ui-server.closing', APP_OWNER, 'runtime listener is shutting down', 'reconnect after the service is ready', 503);
      }
      streamEvents(request, response, service, operationId, verification.session, accessControl, sseRegistry);
      return;
    }
    const executionMemoryContext = /^\/api\/executions\/([^/]+)\/memory-context$/.exec(path);
    if (executionMemoryContext && method === 'GET') {
      const operationId = id('operation', decodeURIComponent(executionMemoryContext[1]!));
      service.operationTask(operationId);
      const receipt = service.memoryContextStatus(operationId);
      writeJson(response, receipt.httpStatus, receipt.body);
      return;
    }
    const taskToolOutput = /^\/api\/tasks\/([^/]+)\/operations\/([^/]+)\/executions\/(\d+)\/events\/(\d+)\/tool-output$/.exec(path);
    if (taskToolOutput && method === 'GET') {
      const report = await service.toolOutput(
        id('task', decodeURIComponent(taskToolOutput[1]!)),
        id('operation', decodeURIComponent(taskToolOutput[2]!)),
        Number(taskToolOutput[3]!),
        Number(taskToolOutput[4]!),
      );
      writeJson(response, 200, report);
      return;
    }
    if (path.startsWith('/api/')) {
      writeError(response, new UiRuntimeApiError('route.not-found', APP_OWNER, `no runtime route for ${method} ${path}`, 'use a documented runtime endpoint', 404));
      return;
    }
    await serveStatic(response, uiRoot, path);
  } catch (error) {
    writeError(response, error);
  }
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  service: UiRuntimeService,
  operationId: { readonly scope: 'operation'; readonly value: string },
  session: AccessSession,
  accessControl: AccessControlService,
  registry: ReturnType<typeof createSseRegistry>,
): void {
  const lastEventId = request.headers['last-event-id'];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let eventWrites = Promise.resolve();
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  let entry: ActiveSse;
  const closeStream = (reason: SseCloseReason): Promise<void> => {
    if (closed) return ended;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (!response.writableEnded) {
      if (reason === 'server.shutdown') {
        response.write('event: server.shutdown\ndata: {"reason":"server.shutdown"}\n\n');
      } else if (reason === 'auth.invalidated') {
        response.write('event: auth.invalidated\ndata: {"code":"auth.session.invalid"}\n\n');
      }
      response.end(() => resolveEnded());
    } else {
      resolveEnded();
    }
    registry.delete(entry);
    return ended;
  };
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  entry = {
    response,
    session,
    close: closeStream,
  };
  registry.add(entry);
  const validateStreamSession = async (): Promise<void> => {
    let currentGeneration: number;
    try {
      currentGeneration = await accessControl.readPersistedGeneration();
    } catch (error) {
      try {
        await closeStream('auth.unavailable');
      } catch {
        throw error;
      }
      return;
    }
    if (session.sessionGeneration !== currentGeneration || accessControl.isExpired(session)) {
      await closeStream('auth.invalidated');
    }
  };
  registry.scheduleAuthRevalidation(accessControl);
  try {
    const subscription = service.subscribeReplay(operationId as never, typeof lastEventId === 'string' ? lastEventId : undefined, (event) => {
      if (closed) return;
      eventWrites = eventWrites.then(async () => {
        if (closed) return;
        try {
          await validateStreamSession();
          if (closed) return;
          writeSse(response, event);
          if (event.kind === 'execution.terminal' && event.terminalPhase === 'final') await closeStream('terminal');
        } catch {
          await closeStream('write-failure');
        }
      });
    });
    unsubscribe = subscription.unsubscribe;
    for (const event of subscription.replay) writeSse(response, event);
    if (subscription.replay.at(-1)?.terminalPhase === 'final') {
      void closeStream('terminal');
      return;
    }
    heartbeat = setInterval(() => {
      void (async () => {
        await validateStreamSession();
        if (closed) return;
        try {
          response.write(': keep-alive\n\n');
        } catch {
          await closeStream('write-failure');
        }
      })();
    }, 15000);
  } catch (error) {
    void closeStream('write-failure');
    throw error;
  }
  response.once('close', () => {
    void closeStream('client');
  });
}

export function taskIdFromParam(value: string): TaskId {
  return id('task', decodeURIComponent(value));
}
