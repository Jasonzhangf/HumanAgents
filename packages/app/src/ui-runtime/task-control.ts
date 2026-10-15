import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../../adapters/jsonl/src/task-grants.js';
import {
  projectTaskGrantAuthority,
  TaskGrantDeniedError,
  type TaskGrantAuthority,
  type TaskGrantPort,
  type TaskGrantReadback,
  type TaskGrantRegistrationPort,
} from '../../../runtime/src/admission/task-grant.js';
import type {
  CheckpointControlBusinessRequest,
  CheckpointControlCapabilityRef,
  CheckpointControlGrantRequest,
  CheckpointControlRevokeRequest,
} from '../../../contracts/src/checkpoint-controls.js';
import type {
  OrganId,
  ScopeRef,
  TaskId,
} from '../../../contracts/src/index.js';
import { UiRuntimeApiError } from './errors.js';

const APP_OWNER = 'humanagent.app.ui-runtime';

/**
 * The A1 declared execution action. A2/R1 later register the real product
 * action set; until then a request for any other action is refused explicitly.
 */
export const TASK_EXECUTION_ACTION_ID = 'task.execute';
export const TASK_EXECUTION_CAPABILITY = 'provider.execution';

export interface TaskControlCapabilityDeclaration {
  readonly actionId: string;
  readonly capabilities: readonly string[];
}

export interface TaskGrantControlRead {
  readonly taskId: TaskId;
  readonly owner: string;
  readonly readback: TaskGrantReadback;
  readonly authority: TaskGrantAuthority | null;
  readonly receivedAt: string;
}

export interface TaskGrantControlReceipt extends TaskGrantControlRead {
  readonly stop?: { readonly state: string; readonly operationId?: string };
}

/**
 * Typed linkage for the A2 execution-admission composition. The dependency is
 * optional today; asking for new-business admission without it fails with an
 * explicit source error and never becomes an unconditional grant.
 */
export interface TaskControlAdmissionPort {
  admitNewBusiness(input: {
    readonly request: CheckpointControlBusinessRequest;
    readonly register: (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => Promise<unknown>;
  }): Promise<unknown>;
}

export interface UiTaskGrantControlOptions {
  readonly journal: JsonlOrganJournal;
  readonly organId: OrganId;
  readonly capability: TaskControlCapabilityDeclaration;
  readonly now: () => Date;
  /** Validates the real task/resource declaration and returns its scope. */
  readonly taskScope: (taskId: TaskId) => ScopeRef;
  readonly admission?: TaskControlAdmissionPort;
  readonly stopTask?: (taskId: TaskId) => Promise<{ readonly state: string; readonly operationId?: string }>;
}

/**
 * Task-scoped control composition over the canonical JsonlTaskGrantJournal.
 * The server supplies the verified product owner; the client cannot create
 * authority with confirmedBy, a boolean, a scope field or a session presence.
 */
export class UiTaskGrantControl {
  private readonly port: TaskGrantPort;

  constructor(private readonly options: UiTaskGrantControlOptions) {
    this.port = new JsonlTaskGrantJournal(options.journal);
  }

  async read(taskId: TaskId, principalOwner: string): Promise<TaskGrantControlRead> {
    return await this.guard(async () => {
      this.requirePrincipal(principalOwner);
      this.requireDeclaredTask(taskId);
      const readback = await this.port.readTaskGrant(taskId);
      return this.receipt(taskId, principalOwner, readback);
    });
  }

  async grant(input: {
    readonly taskId: TaskId;
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly principalOwner: string;
    readonly capability?: TaskControlCapabilityDeclaration;
  }): Promise<TaskGrantControlReceipt> {
    return await this.guard(async () => {
      this.requirePrincipal(input.principalOwner);
      const scope = this.requireDeclaredTask(input.taskId);
      const capability = this.resolveCapability(input.taskId, scope, input.capability);
      const request: CheckpointControlGrantRequest = {
        requestId: input.requestId,
        taskId: input.taskId,
        owner: input.principalOwner,
        capability,
        expectedRevision: input.expectedRevision,
      };
      const readback = await this.port.grant(request);
      return this.receipt(input.taskId, input.principalOwner, readback);
    });
  }

