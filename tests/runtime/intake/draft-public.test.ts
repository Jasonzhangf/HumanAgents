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
  type MatchResult,
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

interface PublicFinalSubmitBinding {
  readonly idempotencyKey: string;
  readonly revisionKey: string;
  readonly requestDigest: string;
  readonly requestIdentity: string;
}

interface ExplicitBrainJournalState {
  readonly ledger: ConfirmationLedgerState & {
    readonly finalSubmitBindings?: readonly PublicFinalSubmitBinding[];
  };
  readonly inbox: RequirementInboxState;
  readonly finalReceipts?: readonly PersistedFinalSubmitReceipt[];
}

class FileExplicitBrainJournal {
  constructor(private readonly filePath: string) {}

  save(state: ExplicitBrainJournalState): void {
    appendFileSync(this.filePath, `${JSON.stringify({ kind: 'explicit-brain.state', state })}\n`, 'utf8');
  }

  load(): ExplicitBrainJournalState | undefined {
    let raw = '';
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
    const records = raw.split('\n').filter((line) => line.trim().length > 0);
    if (records.length === 0) return undefined;
    const latest = JSON.parse(records[records.length - 1]) as { state: ExplicitBrainJournalState };
    return structuredClone(latest.state);
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
    executionControlRef: 'control://policy/original',
    ...overrides,
  };
}

function matchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    normalizedInput: 'legacy match input',
    matchedTasks: [{ taskId: currentTask, relation: 'current', status: 'running' }],
    knownFacts: ['legacy fixture'],
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

function interactionState(state: ExplicitIntakeState, interactionId: string) {
  return state.interactions.find((interaction) => interaction.interactionId === interactionId);
}

