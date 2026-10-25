import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { formatPairingCommand } from '../../../config/src/index.js';
import {
  id,
  validateExecutionPolicyDefinition,
  validateJournalCommitRef,
  validateInteractionDecision,
  type ExecutionPolicyDefinition,
  type InteractionRequestKind,
  type InteractionTraceKind,
  type JournalCommitRef,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { RequirementIntent } from '../../../contracts/src/index.js';
import { boundedErrorCause, UiRuntimeApiError } from './errors.js';
import type { ProductSessionReadScope, UiRuntimeService } from './service.js';
import type { ProductBoardScope } from './product-session-read.js';
import { decodeTaskAgentActivitySelectionQuery } from './agent-activity-read.js';
import type { CheckpointHistoryReadInput } from './checkpoint-history.js';
import type { RuntimeReadResult, RuntimeSseEvent } from '../../../ui/contracts/runtime.js';
import type { RuntimeCheckpointAssetSelector } from '../../../ui/contracts/checkpoint-history.js';
import type { TaskCheckpointAssetBodyQuery } from './service.js';
import type { DaemonRestartReceipt } from '../supervisor/restart-client.js';
import { AppLifecycleError } from '../errors.js';
import { CheckpointSubmissionError } from '../../../runtime/src/checkpoints/errors.js';
import { RuntimeTaskControlError } from '../../../runtime/src/ui-runtime/coordinator.js';
import { ConfirmedControlExpectedConflict } from './reentry-current-facts.js';
import {
  AccessControlError,
  isAccessControlError,
  type AccessControlService,
  type AccessSession,
  type SessionVerification,
  type ProductPrincipalVerification,
} from './access-control.js';
import {
  UI_DISPLAY_PREFERENCE_ROUTE,
  type UiDisplayPreferenceResourceHandler,
} from './display-preferences.js';
import type {
  TaskControlCapabilityDeclaration,
  UiTaskGrantControl,
} from './task-control.js';

const APP_OWNER = 'humanagent.app';

export interface UiRuntimeServerOptions {
  readonly service: UiRuntimeService;
  readonly accessControl: AccessControlService;
  /**
   * Config-owned product root. It is the only source for the public pairing
   * command; the server never infers it from a credential path.
   */
  readonly productRoot: string;
  readonly uiRoot: string;
  /**
   * Task-scoped grant control over the same control Organ Journal. Absent
   * means this server cannot answer the task grant/revoke control routes.
   */
  readonly taskControl?: UiTaskGrantControl;
  readonly displayPreference?: UiDisplayPreferenceResourceHandler;
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

function readFailureStatus(code: string): number {
  if (code === 'project.unknown' || code === 'task.not-found' || code === 'records.cursor-not-found') return 404;
  if (code === 'records.view.invalid' || code === 'records.cursor-invalid') return 400;
  if (code === 'i2.history.unavailable') return 503;
  if (code === 'i2.cursor-invalid' || code === 'i2.cursor-scope-mismatch') return 400;
  if (code === 'i2.cursor-not-found' || code.endsWith('.unknown') || code.endsWith('.viewed-unknown')) return 404;
  return 409;
}

function writeReadResult<T>(response: ServerResponse, result: RuntimeReadResult<T>): void {
  if (result.ok) {
    writeJson(response, 200, result.value);
    return;
  }
  writeJson(response, readFailureStatus(result.failure.code), { error: result.failure });
}

function requireReadScope(url: URL): { readonly projectKey: string; readonly mode: 'fake' | 'rcc' } {
  const projectKey = url.searchParams.get('projectKey')?.trim();
  const mode = url.searchParams.get('mode');
  if (!projectKey || !mode) {
    throw new UiRuntimeApiError(
      'read.scope.invalid',
      APP_OWNER,
      'scoped task history requires both projectKey and mode',
      'send projectKey=<declared projectKey>&mode=fake|rcc',
      400,
    );
  }
  if (mode !== 'fake' && mode !== 'rcc') {
    throw new UiRuntimeApiError(
      'read.scope.invalid',
      APP_OWNER,
      `unsupported task read mode: ${mode}`,
      'send mode=fake or mode=rcc',
      400,
    );
  }
  return { projectKey, mode };
}

function optionalTaskControlScope(url: URL): { readonly projectKey: string; readonly mode: 'fake' | 'rcc' } | undefined {
  const projectKey = url.searchParams.get('projectKey');
  const mode = url.searchParams.get('mode');
  if (projectKey === null && mode === null) return undefined;
  const trimmed = projectKey?.trim();
  if (!trimmed || (mode !== 'fake' && mode !== 'rcc')) {
    throw new UiRuntimeApiError(
      'task-control.scope.invalid',
      APP_OWNER,
      'task control scope requires a non-empty projectKey and mode=fake|rcc',
      'send both projectKey=<declared projectKey>&mode=fake|rcc, or omit both for the legacy route',
      400,
    );
  }
  return { projectKey: trimmed, mode };
}

function requireTaskControlScope(url: URL): { readonly projectKey: string; readonly mode: 'fake' | 'rcc' } {
  const scope = optionalTaskControlScope(url);
  if (scope === undefined) {
    throw new UiRuntimeApiError(
      'task-control.scope.invalid',
      APP_OWNER,
      'task control scope requires both projectKey and mode=fake|rcc',
      'send both projectKey=<declared projectKey>&mode=fake|rcc',
      400,
    );
  }
  return scope;
}

function optionalI2ReadScope(url: URL): { readonly projectKey: string; readonly mode: 'fake' | 'rcc' } | undefined {
  const projectKey = url.searchParams.get('projectKey');
  const mode = url.searchParams.get('mode');
  if (projectKey === null && mode === null) return undefined;
  return requireReadScope(url);
}

function productBoardReadScope(
  url: URL,
  projectKey: string,
  mode: 'fake' | 'rcc',
): ProductBoardScope {
  const rawTaskId = url.searchParams.get('taskId');
  if (rawTaskId === null) return { kind: 'project', projectKey };
  const taskId = rawTaskId.trim();
  if (!taskId) {
    throw new UiRuntimeApiError(
      'read.scope.invalid',
      APP_OWNER,
      'product read taskId must be non-empty',
      'send taskId=<task-id> or omit it',
      400,
    );
  }
  return { kind: 'task', projectKey, mode, taskId: id('task', taskId) };
}

function requireBoundProductBoardScope(url: URL, service: UiRuntimeService): ProductBoardScope {
  const { projectKey, mode } = requireReadScope(url);
  if (!service.isBoundReadScope(projectKey, mode)) {
    throw new UiRuntimeApiError(
      'product-read.scope-not-bound',
      APP_OWNER,
      `product read scope ${projectKey}/${mode} is outside the serve-bound scope`,
      'read the product board with the serve-bound project and mode',
      409,
    );
  }
  return productBoardReadScope(url, projectKey, mode);
}

function optionalProductReadId(url: URL, field: 'taskId' | 'sessionId'): string | undefined {
  const raw = url.searchParams.get(field);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!value) {
    throw new UiRuntimeApiError(
      'read.scope.invalid',
      APP_OWNER,
      `product read ${field} must be non-empty`,
      `send ${field}=<id> or omit it`,
      400,
    );
  }
  return value;
}

function requireBoundProductSessionScope(
  url: URL,
  service: UiRuntimeService,
): ProductSessionReadScope {
  const { projectKey, mode } = requireReadScope(url);
  if (!service.isBoundReadScope(projectKey, mode)) {
    throw new UiRuntimeApiError(
      'product-read.scope-not-bound',
      APP_OWNER,
      `product read scope ${projectKey}/${mode} is outside the serve-bound scope`,
      'read the product session with the serve-bound project and mode',
      409,
    );
  }
  const taskId = optionalProductReadId(url, 'taskId');
  const sessionId = optionalProductReadId(url, 'sessionId');
  return {
    projectKey,
    mode,
    ...(taskId === undefined ? {} : { taskId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function readProduct<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UiRuntimeApiError) throw error;
    if (error instanceof RuntimeTaskControlError) {
      throw new UiRuntimeApiError(
        error.code,
        error.ownerId,
        error.message,
        error.nextAction,
        error.code.endsWith('.not.found') ? 404 : 409,
      );
    }
    throw error;
  }
}

function requireHistoryLimit(url: URL, family: 'context-history' | 'checkpoints' | 'i2-history'): number {
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam === null ? 20 : Number(limitParam);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new UiRuntimeApiError(
      `${family}.limit.invalid`,
      APP_OWNER,
      `${family} limit must be an integer from 1 to 500`,
      `send a valid ${family} limit`,
      400,
    );
  }
  return limit;
}

function optionalIntegerParam(url: URL, name: string, code: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UiRuntimeApiError(code, APP_OWNER, `${name} must be an integer`, `send ${name} as an integer`);
  }
  return parsed;
}

