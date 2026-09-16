import { mkdir, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { RuntimePaths } from '../../../config/src/index.js';
import { AppLifecycleError } from '../errors.js';

const LEASE_SCHEMA_VERSION = 1 as const;

export interface SupervisorFailureRecord {
  readonly phase: string;
  readonly ownerId: string;
  readonly errorCode: string;
  readonly nextAction: string;
  readonly message: string;
  readonly occurredAt: string;
  readonly cleanupFailure?: SupervisorCleanupFailure;
}

export interface SupervisorCleanupFailure {
  readonly ownerId: string;
  readonly message: string;
}

export interface SupervisorTakeoverRecord {
  readonly previousLeaseId: string;
  readonly previousGeneration: number;
  readonly reason: string;
  readonly detectedAt: string;
}

export interface SupervisorLeaseRecord {
  readonly schemaVersion: typeof LEASE_SCHEMA_VERSION;
  readonly leaseId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly pid: number;
  readonly processStartToken: string;
  readonly acquiredAt: string;
  readonly readyAt?: string;
  readonly disposedAt?: string;
  readonly takeover?: SupervisorTakeoverRecord;
  readonly failure?: SupervisorFailureRecord;
}

export interface SupervisorFailureReceipt extends SupervisorFailureRecord {
  readonly startedStages: readonly string[];
  readonly disposedStages: readonly string[];
  readonly originalError?: unknown;
}

export interface SupervisorDisposeReceipt {
  readonly lease: SupervisorLeaseRecord;
  readonly disposedStages: readonly string[];
  readonly releasedAt: string;
  readonly cleanupFailure?: SupervisorCleanupFailure;
}

export interface SupervisorLease {
  readonly paths: RuntimePaths;
  readonly record: SupervisorLeaseRecord;
  refresh(): Promise<SupervisorLeaseRecord>;
  assertActive(): Promise<void>;
  markReady(): Promise<SupervisorLeaseRecord>;
  release(input?: { readonly failure?: SupervisorFailureRecord }): Promise<SupervisorLeaseRecord>;
}

export interface SupervisorTakeoverOptions {
  readonly reason: string;
  readonly allowed?: (record: SupervisorLeaseRecord) => boolean | Promise<boolean>;
}

export interface AcquireDaemonLeaseOptions {
  readonly ownerId?: string;
  readonly takeover?: SupervisorTakeoverOptions;
}

export interface SupervisorStage {
  readonly name: string;
  readonly ownerId: string;
  readonly nextAction?: string;
  readonly start: () => Promise<void>;
  readonly dispose?: () => Promise<void>;
}

export interface SupervisorStartupOptions {
  readonly lease?: AcquireDaemonLeaseOptions;
}

export interface SupervisorStartup {
  readonly paths: RuntimePaths;
  readonly lease: SupervisorLease;
  readonly readyAt: string;
  readonly stages: readonly string[];
  dispose(): Promise<SupervisorDisposeReceipt>;
}

function supervisorError(code: string, message: string, nextAction: string, ownerId = 'supervisor'): AppLifecycleError {
  return new AppLifecycleError(code, message, nextAction, ownerId);
}

export function daemonLeasePath(paths: RuntimePaths): string {
  return join(paths.projectRoot, 'daemon', 'lease.json');
}

function validateLeaseRecord(value: Partial<SupervisorLeaseRecord>): void {
  if (
    value.schemaVersion !== LEASE_SCHEMA_VERSION
    || typeof value.leaseId !== 'string'
    || !value.leaseId
    || !Number.isSafeInteger(value.generation)
    || (value.generation ?? 0) < 1
    || typeof value.ownerId !== 'string'
    || !value.ownerId
    || !Number.isSafeInteger(value.pid)
    || typeof value.processStartToken !== 'string'
    || !value.processStartToken
    || typeof value.acquiredAt !== 'string'
    || !value.acquiredAt
  ) {
    throw supervisorError(
      'daemon-lease-corrupt',
      'daemon lease record is invalid',
      'inspect and repair the daemon lease after confirming no live daemon owns it',
    );
  }
  for (const key of ['readyAt', 'disposedAt'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw supervisorError('daemon-lease-corrupt', `daemon lease field ${key} is invalid`, 'inspect and repair the daemon lease');
    }
  }
  if (value.takeover !== undefined) {
    const takeover = value.takeover;
    if (
      typeof takeover.previousLeaseId !== 'string'
      || typeof takeover.reason !== 'string'
      || typeof takeover.detectedAt !== 'string'
      || !Number.isSafeInteger(takeover.previousGeneration)
    ) {
      throw supervisorError('daemon-lease-corrupt', 'daemon lease takeover record is invalid', 'inspect and repair the daemon lease');
    }
  }
  if (value.failure !== undefined) {
    const failure = value.failure;
    if (
      typeof failure.phase !== 'string'
      || typeof failure.ownerId !== 'string'
      || typeof failure.errorCode !== 'string'
      || typeof failure.nextAction !== 'string'
      || typeof failure.message !== 'string'
      || typeof failure.occurredAt !== 'string'
    ) {
      throw supervisorError('daemon-lease-corrupt', 'daemon lease failure record is invalid', 'inspect and repair the daemon lease');
    }
  }
}

async function readLeaseRecord(paths: RuntimePaths): Promise<SupervisorLeaseRecord | undefined> {
  const leasePath = daemonLeasePath(paths);
  try {
    const content = await readFile(leasePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<SupervisorLeaseRecord>;
    validateLeaseRecord(parsed);
    return parsed as SupervisorLeaseRecord;
  } catch (error) {
    if (error instanceof AppLifecycleError) throw error;
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw supervisorError(
      'daemon-lease-corrupt',
      'daemon lease file is not readable JSON',
      'inspect and repair or remove the stale daemon lease after confirming no owner is running',
      'supervisor',
    );
  }
}

interface LeaseGuardOwner {
  readonly pid: number;
  readonly createdAt: string;
}

async function createLeaseGuard(guardPath: string): Promise<void> {
  const candidatePath = `${guardPath}.candidate-${randomUUID()}`;
  await mkdir(candidatePath);
  try {
    const owner: LeaseGuardOwner = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(candidatePath, 'owner.json'), JSON.stringify(owner) + '\n', 'utf8');
    await rename(candidatePath, guardPath);
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    throw error;
  }
}

async function readLeaseGuardOwner(guardPath: string): Promise<LeaseGuardOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(guardPath, 'owner.json'), 'utf8')) as Partial<LeaseGuardOwner>;
    if (!Number.isSafeInteger(parsed.pid) || typeof parsed.createdAt !== 'string') return undefined;
    return parsed as LeaseGuardOwner;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function withLeaseGuard<T>(leasePath: string, operation: () => Promise<T>, options: { readonly allowStaleTakeover?: boolean } = {}): Promise<T> {
  const guardPath = `${leasePath}.acquire`;
  for (;;) {
    try {
      await createLeaseGuard(guardPath);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST' && (error as { code?: string }).code !== 'ENOTEMPTY') throw error;
      if (!options.allowStaleTakeover) {
        throw supervisorError(
          'daemon-lease-transition-in-progress',
          'another daemon lease transition is already in progress',
          'wait for the daemon lease transition to finish',
        );
      }
      const owner = await readLeaseGuardOwner(guardPath);
      if (owner !== undefined && processIsAlive(owner.pid)) {
        throw supervisorError(
          'daemon-lease-transition-in-progress',
          'another daemon lease transition is already in progress',
          'wait for the daemon lease transition to finish',
        );
      }
      const stalePath = `${guardPath}.stale-${randomUUID()}`;
      try {
        await rename(guardPath, stalePath);
      } catch (renameError) {
        if ((renameError as { code?: string }).code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }
  try {
    return await operation();
  } finally {
    await rm(guardPath, { recursive: true, force: true });
  }
}

async function writeLeaseRecord(paths: RuntimePaths, record: SupervisorLeaseRecord): Promise<void> {
  const leasePath = daemonLeasePath(paths);
  const tempPath = `${leasePath}.tmp-${record.leaseId}`;
  const handle = await openFile(tempPath, 'w');
  try {
    await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, leasePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    (process as unknown as { kill(pid: number, signal: number): void }).kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function leaseOwnedError(record: SupervisorLeaseRecord): AppLifecycleError {
  return supervisorError(
    'daemon-lease-owned',
    `daemon lease ${record.leaseId} generation ${record.generation} is active`,
    'wait for the active daemon to release the lease or run an explicit crash takeover',
    record.ownerId,
  );
}

function newLeaseRecord(paths: RuntimePaths, generation: number, options: { readonly takeover?: SupervisorTakeoverRecord; readonly ownerId?: string }): SupervisorLeaseRecord {
  return {
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: randomUUID(),
    generation,
    ownerId: options.ownerId ?? 'supervisor',
    pid: process.pid,
    processStartToken: randomUUID(),
    acquiredAt: new Date().toISOString(),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  };
}

async function assertLeaseActive(paths: RuntimePaths, expected: SupervisorLeaseRecord): Promise<SupervisorLeaseRecord> {
  const latest = await readLeaseRecord(paths);
  if (!latest || latest.leaseId !== expected.leaseId || latest.generation !== expected.generation || latest.processStartToken !== expected.processStartToken) {
    throw supervisorError(
      'daemon-lease-stale',
      'daemon lease was replaced',
      'acquire a fresh daemon lease before continuing',
      'supervisor',
    );
  }
  if (latest.disposedAt) {
    throw supervisorError(
      'daemon-lease-disposed',
      'daemon lease has been disposed',
      'acquire a new daemon lease before continuing',
      'supervisor',
    );
  }
  return latest;
}

function createLease(paths: RuntimePaths, initial: SupervisorLeaseRecord): SupervisorLease {
  let record = initial;
  let released = false;

  async function update(mutate: (current: SupervisorLeaseRecord) => SupervisorLeaseRecord): Promise<SupervisorLeaseRecord> {
    return withLeaseGuard(daemonLeasePath(paths), async () => {
      const latest = await assertLeaseActive(paths, record);
      const next = mutate(latest);
      validateLeaseRecord(next);
      await writeLeaseRecord(paths, next);
      record = next;
      return next;
    });
  }

  return {
    paths,
    get record() {
      return record;
    },
    async refresh() {
      const latest = await readLeaseRecord(paths);
      if (!latest) {
        throw supervisorError('daemon-lease-stale', 'daemon lease is missing', 'acquire a fresh daemon lease before continuing');
      }
      record = latest;
      return latest;
    },
    async assertActive() {
      record = await assertLeaseActive(paths, record);
    },
    async markReady() {
      return update((current) => ({ ...current, readyAt: current.readyAt ?? new Date().toISOString() }));
    },
    async release(input) {
      if (released) return record;
      const next = await update((current) => ({
        ...current,
        ...(input?.failure === undefined ? {} : { failure: input.failure }),
        disposedAt: new Date().toISOString(),
      }));
      released = true;
      return next;
    },
  };
}

export async function acquireDaemonLease(paths: RuntimePaths, options: AcquireDaemonLeaseOptions = {}): Promise<SupervisorLease> {
  const leasePath = daemonLeasePath(paths);
  await mkdir(dirname(leasePath), { recursive: true });
  return withLeaseGuard(leasePath, async () => {
    const existing = await readLeaseRecord(paths);
    if (existing && !existing.disposedAt) {
      if (!options.takeover) throw leaseOwnedError(existing);
      const allowed = options.takeover.allowed === undefined
        ? !processIsAlive(existing.pid)
        : await options.takeover.allowed(existing);
      if (!allowed) throw leaseOwnedError(existing);
      const record = newLeaseRecord(paths, existing.generation + 1, {
        ownerId: options.ownerId,
        takeover: {
          previousLeaseId: existing.leaseId,
          previousGeneration: existing.generation,
          reason: options.takeover.reason,
          detectedAt: new Date().toISOString(),
        },
      });
      await writeLeaseRecord(paths, record);
      return createLease(paths, record);
    }
    const record = newLeaseRecord(paths, existing ? existing.generation + 1 : 1, { ownerId: options.ownerId });
    await writeLeaseRecord(paths, record);
    return createLease(paths, record);
  }, { allowStaleTakeover: options.takeover !== undefined });
}

export async function readDaemonLease(paths: RuntimePaths): Promise<SupervisorLeaseRecord | undefined> {
  return readLeaseRecord(paths);
}

function failureRecordFor(error: unknown, failingStage: SupervisorStage | undefined): SupervisorFailureRecord {
  const code = error instanceof AppLifecycleError
    ? error.code
    : 'supervisor-startup-failed';
  const ownerId = error instanceof AppLifecycleError
    ? error.ownerId
    : failingStage?.ownerId ?? 'supervisor';
  const nextAction = error instanceof AppLifecycleError
    ? error.nextAction
    : failingStage?.nextAction ?? 'resolve the failing startup phase and retry after confirming no stale daemon owns the lease';
  return {
    phase: failingStage?.name ?? 'startup',
    ownerId,
    errorCode: code,
    nextAction,
    message: error instanceof Error ? error.message : String(error),
    occurredAt: new Date().toISOString(),
  };
}

async function disposeStagesReverse(stages: readonly SupervisorStage[]): Promise<{ readonly disposedStages: readonly string[]; readonly cleanupFailure?: SupervisorCleanupFailure }> {
  const disposedStages: string[] = [];
  let cleanupFailure: SupervisorCleanupFailure | undefined;
  for (const stage of [...stages].reverse()) {
    try {
      await stage.dispose?.();
      disposedStages.push(stage.name);
    } catch (error) {
      if (cleanupFailure === undefined) {
        cleanupFailure = {
          ownerId: stage.ownerId,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  return { disposedStages, cleanupFailure };
}

async function failAndCleanup(paths: RuntimePaths, lease: SupervisorLease, error: unknown, started: readonly SupervisorStage[]): Promise<{ readonly error: unknown; readonly receipt: SupervisorFailureReceipt }> {
  const failingStage = started.at(-1);
  const failure = failureRecordFor(error, failingStage);
  const cleanup = await disposeStagesReverse(started);
  const failureRecord = {
    ...failure,
    ...(cleanup.cleanupFailure === undefined ? {} : { cleanupFailure: cleanup.cleanupFailure }),
  };
  await lease.release({ failure: failureRecord });
  const receipt: SupervisorFailureReceipt = {
    ...failureRecord,
    startedStages: started.map((stage) => stage.name),
    disposedStages: cleanup.disposedStages,
    originalError: error,
  };
  const wrapped = error instanceof AppLifecycleError
    ? error
    : new AppLifecycleError(failure.errorCode, `host startup failed at ${failure.phase}: ${failure.message}`, failure.nextAction, failure.ownerId, error);
  (wrapped as AppLifecycleError & { supervisorFailure?: SupervisorFailureReceipt }).supervisorFailure = receipt;
  return { error: wrapped, receipt };
}

export async function runSupervisorStartup(paths: RuntimePaths, stages: readonly SupervisorStage[], options: SupervisorStartupOptions = {}): Promise<SupervisorStartup> {
  const lease = await acquireDaemonLease(paths, options.lease);
  const started: SupervisorStage[] = [];
  try {
    for (const stage of stages) {
      started.push(stage);
      await stage.start();
    }
    await lease.markReady();
    let disposed = false;
    let disposeReceipt: SupervisorDisposeReceipt | undefined;
    const startup: SupervisorStartup = {
      paths,
      lease,
      readyAt: lease.record.readyAt ?? new Date().toISOString(),
      stages: stages.map((stage) => stage.name),
      async dispose() {
        if (disposed) {
          if (disposeReceipt === undefined) throw new Error('startup dispose was already completed without a receipt');
          return disposeReceipt;
        }
        disposed = true;
        const cleanup = await disposeStagesReverse(started);
        const released = await lease.release();
        disposeReceipt = {
          lease: released,
          disposedStages: cleanup.disposedStages,
          releasedAt: released.disposedAt ?? new Date().toISOString(),
          ...(cleanup.cleanupFailure === undefined ? {} : { cleanupFailure: cleanup.cleanupFailure }),
        };
        return disposeReceipt;
      },
    };
    return startup;
  } catch (error) {
    const failure = await failAndCleanup(paths, lease, error, started);
    throw failure.error;
  }
}
