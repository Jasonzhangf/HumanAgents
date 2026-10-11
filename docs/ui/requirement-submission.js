/**
 * Shared same-step new-task submission engine.
 *
 * Project contract (HumanAgent AGENTS.md): submitting a new-task form *is* the
 * user confirmation for that new task. One submit must
 *
 *   1. organize the raw input through the explicit brain, and
 *   2. hand the exact reviewable revision to the runtime's final-submit edge,
 *
 * in the same handling, without a second human confirmation, modal, double
 * click or implicit auto-confirm.
 *
 * This module owns that order once. Homepage (`entry.js`) and Dashboard
 * (`dashboard.js`) only render the input and show the runtime's answer.
 *
 * Scope and non-scope:
 * - Only a genuine *new task* is submitted here. `append`/`change` describe an
 *   existing-task material change; that must be separately confirmed through
 *   its own public caller and is deliberately refused here rather than being
 *   smuggled through the new-task authorization edge.
 * - Control commands (steer/stop/permission revocation) never enter this path;
 *   the runtime already refuses `channel === 'control'` on the business input
 *   route, and this module always sends `business`.
 * - The runtime stays the only authorization owner. This module never writes a
 *   requirement locally, never retries a non-idempotent submission, and never
 *   treats a preview as a confirmation.
 */

/**
 * The exact `sourceRef` a page reports for its own new-task form. It is display
 * provenance only; it does not authorize anything.
 */
export const NEW_TASK_PREVIEW_KIND = 'new-task-preview';

/**
 * One typed refusal for an organized input that is not a new task.
 *
 * `append`/`change` are legal explicit-brain intents, so this is a product
 * decision, not a malformed request: the new-task form must not authorize an
 * existing-task material change.
 */
const EXISTING_TASK_INTENTS = new Set(['append', 'change']);

/**
 * The interaction states the runtime reports once it has accepted the revision.
 * A read that reports anything else is not the accepted revision's current state.
 */
const POST_CONFIRMATION_STATES = new Set(['confirmed', 'dispatched']);

export class RequirementSubmissionRefusal extends Error {
  constructor(proposedIntent) {
    super(
      `整理结果不是新任务（意图：${proposedIntent || '未提供'}）。`
      + '已有任务的目标、范围或处理方式变更需要单独确认，本次提交未入队。',
    );
    this.name = 'RequirementSubmissionRefusal';
    this.code = 'requirement-submission.existing-task-change-separate-confirmation';
    this.ownerId = 'humanagent.app.ui';
    this.nextAction = 'open the existing task and confirm the proposed change there';
    this.proposedIntent = proposedIntent;
  }
}

/**
 * Mint the per-submission identities once, up front. The same identities are
 * reused across clarification rounds and a legitimate retry, so a duplicated
 * send cannot create a second requirement for the same human intent.
 */
export function createSubmissionIdentity(prefix = 'ui') {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    submissionId: `${prefix}-${nonce}`,
    confirmationRef: `confirmation:${prefix}:${nonce}`,
    payloadRef: `asset://requirements/${prefix}:${nonce}`,
    idempotencyKey: `${prefix}-submission:${nonce}`,
  };
}

function submissionFailure(message, nextAction) {
  return Object.assign(new Error(message), {
    code: 'requirement-submission.state-invalid',
    ownerId: 'humanagent.app.ui',
    nextAction,
  });
}

/**
 * Organize `rawInput` and, for a genuine new task, authorize it once.
 *
 * The caller supplies the runtime API and the already-minted identity. The
 * return value reports exactly what happened so the page can render the real
 * outcome instead of inferring success:
 *
 * - `confirmed`   the runtime accepted the exact revision and FIFO-enqueued it;
 * - `clarification` the explicit brain needs a human answer before submitting;
 * - `status-only` the input was a status query, so nothing is enqueued;
 * - `refused`     an existing-task material change, refused and not enqueued.
 *
 * For `confirmed`, `snapshot` is the interaction's state *after* the acceptance
 * and `organizedSnapshot` is the pre-confirmation draft the human reviewed.
 * The page renders the current state from `snapshot` and may show the organized
 * draft as history.
 *
 * A refused or failed submission throws or returns a terminal result; it is
 * never converted into a success.
 */
