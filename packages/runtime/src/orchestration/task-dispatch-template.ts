import type { WorkAssignment } from '../../../contracts/src/index.js';
import type { RequestScopedInstructions } from '../../../contracts/src/provider-request-context.js';

/**
 * Renders the transient re-orientation for one task-mode dispatch.
 *
 * The input is the actual retained dispatch structure the App caller already
 * builds for a task turn (`WorkAssignment`): its `objective` is the retained
 * dispatch that the initial request carried and that the admitted turn binding
 * keeps. The same structure therefore feeds the initial dispatch and this
 * continuation, so there is no second interpretation of the Task.
 *
 * The returned instructions re-orient the model to that dispatch, ask it to
 * find unfinished work and choose the next applicable action, and ask it to end
 * the turn through the bound standard-end action only when real evidence
 * exists. The text assumes no `goal`, stage-result or delivery section beyond
 * the objective, and it adds no simple-QA or completion flag.
 *
 * Explicit-Brain simple QA never produces a `WorkAssignment`, so it stays a
 * direct answer and never reaches this renderer.
 *
 * The instructions are request-scoped. The caller must pass them to
 * `continueCurrentTurn({ instructions })` and must never append them to durable
 * I5 context, raw business messages, the Task payload or the next request.
 */
export function renderTaskReorientation(dispatch: WorkAssignment): RequestScopedInstructions {
  const objective = dispatch.objective;
  if (typeof objective !== 'string' || !objective.trim()) {
    throw new Error('task reorientation requires the retained dispatch objective');
  }
  const text = [
    'You are continuing the same task turn. Re-orient to your retained task dispatch, then finish it.',
    '',
    'Retained task dispatch:',
    objective,
    '',
    'Do this now:',
    '1. Re-read the dispatch above together with the work already accepted in this turn.',
    '2. Find the work that is still unfinished against that dispatch.',
    '3. Choose the next applicable action from the tools you have and continue that work.',
    '4. When this phase has sufficient results and evidence, end the turn by calling the bound standard-end action with the four-part goal/actions/result/expectedNextStep summary and delivery references. The Task can remain unfinished; the independent Planner decides continue, complete, or failed after closure. A plain model finish, status message, or text alone does not end the turn.',
    '',
    'This orientation applies only to the current request. It is not part of the task history and must not be carried into the next request.',
  ].join('\n');
  return { text };
}
