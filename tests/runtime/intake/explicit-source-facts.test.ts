import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProductMessageActor } from '../../../packages/contracts/src/index.js';
import {
  ExplicitIntake,
  type ExplicitIntakeJournalPort,
  type ExplicitIntakeState,
} from '../../../packages/runtime/src/intake/explicit-intake.js';
import { ExplicitIntakeError } from '../../../packages/runtime/src/intake/errors.js';

/**
 * Real, file-backed journal port for the explicit intake snapshot. It writes
 * the same `explicit-brain.state` record envelope that the app's
 * UiRuntimeJournal already validates (`state.intake`), so a second ExplicitIntake
 * reads the persisted bytes instead of an in-memory mock.
 */
class FileIntakeJournal implements ExplicitIntakeJournalPort {
  constructor(private readonly filePath: string) {}

  save(state: ExplicitIntakeState): void {
    appendFileSync(
      this.filePath,
      `${JSON.stringify({ kind: 'explicit-brain.state', state: { intake: state } })}\n`,
      'utf8',
    );
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
}

const fixedNow = new Date('2026-10-21T18:00:00.000Z');
const explicitOccurredAt = '2026-10-21T17:58:00.000Z';

const humanActor: ProductMessageActor = {
  kind: 'human',
  sourceKind: 'product-principal',
  sourceRef: 'product-principal:v1:test-owner',
};
const agentActor: ProductMessageActor = {
  kind: 'agent',
  sourceKind: 'explicit-brain-interpreter',
};

function journalPath(root: string): string {
  return join(root, 'explicit-brain.jsonl');
}

test('verified human actor and explicit event time survive the durable journal round-trip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-source-human-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal, () => fixedNow);
    const interactionId = await intake.receive({
      sourceRef: 'ui:task-detail',
      rawInput: 'summarize the current task evidence',
      channel: 'business',
      occurredAt: explicitOccurredAt,
      actor: humanActor,
    });

    const live = await intake.inspect(interactionId);
    assert.equal(live.interactionId, interactionId);
    assert.deepEqual(live.actor, humanActor);
    assert.equal(live.occurredAt, explicitOccurredAt);
    assert.equal(live.sourceRef, 'ui:task-detail');

    const reloaded = new ExplicitIntake(journal, () => fixedNow);
    const durable = await reloaded.inspect(interactionId);
    assert.equal(durable.interactionId, interactionId);
    assert.deepEqual(durable.actor, humanActor);
    assert.equal(durable.occurredAt, explicitOccurredAt);
    assert.equal(durable.sourceRef, 'ui:task-detail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent and human inputs keep distinct actor sources after a cold reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-source-mixed-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal, () => fixedNow);
    const humanInteraction = await intake.receive({
      sourceRef: 'ui:task-detail',
      rawInput: 'human authored input',
      channel: 'business',
      actor: humanActor,
    });
    const agentInteraction = await intake.receive({
      sourceRef: 'runtime:explicit-brain',
      rawInput: 'agent authored input',
      channel: 'business',
      actor: agentActor,
    });

    const reloaded = new ExplicitIntake(journal, () => fixedNow);
    const durableHuman = await reloaded.inspect(humanInteraction);
    const durableAgent = await reloaded.inspect(agentInteraction);
    assert.deepEqual(durableHuman.actor, humanActor);
    assert.deepEqual(durableAgent.actor, agentActor);
    assert.notEqual(durableHuman.actor?.kind, durableAgent.actor?.kind);
    assert.equal(durableAgent.actor?.kind, 'agent');
    assert.equal(durableHuman.actor?.kind, 'human');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('omitted occurrence time is recorded once at the intake owner and survives reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-source-time-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal, () => fixedNow);
    const interactionId = await intake.receive({
      sourceRef: 'ui:new-task-form',
      rawInput: 'create a task from this input',
      channel: 'business',
    });
    assert.equal((await intake.inspect(interactionId)).occurredAt, fixedNow.toISOString());

    const reloaded = new ExplicitIntake(journal, () => new Date('2030-01-01T00:00:00.000Z'));
    assert.equal((await reloaded.inspect(interactionId)).occurredAt, fixedNow.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy interactions without actor or time are not rewritten as human', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-source-legacy-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const legacy: ExplicitIntakeState = {
      nextInteractionSeq: 2,
      nextDraftSeq: 1,
      interactions: [
        {
          interactionId: 'interaction-1',
          inputRevision: 1,
          sourceRef: 'ui:legacy',
          rawInput: 'legacy message without source facts',
          state: 'received',
          owner: 'explicit-intake',
          nextAction: 'start-matching',
          condition: 'matching-requested',
          history: ['received'],
          steps: [],
        },
      ],
    };
    journal.save(legacy);

    const intake = new ExplicitIntake(journal, () => fixedNow);
    const snapshot = await intake.inspect('interaction-1');
    assert.equal(snapshot.actor, undefined);
    assert.equal(snapshot.occurredAt, undefined);
    assert.notEqual(snapshot.actor?.kind, 'human');
    const exported = intake.exportState().interactions[0];
    assert.equal(exported?.actor, undefined);
    assert.equal(exported?.occurredAt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a human actor without a decoded principal source is rejected and not persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humanagent-intake-source-forged-'));
  try {
    const journal = new FileIntakeJournal(journalPath(root));
    const intake = new ExplicitIntake(journal, () => fixedNow);
    await assert.rejects(
      () => intake.receive({
        sourceRef: 'ui:forged',
        rawInput: 'forged human input',
        channel: 'business',
        // A caller may bypass TypeScript; the owner must still reject it.
        actor: { kind: 'human', sourceKind: 'task.input' } as unknown as ProductMessageActor,
      }),
      (error: unknown) => error instanceof ExplicitIntakeError && error.code === 'actor-invalid',
    );
    assert.equal(intake.exportState().interactions.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
