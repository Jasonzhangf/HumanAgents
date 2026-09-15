import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimePaths } from '../../config/src/index.js';
import type { OperationId, ScopeRef, TaskId } from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.run-manifest';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * HumanAgent-owned identity for one session's agent operation. DSH session logs
 * never carry this identity; the app reads it back on resume instead of
 * reconstructing it from an adapter or guessing.
 */
export interface RunManifest {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly agentId: string;
  readonly driverRef: 'fake' | 'dsh';
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly directiveRevision: number;
  readonly cycleId: { readonly scope: 'cycle'; readonly value: string };
  readonly scope: ScopeRef;
}

function corrupt(message: string): never {
  throw new AppLifecycleError(
    'run-manifest-corrupt',
    message,
    'inspect and repair the run manifest',
    OWNER,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScopedId(value: unknown, scope: 'organ' | 'task' | 'cycle' | 'operation'): boolean {
  return isRecord(value)
    && value.scope === scope
    && typeof value.value === 'string'
    && ID_PATTERN.test(value.value);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateRunManifest(value: unknown, expectedSessionId: string): RunManifest {
  if (!isRecord(value)) return corrupt('run manifest is not an object');
  if (value.schemaVersion !== 1) return corrupt('run manifest schema version is invalid');
  if (value.sessionId !== expectedSessionId) return corrupt('run manifest session identity does not match its file');
  if (typeof value.agentId !== 'string' || !ID_PATTERN.test(value.agentId)) return corrupt('run manifest agent identity is invalid');
  if (value.driverRef !== 'fake' && value.driverRef !== 'dsh') return corrupt('run manifest driver is invalid');
  if (typeof value.runtimeId !== 'string' || !ID_PATTERN.test(value.runtimeId)) {
    return corrupt('run manifest runtime identity is invalid');
  }
  if (!positiveSafeInteger(value.executionEpoch)) return corrupt('run manifest execution epoch is invalid');
  if (!positiveSafeInteger(value.directiveRevision)) return corrupt('run manifest directive revision is invalid');
  if (!isScopedId(value.taskId, 'task')) return corrupt('run manifest task identity is invalid');
  if (!isScopedId(value.operationId, 'operation')) return corrupt('run manifest operation identity is invalid');
  if (!isScopedId(value.cycleId, 'cycle')) return corrupt('run manifest cycle identity is invalid');
  const taskId = value.taskId as { readonly scope: 'task'; readonly value: string };
  const operationId = value.operationId as { readonly scope: 'operation'; readonly value: string };
  const cycleId = value.cycleId as { readonly scope: 'cycle'; readonly value: string };
  if (cycleId.value !== `${expectedSessionId}-cycle-${value.executionEpoch}`) {
    return corrupt('run manifest cycle identity is not derived from its session and epoch');
  }
  if (!isRecord(value.scope) || !isScopedId(value.scope.organId, 'organ')) {
    return corrupt('run manifest scope is invalid');
  }
  const scope = value.scope;
  if (!isScopedId(value.scope.taskId, 'task')
    || !isScopedId(scope.cycleId, 'cycle')
    || !isScopedId(scope.operationId, 'operation')) {
    return corrupt('run manifest scope does not match its task, cycle, and operation identities');
  }
  const scopedTaskId = scope.taskId as { readonly value: string };
  const scopedCycleId = scope.cycleId as { readonly value: string };
  const scopedOperationId = scope.operationId as { readonly value: string };
  if (scopedTaskId.value !== taskId.value
    || scopedCycleId.value !== cycleId.value
    || scopedOperationId.value !== operationId.value) {
    return corrupt('run manifest scope does not match its task, cycle, and operation identities');
  }
  return value as unknown as RunManifest;
}

function manifestPath(paths: RuntimePaths, sessionId: string): string {
  if (!ID_PATTERN.test(sessionId)) {
    throw new AppLifecycleError('run-manifest-invalid', 'invalid session id for run manifest', 'use an alphanumeric session id', OWNER);
  }
  return join(paths.runNotesRoot, `${sessionId}.manifest.json`);
}

export async function writeRunManifest(paths: RuntimePaths, manifest: RunManifest): Promise<void> {
  const checked = validateRunManifest(manifest, manifest.sessionId);
  const file = manifestPath(paths, manifest.sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(checked, null, 2) + '\n', 'utf8');
}

export async function readRunManifest(paths: RuntimePaths, sessionId: string): Promise<RunManifest> {
  const file = manifestPath(paths, sessionId);
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new AppLifecycleError(
        'run-manifest-missing',
        'session has no HumanAgent run manifest',
        'run the session before resuming it',
        OWNER,
      );
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new AppLifecycleError('run-manifest-corrupt', 'run manifest is not valid JSON', 'inspect and repair the run manifest', OWNER);
  }
  return validateRunManifest(value, sessionId);
}