function checkpointViewedTarget(url: URL): CheckpointHistoryReadInput['viewed'] {
  const allowed = new Set(['projectKey', 'mode', 'limit', 'cursor', 'directiveRevision', 'executionEpoch',
    'cycleId', 'occurrenceRef', 'checkpointId', 'checkpointCommitId', 'checkpointJournalSeq', 'checkpointRecordDigest']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new UiRuntimeApiError('checkpoint-history.query-invalid', APP_OWNER,
        `unsupported or repeated checkpoint query key: ${key}`, 'send the checkpoint query keys exactly once', 400);
    }
  }
  const checkpointId = url.searchParams.get('checkpointId');
  const commitId = url.searchParams.get('checkpointCommitId');
  const journalSeq = url.searchParams.get('checkpointJournalSeq');
  const recordDigest = url.searchParams.get('checkpointRecordDigest');
  if (checkpointId === null && commitId === null && journalSeq === null && recordDigest === null) return undefined;
  const hasReceipt = commitId !== null || journalSeq !== null || recordDigest !== null;
  if ((checkpointId !== null && checkpointId.trim() === '')
    || (hasReceipt && (commitId === null || journalSeq === null || recordDigest === null))) {
    throw new UiRuntimeApiError('checkpoint-history.viewed-partial', APP_OWNER,
      'checkpoint target has an empty identity or an incomplete physical receipt',
      'send checkpointId and the complete checkpointCommitId/checkpointJournalSeq/checkpointRecordDigest receipt', 400);
  }
  if (hasReceipt && (commitId!.trim() === '' || !/^[1-9]\d*$/.test(journalSeq!)
    || !Number.isSafeInteger(Number(journalSeq)) || !/^sha256:[0-9a-f]{64}$/.test(recordDigest!))) {
    throw new UiRuntimeApiError('checkpoint-history.viewed-invalid', APP_OWNER,
      'checkpoint physical receipt is malformed', 'send the exact committed checkpoint receipt', 400);
  }
  return {
    ...(checkpointId === null ? {} : { checkpointId: id('checkpoint', checkpointId) }),
    ...(hasReceipt ? { commitRef: { commitId: commitId!, journalSeq: Number(journalSeq), recordDigest: recordDigest! } } : {}),
  };
}

/**
 * Exact checkpoint target and selector for one asset body read. Only the read
 * scope and the four checkpoint receipt keys are accepted; no list filter,
 * cursor, limit or client descriptor reaches the asset read.
 */
function checkpointAssetBodyQuery(url: URL, selector: RuntimeCheckpointAssetSelector): TaskCheckpointAssetBodyQuery {
  const { projectKey, mode } = requireReadScope(url);
  const allowed = new Set(['projectKey', 'mode', 'checkpointId', 'checkpointCommitId', 'checkpointJournalSeq', 'checkpointRecordDigest']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new UiRuntimeApiError('checkpoint-asset.query-invalid', APP_OWNER,
        `unsupported or repeated checkpoint asset query key: ${key}`, 'send the checkpoint query keys exactly once', 400);
    }
  }
  const viewed = checkpointViewedTarget(url);
  if (viewed === undefined || viewed.checkpointId === undefined || viewed.commitRef === undefined) {
    throw new UiRuntimeApiError('checkpoint-history.viewed-partial', APP_OWNER,
      'checkpoint asset read requires the checkpoint identity and its complete physical receipt',
      'send checkpointId and the complete checkpointCommitId/checkpointJournalSeq/checkpointRecordDigest receipt', 400);
  }
  return { projectKey, mode, viewed: { checkpointId: viewed.checkpointId, commitRef: viewed.commitRef }, selector };
}

