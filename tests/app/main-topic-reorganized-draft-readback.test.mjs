import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';
import { id } from '../../dist/app/contracts/src/index.js';
import { JsonlOrganJournal, readLatestExplicitBrainStateFromFile } from '../../dist/app/adapters/jsonl/src/index.js';
import { JsonlTaskIdentityJournal } from '../../dist/app/adapters/jsonl/src/task-identities.js';
import { TaskIdentityConsumer } from '../../dist/app/runtime/src/orchestration/task-identity.js';
import { SubscriptionControlPort } from '../../dist/app/runtime/src/subscriptions/index.js';
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js';
import { FakeReplayExecutionRuntimePort, FileCheckpointStore, UiRuntimeJournal, UiRuntimeService } from '../../dist/app/app/src/ui-runtime/index.js';

// Read-only replay of the original retained Journal; no business operation or server.
const fixture = process.env.HUMANAGENT_REORGANIZED_FIXTURE;
const receipt = process.env.HUMANAGENT_REORGANIZED_RECEIPT;
test('reorganized new-task receipt owns its result despite an old matched task candidate',
  { skip: !fixture || !receipt }, async (t) => {
    const expected = JSON.parse(await readFile(receipt, 'utf8'));
    const topicSample = expected.mainTopic;
    assert.ok(topicSample, 'receipt must contain mainTopic');
    const projectKey = topicSample.projectKey;
    const original = topicSample.tasks.find((task) => task.taskId.value === 'ui-task-implicit-draft-5');
    assert.equal(original.state, 'succeeded');
    assert.equal(original.sourceInteractionId, undefined, 'original sample demonstrates the missing association');
    const state = readLatestExplicitBrainStateFromFile(join(fixture, 'control/main/sessions/explicit-brain.jsonl')).state;
    assert.equal(state.dispatchLedger.length, 0);
    const interaction = state.intake.interactions.find((i) => i.interactionId === 'interaction-3');
    assert.equal(interaction.confirmation.taskRef.value, 'ui-task-implicit-draft-3');
    assert.equal(interaction.revision.draftId, 'draft-5');
    const modeRoot = join(fixture, 'control/sessions', projectKey, 'checkpoints/ui-runtime/rcc');
    const testRoot = join(homedir(), '.humanagent/run-notes');
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(join(testRoot, 'reorganized-draft-readback-20261123-'));
    try {
      for (const name of ['ui-runtime-journal.jsonl', 'task-control.jsonl', 'subscriptions.jsonl']) {
        await copyFile(join(modeRoot, name), join(root, name));
      }
      const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
      const interactionJournal = new UiRuntimeJournal(join(root, 'explicit-brain.jsonl'));
      interactionJournal.append({ kind: 'explicit-brain.state', state });
      const organId = id('organ', 'humanagent-ui');
      const identities = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(root, 'task-control.jsonl'))));
      const binding = { bindingId: 'readback', providerId: 'readback', protocol: 'responses', endpointRef: 'fake://readback', modelRef: 'unused', configDigest: 'fixture', capabilityDigest: 'fixture' };
      const port = new FakeReplayExecutionRuntimePort({ binding });
      port.start = async () => { throw new Error('readback must not execute'); };
      let mismatch;
      let identityFailure = false;
      const service = new UiRuntimeService({
        mode: 'rcc', organId, projectKey, workspaceRoot: topicSample.workspaceCwd,
        binding, port, providerState: 'ready', autoResumeOnHydrate: false,
        journal, interactionJournal, closurePort: journal,
        checkpointStoreFor: () => new FileCheckpointStore(join(root, 'task-control.jsonl')),
        taskIdentity: { async read(scope) {
          if (identityFailure) throw new Error('identity-read-failed');
          const record = await identities.read(scope);
          if (!record || scope.taskId.value !== original.taskId.value || !mismatch) return record;
          const copy = structuredClone(record);
          copy.source[mismatch] = typeof copy.source[mismatch] === 'number' ? copy.source[mismatch] + 1 : 'different';
          return copy;
        } },
        subscriptionControl: new SubscriptionControlPort(new JsonlOrganJournal(join(root, 'subscriptions.jsonl')), { organId }, join(root, 'subscriptions.jsonl')),
        attentionPort: { async publish() {}, async resolve() {} },
        memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey, roleId: 'execution' },
        runtimeComposition: { admitExecution: async () => { throw new Error('readback must not admit'); } },
        explicitBrainInterpreter: { async interpret() { throw new Error('readback must not interpret'); } },
      });
      await service.hydrate();
      await t.test('exact new-task identity wins; result appears once and old failure remains', async () => {
        const first = await service.readMainTopic();
        assert.equal(first.tasks.find((task) => task.taskId.value === original.taskId.value).sourceInteractionId, 'interaction-3');
        const results = first.turns.filter((turn) => turn.kind === 'result' && turn.taskId?.value === original.taskId.value);
        assert.equal(results.length, 1);
        assert.equal(results[0].text, original.output);
        const old = first.tasks.find((task) => task.taskId.value === 'ui-task-implicit-draft-3');
        assert.equal(old.sourceInteractionId, 'interaction-2');
        assert.equal(old.state, 'blocked');
        assert.equal(old.error.code, 'transport.failure');
        assert.deepEqual(await service.readMainTopic(), first);
      });
      for (const field of ['requirementId', 'draftId', 'inputRevision', 'draftRevisionVersion', 'draftRevisionHash', 'confirmationRef']) {
        await t.test(`wrong ${field} cannot borrow either result`, async () => {
          mismatch = field;
          const topic = await service.readMainTopic();
          assert.equal(topic.tasks.find((task) => task.taskId.value === original.taskId.value).sourceInteractionId, undefined);
          assert.equal(topic.tasks.find((task) => task.taskId.value === 'ui-task-implicit-draft-3').sourceInteractionId, 'interaction-2');
        });
      }
      mismatch = undefined;
      await t.test('two matching business parents remain ambiguous', async () => {
        const sourceRecord = await identities.read({ organId, taskId: original.taskId });
        const other = service.createTask({ title: original.title, directive: 'unrelated business task' });
        await identities.establish({ scope: { organId, taskId: other.taskId }, source: sourceRecord.source });
        const topic = await service.readMainTopic();
        assert.equal(topic.tasks.find((task) => task.taskId.value === original.taskId.value).sourceInteractionId, undefined);
        assert.equal(topic.tasks.find((task) => task.taskId.value === other.taskId.value).sourceInteractionId, undefined);
      });
      await t.test('identity read failure stays visible', async () => {
        identityFailure = true;
        await assert.rejects(service.readMainTopic(), /identity-read-failed/);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
