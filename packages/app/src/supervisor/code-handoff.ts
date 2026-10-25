import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { RuntimePaths } from '../../../config/src/index.js';
import { AppLifecycleError } from '../errors.js';
import {
  assertDaemonLeaseIdentity,
  readDaemonLease,
  recordDaemonRestartFailure,
  recordDaemonRestartTransition,
  SERVE_OWNER,
  SUPERVISOR_RESTART_REQUEST_OPTION as RESTART_REQUEST_OPTION,
  type SupervisorLeaseIdentity,
  type SupervisorLeaseRecord,
  type SupervisorRestartTransition,
  type SupervisorSourceReceipt,
  type SupervisorStartupDeclaration,
} from './supervisor.js';

// The replacement ready timeout is a backstop against a replacement that never
// becomes ready, not a scheduling guarantee for a slow-but-working start.
// Production evidence: daemon restart 0.1.0041 (requestId
// b2d81e08-291c-4012-addc-660747abcfb1) needed about 65 s from replacement spawn
// to readiness, while the previous 30 s bound fired first and falsely recorded
// `restart.failure` for a replacement that then completed. 120 s covers that
// measured cold start with ~1.85x headroom and stays a backstop; the lease's
// completedAt/failure marker remains the authoritative outcome.
const DEFAULT_HANDOFF_TIMEOUT_MS = 120_000;
const DEFAULT_HANDOFF_POLL_INTERVAL_MS = 25;
type ChildProcessLike = ReturnType<typeof spawn>;
const spawnFailures = new WeakMap<ChildProcessLike, Error>();

export interface DaemonRestartReceipt {
  readonly requestId: string;
  readonly acceptedAt: string;
  readonly ownerId: typeof SERVE_OWNER;
  readonly leaseId: string;
  readonly generation: number;
  readonly observerOnly: true;
}

export interface DaemonRestartCompletionReceipt {
  readonly requestId: string;
  readonly acceptedAt: string;
  readonly completedAt: string;
  readonly previous: {
    readonly leaseId: string;
    readonly generation: number;
    readonly pid: number;
    readonly processStartToken: string;
  };
  readonly current: {
    readonly leaseId: string;
    readonly generation: number;
    readonly pid: number;
    readonly processStartToken: string;
    readonly readyAt: string;
    readonly controlEndpoint: NonNullable<SupervisorLeaseRecord['controlEndpoint']>;
  };
  readonly controlRoot: string;
  readonly workspace: string;
  readonly projectKey: string;
  readonly source: SupervisorSourceReceipt;
  readonly legacyCloseReceipt: 'clean' | 'unavailable';
}

export interface DaemonCodeHandoff {
  readonly receipt: DaemonRestartReceipt;
  readonly completion: Promise<DaemonRestartCompletionReceipt>;
}

export interface DaemonCodeHandoffInput {
  readonly expected: SupervisorLeaseRecord;
  readonly startup: SupervisorStartupDeclaration;
  readonly timeoutMs?: number;
}

function handoffError(code: string, message: string, nextAction: string, ownerId = SERVE_OWNER): AppLifecycleError {
  return new AppLifecycleError(code, message, nextAction, ownerId);
}

function leaseIdentity(record: SupervisorLeaseRecord): SupervisorLeaseIdentity {
  return {
    leaseId: record.leaseId,
    generation: record.generation,
    processStartToken: record.processStartToken,
  };
}

function sameLeaseIdentity(left: SupervisorLeaseRecord, right: SupervisorLeaseRecord): boolean {
  return left.leaseId === right.leaseId
    && left.generation === right.generation
    && left.processStartToken === right.processStartToken;
}

function assertExpectedLease(current: SupervisorLeaseRecord | undefined, expected: SupervisorLeaseRecord): SupervisorLeaseRecord {
  if (current === undefined || !sameLeaseIdentity(current, expected)) {
    throw handoffError(
      'daemon-restart.owner-fence',
      'the restart request no longer matches the active serve lease',
      'read the current daemon lease and retry from the active serve owner',
      SERVE_OWNER,
    );
  }
  if (current.disposedAt) {
    throw handoffError(
      'daemon-restart.owner-disposed',
      'the serve owner disposed its daemon lease before the restart could start',
      'start a new serve owner before requesting restart',
      SERVE_OWNER,
    );
  }
  return current;
}