function adoptedChildSelector(invocationId: string, childTurnId: string, deliverySeq: string): RuntimeCheckpointAssetSelector {
  const deliverySequence = Number(deliverySeq);
  if (invocationId.trim() === '' || childTurnId.trim() === '' || !/^[1-9]\d*$/.test(deliverySeq)
    || !Number.isSafeInteger(deliverySequence)) {
    throw new UiRuntimeApiError('checkpoint-asset.selector-invalid', APP_OWNER,
      'adopted child selector needs a non-empty invocation and child turn and a positive delivery sequence',
      'send the exact committed invocation, child turn and delivery sequence', 400);
  }
  return { kind: 'adopted-child', invocationId, childTurnId, deliverySeq: deliverySequence };
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

function isConfirmedControlConflict(error: unknown): boolean {
  if (error instanceof ConfirmedControlExpectedConflict) return true;
  if (!(error instanceof CheckpointSubmissionError)) return false;
  if (error.cause instanceof ConfirmedControlExpectedConflict) return true;
  return error.cause instanceof AppLifecycleError
    && (error.cause.code === 'checkpoint-closure-conflict'
      || error.cause.code === 'checkpoint-current-control-conflict');
}

async function commitConfirmedControl<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isConfirmedControlConflict(error)) throw error;
    throw new UiRuntimeApiError(
      'confirmed-control.conflict',
      APP_OWNER,
      error instanceof Error ? error.message : String(error),
      'read the latest authoritative current facts and retry with a new command',
      409,
      undefined,
      error,
    );
  }
}

