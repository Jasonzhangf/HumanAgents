import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExplicitIntake,
  type ExplicitInput,
  type ExplicitIntakeJournalPort,
  type ExplicitIntakeState,
} from '../../../packages/runtime/src/intake/explicit-intake.js';

class MemoryIntakeJournal implements ExplicitIntakeJournalPort {
  private current?: ExplicitIntakeState;
  readonly saves: ExplicitIntakeState[] = [];

  save(state: ExplicitIntakeState): void {
    this.current = structuredClone(state);
    this.saves.push(structuredClone(state));
  }

  load(): ExplicitIntakeState | undefined {
    return this.current === undefined ? undefined : structuredClone(this.current);
  }
}

function input(ref = 'ui:entry'): ExplicitInput {
  return { sourceRef: ref, rawInput: `raw:${ref}`, channel: 'business' };
}

async function succeed(intake: ExplicitIntake, ref = 'ui:entry'): Promise<string> {
  const interactionId = await intake.receive(input(ref));
  await intake.beginMatching(interactionId);
  await intake.completeAnswer(interactionId, 'answer');
  return interactionId;
}

async function failAfterReceive(intake: ExplicitIntake, ref = 'ui:entry'): Promise<string> {
  const interactionId = await intake.receive(input(ref));
  await intake.beginMatching(interactionId);
  return interactionId;
}

test('first failure consumes no number and the next success still gets number 1', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  const failed = await failAfterReceive(intake, 'ui:first');
  assert.equal((await intake.inspect(failed)).requestNumber, undefined);

  const next = await succeed(intake, 'ui:next');
  assert.notEqual(next, failed);
  assert.equal((await intake.inspect(next)).requestNumber, 1);
});

test('consecutive failures keep the same pending number', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  const failedA = await failAfterReceive(intake, 'ui:fail-a');
  const failedB = await failAfterReceive(intake, 'ui:fail-b');
  assert.equal((await intake.inspect(failedA)).requestNumber, undefined);
  assert.equal((await intake.inspect(failedB)).requestNumber, undefined);

  const next = await succeed(intake, 'ui:after-failures');
  assert.equal((await intake.inspect(next)).requestNumber, 1);
});

test('success 7 then error 8 keeps 8, success 8 then advances to 9', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  for (let i = 1; i <= 7; i += 1) {
    const id = await succeed(intake, `ui:success-${i}`);
    assert.equal((await intake.inspect(id)).requestNumber, i);
  }
  const failed8 = await failAfterReceive(intake, 'ui:error-8');
  assert.equal((await intake.inspect(failed8)).requestNumber, undefined);

  const retried8 = await succeed(intake, 'ui:retry-8');
  assert.equal((await intake.inspect(retried8)).requestNumber, 8);
  const next9 = await succeed(intake, 'ui:success-9');
  assert.equal((await intake.inspect(next9)).requestNumber, 9);
});

test('concurrent receives do not reserve a number and success order is the commit order', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  for (let i = 1; i <= 7; i += 1) await succeed(intake, `ui:before-${i}`);

  const a = await intake.receive(input('ui:concurrent-a'));
  const b = await intake.receive(input('ui:concurrent-b'));
  await intake.beginMatching(a);
  await intake.beginMatching(b);
  assert.equal((await intake.inspect(a)).requestNumber, undefined);
  assert.equal((await intake.inspect(b)).requestNumber, undefined);

  await intake.completeAnswer(b, 'b answer');
  assert.equal((await intake.inspect(b)).requestNumber, 8);
  await intake.completeAnswer(a, 'a answer');
  assert.equal((await intake.inspect(a)).requestNumber, 9);
});

test('a failed concurrent interaction keeps the next number for the following success', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  for (let i = 1; i <= 7; i += 1) await succeed(intake, `ui:before-${i}`);

  const a = await intake.receive(input('ui:failed-concurrent-a'));
  const b = await intake.receive(input('ui:success-concurrent-b'));
  await intake.beginMatching(a);
  await intake.beginMatching(b);
  await intake.completeAnswer(b, 'b answer');
  assert.equal((await intake.inspect(b)).requestNumber, 8);
  assert.equal((await intake.inspect(a)).requestNumber, undefined);

  const next = await succeed(intake, 'ui:after-failed-concurrent');
  assert.equal((await intake.inspect(next)).requestNumber, 9);
});

test('an exact success retry returns the existing number without advancing', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  const id = await succeed(intake, 'ui:retry-identity');
  const assigned = (await intake.inspect(id)).requestNumber;
  const before = intake.exportState().nextRequestNumber;

  assert.equal(intake.assignRequestNumber(id), assigned);
  assert.equal(intake.exportState().nextRequestNumber, before);
  assert.equal((await intake.inspect(id)).requestNumber, assigned);
});

test('failure and success keep distinct internal identity, history and no Journal regression', async () => {
  const journal = new MemoryIntakeJournal();
  const intake = new ExplicitIntake(journal);
  const failed = await failAfterReceive(intake, 'ui:distinct-fail');
  const succeeded = await succeed(intake, 'ui:distinct-success');

  assert.notEqual(failed, succeeded);
  assert.deepEqual((await intake.inspect(failed)).history, ['received', 'matching']);
  assert.deepEqual((await intake.inspect(succeeded)).history, ['received', 'matching', 'answered']);
  assert.equal((await intake.inspect(failed)).requestNumber, undefined);
  assert.equal((await intake.inspect(succeeded)).requestNumber, 1);

  let previousNext = 1;
  for (const snapshot of journal.saves) {
    const nextNumber = snapshot.nextRequestNumber ?? 1;
    assert.ok(nextNumber >= previousNext);
    previousNext = nextNumber;
  }
});

test('cold reload preserves the next number and assigned numbers without a model call', async () => {
  const journal = new MemoryIntakeJournal();
  const first = new ExplicitIntake(journal);
  const failed = await failAfterReceive(first, 'ui:cold-fail');
  const succeeded = await succeed(first, 'ui:cold-success');
  assert.equal((await first.inspect(succeeded)).requestNumber, 1);

  const reloaded = new ExplicitIntake(journal);
  assert.equal((await reloaded.inspect(failed)).requestNumber, undefined);
  assert.equal((await reloaded.inspect(succeeded)).requestNumber, 1);
  const next = await succeed(reloaded, 'ui:cold-next');
  assert.equal((await reloaded.inspect(next)).requestNumber, 2);
});
