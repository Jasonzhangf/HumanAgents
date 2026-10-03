import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  DraftRevisionInput,
  ExistingTaskChangeSubmit,
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
  ExplicitBrainRouterError,
  RequirementSubmissionOwner,
  rejectDraftRevision,
  type ConfirmationLedgerState,
  type PersistedFinalSubmitReceipt,
  type RegisteredDraftRevision,
} from '../../../packages/runtime/src/explicit-brain/router.js';
import type { RequirementInboxState } from '../../../packages/runtime/src/intake/requirement-inbox.js';

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

class FlakyFileIntakeJournal extends FileIntakeJournal {
  failNextSave = false;

  override save(state: ExplicitIntakeState): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('journal unavailable');
    }
    super.save(state);
  }
}

class CountingRequirementInbox extends RequirementInbox {
  appendCount = 0;

  override async append(input: RequirementEnvelope) {
    this.appendCount += 1;
    return super.append(input);
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function confirmedDraftFixture(intake: ExplicitIntake, payloadRef: string) {
  const interaction = await receivePreview(intake);
  await intake.createDraft(interaction, draftIntent());
  const revision = intake.currentDraftRevision(interaction);
  assert.ok(revision);
  const confirmation = await intake.confirmDraftRevision({
    interactionId: interaction,
    draftId: revision.draftId,
    draftRevisionVersion: revision.revisionVersion,
    draftRevisionHash: revision.revisionHash,
    confirmationRef: `confirm-${payloadRef}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef,
  });
  const registered: RegisteredDraftRevision = {
    interactionId: interaction,
    draftId: revision.draftId,
    inputRevision: revision.inputRevision,
    draftRevisionVersion: revision.revisionVersion,
    draftRevisionHash: revision.revisionHash,
    normalizedInput: revision.normalizedInput,
    intent: revision.proposedIntent,
    taskRef: currentTask,
    payloadRef,
    requestKind: 'new-task-create',
  };
  return { interaction, revision, confirmation, registered };
}

function finalSubmitFor(
  registered: RegisteredDraftRevision,
  confirmationRef: string,
  idempotencyKey: string,
): FinalSubmit {
  return {
    interactionId: registered.interactionId,
    draftId: registered.draftId,
    inputRevision: registered.inputRevision,
    draftRevisionVersion: registered.draftRevisionVersion,
    draftRevisionHash: registered.draftRevisionHash,
    confirmationRef,
    idempotencyKey,
    requestKind: 'new-task-create',
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

  // Reusing the key for different edit content, instruction, base, hash, or
  // draft is a typed conflict and must not replace the original receipt.
  const conflicts: readonly DraftRevisionInput[] = [
    edit(first, {
      idempotencyKey: 'edit-1',
      fields: { normalizedInput: 'different edit content', scope: 'different-scope' },
    }),
    edit(first, {
      idempotencyKey: 'edit-1',
      instructionRef: 'user-edit-2',
    }),
    edit(first, {
      idempotencyKey: 'edit-1',
      baseRevisionVersion: refined.revisionVersion,
      requestedRevisionHash: refined.revisionHash,
    }),
    edit(first, {
      idempotencyKey: 'edit-1',
      draftId: 'draft-other',
    }),
  ];
  for (const conflict of conflicts) {
    await assert.rejects(
      () => intake.refineDraft(interaction, conflict),
      (error) => error instanceof ExplicitIntakeError && error.code === 'idempotency-conflict',
    );
    assert.equal(intake.currentDraftRevision(interaction)?.revisionHash, refined.revisionHash);
  }

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

test('confirmation ledger binds the exact payload reference before final submit', async () => {
  const revision: RegisteredDraftRevision = {
    interactionId: 'interaction-payload-binding',
    draftId: 'draft-payload-binding',
    inputRevision: 1,
    draftRevisionVersion: 1,
    draftRevisionHash: 'sha256:payload-binding',
    normalizedInput: 'bind the exact payload',
    intent: 'create',
    payloadRef: 'asset://requirements/payload-a',
    requestKind: 'new-task-create',
  };
  const ledger = new ConfirmationLedger();
  ledger.registerRevision(revision);

  let mismatchCode = '';
  try {
    ledger.confirmRevision({
      confirmationRef: 'confirm-payload-binding',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-03T00:00:00.000Z',
      payloadRef: 'asset://requirements/payload-b',
      draftId: revision.draftId,
      draftRevisionVersion: revision.draftRevisionVersion,
      draftRevisionHash: revision.draftRevisionHash,
      interactionId: revision.interactionId,
    });
  } catch (error) {
    mismatchCode = error instanceof ExplicitBrainRouterError ? error.code : 'not-router-error';
  }
  assert.equal(mismatchCode, 'confirmation-stale');
  assert.equal(ledger.revisionConfirmation(revision.draftId), undefined);

  const inbox = new CountingRequirementInbox();
  const dispatched: RequirementEnvelope[] = [];
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      dispatched.push(envelope);
      return { requirementId: envelope.requirementId };
    },
  });
  const submit: FinalSubmit = {
    interactionId: revision.interactionId,
    draftId: revision.draftId,
    inputRevision: revision.inputRevision,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    confirmationRef: 'confirm-payload-binding',
    idempotencyKey: 'submit-payload-binding',
    requestKind: 'new-task-create',
  };
  await assert.rejects(
    () => owner.submitFinal(submit),
    (error) => error instanceof ExplicitBrainRouterError && error.code === 'confirmation-required',
  );
  assert.equal(inbox.appendCount, 0);
  assert.equal(dispatched.length, 0);

  ledger.confirmRevision({
    confirmationRef: 'confirm-payload-binding',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: revision.payloadRef,
    draftId: revision.draftId,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    interactionId: revision.interactionId,
  });
  const receipt = await owner.submitFinal(submit);
  assert.equal(receipt.status, 'submitted');
  assert.equal(inbox.appendCount, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.payloadRef, revision.payloadRef);
});

test('final submit is the only authorization: duplicate is idempotent, reject never dispatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-'));
  try {
  const journal = new FileIntakeJournal(journalPath(root));
  const receiptPath = join(root, 'final-submit-receipts.json');
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
  assert.equal(submitted[0]?.draftId, refined.draftId);
  assert.equal(submitted[0]?.normalizedInput, refined.normalizedInput);
  assert.equal(submitted[0]?.fifoSeq, firstReceipt.requirement.fifoSeq);
  const duplicate = await owner.submitFinal(submit);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.requirement.requirementId, firstReceipt.requirement.requirementId);
  const distinctKeyReplay = await owner.submitFinal({ ...submit, idempotencyKey: 'submit-1-distinct' });
  assert.equal(distinctKeyReplay.status, 'duplicate');
  assert.equal(distinctKeyReplay.requirement.requirementId, firstReceipt.requirement.requirementId);
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

  // Persist the public final receipt contract and restore it into fresh owners:
  // the same-key replay stays a duplicate and never invokes the downstream port.
  appendFileSync(receiptPath, `${JSON.stringify({
    ledger: ledger.exportState(),
    inbox: inbox.exportState(),
    finalReceipts: owner.finalReceipts(),
  })}\n`, 'utf8');
  const restoredReceipts = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    ledger: ConfirmationLedgerState;
    inbox: RequirementInboxState;
    finalReceipts: readonly PersistedFinalSubmitReceipt[];
  };
  const restoredLedger = new ConfirmationLedger();
  restoredLedger.restoreState(restoredReceipts.ledger);
  const restoredInbox = new RequirementInbox();
  restoredInbox.restoreState(restoredReceipts.inbox);
  const restoredDispatches: RequirementEnvelope[] = [];
  const restoredOwner = new RequirementSubmissionOwner(restoredLedger, restoredInbox, {
    async submit(envelope) {
      restoredDispatches.push(envelope);
      return { requirementId: envelope.requirementId };
    },
  });
  restoredOwner.restoreFinalReceipts(restoredReceipts.finalReceipts);
  const restoredReplay = await restoredOwner.submitFinal(submit);
  assert.equal(restoredReplay.status, 'duplicate');
  assert.equal(restoredReplay.requirement.requirementId, firstReceipt.requirement.requirementId);
  const restoredDistinctKeyReplay = await restoredOwner.submitFinal({ ...submit, idempotencyKey: 'submit-1-distinct' });
  assert.equal(restoredDistinctKeyReplay.status, 'duplicate');
  assert.equal(restoredDistinctKeyReplay.requirement.requirementId, firstReceipt.requirement.requirementId);
  assert.equal(restoredDispatches.length, 0);

  // Persistence boundary: reloading the journal reconstructs the same intake state.
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

test('failed confirmation persistence keeps the prior state and retry commits durably', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-persistence-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.createDraft(interaction, draftIntent());
    const revision = intake.currentDraftRevision(interaction);
    assert.ok(revision);

    const confirmationInput = {
      interactionId: interaction,
      draftId: revision.draftId,
      draftRevisionVersion: revision.revisionVersion,
      draftRevisionHash: revision.revisionHash,
      confirmationRef: 'confirm-durable-retry',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-03T00:00:00.000Z',
      payloadRef: 'asset://requirements/durable-confirmation',
    };
    journal.failNextSave = true;
    await assert.rejects(
      () => intake.confirmDraftRevision(confirmationInput),
      /journal unavailable/,
    );

    const afterFailure = await intake.inspect(interaction);
    assert.equal(afterFailure.state, 'awaiting-confirmation');
    assert.equal(afterFailure.revision?.state, 'draft');
    assert.equal(afterFailure.confirmation, undefined);
    assert.equal(afterFailure.confirmations?.length ?? 0, 0);

    const reloadedAfterFailure = new ExplicitIntake(journal);
    const durableAfterFailure = await reloadedAfterFailure.inspect(interaction);
    assert.equal(durableAfterFailure.state, 'awaiting-confirmation');
    assert.equal(durableAfterFailure.revision?.state, 'draft');
    assert.equal(durableAfterFailure.confirmation, undefined);

    const confirmation = await intake.confirmDraftRevision(confirmationInput);
    assert.equal(confirmation.confirmationRef, 'confirm-durable-retry');
    assert.equal(confirmation.payloadRef, 'asset://requirements/durable-confirmation');

    const reloadedAfterRetry = new ExplicitIntake(journal);
    const durableAfterRetry = await reloadedAfterRetry.inspect(interaction);
    assert.equal(durableAfterRetry.state, 'confirmed');
    assert.equal(durableAfterRetry.revision?.state, 'confirmed');
    assert.equal(durableAfterRetry.revision?.revisionHash, revision.revisionHash);
    assert.equal(durableAfterRetry.confirmation?.confirmationRef, 'confirm-durable-retry');
    assert.equal(durableAfterRetry.confirmation?.payloadRef, 'asset://requirements/durable-confirmation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed refinement persistence keeps the prior revision and retry commits durably', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-refinement-persistence-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.createDraft(interaction, draftIntent());
    const first = intake.currentDraftRevision(interaction);
    assert.ok(first);

    journal.failNextSave = true;
    await assert.rejects(
      () => intake.refineDraft(interaction, edit(first)),
      /journal unavailable/,
    );
    assert.equal(intake.currentDraftRevision(interaction)?.revisionHash, first.revisionHash);

    const reloadedAfterFailure = new ExplicitIntake(journal);
    assert.equal(reloadedAfterFailure.currentDraftRevision(interaction)?.revisionHash, first.revisionHash);

    const refined = await intake.refineDraft(interaction, edit(first));
    assert.notEqual(refined.revisionHash, first.revisionHash);

    const reloadedAfterRetry = new ExplicitIntake(journal);
    assert.equal(reloadedAfterRetry.currentDraftRevision(interaction)?.revisionHash, refined.revisionHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('final submit recovery reuses the durable FIFO after callback/downstream failure and fresh owner restart', async () => {
  const revision: RegisteredDraftRevision = {
    interactionId: 'interaction-durable-retry',
    draftId: 'draft-durable-retry',
    inputRevision: 1,
    draftRevisionVersion: 1,
    draftRevisionHash: 'sha256:durable-retry',
    normalizedInput: 'recover the confirmed requirement',
    intent: 'create',
    payloadRef: 'asset://requirements/durable-retry',
    requestKind: 'new-task-create',
  };
  const ledger = new ConfirmationLedger();
  ledger.registerRevision(revision);
  ledger.confirmRevision({
    confirmationRef: 'confirm-durable-retry',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: revision.payloadRef,
    draftId: revision.draftId,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    interactionId: revision.interactionId,
  });
  const inbox = new CountingRequirementInbox();
  let downstreamCalls = 0;
  let appendCallbackCalls = 0;
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      downstreamCalls += 1;
      if (downstreamCalls === 1) throw new Error('transport lost after durable append');
      return { requirementId: envelope.requirementId };
    },
  }, () => {
    appendCallbackCalls += 1;
    if (appendCallbackCalls === 1) throw new Error('append callback failed');
  });
  const submit: FinalSubmit = {
    interactionId: revision.interactionId,
    draftId: revision.draftId,
    inputRevision: revision.inputRevision,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    confirmationRef: 'confirm-durable-retry',
    idempotencyKey: 'submit-durable-retry',
    requestKind: 'new-task-create',
  };

  await assert.rejects(
    () => owner.submitFinal(submit),
    /append callback failed/,
  );
  assert.equal(inbox.appendCount, 1);
  assert.equal(inbox.size, 1);
  assert.equal(inbox.expectedNextFifoSeq, 2);
  assert.equal(inbox.find(revision.draftId)?.fifoSeq, 1);
  assert.equal(downstreamCalls, 0);

  await assert.rejects(
    () => owner.submitFinal(submit),
    /transport lost after durable append/,
  );
  assert.equal(inbox.appendCount, 1);
  assert.equal(inbox.size, 1);
  assert.equal(inbox.expectedNextFifoSeq, 2);
  assert.equal(inbox.find(revision.draftId)?.fifoSeq, 1);
  assert.equal(downstreamCalls, 1);
  const persistedAfterFailure = JSON.parse(JSON.stringify({
    ledger: ledger.exportState(),
    inbox: inbox.exportState(),
  })) as { ledger: ConfirmationLedgerState; inbox: RequirementInboxState };

  const retry = await owner.submitFinal(submit);
  assert.equal(retry.status, 'submitted');
  assert.equal(retry.requirement.fifoSeq, 1);
  assert.equal(inbox.appendCount, 1);
  assert.equal(inbox.size, 1);
  assert.equal(inbox.expectedNextFifoSeq, 2);
  assert.equal(downstreamCalls, 2);

  const restoredLedger = new ConfirmationLedger();
  restoredLedger.restoreState(persistedAfterFailure.ledger);
  const restoredInbox = new CountingRequirementInbox();
  restoredInbox.restoreState(persistedAfterFailure.inbox);
  let restoredCalls = 0;
  const restoredOwner = new RequirementSubmissionOwner(restoredLedger, restoredInbox, {
    async submit(envelope) {
      restoredCalls += 1;
      return { requirementId: envelope.requirementId };
    },
  });
  const restored = await restoredOwner.submitFinal(submit);
  assert.equal(restored.status, 'submitted');
  assert.equal(restored.requirement.requirementId, retry.requirement.requirementId);
  assert.equal(restored.requirement.fifoSeq, 1);
  assert.equal(restoredInbox.appendCount, 0);
  assert.equal(restoredInbox.size, 1);
  assert.equal(restoredInbox.expectedNextFifoSeq, 2);
  assert.equal(restoredCalls, 1);
});

test('final submit recovery reuses the durable FIFO after a mismatching downstream receipt', async () => {
  const revision: RegisteredDraftRevision = {
    interactionId: 'interaction-receipt-retry',
    draftId: 'draft-receipt-retry',
    inputRevision: 1,
    draftRevisionVersion: 1,
    draftRevisionHash: 'sha256:receipt-retry',
    normalizedInput: 'recover the confirmed receipt',
    intent: 'create',
    payloadRef: 'asset://requirements/receipt-retry',
    requestKind: 'new-task-create',
  };
  const ledger = new ConfirmationLedger();
  ledger.registerRevision(revision);
  ledger.confirmRevision({
    confirmationRef: 'confirm-receipt-retry',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: revision.payloadRef,
    draftId: revision.draftId,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    interactionId: revision.interactionId,
  });
  const inbox = new CountingRequirementInbox();
  let downstreamCalls = 0;
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      downstreamCalls += 1;
      return {
        requirementId: downstreamCalls === 1 ? 'requirement:other' : envelope.requirementId,
      };
    },
  });
  const submit: FinalSubmit = {
    interactionId: revision.interactionId,
    draftId: revision.draftId,
    inputRevision: revision.inputRevision,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    confirmationRef: 'confirm-receipt-retry',
    idempotencyKey: 'submit-receipt-retry',
    requestKind: 'new-task-create',
  };

  await assert.rejects(
    () => owner.submitFinal(submit),
    /requirement submission receipt mismatch: requirement:other/,
  );
  assert.equal(inbox.appendCount, 1);
  assert.equal(inbox.find(revision.draftId)?.fifoSeq, 1);

  const retry = await owner.submitFinal(submit);
  assert.equal(retry.status, 'submitted');
  assert.equal(retry.requirement.fifoSeq, 1);
  assert.equal(inbox.appendCount, 1);
  assert.equal(inbox.size, 1);
  assert.equal(inbox.expectedNextFifoSeq, 2);
  assert.equal(downstreamCalls, 2);
});

test('existing-task-change first submit cannot retarget the confirmed task', async () => {
  const taskA = id('task', 'task-existing-a');
  const taskB = id('task', 'task-existing-b');
  const revision: RegisteredDraftRevision = {
    interactionId: 'interaction-existing-target',
    draftId: 'draft-existing-target',
    inputRevision: 1,
    draftRevisionVersion: 1,
    draftRevisionHash: 'sha256:existing-target',
    normalizedInput: 'change task A',
    intent: 'change',
    taskRef: taskA,
    payloadRef: 'asset://requirements/existing-target',
    requestKind: 'existing-task-change',
  };
  const ledger = new ConfirmationLedger();
  ledger.registerRevision(revision);
  ledger.confirmRevision({
    confirmationRef: 'confirm-existing-target',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: revision.payloadRef,
    draftId: revision.draftId,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    interactionId: revision.interactionId,
  });
  const inbox = new CountingRequirementInbox();
  const downstream: RequirementEnvelope[] = [];
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      downstream.push(envelope);
      return { requirementId: envelope.requirementId };
    },
  });
  const submit: ExistingTaskChangeSubmit = {
    interactionId: revision.interactionId,
    taskId: taskB,
    draftId: revision.draftId,
    inputRevision: revision.inputRevision,
    draftRevisionVersion: revision.draftRevisionVersion,
    draftRevisionHash: revision.draftRevisionHash,
    confirmationRef: 'confirm-existing-target',
    idempotencyKey: 'submit-existing-b',
    requestKind: 'existing-task-change',
  };

  await assert.rejects(
    () => owner.submitFinal(submit),
    (error) => error instanceof ExplicitBrainRouterError && error.code === 'unauthorized-final-submit',
  );
  assert.equal(inbox.appendCount, 0);
  assert.equal(inbox.size, 0);
  assert.equal(downstream.length, 0);

  const receipt = await owner.submitFinal({ ...submit, taskId: taskA, idempotencyKey: 'submit-existing-a' });
  assert.equal(receipt.status, 'submitted');
  assert.equal(inbox.appendCount, 1);
  assert.equal(inbox.find(revision.draftId)?.taskRef?.scope, taskA.scope);
  assert.equal(inbox.find(revision.draftId)?.taskRef?.value, taskA.value);
  assert.equal(downstream.length, 1);
  assert.equal(downstream[0]?.taskRef?.value, taskA.value);
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

  const closure = await rejectDraftRevision(intake, owner, {
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

test('failed draft creation persistence preserves prior state, lookup, sequence, and durable retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-create-failure-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);

    journal.failNextSave = true;
    await assert.rejects(
      () => intake.createDraft(interaction, draftIntent()),
      /journal unavailable/,
    );

    const afterFailure = await intake.inspect(interaction);
    assert.equal(afterFailure.state, 'received');
    assert.equal(afterFailure.revision, undefined);
    assert.equal(afterFailure.draft, undefined);
    assert.equal(afterFailure.preview, undefined);
    await assert.rejects(
      () => intake.prepareConfirmation({
        draftId: 'draft-1',
        inputRevision: 1,
        confirmationRef: 'confirm-after-failed-create',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-03T00:00:00.000Z',
        payloadRef: 'asset://requirements/failed-create',
      }),
      (error) => error instanceof ExplicitIntakeError && error.code === 'draft-not-found',
    );

    const reloadedAfterFailure = new ExplicitIntake(journal);
    const durableAfterFailure = await reloadedAfterFailure.inspect(interaction);
    assert.equal(durableAfterFailure.state, 'received');
    assert.equal(durableAfterFailure.revision, undefined);

    const preview = await intake.createDraft(interaction, draftIntent());
    assert.equal(preview.draftId, 'draft-1');
    const secondInteraction = await receivePreview(intake);
    const secondPreview = await intake.createDraft(secondInteraction, draftIntent());
    assert.equal(secondPreview.draftId, 'draft-2');

    const reloadedAfterRetry = new ExplicitIntake(journal);
    assert.equal((await reloadedAfterRetry.inspect(interaction)).revision?.draftId, 'draft-1');
    assert.equal((await reloadedAfterRetry.inspect(secondInteraction)).revision?.draftId, 'draft-2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed rejection persistence preserves prior state, retries once, and replays the same closure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-rejection-failure-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.createDraft(interaction, draftIntent());
    const revision = intake.currentDraftRevision(interaction);
    assert.ok(revision);

    const rejectionInput = {
      interactionId: interaction,
      reason: 'user abandoned the draft',
      rejectionId: 'reject-durable-retry',
      closedAt: '2026-10-03T00:00:00.000Z',
    };
    journal.failNextSave = true;
    await assert.rejects(
      () => intake.rejectDraft(rejectionInput),
      /journal unavailable/,
    );

    const afterFailure = await intake.inspect(interaction);
    assert.equal(afterFailure.state, 'awaiting-confirmation');
    assert.equal(afterFailure.revision?.state, 'draft');
    assert.equal(afterFailure.reason, undefined);
    assert.equal(afterFailure.rejections?.length ?? 0, 0);

    const reloadedAfterFailure = new ExplicitIntake(journal);
    const durableAfterFailure = await reloadedAfterFailure.inspect(interaction);
    assert.equal(durableAfterFailure.state, 'awaiting-confirmation');
    assert.equal(durableAfterFailure.revision?.state, 'draft');
    assert.equal(durableAfterFailure.rejections?.length ?? 0, 0);

    const closure = await intake.rejectDraft(rejectionInput);
    assert.equal(closure.durable, true);
    const duplicate = await intake.rejectDraft(rejectionInput);
    assert.deepEqual(duplicate, closure);

    const afterRetry = await intake.inspect(interaction);
    assert.equal(afterRetry.state, 'rejected');
    assert.equal(afterRetry.revision?.state, 'rejected');
    assert.equal(afterRetry.rejections?.length, 1);
    assert.deepEqual(afterRetry.rejections?.[0], closure);

    const reloadedAfterRetry = new ExplicitIntake(journal);
    const durableAfterRetry = await reloadedAfterRetry.inspect(interaction);
    assert.equal(durableAfterRetry.state, 'rejected');
    assert.equal(durableAfterRetry.revision?.state, 'rejected');
    assert.equal(durableAfterRetry.rejections?.length, 1);
    assert.deepEqual(durableAfterRetry.rejections?.[0], closure);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed submitted-marker persistence preserves confirmed state and retry dispatches once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-submitted-failure-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const { interaction } = await confirmedDraftFixture(intake, 'asset://requirements/submitted-retry');

    journal.failNextSave = true;
    await assert.rejects(
      () => intake.markRevisionSubmitted(interaction),
      /journal unavailable/,
    );

    const afterFailure = await intake.inspect(interaction);
    assert.equal(afterFailure.state, 'confirmed');
    assert.equal(afterFailure.revision?.state, 'confirmed');
    const reloadedAfterFailure = new ExplicitIntake(journal);
    const durableAfterFailure = await reloadedAfterFailure.inspect(interaction);
    assert.equal(durableAfterFailure.state, 'confirmed');
    assert.equal(durableAfterFailure.revision?.state, 'confirmed');

    await intake.markRevisionSubmitted(interaction);
    await intake.markRevisionSubmitted(interaction);
    const afterRetry = await intake.inspect(interaction);
    assert.equal(afterRetry.state, 'dispatched');
    assert.equal(afterRetry.revision?.state, 'submitted');
    const reloadedAfterRetry = new ExplicitIntake(journal);
    const durableAfterRetry = await reloadedAfterRetry.inspect(interaction);
    assert.equal(durableAfterRetry.state, 'dispatched');
    assert.equal(durableAfterRetry.revision?.state, 'submitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejection before append persists first, retries after save failure, and fences final submit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-rejection-before-append-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const { interaction, confirmation, registered } = await confirmedDraftFixture(
      intake,
      'asset://requirements/rejection-before-append',
    );
    const ledger = new ConfirmationLedger();
    ledger.registerRevision(registered);
    ledger.confirmRevision(confirmation);
    const inbox = new CountingRequirementInbox();
    let portCalls = 0;
    const owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        portCalls += 1;
        return { requirementId: envelope.requirementId };
      },
    });
    const submitInput = finalSubmitFor(registered, confirmation.confirmationRef, 'submit-rejected-before-append');
    const rejectionInput = {
      interactionId: interaction,
      reason: 'user abandoned the draft',
      rejectionId: 'reject-before-append',
      closedAt: '2026-10-03T00:00:00.000Z',
    };

    journal.failNextSave = true;
    await assert.rejects(
      () => rejectDraftRevision(intake, owner, rejectionInput),
      /journal unavailable/,
    );
    const afterFailure = await intake.inspect(interaction);
    assert.equal(afterFailure.state, 'confirmed');
    assert.equal(afterFailure.revision?.state, 'confirmed');
    assert.equal(afterFailure.rejections?.length ?? 0, 0);
    assert.doesNotThrow(() => ledger.assertFinalSubmit(submitInput));
    assert.equal(inbox.size, 0);
    assert.equal(portCalls, 0);

    const closure = await rejectDraftRevision(intake, owner, rejectionInput);
    assert.equal(closure.durable, true);
    assert.equal((await intake.inspect(interaction)).state, 'rejected');
    assert.equal(inbox.size, 0);
    assert.equal(portCalls, 0);
    await assert.rejects(
      () => owner.submitFinal(submitInput),
      (error) => error instanceof ExplicitBrainRouterError && error.code === 'confirmation-stale',
    );
    assert.equal(inbox.size, 0);
    assert.equal(portCalls, 0);

    const duplicate = await rejectDraftRevision(intake, owner, {
      interactionId: interaction,
      reason: rejectionInput.reason,
      rejectionId: rejectionInput.rejectionId,
    });
    assert.deepEqual(duplicate, closure);
    assert.equal((await intake.inspect(interaction)).rejections?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejection queued behind a held final submit cannot close after durable dispatch', async () => {
  const intake = new ExplicitIntake();
  const { interaction, confirmation, registered } = await confirmedDraftFixture(
    intake,
    'asset://requirements/rejection-race',
  );
  const ledger = new ConfirmationLedger();
  ledger.registerRevision(registered);
  ledger.confirmRevision(confirmation);
  const inbox = new CountingRequirementInbox();
  const portEntered = deferred<void>();
  const releasePort = deferred<void>();
  let portCalls = 0;
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) {
      portCalls += 1;
      portEntered.resolve();
      await releasePort.promise;
      return { requirementId: envelope.requirementId };
    },
  });
  const submitInput = finalSubmitFor(registered, confirmation.confirmationRef, 'submit-rejection-race');
  const submitting = owner.submitFinal(submitInput);
  await portEntered.promise;
  assert.equal(inbox.size, 1);

  let rejectionSettled = false;
  const rejectionPromise = rejectDraftRevision(intake, owner, {
    interactionId: interaction,
    reason: 'user abandoned the draft',
    rejectionId: 'reject-race',
    closedAt: '2026-10-03T00:00:00.000Z',
  }).then(
    () => {
      rejectionSettled = true;
      return undefined;
    },
    (error: unknown) => {
      rejectionSettled = true;
      return error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rejectionSettled, false);

  releasePort.resolve();
  const receipt = await submitting;
  const rejection = await rejectionPromise;
  assert.equal(receipt.status, 'submitted');
  assert.ok(rejection instanceof ExplicitBrainRouterError);
  assert.equal(rejection.code, 'rejection-blocked');
  const after = await intake.inspect(interaction);
  assert.equal(after.state, 'confirmed');
  assert.equal(after.revision?.state, 'confirmed');
  assert.equal(after.rejections?.length ?? 0, 0);
  assert.equal(inbox.size, 1);
  assert.equal(portCalls, 1);
});

test('uncertain final-submit failure and restart retain durable inbox fencing for rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-rejection-restart-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const { interaction, confirmation, registered } = await confirmedDraftFixture(
      intake,
      'asset://requirements/rejection-restart',
    );
    const ledger = new ConfirmationLedger();
    ledger.registerRevision(registered);
    ledger.confirmRevision(confirmation);
    const inbox = new CountingRequirementInbox();
    let portCalls = 0;
    const owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        portCalls += 1;
        throw new Error(`transport lost after durable append: ${envelope.requirementId}`);
      },
    });
    const submitInput = finalSubmitFor(registered, confirmation.confirmationRef, 'submit-rejection-restart');
    await assert.rejects(
      () => owner.submitFinal(submitInput),
      /transport lost after durable append/,
    );
    assert.equal(portCalls, 1);
    assert.equal(inbox.appendCount, 1);
    assert.equal(inbox.size, 1);

    const rejectionInput = {
      interactionId: interaction,
      reason: 'user abandoned the draft',
      rejectionId: 'reject-restart',
      closedAt: '2026-10-03T00:00:00.000Z',
    };
    const rejection = await rejectDraftRevision(intake, owner, rejectionInput).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof ExplicitBrainRouterError);
    assert.equal(rejection.code, 'rejection-blocked');
    assert.equal((await intake.inspect(interaction)).state, 'confirmed');

    const ledgerState = ledger.exportState();
    const inboxState = inbox.exportState();
    const restoredIntake = new ExplicitIntake(journal);
    const restoredLedger = new ConfirmationLedger();
    restoredLedger.restoreState(ledgerState);
    const restoredInbox = new CountingRequirementInbox();
    restoredInbox.restoreState(inboxState);
    const restoredOwner = new RequirementSubmissionOwner(restoredLedger, restoredInbox, {
      async submit(envelope) {
        return { requirementId: envelope.requirementId };
      },
    });

    const restoredRejection = await rejectDraftRevision(restoredIntake, restoredOwner, rejectionInput).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(restoredRejection instanceof ExplicitBrainRouterError);
    assert.equal(restoredRejection.code, 'rejection-blocked');
    assert.equal((await restoredIntake.inspect(interaction)).state, 'confirmed');

    const retry = await restoredOwner.submitFinal(submitInput);
    assert.equal(retry.status, 'submitted');
    assert.equal(restoredInbox.appendCount, 0);
    assert.equal(restoredInbox.size, 1);
    assert.equal(restoredInbox.find(registered.draftId)?.fifoSeq, retry.requirement.fifoSeq);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
