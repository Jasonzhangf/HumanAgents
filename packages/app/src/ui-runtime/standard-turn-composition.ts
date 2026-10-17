import type { ProviderToolDefinition } from '../../../contracts/src/index.js';
import { isStandardTurnEndToolId, STANDARD_TURN_END_WIRE_TOOL_ID } from '../../../contracts/src/standard-turn-end.js';
import { STANDARD_TURN_END_TOOL } from './standard-turn-control.js';
import {
  createRefusedStandardTurnEndResult,
  standardTurnEndModelInputRefusal,
  StandardTurnEndError,
  type StandardTurnEndOwnerPort,
} from './standard-turn-control.js';
import type { ProviderToolExecutionPort } from '../../../adapters/provider/src/agent-driver.js';
import type { BusinessPayload, TurnCloseSummary } from '../../../contracts/src/index.js';

/**
 * Re-exported from the shared standard-end contract. Both ids denote exactly
 * one action; there is no second end action, no completion flag and no
 * separate Task schema.
 */

/** The advertised Provider tool surface for the bound standard-turn end action. */
export const ADVERTISED_STANDARD_TURN_END_TOOL: ProviderToolDefinition = {
  ...STANDARD_TURN_END_TOOL,
  toolId: STANDARD_TURN_END_WIRE_TOOL_ID,
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'object', properties: Object.fromEntries(
        ['goal', 'actions', 'result', 'expectedNextStep'].map((section) => [section, {
          type: 'object', properties: { text: { type: 'string' },
            evidenceRefs: { type: 'array', items: { type: 'string' } } },
          required: ['text', 'evidenceRefs'], additionalProperties: false,
        }]),
      ), required: ['goal', 'actions', 'result', 'expectedNextStep'], additionalProperties: false },
      deliveryText: { type: 'string' },
      deliveryRefs: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'deliveryRefs'], additionalProperties: false,
  },
};

/** Resolve model-owned reference strings before crossing into typed control.
 * Scope and operation identity come only from the admitted evidence owner.
 */
export function createStandardTurnEndWireExecutor(owner: StandardTurnEndOwnerPort,
  control: ProviderToolExecutionPort): ProviderToolExecutionPort {
  return {
    async execute(request) {
      const identity = await owner.resolveBoundTurn(request);
      if (!identity) throw new StandardTurnEndError('standard-turn-end.unbound', 'no admitted turn is bound to the actual provider request');
      const raw = request.call.arguments.summary;
      let summary: Record<keyof TurnCloseSummary, TurnCloseSummary['goal']>;
      let deliveryText: string | undefined;
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end requires a summary object');
        }
        summary = {} as Record<keyof TurnCloseSummary, TurnCloseSummary['goal']>;
        for (const key of ['goal', 'actions', 'result', 'expectedNextStep'] as const) {
          const section = raw[key];
          if (!section || typeof section !== 'object' || Array.isArray(section)
            || typeof section.text !== 'string' || !Array.isArray(section.evidenceRefs)
            || !section.evidenceRefs.every((ref) => typeof ref === 'string')) {
            throw new StandardTurnEndError('standard-turn-end.arguments', `${key} requires text and evidence reference strings`);
          }
          summary[key] = { text: section.text,
            evidenceRefs: await owner.resolveDelivery({ identity, deliveryRefs: section.evidenceRefs as string[] }) };
        }
        const rawArguments = request.call.arguments as Record<string, unknown>;
        const parsedDeliveryText = rawArguments.deliveryText;
        if (parsedDeliveryText !== undefined && typeof parsedDeliveryText !== 'string') {
          throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end deliveryText must be a string when present');
        }
        deliveryText = parsedDeliveryText;
      } catch (error) {
        const refusal = standardTurnEndModelInputRefusal(error);
        if (refusal) return createRefusedStandardTurnEndResult(identity, refusal);
        throw error;
      }
      return control.execute({ ...request, call: { ...request.call,
        arguments: { ...request.call.arguments, summary,
          ...(deliveryText === undefined ? {} : { deliveryText }) } as unknown as BusinessPayload } });
    },
  };
}

export { isStandardTurnEndToolId as isStandardTurnEndCall, STANDARD_TURN_END_WIRE_TOOL_ID };
