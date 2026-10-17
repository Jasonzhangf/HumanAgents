import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import type { CheckpointControlBusinessRequest, CheckpointControlCapabilityRef } from '../../../contracts/src/checkpoint-controls.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import { id, scopeContains, type OperationIntent, type TaskId, type ToolRegistration } from '../../../contracts/src/index.js';
import {
  admitTaskGrantBusiness,
  decideTaskGrantAdmission,
  validateTaskGrantReadback,
  type TaskGrantAuthority,
  type TaskGrantBusinessRegistration,
  type TaskGrantPort,
  type TaskGrantRegistrationPort,
} from '../../../runtime/src/admission/task-grant.js';
import type { RuntimeExecutionAllocation } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { ToolExecutionGateway } from '../../../runtime/src/gateway/gateway.js';
import type {
  ExternalOperationLifecycle,
  OperationChildAdmission,
  OperationControlBinding,
  OperationJournalPort,
  OperationPermissionPort,
  OperationSnapshot,
  OperationTaskBoundaryPort,
} from '../../../runtime/src/gateway/ports.js';
import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { createJsonlOperationControlJournal } from '../operation-control-journal.js';
import { AppLifecycleError } from '../errors.js';

import type { AdmittedExecutionInput } from '../prepared-execution-input.js';
import { validateNativeSegmentSaveSourceV2, type NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
export type { AdmittedExecutionInput } from '../prepared-execution-input.js';
import type { RegisteredParentChildCall } from '../../../runtime/src/orchestration/types.js';

/** Actual parent owner facts; only the admission binding is filled here. */
export type PreparedParentLifecycle = Omit<ExternalOperationLifecycle, 'control'> & {
  readonly control: Omit<ExternalOperationLifecycle['control'], 'binding'>;
};

export interface ExecutionAdmissionReceipt {
  readonly authority: TaskGrantAuthority;
  readonly authorityCommitRef: JournalCommitRef;
  readonly businessRegistrationCommitRef: JournalCommitRef;
  readonly coverageCommitRef: JournalCommitRef;
  readonly binding: OperationControlBinding;
  readonly parent: OperationSnapshot;
}

/** Distinct facts returned by one explicit child tool-operation admission. */
export interface ToolOperationAdmissionReceipt {
  readonly authority: TaskGrantAuthority;
  readonly authorityCommitRef: JournalCommitRef;
  readonly businessRegistrationCommitRef: JournalCommitRef;
  readonly coverageCommitRef: JournalCommitRef;
  readonly childAdmission: OperationChildAdmission;
}

export interface ExecutionAdmissionOptions {
  readonly organJournal: JsonlOrganJournal;
  readonly taskGrantPort: TaskGrantPort;
  readonly principalOwner: string;
  /** Actual capability/scope declaration for an operation, never an intent echo. */
  readonly capabilityFor: (input: {
    readonly intent: OperationIntent;
    readonly registration: ToolRegistration;
  }) => CheckpointControlCapabilityRef;
  readonly resourceBoundary: OperationTaskBoundaryPort;
  readonly resolveAdmittedInput: (allocation: RuntimeExecutionAllocation) => Promise<AdmittedExecutionInput>;
  readonly createGateway: (ports: {
    readonly journal: OperationJournalPort;
    readonly permissions: OperationPermissionPort;
    readonly taskBoundaries: OperationTaskBoundaryPort;
  }) => ToolExecutionGateway;
}

function invalid(message: string): never {
  throw new AppLifecycleError('execution-admission-input-conflict', message,
    'supply the actual immutable allocation input and parent lifecycle facts before releasing execution',
    'humanagent.app.execution-admission');
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string },
  right: { readonly scope: string; readonly value: string },
): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

/**
 * One child business registration readback. It is the only place the concrete
 * grant journal exposes the durable typed child provenance; the grant port
 * itself never carries it.
 */
interface BusinessRegistrationReadPort {
  readBusinessRegistration(input: {
    readonly taskId: TaskId;
    readonly requestRef: string;
  }): Promise<{
    readonly registration: TaskGrantBusinessRegistration;
    readonly commit: JournalCommitRef;
  } | null>;
}

export function executionAdmissionInputDigest(allocation: RuntimeExecutionAllocation, input: AdmittedExecutionInput): string {
  if (input.inputRevision !== allocation.inputRevision
    || canonicalJsonStringify(input.inputRefs) !== canonicalJsonStringify(allocation.inputRefs)) {
    invalid('admitted input does not match the allocated immutable input identity');
  }
  return `sha256:${createHash('sha256').update(canonicalJsonStringify({ allocation, input })).digest('hex')}`;
}