function assertStartupDeclaration(startup: SupervisorStartupDeclaration): void {
  if (
    !startup.launcherPath
    || !startup.cwd
    || !startup.source.entryPath
  ) {
    throw handoffError(
      'daemon-restart.startup-missing',
      'the active serve owner did not publish a complete restart startup declaration',
      'retry the official restart with the original serve startup options',
      SERVE_OWNER,
    );
  }
}

/**
 * The legacy close receipt reports the replaced owner's close as clean only
 * when this handoff observed a real graceful termination of that same owner.
 * An already-dead owner never publishes a graceful close, so it stays
 * 'unavailable' instead of inferring clean from an old startup declaration.
 */
function legacyCloseReceipt(replacement: SupervisorLeaseRecord, previous: SupervisorLeaseRecord): 'clean' | 'unavailable' {
  const takeover = replacement.takeover;
  return takeover !== undefined
    && previous.startup !== undefined
    && takeover.previousLeaseId === previous.leaseId
    && takeover.previousGeneration === previous.generation
    && takeover.termination === 'graceful'
    ? 'clean'
    : 'unavailable';
}

async function waitForNewOwner(input: {
  readonly paths: RuntimePaths;
  readonly previous: SupervisorLeaseRecord;
  readonly startup: SupervisorStartupDeclaration;
  readonly child: ChildProcessLike;
  readonly timeoutMs: number;
}): Promise<SupervisorLeaseRecord> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const spawnError = spawnFailures.get(input.child);
    if (spawnError !== undefined) {
      throw handoffError(
        'daemon-restart.spawn-failed',
        `replacement serve could not start: ${spawnError.message}`,
        'inspect the selected launcher path and original serve startup options before retrying',
        SERVE_OWNER,
      );
    }
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw handoffError(
        'daemon-restart.child-exited',
        `replacement serve exited before readiness (code=${String(input.child.exitCode)}, signal=${String(input.child.signalCode)})`,
        'inspect the replacement serve startup failure and the daemon lease before retrying',
        SERVE_OWNER,
      );
    }
    try {
      const current = await readDaemonLease(input.paths);
      if (
        current !== undefined
        && !current.disposedAt
        && current.generation > input.previous.generation
        && current.pid === input.child.pid
        && current.processStartToken !== input.previous.processStartToken
        && current.readyAt !== undefined
        && current.controlEndpoint !== undefined
        && current.restart?.completedAt !== undefined
      ) {
        await assertDaemonLeaseIdentity(input.paths, current);
        return current;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_HANDOFF_POLL_INTERVAL_MS));
  }
  throw handoffError(
    'daemon-restart.ready-timeout',
    `replacement serve did not become ready: ${lastError instanceof Error ? lastError.message : 'no new owner identity was published'}`,
    'inspect the replacement serve startup output and the daemon lease before retrying',
    SERVE_OWNER,
  );
}

