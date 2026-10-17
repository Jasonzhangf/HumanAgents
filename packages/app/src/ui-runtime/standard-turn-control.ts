import { canonicalJsonStringify, type AcceptedRawFact, type BusinessPayload,
  id, type EvidenceRef, type ProviderExecutionIdentityRef, type ProviderToolCall,
  type ProviderToolDefinition, type RuntimeRequestRecord } from '../../../contracts/src/index.js';
import type { AdmittedTurnIdentity } from '../../../contracts/src/native-reasoning.js';
import { validateNativeSegmentSaveSourceV2, type NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import { projectAdmittedTurnIdentityV1 } from '../../../runtime/src/context/semantic-history.js';
import type { TurnCloseSummary } from '../../../contracts/src/turn-closure.js';
import { ContractError } from '../../../contracts/src/errors.js';
import {
  STANDARD_TURN_END_TOOL_ID,
  isStandardTurnEndToolId,
  validateStandardTurnEndCommand,
  validateStandardTurnEndInput,
  type StandardTurnEndCommand,
  type StandardTurnEndInput,
} from '../../../contracts/src/standard-turn-end.js';
import type {
  ProviderToolExecutionPort,
  ProviderToolExecutionResult,
} from '../../../adapters/provider/src/agent-driver.js';

const OWNER = 'humanagent.app.standard-turn-control';

/** One summary section as the model produces it: semantic text plus evidence refs. */
const SUMMARY_SECTION_SCHEMA: BusinessPayload = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    evidenceRefs: { type: 'array', items: { type: 'object' } },
  },
  required: ['text', 'evidenceRefs'],
  additionalProperties: false,
};

/** Advertised wire shape for the existing inspection execution outcome union. */
export const INSPECTION_OUTCOME_SCHEMA: BusinessPayload = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed'] },
        judgment: { type: 'string', minLength: 1 },
      },
      required: ['status', 'judgment'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['failed', 'blocked', 'cancelled', 'unknown'] },
        reason: { type: 'string', minLength: 1 },
        judgment: { type: 'string', minLength: 1 },
      },
      required: ['status', 'reason'],
      additionalProperties: false,
    },
  ],
};

/**
 * The actual advertised Provider tool definition for the bound standard-turn
 * end action. The tool surface IS the Harness tool surface: a model that calls
 * `humanagent.turn.end` reaches this definition.
 */
export const STANDARD_TURN_END_TOOL: ProviderToolDefinition = {
  toolId: STANDARD_TURN_END_TOOL_ID,
  description: 'humanagent.turn.end: End the current task turn when this phase has sufficient results and evidence. Provide the four-part goal/actions/result/expectedNextStep summary and scoped delivery references. The Task can remain unfinished; the independent Planner decides continue, complete, or failed after closure.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'object',
        properties: {
          goal: SUMMARY_SECTION_SCHEMA,
          actions: SUMMARY_SECTION_SCHEMA,
          result: SUMMARY_SECTION_SCHEMA,
          expectedNextStep: SUMMARY_SECTION_SCHEMA,
          inspectionOutcome: INSPECTION_OUTCOME_SCHEMA,
        },
        required: ['goal', 'actions', 'result', 'expectedNextStep'],
        additionalProperties: false,
      },
      deliveryText: { type: 'string' },
      deliveryRefs: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'deliveryRefs'],
    additionalProperties: false,
  },
};

/**
 * Narrow owner port the App injects. The real implementation resolves the
 * admitted turn from the actual typed Provider request and resolves delivery
 * references to real scoped evidence. It never trusts the model's arguments for
 * identity or authority.
 */
export interface StandardTurnEndOwnerPort {
  /**
   * The exact binding for the actual call: the committed segment source, the
   * durable request registration and the accepted standard-end tool-call of
   * that same request. Provider request identity is independent of business
   * turn identity, so the normal check is registration <-> accepted fact.
   */
  resolveSegmentBinding?(input: {
    readonly execution: ProviderExecutionIdentityRef;
    readonly requestId?: string;
    readonly call: ProviderToolCall;
  }): Promise<{
    readonly source: NativeSegmentSaveSourceV2;
    readonly request: RuntimeRequestRecord;
    readonly acceptedEndCall: AcceptedRawFact;
  } | null>;
  /** Resolve the admitted turn bound to the actual typed Provider request. */
  resolveBoundTurn(input: {
    readonly execution: ProviderExecutionIdentityRef;
    readonly requestId?: string;
  }): Promise<AdmittedTurnIdentity | null>;
  /** Resolve delivery references to real evidence; foreign or missing refs reject. */
  resolveDelivery(input: {
    readonly identity: AdmittedTurnIdentity;
    readonly deliveryRefs: readonly string[];
  }): Promise<readonly EvidenceRef[]>;
}

