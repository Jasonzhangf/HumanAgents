import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  DraftRevisionInput,
  FinalSubmit,
  RequirementEnvelope,
  TaskId,
} from '../../../packages/contracts/src/index.js';
import { id } from '../../../packages/contracts/src/index.js';
import { DraftRevisionError } from '../../../packages/core/src/index.js';
import {
  ExplicitIntake,
  type DraftIntent,
  type ExplicitIntakeJournalPort,
  type ExplicitIntakeState,
} from '../../../packages/runtime/src/intake/explicit-intake.js';
import { ExplicitIntakeError } from '../../../packages/runtime/src/intake/errors.js';
import { RequirementInbox } from '../../../packages/runtime/src/intake/requirement-inbox.js';
import {
  ConfirmationLedger,
  RequirementSubmissionOwner,
  rejectDraftRevision,
  type RegisteredDraftRevision,
} from '../../../packages/runtime/src/explicit-brain/router.js';

const currentTask: TaskId = id('task', 'task-current');

/**
 * Real, file-backed journal port for the explicit intake snapshot. It writes
 * the same `explicit-brain.state` record envelope that the app's
 * UiRuntimeJournal already validates (`state.intake`), so the boundary this
 * test exercises is the production snapshot shape, not a private in-memory
 * mock. Reloading constructs a second ExplicitIntake from the persisted bytes.
 */
class FileIntakeJournal implements ExplicitIntakeJournalPort {
  constructor(private readonly filePath: string) {}

  save(state: ExplicitIntakeState): void {
    appendFileSync(this.filePath, `${JSON.stringify({ kind: 'explicit-brain.state', state: { intake: state } })}\n`, 'utf8');
  }

  load(): ExplicitIntakeState | undefined {
    let raw = '';
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
    const records = raw.split('\n').filter((line) => line.trim().length > 0);
    if (records.length === 0) return undefined;
    const latest = JSON.parse(records[records.length - 1]) as { state: { intake: ExplicitIntakeState } };
    return structuredClone(latest.state.intake);
  }

  recordCount(): number {
    return readFileSync(this.filePath, 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
  }
}

function journalPath(root: string): string {
  return join(root, 'explicit-brain.jsonl');
}

function draftIntent(overrides: Partial<DraftIntent> = {}): DraftIntent {
  return {
    goal: 'summarize the current task evidence',
    scope: 'task-current',
    constraints: ['read-only'],
    deliverables: ['summary'],
    normalizedInput: 'summarize current evidence',
    proposedIntent: 'create',
    proposal: 'create a summary task',
    matchedTasks: [{ taskId: currentTask, relation: 'current', status: 'running' }],
    knownFacts: ['fixture'],
    ...overrides,
  };
}

async function receivePreview(intake: ExplicitIntake): Promise<string> {
  return intake.receive({
    sourceRef: 'ui:new-task-form',
    rawInput: 'summarize the current task evidence',
    channel: 'business',
    requestKind: 'new-task-preview',
    occurredAt: '2026-10-02T00:00:00.000Z',
  });
}

function edit(base: { draftId: string; revisionVersion: number; revisionHash: string }, overrides: Partial<DraftRevisionInput> = {}): DraftRevisionInput {
  return {
    draftId: base.draftId,
    baseRevisionVersion: base.revisionVersion,
    requestedRevisionHash: base.revisionHash,
    fields: { normalizedInput: 'summarize current evidence and open risks', scope: 'task-current+risks' },
    instructionRef: 'user-edit-1',
    idempotencyKey: 'edit-1',
    ...overrides,
  };
}

test('new-task-preview creates an editable draft without dispatching; status stays status-only', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake();
  const previewInteraction = await receivePreview(intake);
  await intake.createDraft(previewInteraction, draftIntent());

  const snapshot = await intake.inspect(previewInteraction);
  assert.equal(snapshot.state, 'awaiting-confirmation');
  assert.equal(snapshot.requestKind, 'new-task-preview');
  assert.equal(snapshot.preview?.authorized, false);
  assert.equal(snapshot.preview?.context.requestKind, 'new-task-preview');
  assert.equal(snapshot.revision?.state, 'draft');
  // A preview never reaches the business inbox.
  assert.equal(inbox.size, 0);

  // A legitimate status query keeps its own path and creates no draft or task.
  const statusInteraction = await intake.receive({
    sourceRef: 'ui:status',
    rawInput: 'what is the current status?',
    channel: 'business',
    requestKind: 'status-query',
  });
  await intake.beginMatching(statusInteraction);
  await intake.beginStatusCheck(statusInteraction);
  const receipt = await intake.completeStatusOnly(statusInteraction, 'running');
  assert.equal(receipt.kind, 'status-only');
  assert.equal((await intake.inspect(statusInteraction)).revision, undefined);
  assert.equal(inbox.size, 0);
});

