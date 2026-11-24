import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectCallUsage } from '../../packages/app/src/ui-runtime/call-usage-read.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import type { UiRuntimeServiceOptions } from '../../packages/app/src/ui-runtime/service.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { id } from '../../packages/contracts/src/index.js';

test('per-call usage keeps missing values unknown and computes weighted rates from known tokens', () => {
  const rows = [
    { callId: 'a', turnId: 'turn-1', inputTokens: 100, outputTokens: 20, cacheReadTokens: 25, cacheWriteTokens: 5, contextLimit: 200, elapsedMs: 2000 },
    { callId: 'b', turnId: 'turn-1', inputTokens: 300, outputTokens: 30, cacheReadTokens: 75, cacheWriteTokens: 0, contextLimit: 500, measuredOutputMs: 1000 },
    { callId: 'c', turnId: 'turn-2', inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, contextLimit: 200, elapsedMs: 500 },
    { callId: 'd', turnId: 'turn-2', outputTokens: 40, elapsedMs: 1000 },
  ];
  const first = projectCallUsage(rows);
  const replay = projectCallUsage(rows);
  assert.deepEqual(replay, first, 'replaying the same read produces the same call projection');
  assert.equal(first.calls[1]?.previousCallCacheHitRate, 0.25);
  assert.equal(first.calls[1]?.currentCallCacheHitRate, 0.25);
  assert.equal(first.calls[2]?.previousBusinessTurnCacheHitRate, 0.25);
  assert.equal(first.calls[2]?.taskCacheHitRate, 0.3);
  assert.equal(first.calls[1]?.context.used, 300);
  assert.equal(first.calls[1]?.context.limit, 500);
  assert.equal(first.calls[1]?.context.percent, 60);
  assert.equal(first.calls[1]?.outputSpeed.tokensPerSecond, 30);
  assert.equal(first.calls[1]?.outputSpeed.basis, 'generation-elapsed');
  assert.equal(first.calls[3]?.inputTokens, null);
  assert.equal(first.calls[3]?.previousCallCacheHitRate, 0.5);
  assert.equal(first.calls[3]?.outputSpeed.tokensPerSecond, 40);
  assert.deepEqual(first.coverage, { calls: 4, callsWithKnownInput: 3, callsWithKnownCacheRead: 3 });
});

test('call usage rejects duplicate identities instead of double-counting replays', () => {
  assert.throws(() => projectCallUsage([
    { callId: 'same', turnId: 'turn-a', inputTokens: 10, cacheReadTokens: 2 },
    { callId: 'same', turnId: 'turn-a', inputTokens: 10, cacheReadTokens: 2 },
  ]), /duplicate call usage identity/);
});

test('cache and context rates stay undefined for zero or missing denominators', () => {
  const result = projectCallUsage([
    { callId: 'zero', turnId: 'turn-a', inputTokens: 0, cacheReadTokens: 0, contextLimit: 0, elapsedMs: 0 },
    { callId: 'missing', turnId: 'turn-b' },
  ]);
  assert.equal(result.calls[0]?.taskCacheHitRate, null);
  assert.equal(result.calls[0]?.context.percent, null);
  assert.equal(result.calls[1]?.inputTokens, null);
  assert.equal(result.calls[1]?.taskCacheHitRate, null);
});

test('ordinary session reads isolate task and interaction usage and retain messages on statistics failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-call-usage-read-'));
  try {
  const reads: Array<Parameters<NonNullable<UiRuntimeServiceOptions['callUsage']>['read']>[0]> = [];
  let offline = false;
  const binding = {
    bindingId: 'usage-binding', providerId: 'usage-provider', protocol: 'responses' as const,
    endpointRef: 'fake://usage', modelRef: 'fake-model', configDigest: 'usage-config', capabilityDigest: 'usage-capability',
  };
  const service = new UiRuntimeService({
    mode: 'fake', organId: id('organ', 'usage-session'), binding,
    port: new FakeReplayExecutionRuntimePort({ binding }),
    journal: new UiRuntimeJournal(`/tmp/humanagent-call-usage-${process.pid}.jsonl`),
    closurePort: new UiRuntimeJournal(`/tmp/humanagent-call-usage-closure-${process.pid}.jsonl`),
    providerState: 'ready',
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(`/tmp/humanagent-call-usage-${taskId.value}-${cycleId.value}.jsonl`),
    attentionPort: { async publish(input) { return { attentionId: input.attentionId, delivered: true }; }, async resolve(input) { return { attentionId: input.attentionId, delivered: true }; } },
    memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'usage-project', roleId: 'execution' },
    explicitBrainInterpreter: { async interpret() { throw new Error('unused'); } },
    callUsage: { read: async (input) => {
      reads.push(input);
      if (offline) throw new Error('usage source unavailable');
      if (input.interactionId !== undefined) {
        return { ok: true, value: [
          { callId: 'explicit-call-1', turnId: 'explicit-turn-1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, contextLimit: 20, elapsedMs: 1000 },
          { callId: 'explicit-call-2', turnId: 'explicit-turn-1', inputTokens: 20, outputTokens: 2, cacheReadTokens: 10, contextLimit: 20, elapsedMs: 1000 },
        ] };
      }
      return { ok: true, value: [
        { callId: 'task-call-1', turnId: 'task-turn-1', inputTokens: 20, outputTokens: 4, cacheReadTokens: 5, contextLimit: 40, elapsedMs: 2000 },
        { callId: 'task-call-2', turnId: 'task-turn-2', inputTokens: 30, outputTokens: 6, cacheReadTokens: 15, contextLimit: 40, measuredOutputMs: 1000 },
      ] };
    } },
    projectCatalog: async () => ({ projects: [{ projectKey: 'usage-project', projectRoot: root, workspaceCwd: root, checkpointsRoot: join(root, 'checkpoints') }], failures: [] }),
  });
  const interactionId = await service.receiveExplicitInput({ sourceRef: 'usage-session-entry', rawInput: 'inspect usage', channel: 'business' });
  const scope = { projectKey: 'usage-project', mode: 'fake' as const, sessionId: interactionId };
  const noTask = await service.productSessionRead(scope);
  assert.deepEqual(reads[0], { projectKey: 'usage-project', mode: 'fake', interactionId });
  assert.deepEqual(noTask.usage?.calls.map((call) => call.callId), ['explicit-call-1', 'explicit-call-2']);
  assert.ok(noTask.messages.length);

  const task = service.createTask({ title: 'usage task' });
  const withTask = await service.productSessionRead({ projectKey: 'usage-project', mode: 'fake', taskId: task.taskId.value }, { debugRequest: true });
  assert.deepEqual(reads[1], { projectKey: 'usage-project', mode: 'fake', taskId: task.taskId.value });
  assert.equal('request' in (withTask.debug ?? {}), false, 'a Task usage read does not borrow an explicit interaction request');
  assert.deepEqual(withTask.usage?.calls.map((call) => call.callId), ['task-call-1', 'task-call-2']);
  assert.equal(withTask.usage?.calls[1]?.previousBusinessTurnCacheHitRate, 0.25);
  assert.equal('usage' in (withTask.debug ?? {}), false);
  offline = true;
  const degraded = await service.productSessionRead(scope);
  assert.deepEqual(degraded.messages, noTask.messages);
  assert.equal(degraded.usage, null);
  assert.equal(degraded.usageFailure?.code, 'call-usage.read-failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