/** Typed failure for the standard-end action. It stays visible; there is no fallback. */
export class StandardTurnEndError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StandardTurnEndError';
  }
}

/**
 * Classify the only model-owned refusals the bound standard-end action may turn
 * into a visible failed tool result: `standard-turn-end.arguments` and
 * `standard-turn-end.delivery-unresolved`. Local argument validation converts
 * its own `ContractError` before calling this classifier. Everything else
 * (binding, route, owner/IO) stays a thrown error. Returns the exact preserved
 * code/message, or `null` to rethrow.
 */
export function standardTurnEndModelInputRefusal(error: unknown): { code: string; message: string } | null {
  if (error instanceof StandardTurnEndError
    && (error.code === 'standard-turn-end.arguments' || error.code === 'standard-turn-end.delivery-unresolved')) {
    return { code: error.code, message: error.message };
  }
  return null;
}

/**
 * Build the honest failed tool result for a refused standard-turn end. It
 * carries the verified turn identity and the exact preserved code/message, and
 * never marks the Task accepted. There is no fallback and no fake success.
 */
export function createRefusedStandardTurnEndResult(
  identity: AdmittedTurnIdentity,
  error: { readonly code: string; readonly message: string },
): ProviderToolExecutionResult {
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', `standard-turn-end-refusal-${identity.turnId}-${error.code}`),
    kind: 'operation',
    source: OWNER,
    locator: `standard-turn-end://${identity.turnId}/${error.code}`,
    scope: identity.scopeRef,
  };
  return {
    output: canonicalJsonStringify({
      kind: 'standard-turn-end',
      turnId: identity.turnId,
      accepted: false,
      error: { code: error.code, message: error.message },
    }),
    outputRefs: [],
    evidenceRefs: [evidence],
    status: 'failed',
    error: {
      errorId: `${OWNER}.${error.code}`,
      code: error.code,
      category: 'validation',
      phase: 'tool',
      message: error.message,
      ownerId: OWNER,
      retryable: 'manual',
      attention: 'foreground',
      evidenceRefs: [evidence],
      nextAction: { kind: 'recover', ref: STANDARD_TURN_END_TOOL_ID },
    },
    executorRoute: STANDARD_TURN_END_TOOL_ID,
  };
}

export interface StandardTurnEndControlInput {
  readonly owner: StandardTurnEndOwnerPort;
  /**
   * Route the accepted typed control event to the caller. The caller owns the
   * real request drain, capture, `closeTurn` and next-turn admission. The
   * handler must not close or wait for its own unfinished call here.
   */
  readonly route: (command: StandardTurnEndCommand) => Promise<void> | void;
}

function parseStandardTurnEndArguments(call: ProviderToolCall): StandardTurnEndInput {
  const args = call.arguments;
  const summary = args.summary;
  const deliveryText = args.deliveryText;
  const deliveryRefs = args.deliveryRefs;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end requires a summary object');
  }
  if (deliveryText !== undefined && typeof deliveryText !== 'string') {
    throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end deliveryText must be a string when present');
  }
  if (!Array.isArray(deliveryRefs) || !deliveryRefs.every((reference) => typeof reference === 'string')) {
    throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end requires a delivery reference string array');
  }
  return { summary: summary as unknown as TurnCloseSummary,
    ...(deliveryText === undefined ? {} : { deliveryText }), deliveryRefs };
}

function assertBoundExecution(identity: AdmittedTurnIdentity, execution: ProviderExecutionIdentityRef): void {
  if (identity.taskRef.value !== execution.taskId.value
    || identity.scopeRef.operationId?.value !== execution.operationId.value
    || identity.executionEpoch !== execution.executionEpoch) {
    throw new StandardTurnEndError(
      'standard-turn-end.binding',
      'the resolved admitted turn does not match the actual provider request execution',
    );
  }
}

/**
 * The real bound standard-end executor. It is compatible with the existing
 * `ProviderToolExecutionPort.execute` (`executeTool`) surface.
 *
 * It validates the semantic arguments, resolves the trusted binding from the
 * actual typed Provider request, resolves delivery evidence through the owner
 * port, and routes the accepted typed control event to the caller. It returns
 * the tool result and never marks the Task complete, closes, drains or waits for
 * its own call. The caller acts on the routed command only after the real
 * request drain.
 */