function sessionError(verification: SessionVerification | ProductPrincipalVerification): AccessControlError {
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

/**
 * True only for the two addresses that denote this machine. A serve process is
 * owned by the local operator, so asking that same operator to copy a pairing
 * code between two processes on one host adds a step without adding an
 * identity; loopback requests therefore adopt a local session instead.
 * Everything that is not loopback keeps the pairing requirement unchanged.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string' || address.length === 0) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalized === '127.0.0.1' || normalized === '::1';
}

interface ResolvedSession {
  readonly session: AccessSession;
  readonly adopted: boolean;
}

/**
 * Resolves the request session once for every authenticated route. A valid
 * cookie is used as-is. A loopback request that carries no session at all
 * adopts a fresh local session and writes its cookie on this response, so the
 * next request from the same browser carries it. An expired or invalid cookie
 * keeps its typed failure, so generation invalidation and expiry stay
 * observable; only the pairing step is dropped, and only for a local browser
 * that has no session yet.
 */
async function resolveSession(
  accessControl: AccessControlService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<ResolvedSession> {
  const cookie = request.headers.cookie;
  const verification = await accessControl.verifySession(Array.isArray(cookie) ? cookie[0] : cookie);
  if (verification.state === 'valid') return { session: verification.session, adopted: false };
  if (verification.state === 'missing' && isLoopbackAddress(request.socket.remoteAddress)) {
    const session = await accessControl.issueLocalSession();
    response.setHeader('set-cookie', accessControl.sessionCookie(session));
    return { session, adopted: true };
  }
  throw sessionError(verification);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (Array.isArray(header)) return undefined;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

function requireSupervisor(
  accessControl: AccessControlService,
  request: IncomingMessage,
  identity: UiRuntimeServerOptions['identity'],
): { readonly leaseId: string; readonly generation: number } {
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

function requireNonNegativeInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be a non-negative safe integer`, `provide a non-negative ${key}`);
  }
  return value as number;
}

function optionalTaskCapability(body: Record<string, unknown>): TaskControlCapabilityDeclaration | undefined {
  if (body.capability === undefined) return undefined;
  const capability = requireRecord(body, 'capability');
  return {
    actionId: requireString(capability, 'actionId'),
    capabilities: requireStringArray(capability, 'capabilities'),
  };
}

function requireStringArray(body: Record<string, unknown>, key: string): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, `request field ${key} must be a string array`, `provide ${key} as a string array`);
  }
  return value;
}

function requireJournalCommitRef(body: Record<string, unknown>, key: string): JournalCommitRef {
  const value = requireRecord(body, key);
  try {
    validateJournalCommitRef(value as unknown as JournalCommitRef);
  } catch (error) {
    throw new UiRuntimeApiError(
      'request.invalid-field',
      APP_OWNER,
      `request field ${key} is not a complete Journal commit receipt: ${error instanceof Error ? error.message : String(error)}`,
      `provide ${key} as { commitId, journalSeq, recordDigest }`,
      400,
      undefined,
      error,
    );
  }
  return value as unknown as JournalCommitRef;
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

/**
 * Parse the exact selected task target for an existing-task-change. The public
 * boundary only validates the typed shape; the runtime confirmation ledger
 * remains the owner that rejects a target that does not match the confirmed
 * draft revision.
 */
function optionalTaskRef(body: Record<string, unknown>): TaskId | undefined {
  const value = body.taskRef;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field taskRef must be a task scope reference', 'provide taskRef as { scope: "task", value }');
  }
  const ref = value as Record<string, unknown>;
  if (ref.scope !== 'task' || typeof ref.value !== 'string' || !ref.value.trim()) {
    throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field taskRef must name a non-empty task', 'provide taskRef as { scope: "task", value }');
  }
  return id('task', ref.value.trim());
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

export interface UiRuntimeRequestDispatcher {
  readonly listener: (request: IncomingMessage, response: ServerResponse) => void;
  readonly sseRegistry: ReturnType<typeof createSseRegistry>;
}

/**
 * Builds the exact request listener the TCP server uses, so callers can drive
 * the real routes without binding a socket. `startUiRuntimeServer` owns the
 * listener lifecycle through `isClosing`.
 */
export function createUiRuntimeRequestDispatcher(options: {
  readonly service: UiRuntimeService;
  readonly accessControl: AccessControlService;
  readonly productRoot: string;
  readonly uiRoot: string;
  readonly isClosing: () => boolean;
  readonly taskControl?: UiRuntimeServerOptions['taskControl'];
  readonly displayPreference?: UiRuntimeServerOptions['displayPreference'];
  readonly restart?: UiRuntimeServerOptions['restart'];
  readonly identity?: UiRuntimeServerOptions['identity'];
  readonly schedulerStatus?: UiRuntimeServerOptions['schedulerStatus'];
}): UiRuntimeRequestDispatcher {
  const sseRegistry = createSseRegistry();
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(
      request,
      response,
      options.service,
      options.accessControl,
      options.productRoot,
      sseRegistry,
      options.isClosing,
      options.uiRoot,
      options.taskControl,
      options.restart,
      options.identity,
      options.schedulerStatus,
      options.displayPreference,
    ).catch((error) => {
      writeError(response, error);
    });
  };
  return { listener, sseRegistry };
}

export async function startUiRuntimeServer(options: UiRuntimeServerOptions): Promise<UiRuntimeServer> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '0.0.0.0' && host !== '::' && host !== '127.0.0.1' && host !== '::1') {
    throw new UiRuntimeApiError('ui-server.host.forbidden', APP_OWNER, 'ui runtime server host must be 0.0.0.0, ::, 127.0.0.1, or ::1', 'choose a supported listener wildcard or loopback host');
  }
  const service = options.service;
  const accessControl = options.accessControl;
  let closing = false;
  const { listener, sseRegistry } = createUiRuntimeRequestDispatcher({
    service,
    accessControl,
    productRoot: options.productRoot,
    uiRoot: options.uiRoot,
    isClosing: () => closing,
    ...(options.taskControl === undefined ? {} : { taskControl: options.taskControl }),
    ...(options.displayPreference === undefined ? {} : { displayPreference: options.displayPreference }),
    ...(options.restart === undefined ? {} : { restart: options.restart }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.schedulerStatus === undefined ? {} : { schedulerStatus: options.schedulerStatus }),
  });
  accessControl.startCredentialWatch(
    () => sseRegistry.revalidateNow(accessControl).then(() => undefined),
    async (error) => {
      await sseRegistry.closeAll('auth.unavailable');
      throw error;
    },
  );
  let closeReceipt: ListenerShutdownReceipt | undefined;
  let closePromise: Promise<ListenerShutdownReceipt> | undefined;
  const server = createServer(listener);
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
  productRoot: string,
  sseRegistry: ReturnType<typeof createSseRegistry>,
  isClosing: () => boolean,
  uiRoot: string,
  taskControl?: UiTaskGrantControl,
  restart?: UiRuntimeServerOptions['restart'],
  identity?: UiRuntimeServerOptions['identity'],
  schedulerStatus?: UiRuntimeServerOptions['schedulerStatus'],
  displayPreference?: UiRuntimeServerOptions['displayPreference'],
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
      const pairingCommand = formatPairingCommand({
        controlRoot: productRoot,
      });
      if (verification.state === 'valid') {
        writeJson(response, 200, { authenticated: true, expiresAt: new Date(verification.session.expiresAt).toISOString(), pairingCommand });
        return;
      }
      if (
        (verification.state === 'missing' || verification.state === 'expired')
        && isLoopbackAddress(request.socket.remoteAddress)
      ) {
        const session = await accessControl.issueLocalSession();
        writeJson(response, 200, {
          authenticated: true,
          expiresAt: new Date(session.expiresAt).toISOString(),
          pairingCommand,
          localAccess: true,
        }, { 'set-cookie': accessControl.sessionCookie(session) });
        return;
      }
      writeJson(response, 200, { authenticated: false, pairingCommand });
      return;
    }
    if (path === '/api/auth/pair' && method === 'POST') {
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
          nextAction: 'send an authenticated POST request',
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
      const challenge = await accessControl.issuePairingChallenge();
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
      await resolveSession(accessControl, request, response);
      if (path === '/api/executions/' || path.startsWith('/api/executions/')) {
        if (isClosing()) {
          throw new UiRuntimeApiError('ui-server.closing', APP_OWNER, 'runtime listener is shutting down', 'reconnect after the service is ready', 503);
        }
      }
    }
    // The existing client task-grant control paths. The common /api/ guard has
    // already verified the session; the product principal owner comes from the
    // same persisted credential and the client never supplies it.
    const taskGrantControl = /^\/api\/tasks\/([^/]+)\/control\/grant$/.exec(path);
    const taskRevokeControl = /^\/api\/tasks\/([^/]+)\/control\/revoke$/.exec(path);
    if (taskGrantControl || taskRevokeControl) {
      if (taskControl === undefined) {
        throw new UiRuntimeApiError(
          'task-control.source.unavailable',
          APP_OWNER,
          'this runtime was started without task-scoped grant control',
          'start the runtime through startUiRuntime',
          503,
        );
      }
      // The common /api/ guard already resolved the request session, including
      // a loopback local adoption, so the product principal owner is the stable
      // credential owner for this control root.
      const principalOwner = accessControl.readProductPrincipalOwner();
      const taskId = id('task', decodeURIComponent((taskGrantControl ?? taskRevokeControl)![1]!));
      const scope = optionalTaskControlScope(url);
      const targetScope = scope === undefined
        ? undefined
        : await service.verifyControllableTaskTarget(taskId, scope.projectKey, scope.mode);
      if (taskGrantControl && method === 'GET') {
        const receipt = await taskControl.read(taskId, principalOwner);
        writeJson(response, 200, targetScope === undefined ? receipt : { ...receipt, targetScope });
        return;
      }
      if ((taskGrantControl && method === 'POST') || (taskRevokeControl && method === 'POST')) {
        const body = await readBody(request);
        const input = {
          requestId: requireString(body, 'requestId'),
          taskId,
          principalOwner,
          expectedRevision: requireNonNegativeInteger(body, 'expectedRevision'),
          ...(taskGrantControl && body.capability !== undefined
            ? { capability: optionalTaskCapability(body) }
            : {}),
        };
        if (taskGrantControl) {
          const receipt = await taskControl.grant(input);
          const execution = await service.releaseGrantedTaskExecution(taskId);
          writeJson(response, 200, { ...receipt, execution, ...(targetScope === undefined ? {} : { targetScope }) });
        } else {
          const receipt = await taskControl.revoke(input);
          writeJson(response, 200, targetScope === undefined ? receipt : { ...receipt, targetScope });
        }
        return;
      }
    }
    const taskContextCorrection = /^\/api\/tasks\/([^/]+)\/control\/context-correction$/.exec(path);
    const taskCheckpointReentry = /^\/api\/tasks\/([^/]+)\/control\/checkpoint-reentry$/.exec(path);
    if ((taskContextCorrection || taskCheckpointReentry) && method === 'POST') {
      const taskId = id('task', decodeURIComponent((taskContextCorrection ?? taskCheckpointReentry)![1]!));
      const { projectKey, mode } = requireTaskControlScope(url);
      const taskScope = await service.resolveConfirmedTaskControlScope(taskId, projectKey, mode);
      const body = await readBody(request);
      const commandId = requireString(body, 'commandId');
      const confirmationRef = requireString(body, 'confirmationRef');
      if (taskContextCorrection) {
        const wrongRefs = requireStringArray(body, 'wrongRefs');
        if (wrongRefs.length === 0 || wrongRefs.some((ref) => ref.trim() === '')) {
          throw new UiRuntimeApiError(
            'request.invalid-field',
            APP_OWNER,
            'request field wrongRefs must contain at least one exact non-empty business ref',
            'provide wrongRefs as exact committed Context business refs',
            400,
          );
        }
        const receipt = await commitConfirmedControl(() => service.executeConfirmedTaskContextCorrection({
          taskScope,
          commandId,
          wrongRefs: wrongRefs.map((ref) => ({ taskScope, ref })),
          repairText: requireString(body, 'repairText'),
          confirmationRef,
          ...(body.sourceCheckpointReceipt === undefined
            ? {}
            : { sourceCheckpointReceipt: requireJournalCommitRef(body, 'sourceCheckpointReceipt') }),
          ...(body.expectedControlReceipt === undefined
            ? {}
            : { expectedControlReceipt: requireJournalCommitRef(body, 'expectedControlReceipt') }),
        }));
        writeJson(response, 200, receipt);
        return;
      }
      const receipt = await commitConfirmedControl(() => service.executeConfirmedTaskCheckpointReentry({
        taskScope,
        commandId,
        targetCheckpointCommitRef: requireJournalCommitRef(body, 'targetCheckpointCommitRef'),
        confirmationRef,
        ...(body.expectedCurrentControlCommitRef === undefined
          ? {}
          : { expectedCurrentControlCommitRef: requireJournalCommitRef(body, 'expectedCurrentControlCommitRef') }),
      }));
      writeJson(response, 200, receipt);
      return;
    }
    // The single public display-preference resource, reached only after the
    // authenticated boundary above. It is Config-backed and writes only the
    // user's display preference; it never touches task or control Journal state.
    if (
      path === UI_DISPLAY_PREFERENCE_ROUTE
      && (method === 'GET' || method === 'PUT' || method === 'DELETE')
    ) {
      if (displayPreference === undefined) {
        throw new UiRuntimeApiError(
          'display-preference.unsupported',
          APP_OWNER,
          'this runtime was started without a Config-backed display preference resource',
          'start the runtime through the supervisor-owned serve entry that assembles Config paths',
          501,
        );
      }
      const body = method === 'PUT' ? await readBody(request) : undefined;
      writeJson(response, 200, await displayPreference.handle(method, body));
      return;
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
      const scope = url.searchParams.get('scope');
      if (scope === null) {
        writeJson(response, 200, await service.dashboardWithIdentitySource());
        return;
      }
      if (scope === 'system') {
        writeJson(response, 200, await service.systemRead());
        return;
      }
      if (scope === 'project') {
        const projectKey = url.searchParams.get('projectKey')?.trim();
        if (!projectKey) {
          throw new UiRuntimeApiError(
            'read.scope.invalid',
            APP_OWNER,
            'project scope requires a non-empty projectKey',
            'send scope=project&projectKey=<declared projectKey>',
            400,
          );
        }
        writeReadResult(response, await service.projectRead(projectKey));
        return;
      }
      throw new UiRuntimeApiError(
        'read.scope.invalid',
        APP_OWNER,
        `unsupported dashboard scope: ${scope}`,
        'send scope=system or scope=project&projectKey=<declared projectKey>',
        400,
      );
    }
    if (path === '/api/product/board' && method === 'GET') {
      const scope = requireBoundProductBoardScope(url, service);
      writeJson(response, 200, await readProduct(() => service.productBoardIndex(scope)));
      return;
    }
    if (path === '/api/product/session' && method === 'GET') {
      const scope = requireBoundProductSessionScope(url, service);
      writeJson(response, 200, await readProduct(() => service.productSessionRead(scope)));
      return;
    }
    if (path === '/api/product/relations' && method === 'GET') {
      const scope = requireBoundProductBoardScope(url, service);
      writeJson(response, 200, await readProduct(() => service.productRelations(scope)));
      return;
    }
    if (path === '/api/product/decision' && method === 'GET') {
      const scope = requireBoundProductBoardScope(url, service);
      writeJson(response, 200, await readProduct(() => service.productPendingDecision(scope)));
      return;
    }
    if (path === '/api/product/output' && method === 'GET') {
      const taskId = url.searchParams.get('taskId')?.trim();
      if (!taskId) {
        throw new UiRuntimeApiError(
          'read.scope.invalid',
          APP_OWNER,
          'product output requires a non-empty taskId',
          'send taskId=<task-id>',
          400,
        );
      }
      writeJson(response, 200, await readProduct(() => service.productPublicOutput(id('task', taskId))));
      return;
    }
    if (path === '/api/tasks' && method === 'GET') {
      writeJson(response, 200, await service.listTasksWithIdentitySource());
      return;
    }
    if (path === '/api/tasks' && method === 'POST') {
      const body = await readBody(request);
      // Submitting the new-task entry is the human's confirmation for this Task,
      // so the confirmed identity is bound with the create instead of leaving the
      // closed-turn Planner without the source it requires.
      const created = await service.createTaskWithConfirmedIdentity({
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
      const occurredAt = optionalString(body, 'occurredAt') ?? new Date().toISOString();
      const interactionId = await service.receiveExplicitInput({
        sourceRef: requireString(body, 'sourceRef'),
        rawInput: requireString(body, 'rawInput'),
        channel,
        actor: {
          kind: 'human',
          sourceKind: 'product-principal',
          sourceRef: accessControl.readProductPrincipalOwner(),
        },
        occurredAt,
        ...(requestKind === undefined ? {} : { requestKind }),
        ...(body.workspace === undefined ? {} : { workspaceRequest: requireString(body, 'workspace') }),
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
    const explicitProviderSettlement =
      /^\/api\/explicit\/interactions\/([^/]+)\/control\/provider-settlement$/.exec(path);
    if (explicitProviderSettlement && method === 'GET') {
      writeJson(response, 200, await service.readExplicitProviderSettlement({
        interactionId: decodeURIComponent(explicitProviderSettlement[1]!),
        inputRevision: requirePositiveInteger(
          { inputRevision: Number(url.searchParams.get('inputRevision')) },
          'inputRevision',
        ),
        turnId: requireString(
          { turnId: url.searchParams.get('turnId') ?? '' },
          'turnId',
        ),
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
      const requestKind = optionalInteractionRequestKind(body);
      if (requestKind !== undefined && requestKind !== 'new-task-create' && requestKind !== 'existing-task-change') {
        throw new UiRuntimeApiError('request.invalid-field', APP_OWNER, 'request field requestKind must be new-task-create or existing-task-change', 'provide a final-submit request kind');
      }
      const taskRef = optionalTaskRef(body);
      const receipt = await service.confirmExplicitRequirement({
        interactionId: decodeURIComponent(explicitConfirmation[1]!),
        draftId: requireString(body, 'draftId'),
        inputRevision: requirePositiveInteger(body, 'inputRevision'),
        confirmationRef: requireString(body, 'confirmationRef'),
        confirmedBy: requireString(body, 'confirmedBy'),
        confirmedAt: requireString(body, 'confirmedAt'),
        payloadRef: requireString(body, 'payloadRef'),
        ...(requestKind === undefined ? {} : { requestKind }),
        ...(taskRef === undefined ? {} : { taskRef }),
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
        ...(dispatched.operationId === undefined ? {} : { operationId: dispatched.operationId.value }),
      });
      return;
    }
    const taskDashboard = /^\/api\/tasks\/([^/]+)\/dashboard$/.exec(path);
    if (taskDashboard && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskDashboard[1]!));
      const agentSelection = decodeTaskAgentActivitySelectionQuery(url.searchParams, taskId);
      const projectKey = url.searchParams.get('projectKey');
      const mode = url.searchParams.get('mode');
      if (projectKey !== null || mode !== null) {
        if (!projectKey || !mode) {
          throw new UiRuntimeApiError(
            'read.scope.invalid',
            APP_OWNER,
            'scoped task dashboard requires both projectKey and mode',
            'send projectKey=<declared projectKey>&mode=fake|rcc',
            400,
          );
        }
        if (mode !== 'fake' && mode !== 'rcc') {
          throw new UiRuntimeApiError(
            'read.scope.invalid',
            APP_OWNER,
            `unsupported task read mode: ${mode}`,
            'send mode=fake or mode=rcc',
            400,
          );
        }
        writeReadResult(response, await service.scopedTaskDashboard(taskId, projectKey, mode, agentSelection));
        return;
      }
      writeJson(response, 200, await service.taskDashboardWithPlan(taskId, agentSelection));
      return;
    }
    const taskRecords = /^\/api\/tasks\/([^/]+)\/records$/.exec(path);
    if (taskRecords && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskRecords[1]!));
      const projectKey = url.searchParams.get('projectKey')?.trim();
      const mode = url.searchParams.get('mode');
      const view = url.searchParams.get('view');
      if (!projectKey || !mode) {
        throw new UiRuntimeApiError(
          'read.scope.invalid',
          APP_OWNER,
          'scoped task records require both projectKey and mode',
          'send projectKey=<declared projectKey>&mode=fake|rcc&view=actions|raw',
          400,
        );
      }
      if (mode !== 'fake' && mode !== 'rcc') {
        throw new UiRuntimeApiError(
          'read.scope.invalid',
          APP_OWNER,
          `unsupported task read mode: ${mode}`,
          'send mode=fake or mode=rcc',
          400,
        );
      }
      if (view !== 'actions' && view !== 'raw') {
        throw new UiRuntimeApiError(
          'records.view.invalid',
          APP_OWNER,
          'records view must be actions or raw',
          'send view=actions or view=raw',
          400,
        );
      }
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam === null ? 20 : Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new UiRuntimeApiError(
          'records.limit.invalid',
          APP_OWNER,
          'records limit must be an integer from 1 to 500',
          'send a valid records limit',
          400,
        );
      }
      const cursor = url.searchParams.get('cursor') ?? undefined;
      writeReadResult(response, await service.taskRecords(taskId, {
        projectKey,
        mode,
        view,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }));
      return;
    }
    const taskContextHistory = /^\/api\/tasks\/([^/]+)\/context-history$/.exec(path);
    if (taskContextHistory && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskContextHistory[1]!));
      const { projectKey, mode } = requireReadScope(url);
      const limit = requireHistoryLimit(url, 'context-history');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const agentRuntimeId = url.searchParams.get('agentRuntimeId') ?? undefined;
      const contextViewRef = url.searchParams.get('contextViewRef') ?? undefined;
      writeReadResult(response, await service.taskContextHistory(taskId, {
        projectKey,
        mode,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(agentRuntimeId === undefined ? {} : { agentRuntimeId }),
        ...(contextViewRef === undefined ? {} : { contextViewRef }),
      }));
      return;
    }
    const taskCheckpoints = /^\/api\/tasks\/([^/]+)\/checkpoints$/.exec(path);
    if (taskCheckpoints && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskCheckpoints[1]!));
      const { projectKey, mode } = requireReadScope(url);
      const limit = requireHistoryLimit(url, 'checkpoints');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const viewed = checkpointViewedTarget(url);
      const directiveRevision = optionalIntegerParam(url, 'directiveRevision', 'checkpoints.directiveRevision.invalid');
      const executionEpoch = optionalIntegerParam(url, 'executionEpoch', 'checkpoints.executionEpoch.invalid');
      const cycleIdParam = url.searchParams.get('cycleId')?.trim();
      const cycleId = cycleIdParam ? id('cycle', cycleIdParam) : undefined;
      const occurrenceRef = url.searchParams.get('occurrenceRef') ?? undefined;
      writeReadResult(response, await service.taskCheckpointHistory(taskId, {
        projectKey,
        mode,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(viewed === undefined ? {} : { viewed }),
        ...(directiveRevision === undefined ? {} : { directiveRevision }),
        ...(executionEpoch === undefined ? {} : { executionEpoch }),
        ...(cycleId === undefined ? {} : { cycleId }),
        ...(occurrenceRef === undefined ? {} : { occurrenceRef }),
      }));
      return;
    }
    // Read-only checkpoint asset bodies. These routes read the exact committed
    // asset named by the canonical checkpoint; they never serve a file path,
    // commit, publish, retry or steer.
    const taskCheckpointCaptureBody = /^\/api\/tasks\/([^/]+)\/checkpoints\/assets\/capture$/.exec(path);
    if (taskCheckpointCaptureBody && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskCheckpointCaptureBody[1]!));
      writeReadResult(response, await service.taskCheckpointAssetBody(taskId,
        checkpointAssetBodyQuery(url, { kind: 'capture' })));
      return;
    }
    const taskCheckpointAdoptedChildBody =
      /^\/api\/tasks\/([^/]+)\/checkpoints\/assets\/adopted-child\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (taskCheckpointAdoptedChildBody && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskCheckpointAdoptedChildBody[1]!));
      const selector = adoptedChildSelector(decodeURIComponent(taskCheckpointAdoptedChildBody[2]!),
        decodeURIComponent(taskCheckpointAdoptedChildBody[3]!), decodeURIComponent(taskCheckpointAdoptedChildBody[4]!));
      writeReadResult(response, await service.taskCheckpointAssetBody(taskId,
        checkpointAssetBodyQuery(url, selector)));
      return;
    }
    // I2 read-only history. These routes never invoke execution, modify the
    // queue, publish, retry or steer; they only read committed I2 authority.
    const taskInspectionComparison = /^\/api\/tasks\/([^/]+)\/inspection-comparison$/.exec(path);
    if (taskInspectionComparison && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskInspectionComparison[1]!));
      const readScope = optionalI2ReadScope(url);
      const left = url.searchParams.get('left')?.trim();
      const right = url.searchParams.get('right')?.trim();
      if (!left || !right) {
        throw new UiRuntimeApiError(
          'i2.comparison.scope.invalid',
          APP_OWNER,
          'inspection comparison requires left and right occurrence ids',
          'send left=<occurrenceId>&right=<occurrenceId>',
          400,
        );
      }
      writeReadResult(response, await service.taskInspectionComparison(taskId, left, right, readScope));
      return;
    }
    const taskInspectionOccurrence = /^\/api\/tasks\/([^/]+)\/inspection-occurrences\/([^/]+)$/.exec(path);
    if (taskInspectionOccurrence && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskInspectionOccurrence[1]!));
      const occurrenceId = decodeURIComponent(taskInspectionOccurrence[2]!);
      writeReadResult(response, await service.taskInspectionOccurrence(taskId, occurrenceId, optionalI2ReadScope(url)));
      return;
    }
    const taskInspectionOccurrences = /^\/api\/tasks\/([^/]+)\/inspection-occurrences$/.exec(path);
    if (taskInspectionOccurrences && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskInspectionOccurrences[1]!));
      const readScope = optionalI2ReadScope(url);
      const limit = requireHistoryLimit(url, 'i2-history');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const viewed = url.searchParams.get('viewed')?.trim() || undefined;
      writeReadResult(response, await service.taskInspectionOccurrences(taskId, {
        ...(readScope === undefined ? {} : readScope),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(viewed === undefined ? {} : { viewed }),
      }));
      return;
    }
    const taskBusinessCycle = /^\/api\/tasks\/([^/]+)\/cycles\/([^/]+)$/.exec(path);
    if (taskBusinessCycle && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskBusinessCycle[1]!));
      const cycleId = decodeURIComponent(taskBusinessCycle[2]!);
      writeReadResult(response, await service.taskBusinessCycle(taskId, cycleId, optionalI2ReadScope(url)));
      return;
    }
    const taskBusinessCycles = /^\/api\/tasks\/([^/]+)\/cycles$/.exec(path);
    if (taskBusinessCycles && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskBusinessCycles[1]!));
      const readScope = optionalI2ReadScope(url);
      const limit = requireHistoryLimit(url, 'i2-history');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const viewed = url.searchParams.get('viewed')?.trim() || undefined;
      writeReadResult(response, await service.taskBusinessCycles(taskId, {
        ...(readScope === undefined ? {} : readScope),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(viewed === undefined ? {} : { viewed }),
      }));
      return;
    }
    const taskReviews = /^\/api\/tasks\/([^/]+)\/reviews$/.exec(path);
    if (taskReviews && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskReviews[1]!));
      const readScope = optionalI2ReadScope(url);
      const limit = requireHistoryLimit(url, 'i2-history');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const cycleId = url.searchParams.get('cycleId')?.trim() || undefined;
      const milestoneId = url.searchParams.get('milestoneId')?.trim() || undefined;
      writeReadResult(response, await service.taskMilestoneReviews(taskId, {
        ...(readScope === undefined ? {} : readScope),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(cycleId === undefined ? {} : { cycleId }),
        ...(milestoneId === undefined ? {} : { milestoneId }),
      }));
      return;
    }
    const taskPlanHistory = /^\/api\/tasks\/([^/]+)\/task-plan-history$/.exec(path);
    if (taskPlanHistory && method === 'GET') {
      const { projectKey, mode } = requireReadScope(url);
      writeReadResult(response, await service.taskPlanHistory(id('task', decodeURIComponent(taskPlanHistory[1]!)), projectKey, mode));
      return;
    }
    const taskObservation = /^\/api\/tasks\/([^/]+)\/observation$/.exec(path);
    if (taskObservation && method === 'GET') {
      const taskId = id('task', decodeURIComponent(taskObservation[1]!));
      const selected = url.searchParams.get('node') ?? undefined;
      const scope = url.searchParams.get('scope') ?? undefined;
      const readScope = optionalI2ReadScope(url);
      const agentSelection = decodeTaskAgentActivitySelectionQuery(url.searchParams, taskId);
      writeJson(response, 200, await service.scopedObservation(
        taskId,
        selected,
        scope,
        readScope?.projectKey,
        readScope?.mode,
        agentSelection,
      ));
      return;
    }
    const taskSemantic = /^\/api\/tasks\/([^/]+)\/semantic$/.exec(path);
    if (taskSemantic && method === 'GET') {
      const readScope = optionalI2ReadScope(url);
      writeJson(response, 200, await service.scopedSemanticObservation(
        id('task', decodeURIComponent(taskSemantic[1]!)),
        readScope?.projectKey,
        readScope?.mode,
      ));
      return;
    }
    const taskSemanticStream = /^\/api\/tasks\/([^/]+)\/semantic\/stream$/.exec(path);
    if (taskSemanticStream && method === 'GET') {
      const { session } = await resolveSession(accessControl, request, response);
      const taskId = id('task', decodeURIComponent(taskSemanticStream[1]!));
      const readScope = optionalI2ReadScope(url);
      const initial = await service.scopedSemanticObservation(taskId, readScope?.projectKey, readScope?.mode);
      if (!service.isBoundReadScope(readScope?.projectKey, readScope?.mode)) {
        streamFiniteSemanticObservation(response, initial);
        return;
      }
      streamSemanticObservation(request, response, service, taskId, session, accessControl, sseRegistry);
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
      const started = await service.startExecution(id('task', decodeURIComponent(taskExecutions[1]!)), { prompt: requirePrompt(body) });
      writeJson(response, 202, { operationId: started.operationId.value, executionEpoch: started.executionEpoch });
      return;
    }
    // Public cold resume: the caller selects only the retained operation. Every
    // business identity, source and control fact comes from the bound owner, so
    // the body accepts exactly one field. The common /api/ guard already
    // verified the session; Runtime retains the task-scoped grant decision.
    const taskResume = /^\/api\/tasks\/([^/]+)\/resume$/.exec(path);
    if (taskResume && method === 'POST') {
      const body = await readBody(request);
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'operationId') {
        throw new UiRuntimeApiError(
          'execution.resume.invalid-request',
          APP_OWNER,
          'resume request body must contain only operationId',
          'send { "operationId": "<operation-id>" }',
          400,
        );
      }
      const operationId = id('operation', requireString(body, 'operationId'));
      const resumed = await service.resumeExecution(
        id('task', decodeURIComponent(taskResume[1]!)),
        { operationId },
      );
      writeJson(response, 202, resumed);
      return;
    }
    const taskStop = /^\/api\/tasks\/([^/]+)\/stop$/.exec(path);
    if (taskStop && method === 'POST') {
      const taskId = id('task', decodeURIComponent(taskStop[1]!));
      const scope = optionalTaskControlScope(url);
      const targetScope = scope === undefined
        ? undefined
        : await service.verifyControllableTaskTarget(taskId, scope.projectKey, scope.mode);
      const result = await service.stop(taskId);
      writeJson(response, 202, {
        ...result,
        principalOwner: accessControl.readProductPrincipalOwner(),
        ...(targetScope === undefined ? {} : { targetScope }),
      });
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
      const { session } = await resolveSession(accessControl, request, response);
      if (isClosing()) {
        throw new UiRuntimeApiError('ui-server.closing', APP_OWNER, 'runtime listener is shutting down', 'reconnect after the service is ready', 503);
      }
      streamEvents(request, response, service, operationId, session, accessControl, sseRegistry);
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

function streamSemanticObservation(
  request: IncomingMessage,
  response: ServerResponse,
  service: UiRuntimeService,
  taskId: TaskId,
  session: AccessSession,
  accessControl: AccessControlService,
  registry: ReturnType<typeof createSseRegistry>,
): void {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let eventWrites = Promise.resolve();
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  let entry: ActiveSse;
  const closeStream = (reason: SseCloseReason): Promise<void> => {
    if (closed) return ended;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
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
  entry = { response, session, close: closeStream };
  registry.add(entry);
  const validateStreamSession = async (): Promise<void> => {
    let currentGeneration: number;
    try {
      currentGeneration = await accessControl.readPersistedGeneration();
    } catch {
      await closeStream('auth.unavailable');
      return;
    }
    if (session.sessionGeneration !== currentGeneration || accessControl.isExpired(session)) {
      await closeStream('auth.invalidated');
    }
  };
  registry.scheduleAuthRevalidation(accessControl);
  try {
    const writeCurrent = () => {
      if (closed) return;
      eventWrites = eventWrites.then(async () => {
        if (closed) return;
        try {
          await validateStreamSession();
          if (closed) return;
          const semantic = service.semanticObservation(taskId);
          const terminal = observedOperationIsTerminal(semantic);
          response.write(`id: semantic-${semantic.sourceWatermark}\n`);
          response.write('event: semantic.observation\n');
          response.write(`data: ${JSON.stringify(semantic)}\n\n`);
          if (terminal) await closeStream('terminal');
        } catch {
          await closeStream('write-failure');
        }
      });
    };
    writeCurrent();
    heartbeat = setInterval(writeCurrent, 250);
  } catch (error) {
    void closeStream('write-failure');
    throw error;
  }
  response.once('close', () => {
    void closeStream('client');
  });
}

function streamFiniteSemanticObservation(
  response: ServerResponse,
  semantic: ReturnType<UiRuntimeService['semanticObservation']>,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  response.write(`id: semantic-${semantic.sourceWatermark}\n`);
  response.write('event: semantic.observation\n');
  response.write(`data: ${JSON.stringify(semantic)}\n\n`);
  response.write('event: semantic-complete\n');
  response.write('data: {}\n\n');
  response.end();
}

/**
 * A semantic stream is terminal only for the operation it currently observes.
 * Retained history can contain earlier closed operations, so the terminal
 * event and the closed operation group must both name the observed operation.
 */
function observedOperationIsTerminal(
  semantic: ReturnType<UiRuntimeService['semanticObservation']>,
): boolean {
  const observedOperationId = semantic.scope.operationId?.value;
  if (observedOperationId === undefined) return false;
  const terminalEventIds = new Set(
    semantic.events
      .filter((event) => event.scope.operationId?.value === observedOperationId
        && (event.type === 'operation.completed' || event.type === 'operation.failed'))
      .map((event) => event.eventId),
  );
  if (terminalEventIds.size === 0) return false;
  return semantic.pairing.some((group) => group.kind === 'operation'
    && group.scope.operationId?.value === observedOperationId
    && group.state === 'closed'
    && group.eventRefs.some((ref) => terminalEventIds.has(ref.eventId)));
}

export function taskIdFromParam(value: string): TaskId {
  return id('task', decodeURIComponent(value));
}
