import type {
  DecisionTraceAdmission,
  DecisionTraceRecord,
  FrameworkExecutionTrace,
  InteractionDecision,
  OperationId,
  SemanticDecisionTrace,
  ToolDecisionTrace,
  ToolIntent,
} from '../../../contracts/src/index.js';
import {
  ExplicitBrainAdmissionError,
  admitToolIntent,
  type ExplicitBrainAdmissionReceipt,
  type ExplicitBrainRuntimeBinding,
  type ExplicitBrainOperationalToolPorts,
  type ExplicitBrainToolRegistry,
} from './tool-registry.js';
import { ExplicitBrainOperationalToolExecutor } from './operational-tools.js';
import type { DecisionTracePort } from './attention.js';

export interface ExplicitBrainDecisionTraceContext {
  readonly scopeRef: string;
  readonly runtimeBindingRef: string;
  readonly ownerRef: string;
  readonly createdAt: string;
  readonly inputDigest: string;
  readonly argumentsRef: (intent: ToolIntent) => string;
  readonly attentionRef?: string;
  readonly bugRef?: string;
  readonly taskRef?: string;
  readonly operationRef?: string;
}

export interface ExplicitBrainToolHandler<TResult> {
  execute(intent: ToolIntent, receipt: ExplicitBrainAdmissionReceipt): Promise<TResult | ExplicitBrainHandlerResult<TResult>>;
}

export interface ExplicitBrainToolOutcome {
  readonly operationId?: OperationId;
  readonly effectRefs?: readonly string[];
  readonly resultRef?: string;
  readonly eventRefs?: readonly string[];
  readonly notificationOperationRefs?: readonly string[];
  readonly failureRef?: string;
  readonly stateTransitionRef?: string;
  readonly downstreamRouteRef?: string;
  readonly finalReceiptRef?: string;
  readonly admission?: DecisionTraceAdmission;
  readonly settlement?: FrameworkExecutionTrace['settlement'];
}

export interface ExplicitBrainHandlerResult<TResult> {
  readonly value: TResult;
  readonly trace?: ExplicitBrainToolOutcome;
}

export interface ExplicitBrainExecutionResult<TResult> {
  readonly intent: ToolIntent;
  readonly receipt: ExplicitBrainAdmissionReceipt;
  readonly result: TResult;
  readonly trace: DecisionTraceRecord;
}

export class ExplicitBrainDecisionError<TResult = unknown> extends Error {
  readonly trace: DecisionTraceRecord;
  readonly admission: DecisionTraceAdmission;
  readonly cause: unknown;
  readonly result?: TResult;

  constructor(input: {
    readonly message: string;
    readonly admission: DecisionTraceAdmission;
    readonly trace: DecisionTraceRecord;
    readonly cause: unknown;
    readonly result?: TResult;
  }) {
    super(input.message);
    this.name = 'ExplicitBrainDecisionError';
    this.trace = input.trace;
    this.admission = input.admission;
    this.cause = input.cause;
    this.result = input.result;
  }
}

function traceId(prefix: string, decision: InteractionDecision, intent: ToolIntent): string {
  return `${prefix}:${decision.decisionId}:${intent.toolIntentId}`;
}

function admissionFromError(error: unknown): DecisionTraceAdmission {
  if (!(error instanceof ExplicitBrainAdmissionError)) return 'rejected';
  switch (error.code) {
    case 'stale-epoch':
      return 'stale';
    case 'capability-denied':
      return 'capability-denied';
    case 'permission-denied':
    case 'missing-confirmation':
      return 'permission-denied';
    default:
      return 'rejected';
  }
}

function isHandlerResult<TResult>(value: TResult | ExplicitBrainHandlerResult<TResult>): value is ExplicitBrainHandlerResult<TResult> {
  return typeof value === 'object' && value !== null && 'value' in value;
}

function isOperationalTool(toolRef: ToolIntent['toolRef']): boolean {
  return toolRef === 'workspace.list'
    || toolRef === 'file.read'
    || toolRef === 'file.search'
    || toolRef === 'agent.query'
    || toolRef === 'agent.message';
}

export class ExplicitBrainDecisionExecutor<TResult> {
  private readonly operationalExecutor?: ExplicitBrainOperationalToolExecutor<TResult>;

  constructor(private readonly input: {
    readonly registry: ExplicitBrainToolRegistry;
    readonly binding: ExplicitBrainRuntimeBinding;
    readonly traces: DecisionTracePort;
    readonly handler: ExplicitBrainToolHandler<TResult>;
    readonly context: ExplicitBrainDecisionTraceContext;
    readonly currentEpoch: number;
    readonly currentPermissionRevision: string;
    readonly argumentsDigest: (args: Readonly<Record<string, unknown>>) => string;
    readonly operationalPorts?: ExplicitBrainOperationalToolPorts;
  }) {
    if (input.operationalPorts !== undefined) {
      this.operationalExecutor = new ExplicitBrainOperationalToolExecutor<TResult>({
        binding: input.binding,
        ports: input.operationalPorts,
      });
    }
  }

  async execute(decision: InteractionDecision): Promise<readonly ExplicitBrainExecutionResult<TResult>[]> {
    if (decision.toolIntents.length === 0) {
      throw new ExplicitBrainDecisionError({
        message: 'explicit brain decision requires at least one tool intent',
        admission: 'rejected',
        trace: this.appendTrace(decision, undefined, 'rejected', undefined, 'tool-intent-required'),
        cause: new Error('tool intent is required'),
      });
    }
    const results: ExplicitBrainExecutionResult<TResult>[] = [];
    for (const intent of decision.toolIntents) {
      results.push(await this.executeIntent(decision, intent));
    }
    return results;
  }

