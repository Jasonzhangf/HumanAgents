import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  id,
  operationIdempotencyKey,
  operationSemanticFingerprint,
  operationSemanticFingerprintKey,
  validateRouteSelection,
  type EvidenceRef,
  type OperationEvent,
  type OperationResult,
  type ProviderExecutionIdentityRef,
  type ProviderToolDefinition,
  type RawAsset,
  type RouteSelection,
  type ScopeRef,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import type {
  ProviderRequestContextHook,
  ProviderRequestContextUnit,
} from '../../../contracts/src/provider-request-context.js';
import type { StandardTurnEndCommand } from '../../../contracts/src/standard-turn-end.js';
import { newActiveTurnId, produceAdmittedTurn } from '../../../runtime/src/admission/admitted-turn.js';
import { ActiveTurnContext } from '../../../runtime/src/context/active-turn-context.js';
import { projectAdmittedTurnIdentityV1 } from '../../../runtime/src/context/semantic-history.js';
import { readSemanticTurnContext } from '../../../runtime/src/context/semantic-turn-context-reader.js';
import type { ToolExecutionGateway } from '../../../runtime/src/gateway/gateway.js';
import type {
  OperationControlBinding,
  OperationControlRecord,
  OperationPermissionPort,
  OperationTaskBoundaryPort,
} from '../../../runtime/src/gateway/ports.js';
import type {
  RegisteredParentChildCall,
  TaskRuntimeIncarnation,
} from '../../../runtime/src/orchestration/types.js';
import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal } from '../../../adapters/jsonl/src/active-turn.js';
import { evidenceReference, ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import type { ProviderToolExecutionPort } from '../../../adapters/provider/src/agent-driver.js';
import { filesystemProviderEvidenceSink, providerRawContentReader } from '../../../adapters/provider/src/evidence.js';
import type { WebSearchProviderBackendConfig } from '../../../adapters/operations/src/index.js';
import { createNativeRecoveryAssets } from '../native-recovery-assets.js';
import { createJsonlSemanticHistoryJournal } from '../checkpoint-journal.js';
import { createResponsesFileToolExecutor, type ProviderToolAdmissionInput } from '../provider-tool-execution.js';
import {
  createStandardTurnEndExecutor,
  StandardTurnEndError,
  type StandardTurnEndOwnerPort,
} from './standard-turn-control.js';
import {
  ADVERTISED_STANDARD_TURN_END_TOOL,
  createStandardTurnEndWireExecutor,
  isStandardTurnEndCall,
} from './standard-turn-composition.js';
import type {
  BindChildRunPort,
  BoundChildRun,
  ChildBodyAssetPort,
  ChildControlLifecyclePort,
} from './child-producer.js';
import type { ToolOperationAdmissionReceipt } from './execution-admission.js';

const OWNER = 'humanagent.app.child-run-composition';

/**
 * The real admission surface this binder consumes. `createServiceExecutionAdmission`
 * already returns every field except the child read seam, so the composition
 * owner passes its own admission object straight in. This module never adds a
 * second gateway, grant port or boundary.
 */
export interface ChildRunAdmissionPort {
  readonly gateway: ToolExecutionGateway;
  readonly permissions: OperationPermissionPort;
  readonly resourceBoundary: OperationTaskBoundaryPort;
  readonly admitToolOperation: NonNullable<ProviderToolAdmissionInput['admitToolOperation']>;
  readonly readChildToolBinding: (input: {
    readonly call: RegisteredParentChildCall;
    readonly operation: ToolOperationAdmissionReceipt;
  }) => Promise<OperationControlBinding>;
}

export interface ChildRunCompositionInput {
  readonly admission: ChildRunAdmissionPort;
  readonly journal: JsonlOrganJournal;
  /** Same Organ Journal path the parent already owns. The child adds no store. */
  readonly filePath: string;
  /** Immutable asset root the parent already owns; the child reuses it. */
  readonly artifactsRoot: string;
  readonly workspaceRoot: string;
  readonly projectKey: string;
  readonly webSearchProviderConfig?: WebSearchProviderBackendConfig;
  /** The real admitted child tool surface, never an availability echo. */
  readonly tools: readonly ProviderToolDefinition[];
  readonly principalOwner: string;
  readonly now: () => Date;
  readonly rules?: readonly string[];
  /**
   * The owner of the accepted standard-turn-end control event. A child run
   * reaches the same advertised `humanagent_turn_end` action as a parent run;
   * the child call owner must consume the accepted command. Without this
   * wiring an accepted end is not silently swallowed: the route stops visibly.
   */
  readonly routeStandardEnd?: (input: {
    readonly call: RegisteredParentChildCall;
    readonly invocationId: string;
    readonly command: StandardTurnEndCommand;
  }) => Promise<void> | void;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical child operation identity. It derives only from the invocation. */
function childOperationId(invocationId: string) {
  return id('operation', `child-${sha256Hex(invocationId)}`);
}

/** Stable immutable asset id for one full child body. No truncation, no slice. */
function childBodyAssetId(invocationId: string, kind: 'execution' | 'review'): string {
  return `child-body-${kind}-${sha256Hex(`humanagent.child-body.v1:${kind}:${invocationId}`).slice(0, 48)}`;
}

function childAdmissionEvidence(operation: ToolOperationAdmissionReceipt, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `child-business-${sha256Hex(operation.businessRegistrationCommitRef.commitId)}`),
    kind: 'operation',
    source: OWNER,
    locator: operation.businessRegistrationCommitRef.commitId,
    scope,
  };
}