  async revoke(input: {
    readonly taskId: TaskId;
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly principalOwner: string;
  }): Promise<TaskGrantControlReceipt> {
    return await this.guard(async () => {
      this.requirePrincipal(input.principalOwner);
      this.requireDeclaredTask(input.taskId);
      const request: CheckpointControlRevokeRequest = {
        requestId: input.requestId,
        taskId: input.taskId,
        owner: input.principalOwner,
        expectedRevision: input.expectedRevision,
      };
      const readback = await this.port.revoke(request);
      const receipt = this.receipt(input.taskId, input.principalOwner, readback);
      if (this.options.stopTask === undefined) return receipt;
      try {
        return { ...receipt, stop: await this.options.stopTask(input.taskId) };
      } catch (error) {
        // A revoked task with no running execution keeps the real closure
        // evidence; the standard stop path is simply not applicable.
        if (error instanceof UiRuntimeApiError && error.code === 'task.not.running') {
          return { ...receipt, stop: { state: 'no-running-execution' } };
        }
        throw error;
      }
    });
  }

  /**
   * A2 typed linkage. Without the real admission composition this fails
   * explicitly and never releases an effect or reports a fabricated receipt.
   */
  async admitNewBusiness(input: {
    readonly request: CheckpointControlBusinessRequest;
    readonly register: (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => Promise<unknown>;
  }): Promise<unknown> {
    return await this.guard(async () => {
      if (this.options.admission === undefined) {
        throw new UiRuntimeApiError(
          'task-control.admission.unavailable',
          APP_OWNER,
          'task-grant business admission is not wired to this runtime',
          'start the runtime with the A2 execution-admission composition',
          503,
        );
      }
      return await this.options.admission.admitNewBusiness(input);
    });
  }

  private requireDeclaredTask(taskId: TaskId): ScopeRef {
    const scope = this.options.taskScope(taskId);
    if (scope.organId.value !== this.options.organId.value || scope.taskId?.value !== taskId.value) {
      throw new UiRuntimeApiError(
        'task-control.scope.mismatch',
        APP_OWNER,
        'task grant scope does not match the declared task',
        'control the exact declared task identity',
        409,
      );
    }
    return scope;
  }

  private resolveCapability(
    taskId: TaskId,
    scope: ScopeRef,
    requested?: TaskControlCapabilityDeclaration,
  ): CheckpointControlCapabilityRef {
    const declared = this.options.capability;
    if (requested === undefined) {
      return { actionId: declared.actionId, capabilities: declared.capabilities, scope };
    }
    if (requested.actionId !== declared.actionId) {
      throw new UiRuntimeApiError(
        'task-control.wrong-action',
        APP_OWNER,
        `action ${requested.actionId} is not the declared execution action`,
        `request the declared action ${declared.actionId}`,
        409,
      );
    }
    const narrowed = requested.capabilities.filter((capability) => declared.capabilities.includes(capability));
    if (narrowed.length === 0 || narrowed.length !== requested.capabilities.length) {
      throw new UiRuntimeApiError(
        'task-control.wrong-capability',
        APP_OWNER,
        'requested capabilities are not within the declared execution capabilities',
        'request a subset of the declared execution capabilities',
        409,
      );
    }
    return { actionId: declared.actionId, capabilities: narrowed, scope };
  }

  private receipt(
    taskId: TaskId,
    principalOwner: string,
    readback: TaskGrantReadback,
  ): TaskGrantControlReceipt {
    return {
      taskId,
      owner: principalOwner,
      readback,
      authority: this.projectedAuthority(readback, principalOwner),
      receivedAt: this.options.now().toISOString(),
    };
  }

  private projectedAuthority(readback: TaskGrantReadback, principalOwner: string): TaskGrantAuthority | null {
    const grant = readback.grant;
    if (grant === null || grant.state !== 'granted' || grant.owner !== principalOwner) return null;
    // Structural corruption stays a real failure; missing/revoked/foreign
    // grants are ordinary denial facts and keep their closure readback.
    return projectTaskGrantAuthority({ readback, principalOwner });
  }

  private requirePrincipal(principalOwner: string): void {
    if (!principalOwner.trim()) {
      throw new UiRuntimeApiError(
        'task-control.principal.required',
        APP_OWNER,
        'verified product principal is required',
        'authenticate the browser session before task control',
        401,
      );
    }
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TaskGrantDeniedError) {
        throw new UiRuntimeApiError(
          `task-control.denied.${error.reason}`,
          APP_OWNER,
          `task grant denied: ${error.reason}`,
          'inspect the current task grant readback and resubmit the exact expected revision',
          409,
        );
      }
      throw error;
    }
  }
}