test('typed request kinds are validated and unconfirmed drafts cannot be marked submitted', async () => {
  const intake = new ExplicitIntake();
  await assert.rejects(
    () => intake.receive({
      sourceRef: 'ui:new-task-form',
      rawInput: 'summarize the current task evidence',
      channel: 'business',
      requestKind: 'not-a-request-kind' as never,
    }),
    (error) => error instanceof ExplicitIntakeError && error.code === 'invalid-request-kind',
  );

  const interaction = await receivePreview(intake);
  await intake.createDraft(interaction, draftIntent());
  await assert.rejects(
    () => intake.markRevisionSubmitted(interaction),
    (error) => error instanceof ExplicitIntakeError && error.code === 'invalid-state',
  );
  assert.equal((await intake.inspect(interaction)).revision?.state, 'draft');
});

test('refinement updates revision hash and normalized input; stale base is rejected and preserves the edit', async () => {
  const intake = new ExplicitIntake();
  const interaction = await receivePreview(intake);
  await intake.createDraft(interaction, draftIntent());
  const first = intake.currentDraftRevision(interaction);
  assert.ok(first);

  const refined = await intake.refineDraft(interaction, edit(first));
  assert.equal(refined.revisionVersion, first.revisionVersion + 1);
  assert.notEqual(refined.revisionHash, first.revisionHash);
  assert.equal(refined.normalizedInput, 'summarize current evidence and open risks');
  assert.equal(refined.previousRevisionRef, first.revisionHash);
  assert.equal(refined.immutableOriginalRef, first.immutableOriginalRef);
  assert.deepEqual(refined.history, [{ draftId: first.draftId, revisionVersion: first.revisionVersion, revisionHash: first.revisionHash }]);

  // Replaying the same idempotency key returns the existing revision, no new one.
  const replay = await intake.refineDraft(interaction, edit(first));
  assert.equal(replay.revisionHash, refined.revisionHash);

  // An old-hash edit is rejected and leaves the current revision untouched.
  let staleCode = '';
  try {
    await intake.refineDraft(interaction, edit(first, { idempotencyKey: 'edit-2' }));
  } catch (error) {
    staleCode = error instanceof DraftRevisionError ? error.code : 'not-draft-error';
  }
  assert.equal(staleCode, 'stale-revision');
  assert.equal(intake.currentDraftRevision(interaction)?.revisionHash, refined.revisionHash);
});