function parentAdmissionEvidence(binding: OperationControlBinding, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `child-parent-admission-${sha256Hex(binding.admissionCommitRef.commitId)}`),
    kind: 'operation',
    source: OWNER,
    locator: binding.admissionCommitRef.commitId,
    scope,
  };
}

/**
 * The child's own control chain over the existing Gateway append owner. The
 * binding is the durable parent namespace binding; the operation identity,
 * registration, admission receipts, route and fingerprint come from the exact
 * admitted child. No parent `task.execute` control is copied.
 */
function createChildControlLifecycle(input: {
  readonly gateway: ToolExecutionGateway;
  readonly binding: OperationControlBinding;
  readonly operation: ToolOperationAdmissionReceipt;
  readonly executionEpoch: number;
  readonly occurredAt: () => string;
  readonly admissionEvidenceRefs: readonly EvidenceRef[];
}): ChildControlLifecyclePort {
  const { intent, registration } = input.operation;
  const route: RouteSelection = {
    operationId: intent.operationId,
    routeId: registration.routeId,
    routeVersion: registration.routeVersion,
    mode: registration.mode,
    contractVersion: registration.contractVersion,
    effectiveScope: intent.requestedScope,
    selectionReason: 'explicit child tool operation admission',
    selectedAt: input.occurredAt(),
  };
  validateRouteSelection(route, registration);
  const base: OperationControlRecord = {
    binding: input.binding,
    childAdmission: input.operation.childAdmission,
    intent,
    registration,
    route,
    status: 'accepted',
    executionEpoch: input.executionEpoch,
    namespaceKey: operationIdempotencyKey(intent),
    fingerprintKey: operationSemanticFingerprintKey(operationSemanticFingerprint(intent, registration)),
  };
  const commit = async (
    status: OperationControlRecord['status'],
    kind: OperationEvent['kind'],
    evidenceRefs: readonly EvidenceRef[],
    result?: OperationResult,
  ): Promise<void> => {
    await input.gateway.applyExternalLifecycle({
      control: { ...base, status, ...(result === undefined ? {} : { result }) },
      event: {
        eventId: `child-control:${kind}:${intent.operationId.value}`,
        schemaVersion: 1,
        kind,
        operationId: intent.operationId,
        taskId: intent.taskId,
        executionEpoch: input.executionEpoch,
        status,
        occurredAt: input.occurredAt(),
        evidenceRefs: [...evidenceRefs],
      },
    });
  };
  return {
    accept: () => commit('accepted', 'operation.accepted', input.admissionEvidenceRefs),
    running: ({ evidenceRefs }) => commit('running', 'operation.started', evidenceRefs),
    settle: ({ status, evidenceRefs, result }) => commit(status,
      status === 'succeeded' ? 'operation.completed'
        : status === 'failed' ? 'operation.failed'
        : status === 'cancelled' ? 'operation.cancelled'
        : 'operation.blocked',
      evidenceRefs,
      result),
  };
}

/**
 * The child's own work assignment. Execution children carry the assignment the
 * manager already prepared; review children derive one from the verified review
 * assignment and the resolved review material. Every field comes from real
 * inputs; nothing here invents a criteria digest or a capability.
 */