export function createStandardTurnEndExecutor(input: StandardTurnEndControlInput): ProviderToolExecutionPort {
  return {
    async execute({ execution, scope, requestId, call }): Promise<ProviderToolExecutionResult> {
      const identity = await input.owner.resolveBoundTurn({
        execution,
        ...(requestId === undefined ? {} : { requestId }),
      });
      if (identity === null) {
        throw new StandardTurnEndError(
          'standard-turn-end.unbound',
          'no admitted turn is bound to the actual provider request; the standard end cannot be accepted',
        );
      }
      const segment = input.owner.resolveSegmentBinding
        ? await input.owner.resolveSegmentBinding({ execution, ...(requestId === undefined ? {} : { requestId }), call })
        : null;
      if (segment === null) {
        if (input.owner.resolveSegmentBinding) {
          throw new StandardTurnEndError(
            'standard-turn-end.unbound',
            'the committed segment has no exact request registration and accepted end call for the actual provider request',
          );
        }
        assertBoundExecution(identity, execution);
      } else {
        validateNativeSegmentSaveSourceV2(segment.source);
        const physical = segment.source.opened.binding;
        // Business identity stays the original admitted turn; the Provider
        // request identity is its own value and is proven by the exact
        // registration <-> accepted fact match, never by turn equality.
        const accepted = segment.acceptedEndCall;
        const endCall = accepted.envelope.fact.kind === 'tool-call'
          ? accepted.envelope.fact.call : null;
        if (canonicalJsonStringify(projectAdmittedTurnIdentityV1(segment.source.originalAdmittedTurn)) !== canonicalJsonStringify(identity)
          || physical.execution.runtimeId !== execution.runtimeId
          || physical.execution.executionEpoch !== execution.executionEpoch
          || physical.scope.taskId?.value !== execution.taskId.value
          || physical.scope.operationId?.value !== execution.operationId.value
          || segment.request.request.requestId !== requestId
          || canonicalJsonStringify(segment.request.scope) !== canonicalJsonStringify(physical.scope)
          || canonicalJsonStringify(segment.request.request) !== canonicalJsonStringify(accepted.envelope.request)
          || canonicalJsonStringify(accepted.envelope.execution) !== canonicalJsonStringify(physical.execution)
          || canonicalJsonStringify(accepted.envelope.scope) !== canonicalJsonStringify(physical.scope)
          || endCall === null
          || !isStandardTurnEndToolId(endCall.toolId)
          || endCall.callId !== call.callId) {
          throw new StandardTurnEndError(
            'standard-turn-end.binding',
            'committed segment, exact request registration or accepted end call conflicts',
          );
        }
      }
      let parsed: StandardTurnEndInput;
      try {
        parsed = parseStandardTurnEndArguments(call);
        validateStandardTurnEndInput(parsed, identity.scopeRef);
      } catch (error) {
        const refusal = error instanceof ContractError
          ? { code: 'standard-turn-end.arguments', message: error.message }
          : standardTurnEndModelInputRefusal(error);
        if (refusal) return createRefusedStandardTurnEndResult(identity, refusal);
        throw error;
      }
      let resolvedEvidenceRefs: readonly EvidenceRef[];
      try {
        resolvedEvidenceRefs = parsed.deliveryRefs.length === 0 ? []
          : await input.owner.resolveDelivery({ identity, deliveryRefs: parsed.deliveryRefs });
      } catch (error) {
        const refusal = standardTurnEndModelInputRefusal(error);
        if (refusal) return createRefusedStandardTurnEndResult(identity, refusal);
        throw error;
      }
      const command: StandardTurnEndCommand = {
        kind: 'standard-turn-end',
        identity,
        summary: parsed.summary,
        ...(parsed.deliveryText === undefined ? {} : { deliveryText: parsed.deliveryText }),
        ...(requestId === undefined ? {} : {
          acceptedEndCall: {
            requestId,
            callId: call.callId,
            execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
            scope,
          },
        }),
        deliveryRefs: parsed.deliveryRefs,
        resolvedEvidenceRefs,
      };
      validateStandardTurnEndCommand(command);
      await input.route(command);
      return {
        output: canonicalJsonStringify({ owner: OWNER, kind: command.kind, turnId: identity.turnId, accepted: true }),
        outputRefs: [],
        evidenceRefs: [...command.resolvedEvidenceRefs],
        status: 'succeeded',
        executorRoute: STANDARD_TURN_END_TOOL_ID,
      };
    },
  };
}
