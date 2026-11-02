import type { ProviderToolDefinition } from '../../../contracts/src/index.js';
import { isStandardTurnEndToolId, STANDARD_TURN_END_WIRE_TOOL_ID } from '../../../contracts/src/standard-turn-end.js';
import { STANDARD_TURN_END_TOOL } from './standard-turn-control.js';
import {
  StandardTurnEndError,
  type StandardTurnEndOwnerPort,
} from './standard-turn-control.js';
import type { ProviderToolExecutionPort } from '../../../adapters/provider/src/agent-driver.js';

/**
 * Re-exported from the shared standard-end contract. Both ids denote exactly
 * one action; there is no second end action, no completion flag and no
 * separate Task schema.
 */

/** The advertised Provider tool surface for the bound standard-turn end action. */
export const ADVERTISED_STANDARD_TURN_END_TOOL: ProviderToolDefinition = {
  ...STANDARD_TURN_END_TOOL,
  toolId: STANDARD_TURN_END_WIRE_TOOL_ID,
  description: [
    'End this standard turn when the current results and evidence are sufficient.',
    'Keep the current-turn raw tool call/result loop available. In this close, summarize the latest raw results and relevant semantic history instead of copying raw tool bodies, call IDs, or transcripts.',
    'For available file read/list/search, write/edit/present, bash, todo/goal, and web search results, state the actual target or query, observed result, evidence scope, and any truncation, failure, or unresolved boundary. A successful action or command exit is not verification of its effect.',
    'If this role has child adoption tools and a child has returned, require an explicit child.adopt or child.not_select decision before this close. Returned is not adopted, and not_select is not child failure.',
    'Set outcome to completed when the task is done, continue when more turns are needed, or blocked when it cannot proceed. Fill summary.goal, summary.actions, summary.result {status, text} and summary.nextStep. After this close, the Planner decides continue, complete, or failed.',
    'summary.result.text is the user-facing answer: when the task is done, put the complete answer there and set result.status to completed. deliveryRefs only cite a committed file write or an inspection result; goal, todo, bash, and edit results never carry delivery material. A text-only delivery leaves deliveryRefs empty.',
    'If an inspection execution occurred, include the optional summary.inspectionOutcome judgment for the executed scope; checks not executed remain missing.',
  ].join(' '),
};

/**
 * The wire action carries the canonical payload unchanged. Only the admitted
 * binding is checked here; argument validation and delivery resolution stay
 * with the single standard-end control executor.
 */
export function createStandardTurnEndWireExecutor(owner: StandardTurnEndOwnerPort,
  control: ProviderToolExecutionPort): ProviderToolExecutionPort {
  return {
    async execute(request) {
      const identity = await owner.resolveBoundTurn(request);
      if (!identity) throw new StandardTurnEndError('standard-turn-end.unbound', 'no admitted turn is bound to the actual provider request');
      return control.execute(request);
    },
  };
}

export { isStandardTurnEndToolId as isStandardTurnEndCall, STANDARD_TURN_END_WIRE_TOOL_ID };