function childWorkAssignment(
  request: Parameters<BindChildRunPort>[0]['request'],
  incarnation: TaskRuntimeIncarnation,
): WorkAssignment {
  if (request.kind === 'execution') {
    const assignment = request.input.assignment;
    if (assignment.executionEpoch !== incarnation.executionEpoch) {
      throw new StandardTurnEndError(
        'child-run.assignment-epoch',
        'the execution assignment epoch does not match the actual child incarnation',
      );
    }
    return assignment;
  }
  const review = request.input.reviewAssignment;
  if (review.executionEpoch !== incarnation.executionEpoch) {
    throw new StandardTurnEndError(
      'child-run.assignment-epoch',
      'the review assignment epoch does not match the actual child incarnation',
    );
  }
  const criteria = request.input.reviewMaterial.acceptanceCriteria;
  if (criteria.trim() === '') {
    throw new StandardTurnEndError('child-run.review-criteria', 'the verified review material has no acceptance criteria');
  }
  return {
    assignmentId: incarnation.assignmentId,
    taskId: incarnation.taskId,
    pipelineNodeId: 'child.review',
    attempt: review.attempt,
    executionEpoch: incarnation.executionEpoch,
    inputRevision: review.inputRevision,
    objective: criteria,
    targetRefs: [...review.subjectRefs],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: review.acceptanceCriteriaDigest,
    successCriteria: [criteria],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [...review.requiredCapabilities],
    mergeGate: review.mergeGate,
  };
}

/** The exact immutable initial input bytes for one child run. Never sliced. */
function childInitialInput(
  request: Parameters<BindChildRunPort>[0]['request'],
  assignment: WorkAssignment,
): string {
  if (request.kind === 'execution') return assignment.objective;
  const material = request.input.reviewMaterial;
  return canonicalJsonStringify({
    acceptanceCriteria: material.acceptanceCriteria,
    acceptanceCriteriaDigest: request.input.reviewAssignment.acceptanceCriteriaDigest,
    reviewKind: request.input.reviewAssignment.reviewKind,
    subjects: material.subjects,
    executorEvidence: material.executorEvidence ?? [],
  });
}

/**
 * The independent child run binder. It builds the real child binding from the
 * durable registered parent business, opens the child's own `ActiveTurnContext`,
 * binds the native raw/registration/context ports to that child turn, and
 * returns the child tool executor plus the bound standard-turn-end owner.
 *
 * It never casts a `ToolOperationAdmissionReceipt` into a binding, never borrows
 * the parent executor, raw hooks or history, and never guesses payload
 * authority. A missing field stops this child visibly instead of faking success.
 */
