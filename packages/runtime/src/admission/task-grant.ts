import {
  validateCheckpointControlGrant,
  type CheckpointControlBusinessRequest,
  type CheckpointControlCapabilityRef,
  type CheckpointControlDenialReason,
  type CheckpointControlGrant,
  type CheckpointControlGrantRequest,
  type CheckpointControlInputIdentity,
  type CheckpointControlRevokeRequest,
} from '../../../contracts/src/checkpoint-controls.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type { TaskId } from '../../../contracts/src/index.js';
import {
  validateTaskGrantAdmission,
  validateTaskGrantSnapshot,
  type TaskBusinessAdmission,
} from '../../../core/src/task-controls.js';
import { AdmissionError } from './errors.js';

/**
 * Runtime admission boundary for task-scoped grants. Every authority signal
 * comes from the durable Journal readback: owner and revision are read off the
 * committed fact, never from a constant, config value, session state or log.
 */

/** Exact durable readback: the current grant and the commit that proved it. */
export interface TaskGrantReadback {
  readonly grant: CheckpointControlGrant | null;
  readonly commit: JournalCommitRef | null;
}

export interface TaskGrantAuthority {
  readonly grant: CheckpointControlGrant;
  readonly commit: JournalCommitRef;
  readonly owner: string;
  readonly permissionRevision: string;
}

/**
 * Durable fact that one new business request was admitted under the exact
 * current grant. It is a control record: it carries the admitted revision and
 * never replaces the grant readback.
 */
export interface TaskGrantBusinessRegistration {
  readonly requestRef: string;
  readonly taskId: TaskId;
  readonly owner: string;
  readonly capability: CheckpointControlCapabilityRef;
  readonly inputIdentity: CheckpointControlInputIdentity;
  readonly grantRevision: number;
}

/**
 * Append capability bound to the Journal transaction that already holds the
 * task-grant lock. The callback registers through this port so authorization
 * and durable registration share one transaction instead of re-locking.
 */
export interface TaskGrantRegistrationPort {
  registerBusiness(registration: TaskGrantBusinessRegistration): Promise<JournalCommitRef>;
}

export interface TaskGrantPort {
  readTaskGrant(taskId: TaskId): Promise<TaskGrantReadback>;
  grant(input: CheckpointControlGrantRequest): Promise<TaskGrantReadback>;
  revoke(input: CheckpointControlRevokeRequest): Promise<TaskGrantReadback>;

  /**
   * Serializes the current authorization check with the durable registration
   * of new business. The held scope covers only the grant read plus the
   * registration callback: it never waits on a network call, model response
   * or tool effect.
   */
  withAuthorizedNewBusiness<T>(
    input: CheckpointControlBusinessRequest,
    register: (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => Promise<T>,
  ): Promise<T>;
}

/** Typed denial for a rejected grant, revoke or new-business admission. */
export class TaskGrantDeniedError extends Error {
  constructor(
    public readonly reason: CheckpointControlDenialReason,
    options?: ErrorOptions,
  ) {
    super(`task grant denied: ${reason}`, options);
    this.name = 'TaskGrantDeniedError';
  }
}

export function validateTaskGrantReadback(readback: TaskGrantReadback): void {
  if (readback.grant !== null) validateCheckpointControlGrant(readback.grant);
  if (readback.grant === null) {
    if (readback.commit !== null) throw new AdmissionError('task grant readback must not carry a commit for a missing grant');
    return;
  }
  if (readback.commit === null) throw new AdmissionError('task grant readback is missing its exact commit');
  if (!readback.commit.commitId.trim() || !Number.isSafeInteger(readback.commit.journalSeq) || !readback.commit.recordDigest.trim()) {
    throw new AdmissionError('task grant readback commit is invalid');
  }
}

/** Denies or admits one new-business request from the exact current readback. */
export function decideTaskGrantAdmission(input: {
  readonly request: CheckpointControlBusinessRequest;
  readonly readback: TaskGrantReadback | undefined;
}): TaskBusinessAdmission {
  if (input.readback === undefined) return validateTaskGrantAdmission({ request: input.request, current: undefined });
  validateTaskGrantReadback(input.readback);
  return validateTaskGrantAdmission({ request: input.request, current: input.readback.grant });
}

/**
 * Derives the authority a caller may act with from the actual readback and the
 * verified principal. `permissionRevision` is `String(grant.revision)` of the
 * same fact, so a numeric string is never a separate authorization.
 */
export function projectTaskGrantAuthority(input: {
  readonly readback: TaskGrantReadback;
  readonly principalOwner: string;
}): TaskGrantAuthority {
  validateTaskGrantReadback(input.readback);
  const snapshot = validateTaskGrantSnapshot({ grant: input.readback.grant, principalOwner: input.principalOwner });
  if (input.readback.commit === null) throw new AdmissionError('task grant readback is missing its exact commit');
  return {
    grant: snapshot.grant,
    commit: input.readback.commit,
    owner: snapshot.grant.owner,
    permissionRevision: snapshot.permissionRevision,
  };
}

/**
 * Routes one new-business registration through the port's authorization lock,
 * then re-checks that the returned authority still matches the verified
 * principal and its own revision before the callback runs.
 */
export async function admitTaskGrantBusiness<T>(input: {
  readonly port: TaskGrantPort;
  readonly request: CheckpointControlBusinessRequest;
  readonly principalOwner: string;
  readonly register: (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => Promise<T>;
}): Promise<T> {
  return await input.port.withAuthorizedNewBusiness(input.request, async (authority, registration) => {
    if (authority.owner !== input.principalOwner) {
      throw new AdmissionError('task grant authority does not match the verified principal');
    }
    if (authority.permissionRevision !== String(authority.grant.revision)) {
      throw new AdmissionError('task grant permission revision does not match its grant');
    }
    return await input.register(authority, registration);
  });
}
