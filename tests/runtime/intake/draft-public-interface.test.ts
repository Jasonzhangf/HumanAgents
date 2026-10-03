import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id } from '../../../packages/contracts/src/index.js';
import {
  ExplicitIntake,
  type DraftIntent,
  type ExplicitIntakeJournalPort,
  type ExplicitIntakeState,
  type MatchResult,
} from '../../../packages/runtime/src/intake/explicit-intake.js';
import { ExplicitIntakeError } from '../../../packages/runtime/src/intake/errors.js';

const currentTask = id('task', 'task-current');

/**
 * File-backed public journal consumer. It writes the same explicit-brain
 * snapshot envelope used by the existing intake public tests.
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
