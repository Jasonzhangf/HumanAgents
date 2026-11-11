import { canonicalJsonStringify, type AcceptedRawFact, type BusinessPayload,
  id, type EvidenceRef, type ProviderExecutionIdentityRef, type ProviderToolCall,
  type ProviderToolDefinition, type RuntimeRequestRecord } from '../../../contracts/src/index.js';
import { createHash } from 'node:crypto';
import type { AdmittedTurnIdentity } from '../../../contracts/src/native-reasoning.js';
import { validateNativeSegmentSaveSourceV2, type NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import { projectAdmittedTurnIdentityV1 } from '../../../runtime/src/context/semantic-history.js';
import { ContractError } from '../../../contracts/src/errors.js';
import {
  STANDARD_TURN_END_TOOL_ID,
  isStandardTurnEndToolId,
  validateStandardTurnEndCommand,
  validateStandardTurnEndPayload,
  type StandardTurnEndCommand,
  type StandardTurnEndInput,
} from '../../../contracts/src/standard-turn-end.js';
import type {
  ProviderToolExecutionPort,
  ProviderToolExecutionResult,
} from '../../../adapters/provider/src/agent-driver.js';

const OWNER = 'humanagent.app.standard-turn-control';

/**
 * The canonical four-part summary as the model produces it. `result.text` is
 * the only public result text; `outcome` and `result.status` are separate
 * model decisions and are never derived from one another.
 */
export const STANDARD_TURN_END_SUMMARY_SCHEMA: BusinessPayload = {
  type: 'object',
  properties: {
    goal: { type: 'string', minLength: 1, description: 'What this turn set out to achieve.' },
    actions: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'What was actually done in this turn, one entry per action.' },
    result: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'partial', 'blocked'] },
        text: { type: 'string', description: 'The user-facing result of this turn. When status is completed this text is published to the user as the answer.' },
      },
      required: ['status', 'text'],
      additionalProperties: false,
    },
    nextStep: { type: 'string', minLength: 1, description: 'The expected next step after this turn.' },
  },
  required: ['goal', 'actions', 'result', 'nextStep'],
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
  description: 'humanagent.turn.end: End the current task turn when this phase has sufficient results and evidence. Provide outcome; use input-required only when execution cannot continue without an exact user fact, and then provide inputRequest question/schemaRef/reason/impact. Provide the four-part summary goal/actions/result/nextStep; result.text is the user-facing answer. deliveryRefs only cite committed file writes or inspection results. The independent Planner decides continue, complete, or failed after ordinary closure.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['completed', 'continue', 'blocked', 'input-required'] },
      summary: {
        ...STANDARD_TURN_END_SUMMARY_SCHEMA,
        properties: {
          ...(STANDARD_TURN_END_SUMMARY_SCHEMA.properties as Record<string, BusinessPayload>),
          inspectionOutcome: INSPECTION_OUTCOME_SCHEMA,
        },
      },
      inputRequest: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1 },
          schemaRef: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          impact: { type: 'string', minLength: 1 },
          expiresAt: { type: 'string', minLength: 1 },
        },
        required: ['question', 'schemaRef', 'reason', 'impact'],
        additionalProperties: false,
      },
      deliveryRefs: { type: 'array', items: { type: 'string' }, description: 'Scoped references to delivery artifacts that can actually be committed to the turn: a file.write output or an inspection result. Never cite goal/todo/bash/edit results here; they carry no delivery material. A text-only delivery leaves this array empty.' },
    },
    required: ['outcome', 'summary', 'deliveryRefs'],
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
  /** Resolve delivery references to real evidence; foreign or missing refs reject.
   *  Summary section references only prove "what happened" and may cite any
   *  accepted tool result. Top-level `deliveryRefs` are the turn's delivery
   *  material, so they must resolve to evidence that can actually carry a
   *  committed delivery: a `file.write` completion or an inspect-kind result.
   *  An apply-kind result that never commits a completion (goal, todo, bash,
   *  edit) cannot be delivered and is refused at this boundary. */
  resolveDelivery(input: {
    readonly identity: AdmittedTurnIdentity;
    readonly deliveryRefs: readonly string[];
    /** True only for the top-level delivery material, never for summary citations. */
    readonly requireDeliveryMaterial?: boolean;
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
  const refusalKey = `standard-turn-end-refusal-${identity.turnId}-${error.code}`;
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', `standard-turn-end-refusal-${createHash('sha256').update(refusalKey).digest('hex')}`),
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
  const deliveryRefs = args.deliveryRefs;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end requires a summary object');
  }
  if (!Array.isArray(deliveryRefs) || !deliveryRefs.every((reference) => typeof reference === 'string')) {
    throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end requires a delivery reference string array');
  }
  // The canonical validator rejects the retired top-level text field by own
  // property, so the raw arguments are forwarded unchanged.
  return args as unknown as StandardTurnEndInput;
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
        validateStandardTurnEndPayload(parsed);
      } catch (error) {
        const refusal = error instanceof ContractError
          ? { code: 'standard-turn-end.arguments', message: error.message }
          : standardTurnEndModelInputRefusal(error);
        if (refusal) return createRefusedStandardTurnEndResult(identity, refusal);
        throw error;
      }
      const deliveryRefs = parsed.deliveryRefs ?? [];
      let resolvedEvidenceRefs: readonly EvidenceRef[];
      try {
        resolvedEvidenceRefs = deliveryRefs.length === 0 ? []
          : await input.owner.resolveDelivery({ identity, deliveryRefs, requireDeliveryMaterial: true });
      } catch (error) {
        const refusal = standardTurnEndModelInputRefusal(error);
        if (refusal) return createRefusedStandardTurnEndResult(identity, refusal);
        throw error;
      }
      const command: StandardTurnEndCommand = {
        kind: 'standard-turn-end',
        identity,
        outcome: parsed.outcome,
        summary: parsed.summary,
        ...(parsed.inputRequest === undefined ? {} : { inputRequest: parsed.inputRequest }),
        ...(requestId === undefined ? {} : {
          acceptedEndCall: {
            requestId,
            callId: call.callId,
            execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
            scope,
          },
        }),
        deliveryRefs,
        resolvedEvidenceRefs,
      };
      validateStandardTurnEndCommand(command);
      await input.route(command);
      return {
        output: canonicalJsonStringify({ owner: OWNER, kind: command.kind, turnId: identity.turnId, accepted: true }),
        outputRefs: [],
        evidenceRefs: [...resolvedEvidenceRefs],
        status: 'succeeded',
        executorRoute: STANDARD_TURN_END_TOOL_ID,
      };
    },
  };
}