export async function submitNewTaskRequirement({
  api,
  sourceRef,
  rawInput,
  identity,
  executionPolicy,
  goal,
  scope,
  clarificationAnswer,
  interactionId,
}) {
  if (typeof rawInput !== 'string' || rawInput.trim().length === 0) {
    throw submissionFailure('请先填写任务输入。', 'provide the task input');
  }
  if (!identity || !identity.confirmationRef || !identity.payloadRef || !identity.idempotencyKey) {
    throw submissionFailure('缺少本次提交的身份信息。', 'mint a submission identity before submitting');
  }

  let resolvedInteractionId = interactionId;
  if (!resolvedInteractionId) {
    const received = await api.receiveExplicitInput({
      sourceRef,
      rawInput,
      inputRevision: 1,
      requestKind: NEW_TASK_PREVIEW_KIND,
    });
    resolvedInteractionId = received.interactionId;
  }

  let snapshot = await api.inspectExplicitInteraction(resolvedInteractionId);
  if (snapshot.state === 'awaiting-clarification') {
    if (!clarificationAnswer) {
      return { outcome: 'clarification', interactionId: resolvedInteractionId, snapshot };
    }
    await api.answerExplicitClarification(resolvedInteractionId, clarificationAnswer);
    snapshot = await api.inspectExplicitInteraction(resolvedInteractionId);
  }
  if (snapshot.state === 'received' || snapshot.state === 'matching') {
    snapshot = await api.interpretExplicitInput(resolvedInteractionId);
  }
  if (snapshot.state === 'awaiting-clarification') {
    return { outcome: 'clarification', interactionId: resolvedInteractionId, snapshot };
  }
  if (snapshot.state === 'status-only') {
    return { outcome: 'status-only', interactionId: resolvedInteractionId, snapshot };
  }
  if (POST_CONFIRMATION_STATES.has(snapshot.state)) {
    // The runtime already accepted this interaction. Report the runtime's own
    // state instead of issuing a second confirmation for the same intent.
    return { outcome: 'confirmed', interactionId: resolvedInteractionId, snapshot, alreadyAccepted: true };
  }
  if (snapshot.state !== 'awaiting-confirmation' || !snapshot.draft) {
    throw submissionFailure(
      `显式大脑当前状态：${snapshot.state}。${snapshot.nextAction || ''}`,
      'inspect the current interaction state before retrying',
    );
  }

  const proposedIntent = snapshot.draft.proposedIntent;
  if (EXISTING_TASK_INTENTS.has(proposedIntent)) {
    return {
      outcome: 'refused',
      interactionId: resolvedInteractionId,
      snapshot,
      refusal: new RequirementSubmissionRefusal(proposedIntent),
    };
  }
  if (proposedIntent !== 'create') {
    throw submissionFailure(
      `无法把意图 ${proposedIntent || '未提供'} 作为新任务提交。`,
      'clarify the intended outcome before submitting',
    );
  }

  // One authorized server request. The runtime registers the exact revision,
  // records confirmation provenance and FIFO-enqueues the RequirementEnvelope
  // under its dispatch lock. Nothing is enqueued here.
  const receipt = await api.confirmExplicitRequirement(resolvedInteractionId, {
    draftId: snapshot.draft.draftId,
    inputRevision: snapshot.draft.inputRevision,
    ...(snapshot.revision?.revisionVersion === undefined
      ? {}
      : { draftRevisionVersion: snapshot.revision.revisionVersion }),
    ...(snapshot.revision?.revisionHash === undefined
      ? {}
      : { draftRevisionHash: snapshot.revision.revisionHash }),
    confirmationRef: identity.confirmationRef,
    confirmedBy: 'human:operator',
    confirmedAt: identity.confirmedAt,
    payloadRef: identity.payloadRef,
    idempotencyKey: identity.idempotencyKey,
    ...(goal === undefined ? {} : { goal }),
    ...(scope === undefined ? {} : { scope }),
    ...(executionPolicy === undefined ? {} : { executionPolicy }),
  });

  // The receipt is the runtime's typed proof that it accepted this exact revision
  // and FIFO-enqueued it. `snapshot` was inspected *before* that acceptance, so it
  // is the organized draft history from here on and must never describe the
  // current state. Read the server's own current state back; the receipt stays the
  // authority whenever that read reports no post-confirmation state, so the card
  // can never keep waiting for a confirmation the runtime already accepted. No
  // state the runtime did not report (for example `dispatched`) is assumed.
  let inspected;
  try {
    inspected = await api.inspectExplicitInteraction(resolvedInteractionId);
  } catch {
    inspected = undefined;
  }
  const currentSnapshot = POST_CONFIRMATION_STATES.has(inspected?.state)
    ? inspected
    : { ...snapshot, state: 'confirmed' };
  return {
    outcome: 'confirmed',
    interactionId: resolvedInteractionId,
    // The state the page must render now.
    snapshot: currentSnapshot,
    // The organized draft the human reviewed, for read-only history display.
    organizedSnapshot: snapshot,
    receipt,
    requirement: receipt?.requirement,
  };
}

/**
 * Bind the engine to one page. The page keeps its own rendering; this only
 * owns the submission identity, the interaction identity and the ordering.
 */
export function createNewTaskSubmissionSession({ api, sourceRef, executionPolicy }) {
  const prefix = sourceRef.replace(/[^a-z0-9]+/gi, '-');
  const mintIdentity = () => ({ ...createSubmissionIdentity(prefix), confirmedAt: new Date().toISOString() });
  let identity = mintIdentity();
  let interactionId;
  let lastRawInput;

  return {
    get interactionId() {
      return interactionId;
    },
    set interactionId(value) {
      interactionId = value;
    },
    get identity() {
      return identity;
    },
    get rawInput() {
      return lastRawInput;
    },
    /**
     * A fresh human intent needs a fresh identity. A retry of the *same*
     * submission keeps the current identity and interaction so a duplicate send
     * cannot mint a second requirement; a new intent must not reuse the previous
     * identity's confirmationRef/idempotencyKey or the runtime could dedupe two
     * different tasks together.
     */
    reset() {
      interactionId = undefined;
      lastRawInput = undefined;
      identity = mintIdentity();
    },
    async submit(rawInput, { clarificationAnswer, goal, scope } = {}) {
      const trimmed = rawInput.trim();
      if (lastRawInput !== undefined && lastRawInput !== trimmed) {
        // The human edited the input, so this is a new intent with its own
        // identity rather than a retry of the previous submission.
        interactionId = undefined;
        identity = mintIdentity();
      }
      lastRawInput = trimmed;
      const result = await submitNewTaskRequirement({
        api,
        sourceRef,
        rawInput: trimmed,
        identity,
        interactionId,
        clarificationAnswer,
        goal,
        scope,
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
      });
      interactionId = result.interactionId;
      return result;
    },
  };
}