function spawnReplacement(startup: SupervisorStartupDeclaration, requestId: string): ChildProcessLike {
  // The request marker is a one-shot control argument for this child only.
  // It stays out of the retained startup declaration so later restarts do not
  // replay a completed request.
  const child = spawn(process.execPath, [
    startup.launcherPath,
    'serve',
    ...startup.args,
    RESTART_REQUEST_OPTION,
    requestId,
  ], {
    cwd: startup.cwd,
    env: process.env,
    // Own session and process group so the restart caller's terminal/session
    // teardown cannot reap the replacement serve after the handoff completes.
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.once('error', (error) => {
    spawnFailures.set(child, error);
  });
  return child;
}

function unrefChild(child: ChildProcessLike): void {
  (child as ChildProcessLike & { unref?: () => void }).unref?.();
}

function restartFailure(error: unknown): {
  readonly errorCode: string;
  readonly ownerId: string;
  readonly nextAction: string;
  readonly message: string;
  readonly occurredAt: string;
} {
  return {
    errorCode: error instanceof AppLifecycleError ? error.code : 'daemon-restart.failed',
    ownerId: error instanceof AppLifecycleError ? error.ownerId : SERVE_OWNER,
    nextAction: error instanceof AppLifecycleError
      ? error.nextAction
      : 'inspect the replacement process and daemon lease before retrying',
    message: error instanceof Error ? error.message : String(error),
    occurredAt: new Date().toISOString(),
  };
}

export async function captureLoadedSourceReceipt(input: {
  readonly entryPath: string;
  readonly packageVersion: string;
  readonly releaseVersion?: string;
}): Promise<SupervisorSourceReceipt> {
  const entryPath = await realpath(input.entryPath);
  return {
    entryPath,
    packageVersion: input.packageVersion,
    ...(input.releaseVersion === undefined ? {} : { releaseVersion: input.releaseVersion }),
  };
}

export function startDaemonCodeHandoff(
  paths: RuntimePaths,
  input: DaemonCodeHandoffInput,
): DaemonCodeHandoff {
  const requestId = randomUUID();
  const acceptedAt = new Date().toISOString();
  const receipt: DaemonRestartReceipt = {
    requestId,
    acceptedAt,
    ownerId: SERVE_OWNER,
    leaseId: input.expected.leaseId,
    generation: input.expected.generation,
    observerOnly: true,
  };
  const timeoutMs = input.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  const completion = (async (): Promise<DaemonRestartCompletionReceipt> => {
    const transition: SupervisorRestartTransition = {
      requestId,
      requestedAt: acceptedAt,
      previousLeaseId: input.expected.leaseId,
      previousGeneration: input.expected.generation,
      previousProcessStartToken: input.expected.processStartToken,
      targetEntryPath: input.startup.source.entryPath,
    };
    try {
      assertStartupDeclaration(input.startup);
      const current = assertExpectedLease(await readDaemonLease(paths), input.expected);
      await recordDaemonRestartTransition(paths, leaseIdentity(current), transition);
      const child = spawnReplacement(input.startup, requestId);
      const replacement = await waitForNewOwner({
        paths,
        previous: current,
        startup: input.startup,
        child,
        timeoutMs,
      });
      const source = replacement.startup?.source;
      if (
        replacement.restart?.requestId !== requestId
        || source === undefined
        || source.entryPath !== input.startup.source.entryPath
      ) {
        unrefChild(child);
        throw handoffError(
          'daemon-restart.loaded-source-mismatch',
          'the replacement owner loaded a different source than the selected restart entry',
          'verify the selected package and restart from the intended installed entry',
          SERVE_OWNER,
        );
      }
      unrefChild(child);
      return {
        requestId,
        acceptedAt,
        completedAt: replacement.restart.completedAt!,
        previous: {
          leaseId: current.leaseId,
          generation: current.generation,
          pid: current.pid,
          processStartToken: current.processStartToken,
        },
        current: {
          leaseId: replacement.leaseId,
          generation: replacement.generation,
          pid: replacement.pid,
          processStartToken: replacement.processStartToken,
          readyAt: replacement.readyAt!,
          controlEndpoint: replacement.controlEndpoint!,
        },
        controlRoot: paths.controlRoot,
        workspace: paths.workspaceCwd,
        projectKey: paths.projectKey,
        source,
        legacyCloseReceipt: legacyCloseReceipt(replacement, current),
      };
    } catch (error) {
      const failure = restartFailure(error);
      await recordDaemonRestartFailure(paths, requestId, failure).catch(() => undefined);
      throw error;
    }
  })();
  return { receipt, completion };
}

export async function restartDaemonWithCodeHandoff(
  paths: RuntimePaths,
  input: DaemonCodeHandoffInput,
): Promise<DaemonRestartCompletionReceipt> {
  return startDaemonCodeHandoff(paths, input).completion;
}