  private async executeIntent(
    decision: InteractionDecision,
    intent: ToolIntent,
  ): Promise<ExplicitBrainExecutionResult<TResult>> {
    let receipt: ExplicitBrainAdmissionReceipt;
    try {
      receipt = admitToolIntent({
        registry: this.input.registry,
        binding: this.input.binding,
        intent,
        currentEpoch: this.input.currentEpoch,
        currentPermissionRevision: this.input.currentPermissionRevision,
        argumentsDigest: this.input.argumentsDigest,
        ...(this.input.operationalPorts === undefined ? {} : { operationalPorts: this.input.operationalPorts }),
      });
    } catch (error) {
      const admission = admissionFromError(error);
      const trace = this.appendTrace(decision, intent, admission, undefined, error instanceof Error ? error.message : String(error));
      throw new ExplicitBrainDecisionError({
        message: error instanceof Error ? error.message : String(error),
        admission,
        trace,
        cause: error,
      });
    }

    let handlerResult: TResult | ExplicitBrainHandlerResult<TResult>;
    try {
      handlerResult = this.operationalExecutor !== undefined && isOperationalTool(intent.toolRef)
        ? await this.operationalExecutor.execute(intent, receipt)
        : await this.input.handler.execute(intent, receipt);
    } catch (error) {
      const trace = this.appendTrace(decision, intent, 'rejected', receipt, error instanceof Error ? error.message : String(error));
      throw new ExplicitBrainDecisionError({
        message: error instanceof Error ? error.message : String(error),
        admission: 'rejected',
        trace,
        cause: error,
      });
    }

    const result = isHandlerResult(handlerResult) ? handlerResult.value : handlerResult;
    const outcome = isHandlerResult(handlerResult) ? handlerResult.trace : undefined;
    const trace = this.appendTrace(
      decision,
      intent,
      outcome?.admission ?? 'accepted',
      receipt,
      outcome?.failureRef,
      outcome,
    );
    return { intent, receipt, result, trace };
  }

  private appendTrace(
    decision: InteractionDecision,
    intent: ToolIntent | undefined,
    admission: DecisionTraceAdmission,
    receipt: ExplicitBrainAdmissionReceipt | undefined,
    failureRef?: string,
    outcome?: ExplicitBrainToolOutcome,
  ): DecisionTraceRecord {
    const semantic: SemanticDecisionTrace = {
      traceId: traceId('semantic', decision, intent ?? { toolIntentId: 'none' } as ToolIntent),
      scopeRef: this.input.context.scopeRef,
      runtimeBindingRef: this.input.context.runtimeBindingRef,
      interactionRef: decision.interactionId,
      attentionRef: this.input.context.attentionRef,
      bugRef: this.input.context.bugRef,
      taskRef: this.input.context.taskRef,
      operationRef: this.input.context.operationRef,
      decisionKind: decision.kind,
      decisionSummary: decision.summary,
      selectedAction: decision.selectedAction,
      evidenceRefs: [...decision.evidenceRefs],
      inputDigest: this.input.context.inputDigest,
      createdAt: this.input.context.createdAt,
    };
    const tool: ToolDecisionTrace | undefined = intent
      ? {
          traceId: traceId('tool', decision, intent),
          parentDecisionTraceId: semantic.traceId,
          toolIntentId: intent.toolIntentId,
          toolRef: intent.toolRef,
          argumentsRef: this.input.context.argumentsRef(intent),
          argumentsDigest: intent.argumentsDigest,
          reasonRefs: [...intent.reasonRefs],
          selectedBecause: intent.selectedBecause,
          bindingRef: this.input.binding.bindingRef,
          capabilityDigest: this.input.binding.capabilityDigest,
          permissionRevision: this.input.binding.permissionRevision,
          executionEpoch: this.input.binding.executionEpoch,
          createdAt: this.input.context.createdAt,
        }
      : undefined;
    const execution: FrameworkExecutionTrace = {
      traceId: traceId('execution', decision, intent ?? { toolIntentId: 'none' } as ToolIntent),
      toolIntentId: intent?.toolIntentId ?? 'none',
      admission,
      operationId: outcome?.operationId,
      ownerRef: this.input.context.ownerRef,
      effectRefs: outcome?.effectRefs ? [...outcome.effectRefs] : receipt ? [receipt.bindingRef] : [],
      resultRef: outcome?.resultRef,
      eventRefs: outcome?.eventRefs ? [...outcome.eventRefs] : [],
      notificationOperationRefs: outcome?.notificationOperationRefs ? [...outcome.notificationOperationRefs] : [],
      failureRef,
      settlement: outcome?.settlement
        ?? (failureRef
          ? { state: 'failed', completedAt: this.input.context.createdAt }
          : { state: 'completed', completedAt: this.input.context.createdAt }),
      stateTransitionRef: outcome?.stateTransitionRef,
      downstreamRouteRef: outcome?.downstreamRouteRef,
      finalReceiptRef: outcome?.finalReceiptRef,
    };
    return this.input.traces.recordToolDecision(tool
      ? { semantic, tool, execution }
      : { semantic, execution });
  }
}
