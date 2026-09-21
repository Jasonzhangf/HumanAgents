import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { id, type TaskId } from '../../../contracts/src/index.js';
import type { RequirementIntent } from '../../../contracts/src/index.js';
import { UiRuntimeApiError } from './errors.js';
import type { UiRuntimeService } from './service.js';
import type { RuntimeSseEvent } from '../../../ui/contracts/runtime.js';

const APP_OWNER = 'humanagent.app';

export interface UiRuntimeServerOptions {
  readonly service: UiRuntimeService;
  readonly uiRoot: string;
  readonly host?: string;
  readonly port?: number;
}

export interface UiRuntimeServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(payload);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof UiRuntimeApiError) {
    writeJson(response, error.httpStatus, { error: error.toBody() });
    return;
  }
  writeJson(response, 500, {
    error: {
      code: 'ui-runtime.unexpected',
      ownerId: APP_OWNER,
      message: error instanceof Error ? error.message : String(error),
      nextAction: 'inspect the runtime error and retry from a new operation',
    },
  });
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

function requireRequirementIntent(body: Record<string, unknown>, key: string): RequirementIntent {
  const value = requireString(body, key);
  if (value !== 'append' && value !== 'change' && value !== 'create') {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be append, change, or create`, `provide a valid ${key}`);
  }
  return value;
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

export async function startUiRuntimeServer(options: UiRuntimeServerOptions): Promise<UiRuntimeServer> {
  // The control API has no authentication yet, so it must never leave loopback.
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new UiRuntimeApiError('ui-server.host.forbidden', APP_OWNER, 'ui runtime server may only bind to loopback until the control API has authentication', 'bind to 127.0.0.1 or ::1');
  }
  const service = options.service;
  const server = createServer((request, response) => {
    void handleRequest(request, response, service, options.uiRoot);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('ui runtime server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return {
    server,
    url,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: UiRuntimeService, uiRoot: string): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (path === '/api/runtime/status' && method === 'GET') {
      writeJson(response, 200, service.status());
      return;
    }
    if (path === '/api/health/probe' && method === 'GET') {
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
      const interactionId = await service.receiveExplicitInput({
        sourceRef: requireString(body, 'sourceRef'),
        rawInput: requireString(body, 'rawInput'),
        channel,
      }, inputRevision);
      writeJson(response, 201, { interactionId });
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
      writeJson(response, 200, await service.rejectExplicitInteraction(
        decodeURIComponent(explicitRejection[1]!),
        requireString(body, 'reason'),
      ));
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
      const receipt = await service.confirmExplicitRequirement({
        draftId: requireString(body, 'draftId'),
        inputRevision: requirePositiveInteger(body, 'inputRevision'),
        confirmationRef: requireString(body, 'confirmationRef'),
        confirmedBy: requireString(body, 'confirmedBy'),
        confirmedAt: requireString(body, 'confirmedAt'),
        payloadRef: requireString(body, 'payloadRef'),
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
      writeJson(response, 200, service.taskDashboard(id('task', decodeURIComponent(taskDashboard[1]!))));
      return;
    }
    const taskObservation = /^\/api\/tasks\/([^/]+)\/observation$/.exec(path);
    if (taskObservation && method === 'GET') {
      const selected = url.searchParams.get('node') ?? undefined;
      const scope = url.searchParams.get('scope') ?? undefined;
      writeJson(response, 200, service.observation(id('task', decodeURIComponent(taskObservation[1]!)), selected, scope));
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
    if (taskDetail && method === 'GET') {
      writeJson(response, 200, service.taskDetail(id('task', decodeURIComponent(taskDetail[1]!))));
      return;
    }
    const executionEvents = /^\/api\/executions\/([^/]+)\/events$/.exec(path);
    if (executionEvents && method === 'GET') {
      const operationId = id('operation', decodeURIComponent(executionEvents[1]!));
      service.operationTask(operationId);
      streamEvents(request, response, service, operationId);
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
    if (path.startsWith('/api/')) {
      writeError(response, new UiRuntimeApiError('route.not-found', APP_OWNER, `no runtime route for ${method} ${path}`, 'use a documented runtime endpoint', 404));
      return;
    }
    await serveStatic(response, uiRoot, path);
  } catch (error) {
    writeError(response, error);
  }
}

function streamEvents(request: IncomingMessage, response: ServerResponse, service: UiRuntimeService, operationId: { readonly scope: 'operation'; readonly value: string }): void {
  const lastEventId = request.headers['last-event-id'];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    response.end();
  };
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const subscription = service.subscribeReplay(operationId as never, typeof lastEventId === 'string' ? lastEventId : undefined, (event) => {
    if (closed) return;
    writeSse(response, event);
    if (event.kind === 'execution.terminal' && event.terminalPhase === 'final') closeStream();
  });
  unsubscribe = subscription.unsubscribe;
  for (const event of subscription.replay) writeSse(response, event);
  if (subscription.replay.at(-1)?.terminalPhase === 'final') {
    closeStream();
    return;
  }
  heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
  request.on('close', closeStream);
}

export function taskIdFromParam(value: string): TaskId {
  return id('task', decodeURIComponent(value));
}
