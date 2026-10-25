import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type Attention,
  type CycleId,
  type ProviderBinding,
  type TaskId,
} from '../../packages/contracts/src/index.js';
import {
  MemoryCoordinator,
  type AttentionPort,
  type RuntimeExplicitBrainJournalState,
} from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';

// Failure modes and cost are recorded in the request-numbering design note
// (docs/ui/request-numbering-design-2026-10-25.md). These cases drive the real
// service entry the HTTP dispatcher calls, so a regression in the app wiring
// (number allocated outside the success commit) fails here, not only in the
// intake unit tests.

const organId = id('organ', 'request-numbering-organ');
const binding: ProviderBinding = {
  bindingId: 'binding-request-numbering',
  providerId: 'provider-request-numbering',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-request-numbering',
  configDigest: 'sha256:request-numbering-config',
  capabilityDigest: 'sha256:request-numbering-capability',
};

function attentionPort(): AttentionPort {
  return {
    async publish(input: Attention) {
      return { attentionId: input.attentionId, delivered: true };
    },
    async resolve(input: Attention) {
      return { attentionId: input.attentionId, delivered: true };
    },
  };
}

function serviceFor(root: string, interpreter: ExplicitBrainInputInterpreter, journal: UiRuntimeJournal): UiRuntimeService {
  return new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId: TaskId, cycleId: CycleId) => new FileCheckpointStore(
      join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`),
    ),
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal,
    closurePort: journal,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-request-numbering',
      roleId: 'execution',
    },
    explicitBrainInterpreter: interpreter,
    runtimeComposition: { admitExecution: async () => {} },
  });
}

function latestExplicitState(journal: UiRuntimeJournal) {
  const persisted = journal.replay()
    .filter((record) => record.kind === 'explicit-brain.state')
    .at(-1);
  if (persisted?.kind !== 'explicit-brain.state') {
    throw new Error('missing explicit-brain state');
  }
  return persisted.state;
}

/**
 * Fails the next `explicit-brain.state` append whose state matches the caller's
 * predicate, exactly once. This drives the real service entry with an injected
 * persistence failure so the success-fact/number atomicity is proven at the
 * authoritative state save, not only at the unit level.
 */
class FailingExplicitStateJournal extends UiRuntimeJournal {
  failWhen?: (state: RuntimeExplicitBrainJournalState) => boolean;

  override append(record: Parameters<UiRuntimeJournal['append']>[0]): void {
    if (record.kind === 'explicit-brain.state' && this.failWhen?.(record.state)) {
      this.failWhen = undefined;
      throw new Error('injected explicit state append failure');
    }
    super.append(record);
  }
}

function answeringInterpreter(options: {
  readonly failCalls?: number;
  readonly onInterpret?: (rawInput: string, call: number) => void;
} = {}): ExplicitBrainInputInterpreter {
  let calls = 0;
  let remainingFailures = options.failCalls ?? 0;
  return {
    async interpret(input) {
      calls += 1;
      options.onInterpret?.(input.rawInput, calls);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error(`provider response error for ${input.rawInput}`);
      }
      if (input.rawInput.startsWith('fail:')) {
        throw new Error(`provider response error for ${input.rawInput}`);
      }
      return {
        kind: 'answer',
        normalizedInput: input.rawInput,
        knownFacts: [],
        answer: `answer:${input.rawInput}`,
        decisionRefs: [],
      };
    },
  };
}

function statusInterpreter(answer = 'status:running'): ExplicitBrainInputInterpreter {
  return {
    async interpret(input) {
      return {
        kind: 'status-query',
        normalizedInput: input.rawInput,
        knownFacts: [],
        answer,
        decisionRefs: [],
      };
    },
  };
}

async function answerOnce(service: UiRuntimeService, ref: string, rawInput: string) {
  const interactionId = await service.receiveExplicitInput({ sourceRef: ref, rawInput, channel: 'business' });
  const snapshot = await service.interpretExplicitInput({ interactionId });
  return { interactionId, snapshot };
}

async function confirmLegacyRequirement(service: UiRuntimeService, suffix: string) {
  const interactionId = await service.receiveExplicitInput({
    sourceRef: `ui:${suffix}`,
    rawInput: `requirement:${suffix}`,
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: `requirement:${suffix}`,
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: `create ${suffix}`,
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  const draftId = proposed.draft!.draftId;
  const confirm = () => service.confirmExplicitRequirement({
    draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-25T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
  });
  const receipt = await confirm();
  return { interactionId, receipt, confirm };
}

test('a failed response shows no request number and the retried success is number 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-error-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, answeringInterpreter({ failCalls: 1 }), journal);

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:first-failure',
    rawInput: 'first',
    channel: 'business',
  });
  await assert.rejects(() => service.interpretExplicitInput({ interactionId }));
  const failed = await service.inspectExplicitInteraction(interactionId);
  assert.equal(failed.state, 'matching');
  assert.equal(failed.requestNumber, undefined);

  const retried = await service.interpretExplicitInput({ interactionId });
  assert.equal(retried.state, 'answered');
  assert.equal(retried.requestNumber, 1);

  const saved = latestExplicitState(journal);
  const savedInteraction = saved.intake.interactions.find((candidate) => candidate.interactionId === interactionId);
  assert.equal(savedInteraction?.state, 'answered');
  assert.equal(savedInteraction?.requestNumber, 1);
  assert.equal(saved.intake.nextRequestNumber, 2);
});

test('consecutive failures do not advance and every committed success advances exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-sequence-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, answeringInterpreter(), journal);

  const failedA = await service.receiveExplicitInput({ sourceRef: 'ui:fail-a', rawInput: 'fail:a', channel: 'business' });
  await assert.rejects(() => service.interpretExplicitInput({ interactionId: failedA }));
  const failedB = await service.receiveExplicitInput({ sourceRef: 'ui:fail-b', rawInput: 'fail:b', channel: 'business' });
  await assert.rejects(() => service.interpretExplicitInput({ interactionId: failedB }));
  assert.equal((await service.inspectExplicitInteraction(failedA)).requestNumber, undefined);
  assert.equal((await service.inspectExplicitInteraction(failedB)).requestNumber, undefined);

  const first = await answerOnce(service, 'ui:first', 'first');
  assert.equal(first.snapshot.requestNumber, 1);
  const second = await answerOnce(service, 'ui:second', 'second');
  assert.equal(second.snapshot.requestNumber, 2);
});

test('a replayed legacy confirmation returns the existing number without a second allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-confirm-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, answeringInterpreter(), journal);

  const first = await confirmLegacyRequirement(service, 'first-requirement');
  assert.equal((await service.inspectExplicitInteraction(first.interactionId)).requestNumber, 1);

  const saved = latestExplicitState(journal);
  const savedInteraction = saved.intake.interactions.find((candidate) => candidate.interactionId === first.interactionId);
  assert.equal(savedInteraction?.state, 'confirmed');
  assert.equal(savedInteraction?.requestNumber, 1);
  assert.equal(saved.intake.nextRequestNumber, 2);
  assert.equal(
    saved.submittedSubmissions.some((candidate) => (
      candidate.interactionId === first.interactionId
      && candidate.requirementId === first.receipt.requirement.requirementId
    )),
    true,
  );

  const replay = await first.confirm();
  assert.equal(replay.requirement.status, 'duplicate');
  assert.equal((await service.inspectExplicitInteraction(first.interactionId)).requestNumber, 1);

  const second = await confirmLegacyRequirement(service, 'second-requirement');
  assert.equal((await service.inspectExplicitInteraction(second.interactionId)).requestNumber, 2);
});

test('typed final submission assigns the number once and a duplicate replay does not advance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-typed-'));
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
  const interpreter: ExplicitBrainInputInterpreter = {
    async interpret(input) {
      return {
        kind: 'requirement',
        normalizedInput: input.rawInput,
        knownFacts: [],
        intent: 'create',
        proposal: `create:${input.rawInput}`,
        structuredProposal: {
          revision: input.inputRevision,
          intent: 'create',
          title: input.rawInput,
          objective: input.rawInput,
          deliverable: `create:${input.rawInput}`,
          deliveryConditions: [],
          evidenceRefs: [],
          blockingGaps: [],
        },
        decisionRefs: [],
      };
    },
  };
  const service = serviceFor(root, interpreter, journal);
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:typed-submit',
    rawInput: 'typed requirement',
    channel: 'business',
    requestKind: 'new-task-create',
  });
  const proposed = await service.interpretExplicitInput({ interactionId });
  assert.equal(proposed.state, 'awaiting-confirmation');
  assert.equal(proposed.requestNumber, undefined);
  const revision = proposed.revision;
  assert.ok(revision);
  const confirm = () => service.confirmExplicitRequirement({
    interactionId,
    draftId: revision!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:typed-submit',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-25T00:00:00.000Z',
    payloadRef: 'asset://requirements/typed-submit',
    idempotencyKey: 'typed-submit-key',
    requestKind: 'new-task-create',
    draftRevisionVersion: revision!.revisionVersion,
    draftRevisionHash: revision!.revisionHash,
  });

  const receipt = await confirm();
  assert.equal(receipt.requirement.status, 'submitted');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).requestNumber, 1);

  const saved = latestExplicitState(journal);
  const savedInteraction = saved.intake.interactions.find((candidate) => candidate.interactionId === interactionId);
  assert.equal(savedInteraction?.state, 'confirmed');
  assert.equal(savedInteraction?.requestNumber, 1);
  assert.equal(saved.intake.nextRequestNumber, 2);
  const finalSubmissions = (saved as typeof saved & {
    readonly finalSubmissions?: readonly {
      readonly requirement: { readonly requirementId: string };
    }[];
  }).finalSubmissions ?? [];
  assert.equal(
    finalSubmissions.some((candidate) => (
      candidate.requirement.requirementId === receipt.requirement.requirementId
    )),
    true,
  );

  const replay = await confirm();
  assert.equal(replay.requirement.status, 'duplicate');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).requestNumber, 1);
});

test('cold reload keeps assigned numbers and the pending sequence without issuing a model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-cold-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  let calls = 0;
  const coldJournal = new UiRuntimeJournal(journalPath);
  const first = serviceFor(root, answeringInterpreter({ onInterpret: () => { calls += 1; } }), coldJournal);

  const failed = await first.receiveExplicitInput({ sourceRef: 'ui:cold-fail', rawInput: 'fail:cold', channel: 'business' });
  await assert.rejects(() => first.interpretExplicitInput({ interactionId: failed }));
  const succeeded = await answerOnce(first, 'ui:cold-success', 'cold-success');
  assert.equal(succeeded.snapshot.requestNumber, 1);
  const callsBeforeReload = calls;

  const reloadedJournal = new UiRuntimeJournal(journalPath);
  const reloaded = serviceFor(root, answeringInterpreter({ onInterpret: () => { calls += 1; } }), reloadedJournal);
  await reloaded.hydrate();
  assert.equal(calls, callsBeforeReload, 'cold hydrate must not issue a model request');
  assert.equal((await reloaded.inspectExplicitInteraction(failed)).requestNumber, undefined);
  assert.equal((await reloaded.inspectExplicitInteraction(succeeded.interactionId)).requestNumber, 1);

  const next = await answerOnce(reloaded, 'ui:cold-next', 'cold-next');
  assert.equal(next.snapshot.requestNumber, 2);
});

test('an answer success append failure rolls back the success and number, then the retry is still 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-answer-append-fail-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journal = new FailingExplicitStateJournal(journalPath);
  const service = serviceFor(root, answeringInterpreter(), journal);

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:answer-append-fail',
    rawInput: 'answer-append-fail',
    channel: 'business',
  });
  journal.failWhen = (state) => state.intake.interactions.some((candidate) => (
    candidate.interactionId === interactionId
    && candidate.state === 'answered'
    && candidate.requestNumber !== undefined
  ));
  await assert.rejects(
    () => service.interpretExplicitInput({ interactionId }),
    /injected explicit state append failure/,
  );

  const failed = await service.inspectExplicitInteraction(interactionId);
  assert.equal(failed.state, 'matching');
  assert.equal(failed.requestNumber, undefined);

  const retried = await service.interpretExplicitInput({ interactionId });
  assert.equal(retried.state, 'answered');
  assert.equal(retried.requestNumber, 1);

  const later = await answerOnce(service, 'ui:answer-after-append-fail', 'after-answer-append-fail');
  assert.equal(later.snapshot.requestNumber, 2);
  assert.equal(latestExplicitState(journal).intake.nextRequestNumber, 3);

  const reloaded = serviceFor(root, answeringInterpreter(), new UiRuntimeJournal(journalPath));
  await reloaded.hydrate();
  const coldFailed = await reloaded.inspectExplicitInteraction(interactionId);
  assert.equal(coldFailed.state, 'answered');
  assert.equal(coldFailed.requestNumber, 1);
  assert.equal((await reloaded.inspectExplicitInteraction(later.interactionId)).requestNumber, 2);
});

test('a status-only success append failure rolls back its transition and number in memory and cold read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-status-append-fail-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journal = new FailingExplicitStateJournal(journalPath);
  const service = serviceFor(root, statusInterpreter(), journal);

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:status-append-fail',
    rawInput: 'status-append-fail',
    channel: 'business',
  });
  journal.failWhen = (state) => state.intake.interactions.some((candidate) => (
    candidate.interactionId === interactionId
    && candidate.state === 'status-only'
    && candidate.requestNumber !== undefined
  ));
  await assert.rejects(
    () => service.interpretExplicitInput({ interactionId }),
    /injected explicit state append failure/,
  );

  const failed = await service.inspectExplicitInteraction(interactionId);
  assert.equal(failed.state, 'matching');
  assert.equal(failed.reply, undefined);
  assert.equal(failed.requestNumber, undefined);

  const retried = await service.interpretExplicitInput({ interactionId });
  assert.equal(retried.state, 'status-only');
  assert.equal(retried.requestNumber, 1);

  const reloaded = serviceFor(root, statusInterpreter(), new UiRuntimeJournal(journalPath));
  await reloaded.hydrate();
  const cold = await reloaded.inspectExplicitInteraction(interactionId);
  assert.equal(cold.state, 'status-only');
  assert.equal(cold.requestNumber, 1);
});

test('a failed success append does not roll back an interaction that already committed its number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-concurrent-append-fail-'));
  const journal = new FailingExplicitStateJournal(join(root, 'ui-runtime-journal.jsonl'));
  const service = serviceFor(root, answeringInterpreter(), journal);

  const committed = await answerOnce(service, 'ui:committed-before-failure', 'committed-before-failure');
  assert.equal(committed.snapshot.requestNumber, 1);

  const failing = await service.receiveExplicitInput({
    sourceRef: 'ui:failing-after-commit',
    rawInput: 'failing-after-commit',
    channel: 'business',
  });
  journal.failWhen = (state) => state.intake.interactions.some((candidate) => (
    candidate.interactionId === failing
    && candidate.state === 'answered'
    && candidate.requestNumber !== undefined
  ));
  await assert.rejects(
    () => service.interpretExplicitInput({ interactionId: failing }),
    /injected explicit state append failure/,
  );

  assert.equal((await service.inspectExplicitInteraction(committed.interactionId)).requestNumber, 1);
  assert.equal((await service.inspectExplicitInteraction(failing)).requestNumber, undefined);

  const next = await answerOnce(service, 'ui:after-concurrent-failure', 'after-concurrent-failure');
  assert.equal(next.snapshot.requestNumber, 2);
});

test('a legacy submit receipt append failure retries the same FIFO receipt and allocates number 1 once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'request-numbering-app-legacy-retry-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journal = new FailingExplicitStateJournal(journalPath);
  const service = serviceFor(root, answeringInterpreter(), journal);

  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:legacy-append-fail',
    rawInput: 'legacy:append-fail',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'legacy:append-fail',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create legacy append-fail work',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  const draftId = proposed.draft!.draftId;
  const confirm = () => service.confirmExplicitRequirement({
    draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:legacy-append-fail',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-25T00:00:00.000Z',
    payloadRef: 'asset://requirements/legacy-append-fail',
  });

  journal.failWhen = (state) => state.intake.interactions.some((candidate) => (
    candidate.interactionId === interactionId
    && candidate.state === 'confirmed'
    && candidate.requestNumber !== undefined
  ));
  await assert.rejects(confirm, /injected explicit state append failure/);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).requestNumber, undefined);

  const retried = await confirm();
  assert.equal((await service.inspectExplicitInteraction(interactionId)).requestNumber, 1);
  const persisted = latestExplicitState(journal);
  const savedInteraction = persisted.intake.interactions.find((candidate) => candidate.interactionId === interactionId);
  assert.equal(savedInteraction?.state, 'confirmed');
  assert.equal(savedInteraction?.requestNumber, 1);
  assert.equal(persisted.intake.nextRequestNumber, 2);
  const durableEnvelopes = persisted.inbox.envelopes.filter((envelope) => envelope.draftId === draftId);
  assert.equal(durableEnvelopes.length, 1, 'the retry must reuse the already appended FIFO envelope');
  assert.equal(durableEnvelopes[0]?.requirementId, retried.requirement.requirementId);

  const replay = await confirm();
  assert.equal(replay.requirement.status, 'duplicate');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).requestNumber, 1);
  assert.equal(latestExplicitState(journal).intake.nextRequestNumber, 2);
});
