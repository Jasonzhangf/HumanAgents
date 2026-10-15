import type { ProviderToolDefinition } from '../../../contracts/src/index.js';
import { STANDARD_TURN_END_TOOL_ID } from '../../../contracts/src/standard-turn-end.js';
import { STANDARD_TURN_END_TOOL } from './standard-turn-control.js';
import { StandardTurnEndError, type StandardTurnEndOwnerPort } from './standard-turn-control.js';
import type { ProviderToolExecutionPort } from '../../../adapters/provider/src/agent-driver.js';
import type { BusinessPayload, TurnCloseSummary } from '../../../contracts/src/index.js';

/**
 * Wire-legal advertised identity of the bound standard-turn end action.
 *
 * The canonical control event identity is the frozen
 * `STANDARD_TURN_END_TOOL_ID` (`humanagent.turn.end`): it is what the accepted
 * `StandardTurnEndCommand` and its executor route carry. The Provider Responses
 * codec can only declare and decode function names matching
 * `[A-Za-z0-9_-]`, so the same action is advertised to the model under this
 * transport-legal id. Both ids denote exactly one action; there is no second
 * end action, no completion flag and no separate Task schema.
 */
export const STANDARD_TURN_END_WIRE_TOOL_ID = 'humanagent_turn_end';

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
            evidenceRefs: { type: 'array', items: { type: 'string' }, minItems: 1 } },
          required: ['text', 'evidenceRefs'], additionalProperties: false,
        }]),
      ), required: ['goal', 'actions', 'result', 'expectedNextStep'], additionalProperties: false },
      deliveryRefs: { type: 'array', items: { type: 'string' }, minItems: 1 },
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
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new StandardTurnEndError('standard-turn-end.arguments', 'standard turn end requires a summary object');
      }
      const summary = {} as Record<keyof TurnCloseSummary, TurnCloseSummary['goal']>;
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
      return control.execute({ ...request, call: { ...request.call,
        arguments: { ...request.call.arguments, summary } as unknown as BusinessPayload } });
    },
  };
}

/** True for the advertised Provider tool id of the bound standard-turn end action. */
export function isStandardTurnEndCall(toolId: string): boolean {
  return toolId === STANDARD_TURN_END_WIRE_TOOL_ID;
}