/** Composes existing grant and lifecycle owners over the supplied physical Journal. */
export function createExecutionAdmission(options: ExecutionAdmissionOptions) {
  const journal = createJsonlOperationControlJournal({ journal: options.organJournal });
  const permissions: OperationPermissionPort = {
    async readGrant(input) {
      const readback = await options.taskGrantPort.readTaskGrant(input.intent.taskId);
      validateTaskGrantReadback(readback);
      if (readback.grant === null || readback.commit === null) return null;
      const request: CheckpointControlBusinessRequest = {
        requestRef: input.intent.inputRef,
        taskId: input.intent.taskId,
        owner: options.principalOwner,
        capability: options.capabilityFor(input),
        inputIdentity: { requestRef: input.intent.inputRef, digest: input.intent.inputDigest },
      };
      // Check the same canonical policy with its real capability/scope. Preserve
      // revoked evidence for closure reads, while Gateway denies active effects.
      const decision = decideTaskGrantAdmission({ request, readback });
      if (!decision.allowed && decision.reason !== 'revoked') return null;
      return {
        scope: readback.grant.capability.scope,
        revoked: readback.grant.state === 'revoked',
        evidenceRefs: [{
          evidenceId: id('evidence', `task-grant-${createHash('sha256').update(readback.commit.commitId).digest('hex')}`),
          kind: 'operation',
          source: 'humanagent.task-grant',
          locator: readback.commit.commitId,
          digest: readback.commit.recordDigest,
          scope: readback.grant.capability.scope,
        }],
      };
    },
  };
  const gateway = options.createGateway({ journal, permissions, taskBoundaries: options.resourceBoundary });

  async function admitNewBusiness<T>(input: {
    readonly request: CheckpointControlBusinessRequest;
    readonly register: (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => Promise<T>;
  }): Promise<T> {
    return await admitTaskGrantBusiness({ ...input, port: options.taskGrantPort, principalOwner: options.principalOwner });
  }

  async function admitExecution(input: {
    readonly allocation: RuntimeExecutionAllocation;
    readonly requestRef: string;
    readonly capability: CheckpointControlCapabilityRef;
    readonly parentLifecycle: PreparedParentLifecycle;
  }): Promise<ExecutionAdmissionReceipt> {
    const { allocation, parentLifecycle } = input;
    const admittedInput = await options.resolveAdmittedInput(allocation);
    const digest = executionAdmissionInputDigest(allocation, admittedInput);
    const { intent, route } = parentLifecycle.control;
    if (intent.operationId.value !== allocation.operationId.value
      || intent.taskId.value !== allocation.taskId.value
      || intent.cycleId.value !== allocation.scope.cycleId?.value
      || intent.inputDigest !== digest
      || !allocation.inputRefs.includes(intent.inputRef)
      || canonicalJsonStringify(intent.requestedScope) !== canonicalJsonStringify(allocation.scope)
      || canonicalJsonStringify(route.effectiveScope) !== canonicalJsonStringify(allocation.scope)
      || input.capability.scope.organId.value !== allocation.scope.organId.value
      || input.capability.scope.taskId?.value !== allocation.taskId.value) {
      invalid('parent lifecycle or task capability does not match the actual allocated execution');
    }
    const request: CheckpointControlBusinessRequest = {
      requestRef: input.requestRef,
      taskId: allocation.taskId,
      owner: options.principalOwner,
      capability: input.capability,
      inputIdentity: { requestRef: intent.inputRef, digest },
    };
    const registered = await admitNewBusiness({ request, register: async (authority, registration) => ({
      authority,
      businessRegistrationCommitRef: await registration.registerBusiness({
        ...request,
        owner: authority.owner,
        grantRevision: authority.grant.revision,
      }),
    }) });
    // The grant transaction has returned. Coverage and the parent commit must
    // acquire their own Journal lock here, before any caller starts effects.
    const binding: OperationControlBinding = {
      scope: allocation.scope,
      agentRuntimeId: allocation.runtimeId,
      harnessExecutionEpoch: allocation.executionEpoch,
      parentOperationId: allocation.operationId,
      admissionCommitRef: registered.businessRegistrationCommitRef,
    };
    const coverageCommitRef = await gateway.initializeCoverage(binding);
    const parent = await gateway.applyExternalLifecycle({
      ...parentLifecycle,
      control: { ...parentLifecycle.control, binding },
    });
    return {
      ...registered,
      authorityCommitRef: registered.authority.commit,
      coverageCommitRef,
      binding,
      parent,
    };
  }

  async function bindingFor(allocation: RuntimeExecutionAllocation): Promise<OperationControlBinding> {
    const readback = await gateway.readControl({
      scope: allocation.scope,
      agentRuntimeId: allocation.runtimeId,
      harnessExecutionEpoch: allocation.executionEpoch,
    });
    if (readback.state !== 'complete') invalid('operation control coverage is unknown');
    const parent = readback.operations.find((record) => record.intent.operationId.value === allocation.operationId.value);
    if (parent === undefined
      || parent.binding.agentRuntimeId !== allocation.runtimeId
      || parent.binding.harnessExecutionEpoch !== allocation.executionEpoch
      || parent.binding.parentOperationId.value !== allocation.operationId.value
      || canonicalJsonStringify(parent.binding.scope) !== canonicalJsonStringify(allocation.scope)) {
      invalid('the allocated parent has no exact durable operation control binding');
    }
    return parent.binding;
  }

  /** New physical control coverage retains the original immutable input/admission. */
  async function bindCommittedSegment(allocation: RuntimeExecutionAllocation, source: NativeSegmentSaveSourceV2, occurredAt: string): Promise<OperationControlBinding> {
    validateNativeSegmentSaveSourceV2(source);
    const physical = source.opened.binding;
    if (physical.assignment.assignmentId !== allocation.assignmentId
      || physical.assignment.inputRevision !== allocation.inputRevision
      || canonicalJsonStringify(physical.scope) !== canonicalJsonStringify(allocation.scope)
      || source.originalAdmittedTurn.executionEpoch !== allocation.executionEpoch) {
      invalid('committed segment conflicts with retained business allocation');
    }
    const original = await bindingFor(allocation);
    const control = await gateway.readControl({ scope: allocation.scope, agentRuntimeId: original.agentRuntimeId,
      harnessExecutionEpoch: original.harnessExecutionEpoch });
    if (control.state !== 'complete') invalid('original parent control is unknown');
    const parent = control.operations.find((item) => item.intent.operationId.value === allocation.operationId.value);
    if (!parent) invalid('original parent controller is absent');
    const binding: OperationControlBinding = { ...original, agentRuntimeId: physical.execution.runtimeId,
      harnessExecutionEpoch: physical.execution.executionEpoch, admissionCommitRef: source.opened.businessRegistrationCommitRef };
    await gateway.initializeCoverage(binding);
    const executionEpoch = parent.executionEpoch + 1;
    const { result: _oldResult, ...parentControl } = parent;
    await gateway.applyExternalLifecycle({ control: { ...parentControl, binding, executionEpoch, status: 'accepted' },
      event: { eventId: `segment-parent-admitted:${source.opened.segmentId}`, schemaVersion: 1,
        kind: 'operation.accepted', operationId: allocation.operationId, taskId: allocation.taskId,
        executionEpoch, status: 'accepted', occurredAt, evidenceRefs: [] } });
    return binding;
  }

  /**
   * Actual explicit child tool-operation admission. It exact-reads the durable
   * parent control and coverage, checks the current resource boundary for the
   * child effect scope, and registers one child business fact with typed
   * provenance under the canonical grant lock. It never initializes coverage,
   * fabricates a child allocation, or starts IO: the caller releases the grant
   * lock first, then submits the child control and runs the effect.
   */
  async function admitToolOperation(input: {
    readonly binding: OperationControlBinding;
    readonly intent: OperationIntent;
    readonly registration: ToolRegistration;
    readonly providerRequestId: string;
    readonly toolCallId: string;
  }): Promise<ToolOperationAdmissionReceipt> {
    const { binding, intent, registration } = input;
    if (typeof input.providerRequestId !== 'string' || input.providerRequestId.trim().length === 0) {
      invalid('child admission requires the actual typed Provider request id');
    }
    if (typeof input.toolCallId !== 'string' || input.toolCallId.trim().length === 0) {
      invalid('child admission requires the actual Provider tool call id');
    }
    if (intent.requestedScope.operationId === undefined
      || !sameScopedId(intent.requestedScope.operationId, intent.operationId)) {
      invalid('child intent must name its own operation in the requested scope');
    }
    if (!sameScopedId(intent.requestedScope.organId, binding.scope.organId)
      || intent.requestedScope.taskId === undefined
      || binding.scope.taskId === undefined
      || !sameScopedId(intent.requestedScope.taskId, binding.scope.taskId)
      || intent.requestedScope.cycleId === undefined
      || binding.scope.cycleId === undefined
      || !sameScopedId(intent.requestedScope.cycleId, binding.scope.cycleId)) {
      invalid('child effect scope must share the admitted parent organ, task and cycle namespace');
    }
    const readback = await gateway.readControl({
      scope: binding.scope,
      agentRuntimeId: binding.agentRuntimeId,
      harnessExecutionEpoch: binding.harnessExecutionEpoch,
      operationId: binding.parentOperationId,
    });
    if (readback.state !== 'complete') invalid('child admission parent control namespace is unknown');
    const index = readback.operations.findIndex((record) => sameScopedId(record.intent.operationId, binding.parentOperationId));
    const parent = index < 0 ? undefined : readback.operations[index];
    if (parent === undefined
      || parent.binding.agentRuntimeId !== binding.agentRuntimeId
      || parent.binding.harnessExecutionEpoch !== binding.harnessExecutionEpoch
      || !sameScopedId(parent.binding.parentOperationId, binding.parentOperationId)
      || !sameCommitRef(parent.binding.admissionCommitRef, binding.admissionCommitRef)
      || canonicalJsonStringify(parent.binding.scope) !== canonicalJsonStringify(binding.scope)) {
      invalid('child admission binding does not match the exact durable parent control');
    }
    const boundary = await options.resourceBoundary.readBoundary({ intent, registration });
    if (!boundary || !scopeContains(boundary.scope, intent.requestedScope)) {
      invalid('child effect scope exceeds the current task resource boundary');
    }
    const capability = options.capabilityFor({ intent, registration });
    const parentControlCommitRef = readback.operationCommits[index]!;
    const coverageCommitRef = readback.coverageCommitRef;
    const requestRef = [
      'provider-tool',
      binding.agentRuntimeId,
      String(binding.harnessExecutionEpoch),
      binding.parentOperationId.value,
      input.providerRequestId,
      input.toolCallId,
    ].join(':');
    const request: CheckpointControlBusinessRequest = {
      requestRef,
      taskId: intent.taskId,
      owner: options.principalOwner,
      capability,
      inputIdentity: { requestRef: intent.inputRef, digest: intent.inputDigest },
    };
    const registered = await admitTaskGrantBusiness({
      port: options.taskGrantPort,
      request,
      principalOwner: options.principalOwner,
      register: async (authority, registrationPort) => ({
        authority,
        businessRegistrationCommitRef: await registrationPort.registerBusiness({
          ...request,
          owner: authority.owner,
          grantRevision: authority.grant.revision,
          operationProvenance: {
            kind: 'provider-tool',
            parentNamespace: binding.scope,
            parentOperationId: binding.parentOperationId,
            parentAdmissionCommitRef: binding.admissionCommitRef,
            parentControlCommitRef,
            agentRuntimeId: binding.agentRuntimeId,
            harnessExecutionEpoch: binding.harnessExecutionEpoch,
            operationId: intent.operationId,
            effectScope: intent.requestedScope,
            providerRequestId: input.providerRequestId,
            toolCallId: input.toolCallId,
            authorityCommitRef: authority.commit,
            coverageCommitRef,
          },
        }),
      }),
    });
    return {
      authority: registered.authority,
      authorityCommitRef: registered.authority.commit,
      businessRegistrationCommitRef: registered.businessRegistrationCommitRef,
      coverageCommitRef,
      childAdmission: {
        authorityCommitRef: registered.authority.commit,
        businessRegistrationCommitRef: registered.businessRegistrationCommitRef,
        coverageCommitRef,
      },
    };
  }

  /**
   * Exact read seam for the durable parent control binding a registered child
   * tool operation must join. A `ToolOperationAdmissionReceipt` carries three
   * commit references, never a binding; the only durable source of the parent
   * namespace, operation, admission and control facts is the typed provenance
   * on the registered child business. This rebuilds the binding from that
   * provenance and then physically confirms it against the live parent control
   * before returning it. It never casts a receipt into a binding, and it never
   * reads or writes anything the child operation did not already register.
   */
  async function readChildToolBinding(input: {
    readonly call: RegisteredParentChildCall;
    readonly operation: ToolOperationAdmissionReceipt;
  }): Promise<OperationControlBinding> {
    const { call, operation } = input;
    if (!sameCommitRef(call.businessRegistrationCommitRef, operation.businessRegistrationCommitRef)) {
      invalid('child binding read receipt does not name the registered child business commit');
    }
    if (typeof call.providerRequestId !== 'string' || call.providerRequestId.trim().length === 0
      || typeof call.toolCallId !== 'string' || call.toolCallId.trim().length === 0) {
      invalid('child binding read requires the actual Provider request and tool call ids');
    }
    if (!Number.isSafeInteger(call.parentExecution.executionEpoch) || call.parentExecution.executionEpoch < 1) {
      invalid('child binding read requires the actual parent Harness epoch');
    }
    // The grant port is a narrow interface; the concrete journal owns the
    // durable provenance read. Absent that exact read, this seam cannot prove
    // the child relationship, so it stops instead of guessing a binding.
    const registrationPort = options.taskGrantPort as TaskGrantPort & Partial<BusinessRegistrationReadPort>;
    if (typeof registrationPort.readBusinessRegistration !== 'function') {
      invalid('the concrete grant journal cannot read the registered child business provenance');
    }
    const requestRef = [
      'provider-tool',
      call.parentExecution.runtimeId,
      String(call.parentExecution.executionEpoch),
      call.parentExecution.operationId.value,
      call.providerRequestId,
      call.toolCallId,
    ].join(':');
    const readback = await registrationPort.readBusinessRegistration({
      taskId: call.parentExecution.taskId,
      requestRef,
    });
    if (readback === null
      || !sameCommitRef(readback.commit, call.businessRegistrationCommitRef)
      || !sameCommitRef(readback.commit, operation.businessRegistrationCommitRef)) {
      invalid('no durable child business registration matches the actual call and admission receipt');
    }
    const provenance = readback.registration.operationProvenance;
    if (provenance === undefined || provenance.kind !== 'provider-tool') {
      invalid('the registered child business carries no typed provider-tool provenance');
    }
    if (!sameCommitRef(provenance.authorityCommitRef, operation.authorityCommitRef)
      || !sameCommitRef(provenance.coverageCommitRef, operation.coverageCommitRef)) {
      invalid('the registered child provenance does not match the admission receipt authority and coverage');
    }
    if (provenance.agentRuntimeId !== call.parentExecution.runtimeId
      || provenance.harnessExecutionEpoch !== call.parentExecution.executionEpoch
      || !sameScopedId(provenance.parentOperationId, call.parentExecution.operationId)
      || provenance.parentNamespace.taskId === undefined
      || !sameScopedId(provenance.parentNamespace.taskId, call.parentExecution.taskId)
      || !Number.isSafeInteger(provenance.harnessExecutionEpoch) || provenance.harnessExecutionEpoch < 1) {
      invalid('the durable child provenance does not describe the actual parent execution');
    }
    // Only the durable provenance may name the parent binding.
    const binding: OperationControlBinding = {
      scope: provenance.parentNamespace,
      agentRuntimeId: provenance.agentRuntimeId,
      harnessExecutionEpoch: provenance.harnessExecutionEpoch,
      parentOperationId: provenance.parentOperationId,
      admissionCommitRef: provenance.parentAdmissionCommitRef,
    };
    // The provenance is an admission-time fact; the live parent control must
    // still carry the exact same binding before any child effect is released.
    const control = await gateway.readControl({
      scope: binding.scope,
      agentRuntimeId: binding.agentRuntimeId,
      harnessExecutionEpoch: binding.harnessExecutionEpoch,
      operationId: binding.parentOperationId,
    });
    if (control.state !== 'complete') invalid('child binding parent control namespace is unknown');
    const parent = control.operations.find((record) => sameScopedId(record.intent.operationId, binding.parentOperationId));
    if (parent === undefined
      || parent.binding.agentRuntimeId !== binding.agentRuntimeId
      || parent.binding.harnessExecutionEpoch !== binding.harnessExecutionEpoch
      || !sameScopedId(parent.binding.parentOperationId, binding.parentOperationId)
      || !sameCommitRef(parent.binding.admissionCommitRef, binding.admissionCommitRef)
      || canonicalJsonStringify(parent.binding.scope) !== canonicalJsonStringify(binding.scope)) {
      invalid('the child binding does not match the exact durable parent control');
    }
    return binding;
  }

  return {
    gateway,
    permissions,
    resourceBoundary: options.resourceBoundary,
    admitNewBusiness,
    admitExecution,
    bindingFor,
    bindCommittedSegment,
    admitToolOperation,
    readChildToolBinding,
  };
}