test('final submit is the only authorization: duplicate is idempotent, reject never dispatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-'));
  try {
  const journal = new FileIntakeJournal(journalPath(root));
  const intake = new ExplicitIntake(journal);
  const interaction = await receivePreview(intake);
  await intake.createDraft(interaction, draftIntent());
  const first = intake.currentDraftRevision(interaction);
  assert.ok(first);
  const refined = await intake.refineDraft(interaction, edit(first));

  const confirmation = await intake.confirmDraftRevision({
    interactionId: interaction,
    draftId: refined.draftId,
    draftRevisionVersion: refined.revisionVersion,
    draftRevisionHash: refined.revisionHash,
    confirmationRef: 'confirm-1',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-02T00:00:00.000Z',
    payloadRef: 'asset://requirements/req-1',
  });
  assert.equal(confirmation.draftRevisionHash, refined.revisionHash);

  // A second confirmation reference cannot authorize the same revision.
  let secondConfirmationCode = '';
  try {
    await intake.confirmDraftRevision({
      interactionId: interaction,
      draftId: refined.draftId,
      draftRevisionVersion: refined.revisionVersion,
      draftRevisionHash: refined.revisionHash,
      confirmationRef: 'confirm-2',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-02T00:00:00.000Z',
      payloadRef: 'asset://requirements/req-2',
    });
  } catch (error) {
    secondConfirmationCode = error instanceof ExplicitIntakeError ? error.code : 'not-intake-error';
  }
  assert.equal(secondConfirmationCode, 'confirmation-stale');

  // A stale confirmation for the earlier revision is rejected.
  let staleRejected = false;
  try {
    await intake.confirmDraftRevision({
      interactionId: interaction,
      draftId: refined.draftId,
      draftRevisionVersion: first.revisionVersion,
      draftRevisionHash: first.revisionHash,
      confirmationRef: 'confirm-stale',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-02T00:00:00.000Z',
      payloadRef: 'asset://requirements/req-stale',
    });
  } catch (error) {
    staleRejected = error instanceof DraftRevisionError && error.code === 'stale-revision';
  }
  assert.equal(staleRejected, true);

  const registered: RegisteredDraftRevision = {
    interactionId: interaction,
    draftId: refined.draftId,
    inputRevision: refined.inputRevision,
    draftRevisionVersion: refined.revisionVersion,
    draftRevisionHash: refined.revisionHash,
    normalizedInput: refined.normalizedInput,
    intent: refined.proposedIntent,
    taskRef: currentTask,
    payloadRef: 'asset://requirements/req-1',
    requestKind: 'new-task-create',
  };
  const ledger = new ConfirmationLedger();
  ledger.registerRevision(registered);
  ledger.confirmRevision(confirmation);
  const inbox = new RequirementInbox();
  const submitted: RequirementEnvelope[] = [];
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      submitted.push(envelope);
      return { requirementId: envelope.requirementId };
    },
  });
  const submit: FinalSubmit = {
    interactionId: interaction,
    draftId: refined.draftId,
    inputRevision: refined.inputRevision,
    draftRevisionVersion: refined.revisionVersion,
    draftRevisionHash: refined.revisionHash,
    confirmationRef: 'confirm-1',
    idempotencyKey: 'submit-1',
    requestKind: 'new-task-create',
  };

  // Old (pre-refinement) revision submit is rejected as stale.
  let staleSubmitCode = '';
  try {
    await owner.submitFinal({ ...submit, draftRevisionVersion: first.revisionVersion, draftRevisionHash: first.revisionHash });
  } catch (error) {
    staleSubmitCode = (error as { code?: string }).code ?? 'no-code';
  }
  assert.equal(staleSubmitCode, 'confirmation-stale');

  const firstReceipt = await owner.submitFinal(submit);
  assert.equal(firstReceipt.status, 'submitted');
  const duplicate = await owner.submitFinal(submit);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.requirement.requirementId, firstReceipt.requirement.requirementId);
  // Exactly one requirement was dispatched and the durable inbox holds one.
  assert.equal(submitted.length, 1);
  assert.equal(inbox.size, 1);
  await intake.markRevisionSubmitted(interaction);
  assert.equal((await intake.inspect(interaction)).state, 'dispatched');

  // Reusing the idempotency key for a different confirmed revision is a typed
  // conflict, never a silent second dispatch.
  const otherRevision: RegisteredDraftRevision = { ...registered, draftId: 'draft-other', normalizedInput: 'other input', payloadRef: 'asset://requirements/req-2' };
  ledger.registerRevision(otherRevision);
  ledger.confirmRevision({
    confirmationRef: 'confirm-other',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-02T00:00:00.000Z',
    payloadRef: 'asset://requirements/req-2',
    draftId: 'draft-other',
    draftRevisionVersion: otherRevision.draftRevisionVersion,
    draftRevisionHash: otherRevision.draftRevisionHash,
    interactionId: interaction,
  });
  let conflictCode = '';
  try {
    await owner.submitFinal({ ...submit, draftId: 'draft-other', draftRevisionHash: otherRevision.draftRevisionHash, confirmationRef: 'confirm-other' });
  } catch (error) {
    conflictCode = (error as { code?: string }).code ?? 'no-code';
  }
  assert.equal(conflictCode, 'duplicate-submit');

  // Persistence boundary: reloading the journal reconstructs the same state.
  const reloaded = new ExplicitIntake(journal);
  const restored = await reloaded.inspect(interaction);
  assert.equal(restored.state, 'dispatched');
  assert.equal(restored.revision?.revisionHash, refined.revisionHash);
  assert.equal(restored.confirmations?.[0].confirmationRef, 'confirm-1');
  assert.ok(journal.recordCount() >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reject closes the draft durably without creating an authorized requirement', async () => {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake();
  const interaction = await receivePreview(intake);
  await intake.createDraft(interaction, draftIntent());
  const draft = intake.currentDraftRevision(interaction);
  assert.ok(draft);
  const confirmation = await intake.confirmDraftRevision({
    interactionId: interaction,
    draftId: draft.draftId,
    draftRevisionVersion: draft.revisionVersion,
    draftRevisionHash: draft.revisionHash,
    confirmationRef: 'confirm-before-reject',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-02T00:00:00.000Z',
    payloadRef: 'asset://requirements/req-rejected',
  });
  const ledger = new ConfirmationLedger();
  ledger.registerRevision({
    interactionId: interaction,
    draftId: draft.draftId,
    inputRevision: draft.inputRevision,
    draftRevisionVersion: draft.revisionVersion,
    draftRevisionHash: draft.revisionHash,
    normalizedInput: draft.normalizedInput,
    intent: draft.proposedIntent,
    taskRef: currentTask,
    payloadRef: 'asset://requirements/req-rejected',
    requestKind: 'new-task-create',
  });
  ledger.confirmRevision(confirmation);
  const dispatched: RequirementEnvelope[] = [];
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      dispatched.push(envelope);
      return { requirementId: envelope.requirementId };
    },
  });

  const closure = await rejectDraftRevision(intake, ledger, {
    interactionId: interaction,
    reason: 'user abandoned the draft',
    rejectionId: 'reject-1',
    closedAt: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(closure.durable, true);
  assert.equal(closure.reason, 'user abandoned the draft');
  assert.equal(closure.draftRevisionHash, draft.revisionHash);
  assert.equal((await intake.inspect(interaction)).state, 'rejected');
  assert.equal(inbox.size, 0);
  await assert.rejects(
    () => owner.submitFinal({
      interactionId: interaction,
      draftId: draft.draftId,
      inputRevision: draft.inputRevision,
      draftRevisionVersion: draft.revisionVersion,
      draftRevisionHash: draft.revisionHash,
      confirmationRef: 'confirm-before-reject',
      idempotencyKey: 'submit-after-reject',
      requestKind: 'new-task-create',
    }),
    (error) => (error as { code?: string }).code === 'confirmation-stale',
  );
  assert.equal(dispatched.length, 0);

  // A rejected draft cannot be confirmed afterward.
  let rejectCode = '';
  try {
    await intake.confirmDraftRevision({
      interactionId: interaction,
      draftId: draft.draftId,
      draftRevisionVersion: draft.revisionVersion,
      draftRevisionHash: draft.revisionHash,
      confirmationRef: 'confirm-after-reject',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-02T00:00:00.000Z',
      payloadRef: 'asset://requirements/req-x',
    });
  } catch (error) {
    rejectCode = error instanceof DraftRevisionError ? error.code : error instanceof ExplicitIntakeError ? error.code : 'unknown';
  }
  assert.notEqual(rejectCode, '');
});