async function assertFailedSaveIsAtomic(
  intake: ExplicitIntake,
  journal: FlakyFileIntakeJournal,
  operation: () => Promise<unknown>,
): Promise<{ readonly before: ExplicitIntakeState; readonly interactionId: string }> {
  const before = structuredClone(intake.exportState());
  const durableBefore = structuredClone(new ExplicitIntake(journal).exportState());
  const interactionId = before.interactions[0]?.interactionId;
  assert.ok(interactionId);

  journal.failNextSave = true;
  await assert.rejects(operation, /journal unavailable/);

  assert.deepEqual(intake.exportState(), before);
  assert.deepEqual(new ExplicitIntake(journal).exportState(), durableBefore);
  return { before, interactionId };
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

test('typed refined preview cannot enter the legacy confirmation and submission chain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-typed-legacy-fence-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.createDraft(interaction, draftIntent());
    const first = intake.currentDraftRevision(interaction);
    assert.ok(first);
    const refined = await intake.refineDraft(interaction, edit(first));
    const before = structuredClone(await intake.inspect(interaction));

    const inbox = new CountingRequirementInbox();
    const ledger = new ConfirmationLedger();
    const dispatched: RequirementEnvelope[] = [];
    const owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        dispatched.push(envelope);
        return { requirementId: envelope.requirementId };
      },
    });

    await assert.rejects(
      async () => {
        const confirmed = await intake.prepareConfirmation({
          interactionId: interaction,
          draftId: refined.draftId,
          inputRevision: refined.inputRevision,
          confirmationRef: 'confirm-legacy-after-refine',
          confirmedBy: 'human:operator',
          confirmedAt: '2026-10-03T00:00:00.000Z',
          payloadRef: 'asset://requirements/legacy-after-refine',
        });
        ledger.registerDraft({
          interactionId: confirmed.interactionId,
          draftId: confirmed.draftId,
          inputRevision: confirmed.inputRevision,
          normalizedInput: confirmed.normalizedInput,
          intent: confirmed.intent,
          taskRef: confirmed.taskRef,
          payloadRef: confirmed.payloadRef,
        });
        ledger.confirm({
          interactionId: confirmed.interactionId,
          draftId: confirmed.draftId,
          inputRevision: confirmed.inputRevision,
          confirmationRef: confirmed.confirmationRef,
          confirmedBy: confirmed.confirmedBy,
          confirmedAt: confirmed.confirmedAt,
        });
        await owner.submit({
          interactionId: confirmed.interactionId,
          draftId: confirmed.draftId,
          confirmationRef: confirmed.confirmationRef,
          inputRevision: confirmed.inputRevision,
        });
      },
      (error) => error instanceof ExplicitIntakeError && error.code === 'typed-draft-final-submit-required',
    );

    const after = await intake.inspect(interaction);
    assert.deepEqual(after, before);
    assert.equal(inbox.size, 0);
    assert.equal(dispatched.length, 0);
    const reloaded = new ExplicitIntake(journal);
    assert.deepEqual(await reloaded.inspect(interaction), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a prepared legacy confirmation cannot be upgraded into typed draft ownership', async () => {
  const intake = new ExplicitIntake();
  const interaction = await receivePreview(intake);
  await intake.beginMatching(interaction);
  await intake.recordMatch(interaction, {
    normalizedInput: 'legacy confirmation first',
    matchedTasks: [{ taskId: currentTask, relation: 'current', status: 'running' }],
    knownFacts: ['legacy fixture'],
  });
  await intake.propose(interaction, {
    proposedIntent: 'change',
    proposal: 'prepare a legacy confirmation',
  });
  const snapshot = await intake.inspect(interaction);
  assert.ok(snapshot.draft);
  await intake.prepareConfirmation({
    interactionId: interaction,
    draftId: snapshot.draft.draftId,
    inputRevision: snapshot.draft.inputRevision,
    confirmationRef: 'confirm-before-typed-create',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: 'asset://requirements/legacy-before-typed-create',
  });
  const before = structuredClone(await intake.inspect(interaction));

  await assert.rejects(
    () => intake.createDraft(interaction, draftIntent()),
    (error) => error instanceof ExplicitIntakeError && error.code === 'draft-confirmation-already-prepared',
  );
  assert.deepEqual(await intake.inspect(interaction), before);
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

test('failed initial receive persistence preserves the prior snapshot and sequence for a later input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-receive-failure-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const before = structuredClone(intake.exportState());

    journal.failNextSave = true;
    await assert.rejects(
      () => intake.receive({
        sourceRef: 'ui:failed-new-task',
        rawInput: 'this input must not be retained',
        channel: 'business',
        requestKind: 'new-task-preview',
      }),
      /journal unavailable/,
    );
    assert.deepEqual(intake.exportState(), before);

    const interaction = await intake.receive({
      sourceRef: 'ui:successful-new-task',
      rawInput: 'retain only this input',
      channel: 'business',
      requestKind: 'new-task-preview',
    });
    assert.equal(interaction, 'interaction-1');
    const afterSuccess = await intake.inspect(interaction);
    assert.equal(afterSuccess.rawInput, 'retain only this input');
    assert.equal(intake.exportState().interactions.length, 1);

    const reloaded = new ExplicitIntake(journal);
    const durable = await reloaded.inspect(interaction);
    assert.equal(durable.rawInput, 'retain only this input');
    assert.equal(reloaded.exportState().interactions.length, 1);
    assert.equal(journal.recordCount(), 1);
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

test('final submit waits for append persistence acknowledgement before downstream dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-final-append-ack-'));
  try {
    const revision: RegisteredDraftRevision = {
      interactionId: 'interaction-final-append-ack',
      draftId: 'draft-final-append-ack',
      inputRevision: 1,
      draftRevisionVersion: 1,
      draftRevisionHash: 'sha256:final-append-ack',
      normalizedInput: 'persist the exact confirmed envelope',
      intent: 'create',
      payloadRef: 'asset://requirements/final-append-ack',
      requestKind: 'new-task-create',
    };
    const ledger = new ConfirmationLedger();
    ledger.registerRevision(revision);
    ledger.confirmRevision({
      confirmationRef: 'confirm-final-append-ack',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-03T00:00:00.000Z',
      payloadRef: revision.payloadRef,
      draftId: revision.draftId,
      draftRevisionVersion: revision.draftRevisionVersion,
      draftRevisionHash: revision.draftRevisionHash,
      interactionId: revision.interactionId,
    });
    const inbox = new CountingRequirementInbox();
    const journal = new FileExplicitBrainJournal(join(root, 'explicit-brain.jsonl'));
    let persistenceAvailable = false;
    let persistenceCalls = 0;
    const persistenceErrors: unknown[] = [];
    const dispatches: RequirementEnvelope[] = [];
    const owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        const persisted = journal.load();
        assert.ok(persisted);
        assert.equal(persisted.ledger.finalSubmitBindings?.length, 1);
        assert.equal(persisted.inbox.envelopes.length, 1);
        assert.deepEqual(persisted.inbox.envelopes[0], envelope);
        dispatches.push(structuredClone(envelope));
        return { requirementId: envelope.requirementId };
      },
    }, () => {
      persistenceCalls += 1;
      if (!persistenceAvailable) throw new Error('journal unavailable');
      journal.save({ ledger: ledger.exportState(), inbox: inbox.exportState() });
    });
    const submit: FinalSubmit = {
      interactionId: revision.interactionId,
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      draftRevisionVersion: revision.draftRevisionVersion,
      draftRevisionHash: revision.draftRevisionHash,
      confirmationRef: 'confirm-final-append-ack',
      idempotencyKey: 'submit-final-append-ack',
      requestKind: 'new-task-create',
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await owner.submitFinal(submit).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'journal unavailable');
      persistenceErrors.push(error);
    }
    assert.equal(persistenceErrors[0], persistenceErrors[1]);
    assert.equal(persistenceCalls, 2);
    assert.equal(inbox.appendCount, 1);
    assert.equal(inbox.size, 1);
    assert.equal(dispatches.length, 0);
    assert.equal(owner.finalReceipts().length, 0);
    const originalEnvelope = inbox.find(revision.draftId);
    assert.ok(originalEnvelope);

    persistenceAvailable = true;
    const receipt = await owner.submitFinal(submit);
    assert.equal(receipt.status, 'submitted');
    assert.equal(persistenceCalls, 3);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0], originalEnvelope);
    assert.equal(dispatches[0]?.fifoSeq, originalEnvelope.fifoSeq);
    assert.equal(inbox.appendCount, 1);
    assert.equal(owner.finalReceipts().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completed revision alias is acknowledged before duplicate replay and survives reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-final-alias-'));
  try {
    const intake = new ExplicitIntake();
    const first = await confirmedDraftFixture(intake, 'asset://requirements/alias-a');
    const second = await confirmedDraftFixture(intake, 'asset://requirements/alias-b');
    const ledger = new ConfirmationLedger();
    ledger.registerRevision(first.registered);
    ledger.confirmRevision(first.confirmation);
    ledger.registerRevision(second.registered);
    ledger.confirmRevision(second.confirmation);
    const inbox = new CountingRequirementInbox();
    const journal = new FileExplicitBrainJournal(join(root, 'explicit-brain.jsonl'));
    const dispatches: RequirementEnvelope[] = [];
    let persistenceAvailable = true;
    let owner!: RequirementSubmissionOwner;
    const persist = () => {
      if (!persistenceAvailable) throw new Error('journal unavailable');
      journal.save({
        ledger: ledger.exportState(),
        inbox: inbox.exportState(),
        finalReceipts: owner.finalReceipts(),
      });
    };
    owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        dispatches.push(structuredClone(envelope));
        return { requirementId: envelope.requirementId };
      },
    }, persist, persist);
    const submitFirst = finalSubmitFor(first.registered, first.confirmation.confirmationRef, 'key-a');
    const submitAlias = finalSubmitFor(first.registered, first.confirmation.confirmationRef, 'alias');

    const firstReceipt = await owner.submitFinal(submitFirst);
    assert.equal(firstReceipt.status, 'submitted');
    assert.equal(dispatches.length, 1);

    persistenceAvailable = false;
    const persistenceErrors: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await owner.submitFinal(submitAlias).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'journal unavailable');
      persistenceErrors.push(error);
    }
    assert.equal(persistenceErrors[0], persistenceErrors[1]);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(
      journal.load()?.finalReceipts?.map((receipt) => receipt.idempotencyKey),
      ['key-a'],
    );

    persistenceAvailable = true;
    const aliasReceipt = await owner.submitFinal(submitAlias);
    assert.equal(aliasReceipt.status, 'duplicate');
    assert.equal(aliasReceipt.requirement.requirementId, firstReceipt.requirement.requirementId);
    assert.equal(dispatches.length, 1);
    assert.equal(inbox.appendCount, 1);
    assert.deepEqual(
      journal.load()?.finalReceipts?.map((receipt) => receipt.idempotencyKey).sort(),
      ['alias', 'key-a'],
    );

    const durable = journal.load();
    assert.ok(durable);
    const restoredLedger = new ConfirmationLedger();
    restoredLedger.restoreState(durable.ledger);
    const restoredInbox = new CountingRequirementInbox();
    restoredInbox.restoreState(durable.inbox);
    const restoredDispatches: RequirementEnvelope[] = [];
    const restoredOwner = new RequirementSubmissionOwner(restoredLedger, restoredInbox, {
      async submit(envelope) {
        restoredDispatches.push(structuredClone(envelope));
        return { requirementId: envelope.requirementId };
      },
    });
    restoredOwner.restoreFinalReceipts(durable.finalReceipts ?? []);
    await assert.rejects(
      () => restoredOwner.submitFinal(
        finalSubmitFor(second.registered, second.confirmation.confirmationRef, 'alias'),
      ),
      (error) => error instanceof ExplicitBrainRouterError && error.code === 'duplicate-submit',
    );
    assert.equal(restoredDispatches.length, 0);
    assert.equal(restoredInbox.appendCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('final submit reserves shared idempotency before dispatch and survives durable replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-final-reservation-'));
  try {
    const intake = new ExplicitIntake();
    const first = await confirmedDraftFixture(intake, 'asset://requirements/reservation-a');
    const second = await confirmedDraftFixture(intake, 'asset://requirements/reservation-b');
    const ledger = new ConfirmationLedger();
    ledger.registerRevision(first.registered);
    ledger.confirmRevision(first.confirmation);
    ledger.registerRevision(second.registered);
    ledger.confirmRevision(second.confirmation);
    const inbox = new CountingRequirementInbox();
    const journal = new FileExplicitBrainJournal(join(root, 'explicit-brain.jsonl'));
    const dispatches: RequirementEnvelope[] = [];
    let responseLosses = 2;
    const owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        dispatches.push(structuredClone(envelope));
        if (responseLosses > 0) {
          responseLosses -= 1;
          throw new Error('response lost after execution');
        }
        return { requirementId: envelope.requirementId };
      },
    }, () => {
      journal.save({ ledger: ledger.exportState(), inbox: inbox.exportState() });
    });
    const submitFirst = finalSubmitFor(first.registered, first.confirmation.confirmationRef, 'shared-reservation-key');
    const submitSecond = finalSubmitFor(second.registered, second.confirmation.confirmationRef, 'shared-reservation-key');

    await assert.rejects(() => owner.submitFinal(submitFirst), /response lost after execution/);
    const originalEnvelope = inbox.find(first.registered.draftId);
    assert.ok(originalEnvelope);
    await assert.rejects(() => owner.submitFinal(submitFirst), /response lost after execution/);
    assert.equal(dispatches.length, 2);
    assert.deepEqual(dispatches[1], originalEnvelope);

    await assert.rejects(
      () => owner.submitFinal(submitSecond),
      (error) => error instanceof ExplicitBrainRouterError && error.code === 'duplicate-submit',
    );
    assert.equal(dispatches.length, 2);
    assert.equal(inbox.appendCount, 1);
    assert.equal(inbox.find(second.registered.draftId), undefined);

    const persisted = journal.load();
    assert.ok(persisted);
    assert.equal(persisted.ledger.finalSubmitBindings?.length, 1);
    assert.equal(persisted.ledger.finalSubmitBindings?.[0]?.idempotencyKey, 'shared-reservation-key');
    assert.deepEqual(persisted.inbox.envelopes, [originalEnvelope]);

    const restoredLedger = new ConfirmationLedger();
    restoredLedger.restoreState(persisted.ledger);
    const restoredInbox = new CountingRequirementInbox();
    restoredInbox.restoreState(persisted.inbox);
    const restoredDispatches: RequirementEnvelope[] = [];
    const restoredOwner = new RequirementSubmissionOwner(restoredLedger, restoredInbox, {
      async submit(envelope) {
        restoredDispatches.push(structuredClone(envelope));
        return { requirementId: envelope.requirementId };
      },
    });

    await assert.rejects(
      () => restoredOwner.submitFinal(submitSecond),
      (error) => error instanceof ExplicitBrainRouterError && error.code === 'duplicate-submit',
    );
    assert.equal(restoredDispatches.length, 0);
    const resumed = await restoredOwner.submitFinal(submitFirst);
    assert.equal(resumed.status, 'submitted');
    assert.equal(resumed.requirement.requirementId, originalEnvelope.requirementId);
    assert.equal(resumed.requirement.fifoSeq, originalEnvelope.fifoSeq);
    assert.deepEqual(restoredDispatches, [originalEnvelope]);
    assert.equal(restoredInbox.appendCount, 0);
    assert.equal(restoredInbox.size, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('exact confirmation replay after formal rejection fails without state or downstream mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-confirm-after-reject-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const { interaction, revision, confirmation, registered } = await confirmedDraftFixture(
      intake,
      'asset://requirements/confirm-after-reject',
    );
    const exactConfirmation = {
      interactionId: interaction,
      draftId: revision.draftId,
      draftRevisionVersion: revision.revisionVersion,
      draftRevisionHash: revision.revisionHash,
      confirmationRef: confirmation.confirmationRef,
      confirmedBy: confirmation.confirmedBy,
      confirmedAt: confirmation.confirmedAt,
      payloadRef: confirmation.payloadRef,
    };
    const ledger = new ConfirmationLedger();
    ledger.registerRevision(registered);
    ledger.confirmRevision(confirmation);
    const inbox = new CountingRequirementInbox();
    let downstreamCalls = 0;
    const owner = new RequirementSubmissionOwner(ledger, inbox, {
      async submit(envelope) {
        downstreamCalls += 1;
        return { requirementId: envelope.requirementId };
      },
    });

    const closure = await rejectDraftRevision(intake, owner, {
      interactionId: interaction,
      reason: 'user abandoned the confirmed draft',
      rejectionId: 'reject-confirm-replay',
      closedAt: '2026-10-03T00:00:00.000Z',
    });
    assert.equal(closure.durable, true);
    const afterReject = structuredClone(await intake.inspect(interaction));
    assert.equal(afterReject.state, 'rejected');
    assert.equal(afterReject.revision?.state, 'rejected');
    assert.equal(afterReject.rejections?.length, 1);
    assert.equal(inbox.appendCount, 0);
    assert.equal(inbox.size, 0);
    assert.equal(downstreamCalls, 0);

    await assert.rejects(
      () => intake.confirmDraftRevision(exactConfirmation),
      (error) => error instanceof ExplicitIntakeError && error.code === 'draft-not-confirmable',
    );
    assert.deepEqual(await intake.inspect(interaction), afterReject);
    assert.equal(inbox.appendCount, 0);
    assert.equal(inbox.size, 0);
    assert.equal(downstreamCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('rejected interaction cannot be reopened by delayed draft creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-terminal-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.reject(interaction, 'user cancelled the preview');

    const before = structuredClone(intake.exportState());
    const durableBefore = structuredClone(new ExplicitIntake(journal).exportState());
    const recordCountBefore = journal.recordCount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await assert.rejects(
      () => intake.createDraft(interaction, draftIntent()),
      (error) => error instanceof ExplicitIntakeError && error.code === 'draft-not-creatable',
    );

    const after = await intake.inspect(interaction);
    assert.equal(after.state, 'rejected');
    assert.equal(after.revision, undefined);
    assert.equal(after.preview, undefined);
    assert.deepEqual(intake.exportState(), before);
    assert.deepEqual(new ExplicitIntake(journal).exportState(), durableBefore);
    assert.equal(journal.recordCount(), recordCountBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspect returns isolated nested revision, preview, and draft snapshots', async () => {
  const intake = new ExplicitIntake();
  const interaction = await receivePreview(intake);
  await intake.createDraft(interaction, draftIntent());

  const before = structuredClone(intake.exportState());
  const snapshot = await intake.inspect(interaction);
  assert.ok(snapshot.revision);
  assert.ok(snapshot.preview);
  assert.ok(snapshot.draft);

  const mutableRevision = snapshot.revision as unknown as {
    goal: string;
    constraints: string[];
    deliverables: string[];
    executionControlRef?: string;
  };
  mutableRevision.goal = 'mutated goal';
  mutableRevision.constraints.push('mutated constraint');
  mutableRevision.deliverables.push('mutated deliverable');
  mutableRevision.executionControlRef = 'control://policy/mutated';

  const mutablePreview = snapshot.preview as unknown as {
    authorized: boolean;
    context: { sourceRef: string };
  };
  mutablePreview.authorized = true;
  mutablePreview.context.sourceRef = 'mutated-source';

  (snapshot.draft.matchedTasks as unknown as Array<Record<string, unknown>>).push({
    taskId: id('task', 'task-mutated'),
    relation: 'current',
    status: 'running',
  });

  const ownerRevision = intake.currentDraftRevision(interaction);
  assert.ok(ownerRevision);
  assert.equal(ownerRevision.goal, 'summarize the current task evidence');
  assert.deepEqual(ownerRevision.constraints, ['read-only']);
  assert.deepEqual(ownerRevision.deliverables, ['summary']);
  assert.equal(ownerRevision.executionControlRef, 'control://policy/original');

  const ownerSnapshot = await intake.inspect(interaction);
  assert.equal(ownerSnapshot.preview?.authorized, false);
  assert.equal(ownerSnapshot.preview?.context.sourceRef, 'ui:new-task-form');
  assert.equal(ownerSnapshot.draft?.matchedTasks.length, 1);
  assert.deepEqual(intake.exportState(), before);

  const confirmation = await intake.confirmDraftRevision({
    interactionId: interaction,
    draftId: ownerRevision.draftId,
    draftRevisionVersion: ownerRevision.revisionVersion,
    draftRevisionHash: ownerRevision.revisionHash,
    confirmationRef: 'confirm-isolated-observation',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-03T00:00:00.000Z',
    payloadRef: 'asset://requirements/isolated-observation',
  });
  assert.equal(confirmation.draftRevisionHash, ownerRevision.revisionHash);
});

test('failed recordMatch save is atomic and cannot be persisted by a later requestClarification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-record-match-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);

    const { before, interactionId } = await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.recordMatch(interaction, matchResult()),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'matching');
    assert.equal(failed.draft, undefined);

    await intake.requestClarification(interaction, 'legitimate clarification after failed match');
    const durable = new ExplicitIntake(journal).exportState();
    assert.equal(durable.nextDraftSeq, before.nextDraftSeq);
    assert.equal(interactionState(durable, interactionId)?.draft, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed completeStatusOnly save is atomic and cannot leak its answer through a later rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-status-only-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);
    await intake.beginStatusCheck(interaction);

    await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.completeStatusOnly(interaction, 'unacknowledged status answer'),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'status-checking');
    assert.equal(failed.reply, undefined);

    await intake.reject(interaction, 'legitimate rejection after failed status');
    const durable = new ExplicitIntake(journal).exportState();
    assert.equal(interactionState(durable, interaction)?.reply, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed requestClarification save is atomic and cannot leak question state through a later rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-request-clarification-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);

    await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.requestClarification(interaction, 'unacknowledged clarification question'),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'matching');
    assert.equal(failed.reply, undefined);
    assert.equal(failed.clarifications, undefined);

    await intake.reject(interaction, 'legitimate rejection after failed clarification');
    const durable = new ExplicitIntake(journal).exportState();
    assert.equal(interactionState(durable, interaction)?.reply, undefined);
    assert.equal(interactionState(durable, interaction)?.clarifications, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed answerClarification save is atomic and cannot leak answer state through a later rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-answer-clarification-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);
    await intake.requestClarification(interaction, 'original question');

    await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.answerClarification(interaction, 'unacknowledged clarification answer'),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'awaiting-clarification');
    assert.equal(failed.reply, 'original question');
    assert.equal(failed.clarifications?.at(-1)?.answer, undefined);

    await intake.reject(interaction, 'legitimate rejection after failed answer');
    const durable = new ExplicitIntake(journal).exportState();
    const durableInteraction = interactionState(durable, interaction);
    assert.equal(durableInteraction?.reply, 'original question');
    assert.equal(durableInteraction?.clarifications?.at(-1)?.answer, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed propose save is atomic and cannot leak draft content through a later rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-propose-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);
    await intake.recordMatch(interaction, matchResult());
    const before = structuredClone(await intake.inspect(interaction));

    await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.propose(interaction, {
        proposedIntent: 'change',
        proposal: 'unacknowledged proposal',
        decisionRefs: ['unacknowledged-decision'],
      }),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'awaiting-intent');
    assert.equal(failed.draft?.proposedIntent, before.draft?.proposedIntent);
    assert.equal(failed.draft?.proposal, before.draft?.proposal);
    assert.deepEqual(failed.draft?.decisionRefs, before.draft?.decisionRefs);

    await intake.reject(interaction, 'legitimate rejection after failed proposal');
    const durable = new ExplicitIntake(journal).exportState();
    const durableInteraction = interactionState(durable, interaction);
    assert.equal(durableInteraction?.draft?.proposedIntent, before.draft?.proposedIntent);
    assert.equal(durableInteraction?.draft?.proposal, before.draft?.proposal);
    assert.deepEqual(durableInteraction?.draft?.decisionRefs, before.draft?.decisionRefs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed reject save is atomic and cannot leak the reason through a later status transition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-reject-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);

    await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.reject(interaction, 'unacknowledged rejection reason'),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'matching');
    assert.equal(failed.reason, undefined);

    await intake.beginStatusCheck(interaction);
    const durable = new ExplicitIntake(journal).exportState();
    assert.equal(interactionState(durable, interaction)?.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed prepareConfirmation save is atomic and cannot leak confirmation through a later rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-prepare-confirmation-'));
  try {
    const journal = new FlakyFileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal);
    const interaction = await receivePreview(intake);
    await intake.beginMatching(interaction);
    await intake.recordMatch(interaction, matchResult());
    await intake.propose(interaction, { proposedIntent: 'change', proposal: 'legacy proposal' });
    const before = await intake.inspect(interaction);
    const beforeDraft = before.draft;
    assert.ok(beforeDraft);

    await assertFailedSaveIsAtomic(
      intake,
      journal,
      () => intake.prepareConfirmation({
        interactionId: interaction,
        draftId: beforeDraft.draftId,
        inputRevision: beforeDraft.inputRevision,
        confirmationRef: 'unacknowledged-confirmation',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-03T00:00:00.000Z',
        payloadRef: 'asset://requirements/unacknowledged-confirmation',
      }),
    );
    const failed = await intake.inspect(interaction);
    assert.equal(failed.state, 'awaiting-confirmation');
    assert.equal(failed.confirmation, undefined);

    await intake.reject(interaction, 'legitimate rejection after failed confirmation');
    const durable = new ExplicitIntake(journal).exportState();
    assert.equal(interactionState(durable, interaction)?.confirmation, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
