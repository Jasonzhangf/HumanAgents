import { createHash } from 'node:crypto';
import {
  validateCheckpointControlGrant,
  validateCheckpointControlGrantRequest,
  validateCheckpointControlRevokeRequest,
  type CheckpointControlBusinessRequest,
  type CheckpointControlCapabilityRef,
  type CheckpointControlGrant,
  type CheckpointControlGrantRequest,
  type CheckpointControlRevokeRequest,
} from '../../../contracts/src/checkpoint-controls.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type { ScopeRef, TaskId } from '../../../contracts/src/index.js';
import {
  grantCheckpointControl,
  revokeCheckpointControl,
  validateTaskGrantAdmission,
} from '../../../core/src/task-controls.js';
import {
  TaskGrantDeniedError,
  type TaskGrantAuthority,
  type TaskGrantBusinessRegistration,
  type TaskGrantPort,
  type TaskGrantReadback,
  type TaskGrantRegistrationPort,
} from '../../../runtime/src/admission/task-grant.js';
import {
  type JournalAppendInput,
  JournalCommitConflictError,
  JournalIntegrityError,
  type JournalRecord,
  type JsonlOrganJournal,
} from './index.js';

const RECORD_TYPE = 'task-grant';
const BUSINESS_RECORD_TYPE = 'task-business-registration';

type TaskGrantPayload = { readonly kind: typeof RECORD_TYPE; readonly grant: CheckpointControlGrant };
type TaskBusinessPayload = {
  readonly kind: typeof BUSINESS_RECORD_TYPE;
  readonly registration: TaskGrantBusinessRegistration;
};

interface TaskGrantEntry {
  readonly grant: CheckpointControlGrant;
  readonly commit: JournalCommitRef;
}

function isTaskGrantRecord(record: JournalRecord): boolean {
  return record.kind === 'event' && record.payload?.kind === RECORD_TYPE;
}

function isTaskBusinessRecord(record: JournalRecord): boolean {
  return record.kind === 'event' && record.payload?.kind === BUSINESS_RECORD_TYPE;
}

function payloadGrant(record: JournalRecord): CheckpointControlGrant {
  const payload = record.payload as Partial<TaskGrantPayload> | undefined;
  if (payload?.kind !== RECORD_TYPE || payload.grant === undefined) {
    throw new JournalIntegrityError('task grant journal record has no typed grant payload');
  }
  return payload.grant as CheckpointControlGrant;
}

function payloadRegistration(record: JournalRecord): TaskGrantBusinessRegistration {
  const payload = record.payload as Partial<TaskBusinessPayload> | undefined;
  if (payload?.kind !== BUSINESS_RECORD_TYPE || payload.registration === undefined) {
    throw new JournalIntegrityError('task business journal record has no typed registration payload');
  }
  return payload.registration;
}

function commitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) throw new JournalIntegrityError('task grant journal record is not committed');
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function commandCommitId(scope: ScopeRef, requestId: string): string {
  return `task-grant:v1:${createHash('sha256')
    .update(`${scope.organId.value}\0${scope.taskId?.value ?? ''}\0${requestId}`)
    .digest('hex')}`;
}

function sameGrantCommand(grant: CheckpointControlGrant, request: CheckpointControlGrantRequest): boolean {
  return grant.owner === request.owner
    && grant.capability.actionId === request.capability.actionId
    && grant.capability.capabilities.length === request.capability.capabilities.length
    && grant.capability.capabilities.every((capability, index) => capability === request.capability.capabilities[index])
    && grant.capability.scope.organId.value === request.capability.scope.organId.value
    && grant.capability.scope.taskId?.value === request.capability.scope.taskId?.value;
}

