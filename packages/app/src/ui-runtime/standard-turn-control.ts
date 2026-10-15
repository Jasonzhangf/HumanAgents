import { canonicalJsonStringify, type BusinessPayload, type EvidenceRef,
  type ProviderExecutionIdentityRef, type ProviderToolCall,
  type ProviderToolDefinition } from '../../../contracts/src/index.js';
import type { AdmittedTurnIdentity } from '../../../contracts/src/native-reasoning.js';
import { validateNativeSegmentSaveSourceV2, type NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import { projectAdmittedTurnIdentityV1 } from '../../../runtime/src/context/semantic-history.js';
import type { TurnCloseSummary } from '../../../contracts/src/turn-closure.js';
import {
  STANDARD_TURN_END_TOOL_ID,
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
        },
        required: ['goal', 'actions', 'result', 'expectedNextStep'],
        additionalProperties: false,
      },
      deliveryRefs: { type: 'array', items: { type: 'string' }, minItems: 1 },
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
  /** Real source and durable request registration, resolved by the segment owner. */
  resolveSegmentBinding?(input: { readonly execution: ProviderExecutionIdentityRef; readonly requestId?: string }): Promise<{
    readonly source: NativeSegmentSaveSourceV2;
    readonly request: import('../../../contracts/src/index.js').RuntimeRequestRecord;
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
  return { summary: summary as unknown as TurnCloseSummary, deliveryRefs };
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
    async execute({ execution, requestId, call }): Promise<ProviderToolExecutionResult> {
      const parsed = parseStandardTurnEndArguments(call);
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
        ? await input.owner.resolveSegmentBinding({ execution, ...(requestId === undefined ? {} : { requestId }) }) : null;
      if (segment) {
        validateNativeSegmentSaveSourceV2(segment.source);
        const physical = segment.source.opened.binding;
        if (canonicalJsonStringify(projectAdmittedTurnIdentityV1(segment.source.originalAdmittedTurn)) !== canonicalJsonStringify(identity)
          || physical.execution.runtimeId !== execution.runtimeId
          || physical.execution.executionEpoch !== execution.executionEpoch
          || physical.scope.taskId?.value !== execution.taskId.value
          || physical.scope.operationId?.value !== execution.operationId.value
          || segment.request.request.turnId !== identity.turnId || segment.request.request.requestId !== requestId
          || canonicalJsonStringify(segment.request.scope) !== canonicalJsonStringify(physical.scope)) {
          throw new StandardTurnEndError('standard-turn-end.binding', 'committed segment or exact request registration conflicts');
        }
      } else assertBoundExecution(identity, execution);
      validateStandardTurnEndInput(parsed, identity.scopeRef);
      const resolvedEvidenceRefs = await input.owner.resolveDelivery({
        identity,
        deliveryRefs: parsed.deliveryRefs,
      });
      const command: StandardTurnEndCommand = {
        kind: 'standard-turn-end',
        identity,
        summary: parsed.summary,
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