export function createChildRunComposition(input: ChildRunCompositionInput): {
  readonly bindChildRun: BindChildRunPort;
  readonly bodyAssets: ChildBodyAssetPort;
} {
  if (!input.filePath.trim()) throw new StandardTurnEndError('child-run.path', 'child run requires the shared Organ Journal path');
  if (!input.artifactsRoot.trim()) throw new StandardTurnEndError('child-run.path', 'child run requires the shared immutable asset root');
  const rawStore = new ImmutableAssetStore(input.artifactsRoot);
  const rawEvidence = filesystemProviderEvidenceSink(rawStore);
  const rules = input.rules ?? [];

  const bindChildRun: BindChildRunPort = async ({ call, operation, incarnation, scope, request }) => {
    if (call.invocationId.trim() === '') {
      throw new StandardTurnEndError('child-run.invocation', 'child run requires the actual invocation identity');
    }
    // The durable registered child business is the only source of the parent
    // binding the child's tool effects must join.
    const parentBinding = await input.admission.readChildToolBinding({ call, operation });
    const childOpId = childOperationId(call.invocationId);
    const childScope: ScopeRef = { ...scope, operationId: childOpId };
    const childExecution: ProviderExecutionIdentityRef = {
      runtimeId: incarnation.runtimeId,
      taskId: incarnation.taskId,
      operationId: childOpId,
      executionEpoch: incarnation.executionEpoch,
    };
    const assignment = childWorkAssignment(request, incarnation);
    const turnId = newActiveTurnId(childOpId.value);
    const currentTurnRef = `active-turn://${turnId}`;
    const admissionEvidence = [childAdmissionEvidence(operation, childScope)];
    const recoveryStateRef = parentAdmissionEvidence(parentBinding, childScope);
    const control = createChildControlLifecycle({
      gateway: input.admission.gateway,
      binding: parentBinding,
      operation,
      executionEpoch: incarnation.executionEpoch,
      occurredAt: () => input.now().toISOString(),
      admissionEvidenceRefs: admissionEvidence,
    });
    const admittedTurn = produceAdmittedTurn({
      runtime: {
        runtimeId: incarnation.runtimeId,
        executionEpoch: incarnation.executionEpoch,
        ownerRef: operation.authority.owner,
        permissionRevision: operation.authority.permissionRevision,
      },
      taskId: incarnation.taskId,
      scope: childScope,
      assignment,
      directiveRevision: assignment.inputRevision,
      turnId,
      currentTurnRef,
      admissionEvidence,
      recoveryStateRef,
    });
    const activeTurnJournal = createJsonlActiveTurnJournal({ filePath: input.filePath, journal: input.journal, turnId });
    const active = await ActiveTurnContext.open({
      journal: activeTurnJournal,
      currentTurnRef,
      binding: {
        admittedTurn,
        assignment,
        execution: { runtimeId: incarnation.runtimeId, executionEpoch: incarnation.executionEpoch },
        scope: childScope,
      },
    });
    const recovery = createNativeRecoveryAssets({
      journalPath: input.filePath,
      journal: input.journal,
      assetRoot: input.artifactsRoot,
    });
    await active.registerInitialInput(
      await recovery.writeInitialInput({ scope: childScope, turnId, rawInput: childInitialInput(request, assignment) }),
    );

    const rawContent = providerRawContentReader(rawEvidence);
    const timeAuthority = {
      source: 'harness' as const,
      owner: 'runtime-checkpoint-control-owner' as const,
      authorityRef: `child-turn:${turnId}`,
      sampleCommittedAt: async () => input.now().toISOString(),
    };
    const semantic = createJsonlSemanticHistoryJournal({
      filePath: input.filePath,
      journal: input.journal,
      artifactsRoot: input.artifactsRoot,
      activeTurnJournal,
      rawContent,
      timeAuthority,
    });

    const requestContext: ProviderRequestContextHook = async (driverRequest) => {
      if (driverRequest.execution.runtimeId !== childExecution.runtimeId
        || driverRequest.execution.executionEpoch !== childExecution.executionEpoch
        || driverRequest.execution.taskId.value !== childExecution.taskId.value
        || driverRequest.execution.operationId.value !== childExecution.operationId.value) {
        throw new StandardTurnEndError('child-run.request-binding', 'child request context does not match the admitted child binding');
      }
      const resolved = await readSemanticTurnContext({
        history: semantic,
        priorCompletedTurns: [],
        live: { prefix: await active.readLivePrefix(currentTurnRef), rawContent },
        runtimeId: childExecution.runtimeId,
        scope: childScope,
        assignment,
        rules,
      });
      const units: ProviderRequestContextUnit[] = [];
      const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      for (const message of resolved.context.messages) {
        if (message.kind === 'semantic-turn-prefix') units.push({ kind: 'message', role: 'user', text: canonicalJsonStringify({
          objective: message.objective, rules: message.rules, successCriteria: message.successCriteria,
          failureCriteria: message.failureCriteria, incompleteCriteria: message.incompleteCriteria }) });
        else if (message.kind === 'semantic-checkpoint') units.push({ kind: 'message', role: 'assistant', text: canonicalJsonStringify({
          goal: message.checkpoint.goal, actions: message.checkpoint.did, result: message.checkpoint.result, nextStep: message.checkpoint.next }) });
        else if (message.kind === 'refined-child') units.push({ kind: 'message', role: 'assistant', text: text(message.bytes) });
        else {
          const unit = message.message;
          if (unit.kind === 'initial-input') units.push({ kind: 'message', role: 'user', text: text(unit.bytes) });
          else if (unit.kind === 'content') units.push({ kind: 'message', role: 'assistant', text: text(unit.bytes) });
          else if (unit.kind === 'tool-call') units.push({ kind: 'tool-call', callId: unit.callId, toolId: unit.toolId, arguments: unit.arguments });
          else units.push({ kind: 'tool-result', callId: unit.callId, toolId: unit.toolId, output: text(unit.rawOutput), status: unit.status, evidenceRefs: [unit.rawOutputRef, ...unit.evidenceRefs] });
        }
      }
      return { canonical: { units }, ...(resolved.instructions === undefined ? {} : { instructions: resolved.instructions }) };
    };

    const endOwner: StandardTurnEndOwnerPort = {
      async resolveBoundTurn({ execution }) {
        if (execution.runtimeId !== childExecution.runtimeId
          || execution.executionEpoch !== childExecution.executionEpoch
          || execution.taskId.value !== childExecution.taskId.value
          || execution.operationId.value !== childExecution.operationId.value) return null;
        return projectAdmittedTurnIdentityV1(admittedTurn);
      },
      async resolveDelivery({ deliveryRefs }) {
        const prefix = await active.readLivePrefix(currentTurnRef);
        const candidates: EvidenceRef[] = [admissionEvidence[0]!];
        for (const entry of prefix.entries) {
          if (!('envelope' in entry)) continue;
          const fact = entry.envelope.fact;
          if (fact.kind !== 'tool-result') continue;
          for (const ref of fact.result.evidenceRefs) candidates.push(ref);
          // The parent-scoped accepted raw-output citation is also a legal delivery
          // reference. It is added only when its accepted scope exactly matches the
          // child's own admitted scope; no task equality or alias substitutes for it.
          if (canonicalJsonStringify(fact.rawOutput.ref.scope) === canonicalJsonStringify(entry.envelope.scope)
            && canonicalJsonStringify(fact.rawOutput.ref.scope) === canonicalJsonStringify(childScope)) {
            candidates.push(fact.rawOutput.ref);
          }
        }
        const byReference = new Map<string, EvidenceRef>();
        for (const ref of candidates) {
          byReference.set(ref.evidenceId.value, ref);
          byReference.set(ref.locator, ref);
        }
        const resolved: EvidenceRef[] = [];
        for (const reference of deliveryRefs) {
          const match = byReference.get(reference);
          if (!match || match.scope.taskId?.value !== childScope.taskId?.value) {
            throw new StandardTurnEndError(
              'child-run.delivery-unresolved',
              `delivery reference ${reference} does not resolve to evidence scoped to this child turn`,
            );
          }
          resolved.push(match);
        }
        return resolved;
      },
    };
    const endExecutor = createStandardTurnEndWireExecutor(endOwner, createStandardTurnEndExecutor({
      owner: endOwner,
      route: (command) => {
        if (input.routeStandardEnd === undefined) {
          throw new StandardTurnEndError(
            'child-run.standard-end-owner',
            'an accepted child standard turn end has no owner to route to',
          );
        }
        return input.routeStandardEnd({ call, invocationId: call.invocationId, command });
      },
    }));

    const providerTool = createResponsesFileToolExecutor({
      workspaceRoot: input.workspaceRoot,
      projectKey: input.projectKey,
      artifactRoot: input.artifactsRoot,
      ...(input.webSearchProviderConfig === undefined ? {} : { webSearchProviderConfig: input.webSearchProviderConfig }),
      admission: {
        organJournal: input.journal,
        currentTaskGrantPort: input.admission.permissions,
        principalOwner: input.principalOwner,
        resourceBoundary: input.admission.resourceBoundary,
        // A child tool effect never resolves a parent allocation; the exact
        // child route below is the only path a child request may take.
        bindingFor: async () => {
          throw new StandardTurnEndError(
            'child-run.parent-route',
            'a child tool request must resolve through the child binding route',
          );
        },
        childBindingFor: async (driverRequest) => {
          if (canonicalJsonStringify(driverRequest.execution) !== canonicalJsonStringify(childExecution)
            || canonicalJsonStringify(driverRequest.scope) !== canonicalJsonStringify(childScope)) return null;
          return { execution: childExecution, scope: childScope, binding: parentBinding };
        },
        admitToolOperation: input.admission.admitToolOperation,
        now: input.now,
      },
    });

    const toolExecution: ProviderToolExecutionPort = {
      async execute(driverRequest) {
        if (isStandardTurnEndCall(driverRequest.call.toolId)) return endExecutor.execute(driverRequest);
        return providerTool.executor.execute(driverRequest);
      },
    };

    const bound: BoundChildRun = {
      native: {
        rawEvidence,
        acceptRawFact: (envelope) => active.acceptRawFact(envelope),
        registerRequest: (registration) => active.registerProviderRequest(registration),
        requestContext,
      },
      toolDefinitions: [...input.tools, ADVERTISED_STANDARD_TURN_END_TOOL],
      toolExecution,
      standardEndOwner: endOwner,
      control,
    };
    return bound;
  };

  const bodyAssets = createChildBodyAssetPort({ store: new ImmutableAssetStore(input.artifactsRoot) });
  return { bindChildRun, bodyAssets };
}

/**
 * Immutable child body asset port over the existing `ImmutableAssetStore`. It
 * exposes exactly three closures: a stable invocation/kind target, a full-byte
 * write, and a digest-verified full-byte read. It never mints a product, never
 * truncates or slices a body, and never introduces a second asset store.
 */
export function createChildBodyAssetPort(input: { readonly store: ImmutableAssetStore }): ChildBodyAssetPort {
  return {
    target({ invocationId, kind }) {
      return `child-body:${kind}:${invocationId}`;
    },
    async write({ scope, invocationId, kind, body }) {
      const reference = await input.store.write(childBodyAssetId(invocationId, kind), new TextEncoder().encode(body));
      return { ref: evidenceReference(reference, scope, 'operation', `${OWNER}.body`), view: { kind: 'utf8-text' } } satisfies RawAsset;
    },
    async read(asset) {
      return input.store.readEvidence(asset.ref);
    },
  };
}