function sameCapability(left: CheckpointControlCapabilityRef, right: CheckpointControlCapabilityRef): boolean {
  return left.actionId === right.actionId
    && left.capabilities.length === right.capabilities.length
    && left.capabilities.every((capability, index) => capability === right.capabilities[index])
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

function businessCommitId(scope: ScopeRef, requestRef: string): string {
  return `task-business:v1:${createHash('sha256')
    .update(`${scope.organId.value}\0${scope.taskId?.value ?? ''}\0${requestRef}`)
    .digest('hex')}`;
}

/**
 * Narrow task-grant codec over the existing authoritative Organ Journal. A
 * durable grant is one typed event fact; readback derives the exact commit from
 * the record, and grant/revoke compare `expectedRevision` under the Journal's
 * own transaction lock. It adds no second store, Journal kind or Registry
 * mirror, and never re-locks through the public append path.
 */
export class JsonlTaskGrantJournal implements TaskGrantPort {
  constructor(private readonly journal: JsonlOrganJournal) {}

  async readTaskGrant(taskId: TaskId): Promise<TaskGrantReadback> {
    const entry = this.replay(await this.journal.replay()).get(taskId.value);
    return entry === undefined ? { grant: null, commit: null } : { grant: entry.grant, commit: entry.commit };
  }

  async grant(input: CheckpointControlGrantRequest): Promise<TaskGrantReadback> {
    validateCheckpointControlGrantRequest(input);
    const scope: ScopeRef = { organId: input.capability.scope.organId, taskId: input.taskId };
    const commitId = commandCommitId(scope, input.requestId);
    return await this.journal.transaction(
      ({ records }) => {
        const existing = records.find((record) => record.commitId === commitId);
        if (existing !== undefined) {
          const grant = this.verifiedGrant(existing);
          if (grant.state !== 'granted' || grant.task.value !== input.taskId.value || !sameGrantCommand(grant, input)) {
            throw new JournalCommitConflictError(commitId, existing);
          }
          return { kind: 'existing' as const, grant, commit: commitRef(existing) };
        }
        const current = this.replay(records).get(input.taskId.value)?.grant;
        const decision = grantCheckpointControl({
          request: input,
          ...(current === undefined ? {} : { current }),
          updatedAt: new Date().toISOString(),
        });
        if (decision.outcome !== 'granted') {
          if (decision.outcome === 'denied') throw new TaskGrantDeniedError(decision.reason);
          throw new JournalIntegrityError('task grant returned an unexpected decision');
        }
        return { kind: 'append' as const, grant: decision.grant, commitId, scope };
      },
      async (plan, append) => {
        if (plan.kind === 'existing') return { grant: plan.grant, commit: plan.commit };
        const record = await append({
          commitId: plan.commitId,
          kind: 'event',
          scope: plan.scope,
          payload: { kind: RECORD_TYPE, grant: plan.grant },
        });
        return { grant: this.verifiedGrant(record), commit: commitRef(record) };
      },
    );
  }

  async revoke(input: CheckpointControlRevokeRequest): Promise<TaskGrantReadback> {
    validateCheckpointControlRevokeRequest(input);
    return await this.journal.transaction(
      ({ records }) => {
        const current = this.replay(records).get(input.taskId.value);
        const existing = records.find((record) => {
          if (!isTaskGrantRecord(record)) return false;
          const grant = payloadGrant(record);
          return grant.task.value === input.taskId.value && grant.requestId === input.requestId;
        });
        if (existing !== undefined) {
          const grant = this.verifiedGrant(existing);
          if (grant.state !== 'revoked' || grant.owner !== input.owner) {
            throw new JournalCommitConflictError(commitRef(existing).commitId, existing);
          }
          return { kind: 'existing' as const, grant, commit: commitRef(existing) };
        }
        const decision = revokeCheckpointControl({
          request: input,
          ...(current === undefined ? {} : { current: current.grant }),
          updatedAt: new Date().toISOString(),
        });
        if (decision.outcome !== 'revoked') {
          if (decision.outcome === 'denied') throw new TaskGrantDeniedError(decision.reason);
          throw new JournalIntegrityError('task revoke returned an unexpected decision');
        }
        if (current === undefined) throw new JournalIntegrityError('task revoke requires a durable current grant');
        const scope: ScopeRef = { organId: current.grant.capability.scope.organId, taskId: input.taskId };
        return { kind: 'append' as const, grant: decision.grant, commitId: commandCommitId(scope, input.requestId), scope };
      },
      async (plan, append) => {
        if (plan.kind === 'existing') return { grant: plan.grant, commit: plan.commit };
        const record = await append({
          commitId: plan.commitId,
          kind: 'event',
          scope: plan.scope,
          payload: { kind: RECORD_TYPE, grant: plan.grant },
        });
        return { grant: this.verifiedGrant(record), commit: commitRef(record) };
      },
    );
  }

  async withAuthorizedNewBusiness<T>(
    input: CheckpointControlBusinessRequest,
    register: (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => Promise<T>,
  ): Promise<T> {
    return await this.journal.transaction(
      ({ records }) => {
        const entry = this.replay(records).get(input.taskId.value);
        const decision = validateTaskGrantAdmission({ request: input, current: entry?.grant ?? null });
        if (!decision.allowed) throw new TaskGrantDeniedError(decision.reason);
        if (entry === undefined) throw new JournalIntegrityError('task grant admission has no durable readback');
        return {
          authority: {
            grant: entry.grant,
            commit: entry.commit,
            owner: entry.grant.owner,
            permissionRevision: String(entry.grant.revision),
          } satisfies TaskGrantAuthority,
        };
      },
      async ({ authority }, append) => await register(authority, this.registrationPort(append, authority, input)),
    );
  }

  async readBusinessRegistration(input: {
    readonly taskId: TaskId;
    readonly requestRef: string;
  }): Promise<{ readonly registration: TaskGrantBusinessRegistration; readonly commit: JournalCommitRef } | null> {
    for (const record of await this.journal.replay()) {
      if (!isTaskBusinessRecord(record)) continue;
      const registration = payloadRegistration(record);
      if (registration.taskId.value === input.taskId.value && registration.requestRef === input.requestRef) {
        return { registration, commit: commitRef(record) };
      }
    }
    return null;
  }

  private registrationPort(
    append: (input: JournalAppendInput) => Promise<JournalRecord>,
    authority: TaskGrantAuthority,
    input: CheckpointControlBusinessRequest,
  ): TaskGrantRegistrationPort {
    return {
      registerBusiness: async (registration) => {
        this.assertRegistrationMatches(registration, authority, input);
        const scope: ScopeRef = { organId: input.capability.scope.organId, taskId: input.taskId };
        const record = await append({
          commitId: businessCommitId(scope, registration.requestRef),
          kind: 'event',
          scope,
          payload: { kind: BUSINESS_RECORD_TYPE, registration },
        });
        return commitRef(record);
      },
    };
  }

  private assertRegistrationMatches(
    registration: TaskGrantBusinessRegistration,
    authority: TaskGrantAuthority,
    input: CheckpointControlBusinessRequest,
  ): void {
    if (registration.requestRef !== input.requestRef) {
      throw new JournalIntegrityError('task business registration requestRef does not match the admitted request');
    }
    if (registration.taskId.value !== input.taskId.value) {
      throw new JournalIntegrityError('task business registration taskId does not match the admitted request');
    }
    if (registration.owner !== authority.owner) {
      throw new JournalIntegrityError('task business registration owner does not match the admitted authority');
    }
    if (registration.grantRevision !== authority.grant.revision) {
      throw new JournalIntegrityError('task business registration revision does not match the admitted authority');
    }
    if (registration.inputIdentity.requestRef !== input.inputIdentity.requestRef
      || registration.inputIdentity.digest !== input.inputIdentity.digest) {
      throw new JournalIntegrityError('task business registration input identity does not match the admitted request');
    }
    if (!sameCapability(registration.capability, input.capability)) {
      throw new JournalIntegrityError('task business registration capability does not match the admitted request');
    }
  }

  private verifiedGrant(record: JournalRecord): CheckpointControlGrant {
    const grant = payloadGrant(record);
    validateCheckpointControlGrant(grant);
    if (record.scope.taskId?.value !== grant.task.value
      || record.scope.organId.value !== grant.capability.scope.organId.value) {
      throw new JournalIntegrityError('task grant fact does not match its Journal record scope');
    }
    return grant;
  }

  private replay(records: readonly JournalRecord[]): Map<string, TaskGrantEntry> {
    const grants = new Map<string, TaskGrantEntry>();
    for (const record of records) {
      if (!isTaskGrantRecord(record)) continue;
      const grant = this.verifiedGrant(record);
      const prior = grants.get(grant.task.value);
      if (prior === undefined) {
        if (grant.revision !== 1) throw new JournalIntegrityError('task grant initial revision must be one');
      } else {
        if (grant.revision !== prior.grant.revision + 1) {
          throw new JournalIntegrityError('task grant revision must increase by exactly one');
        }
        if (grant.requestId === prior.grant.requestId) {
          throw new JournalIntegrityError('task grant request identity must be unique per task');
        }
      }
      grants.set(grant.task.value, { grant, commit: commitRef(record) });
    }
    return grants;
  }
}
