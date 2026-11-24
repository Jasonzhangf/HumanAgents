import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id } from '../../packages/contracts/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { FakeReplayExecutionRuntimePort, FileCheckpointStore, UiRuntimeJournal, UiRuntimeService } from '../../packages/app/src/ui-runtime/index.js';
import { startUiRuntimeServer } from '../../packages/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';

test('public explicit session exposes sourced replies and safe actions without raw step content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-public-explicit-actions-'));
  let server: Awaited<ReturnType<typeof startUiRuntimeServer>> | undefined;
  try {
    const binding = { bindingId: 'public-explicit', providerId: 'fake', protocol: 'responses' as const,
      endpointRef: 'fake://public-explicit', modelRef: 'fake', configDigest: 'test', capabilityDigest: 'test' };
    const journal = new UiRuntimeJournal(join(root, 'journal.jsonl'));
    let matchedTaskId: string | undefined;
    const service = new UiRuntimeService({
      mode: 'fake', organId: id('organ', 'public-explicit'), projectKey: 'public-explicit', binding,
      port: new FakeReplayExecutionRuntimePort({ binding }), providerState: 'ready', journal, closurePort: journal,
      checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `${taskId.value}-${cycleId.value}.jsonl`)),
      attentionPort: { async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
        async resolve(input) { return { attentionId: input.attentionId, delivered: true }; } },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'public-explicit' },
      explicitBrainInterpreter: { async interpret(input) {
        if ((input.rawInput === '需要澄清' || input.rawInput === '补充任务') && input.clarifications.length === 0) {
          return { kind: 'clarification', question: '请指定交付位置', normalizedInput: input.rawInput, knownFacts: [], decisionRefs: [] };
        }
        input.onStep?.({ kind: 'request.dispatched', summary: 'SECRET_PROMPT raw intake JSON', requestId: 'PRIVATE_REQUEST' });
        input.onStep?.({ kind: 'response.reasoning', summary: 'SECRET_REASONING' });
        input.onStep?.({ kind: 'tool.started', summary: 'SECRET_TOOL_INPUT', requestId: 'request-1', turnId: 'turn-1',
          tool: { kind: 'select-skills', callId: 'call-1' } });
        input.onStep?.({ kind: 'tool.finished', summary: 'SECRET_TOOL_RESULT', requestId: 'request-1', turnId: 'turn-1',
          tool: { kind: 'select-skills', callId: 'call-1', status: 'succeeded' } });
        input.onStep?.({ kind: 'helper.accepted', summary: 'SECRET_TOOL_ARGUMENTS', helperCallId: 'PRIVATE_HELPER' });
        input.onStep?.({ kind: 'turn.completed', summary: 'SECRET_DEBUG' });
        if (input.rawInput === '补充任务' && matchedTaskId !== undefined) {
          return { kind: 'requirement', intent: 'append', matchedTaskId, proposal: '补充交付位置',
            structuredProposal: { revision: input.inputRevision, intent: 'append', title: '补充任务',
              objective: '补充交付位置', deliverable: '交付位置', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
            normalizedInput: input.rawInput, knownFacts: [], decisionRefs: [] };
        }
        return { kind: 'answer', answer: `正式答复：${input.rawInput}`, normalizedInput: input.rawInput, knownFacts: [], decisionRefs: [] };
      } },
      projectCatalog: async () => ({ projects: [{ projectKey: 'public-explicit', projectRoot: root,
        workspaceCwd: root, checkpointsRoot: join(root, 'checkpoints') }], failures: [] }),
    });
    const first = await service.receiveExplicitInput({ sourceRef: 'test:first', rawInput: '第一个问题', channel: 'business' });
    await service.interpretExplicitInput({ interactionId: first });
    const second = await service.receiveExplicitInput({ sourceRef: 'test:second', rawInput: '第二个问题', channel: 'business' });
    await service.interpretExplicitInput({ interactionId: second });
    const scope = { projectKey: 'public-explicit', mode: 'fake' as const, sessionId: first };
    const result = await service.productSessionRead(scope);
    assert.ok(result.messages.some(message => message.text === '正式答复：第一个问题'), 'persisted formal reply must reach the public session');
    const serialized = JSON.stringify(result.messages);
    assert.equal(/SECRET_|PRIVATE_|第二个问题|rawInput|helperCallId/.test(serialized), false);
    assert.deepEqual(result.messages.flatMap(message => 'explicitToolStep' in message ? [message.explicitToolStep] : []), [
      { kind: 'tool.started', requestId: 'request-1', turnId: 'turn-1', tool: { kind: 'select-skills', callId: 'call-1' } },
      { kind: 'tool.finished', requestId: 'request-1', turnId: 'turn-1', tool: { kind: 'select-skills', callId: 'call-1', status: 'succeeded' } },
    ]);
    const reply = result.messages.find(message => message.text === '正式答复：第一个问题')!;
    assert.equal(reply.actor.kind, 'agent');
    assert.equal(reply.occurredAt, undefined, 'reply time is not persisted and must not borrow input time');
    assert.ok(reply.occurredAtUnavailableReason);
    assert.deepEqual((await service.productSessionRead({ ...scope, sessionId: 'missing' })).messages, []);
    const task = service.createTask({ title: 'unrelated task' });
    assert.deepEqual((await service.productSessionRead({ ...scope, taskId: task.taskId.value })).messages, []);
    const clarification = await service.receiveExplicitInput({ sourceRef: 'test:clarification', rawInput: '需要澄清', channel: 'business' });
    await service.interpretExplicitInput({ interactionId: clarification });
    const pending = await service.productSessionRead({ ...scope, sessionId: clarification });
    assert.ok(pending.messages.some(message => message.text === '请指定交付位置' && message.actor.kind === 'agent'));
    await service.answerExplicitClarification({ interactionId: clarification, answer: '放在指定目录' });
    const clarified = await service.productSessionRead({ ...scope, sessionId: clarification });
    assert.ok(clarified.messages.some(message => message.text === '放在指定目录' && message.actor.kind === 'unknown'));

    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'web-access.json'), create: true });
    server = await startUiRuntimeServer({ service, accessControl, productRoot: root, uiRoot: join(process.cwd(), 'docs/ui'), port: 0 });
    const session = await accessControl.consumePairingCode((await accessControl.issuePairingChallenge()).code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const path = `/api/product/session?projectKey=public-explicit&mode=fake&sessionId=${first}`;
    const response = await fetch(`${server.url}${path}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json() as typeof result;
    assert.deepEqual(payload.messages, result.messages);
    assert.equal('debug' in payload, false);
    const wrongScope = await fetch(`${server.url}${path.replace('projectKey=public-explicit', 'projectKey=other')}`, { headers: { cookie } });
    assert.equal(wrongScope.status, 409);

    matchedTaskId = task.taskId.value;
    const bound = await service.receiveExplicitInput({ sourceRef: 'test:bound', rawInput: '补充任务', channel: 'business' });
    await service.interpretExplicitInput({ interactionId: bound });
    await service.answerExplicitClarification({ interactionId: bound, answer: '此任务的交付目录' });
    await service.interpretExplicitInput({ interactionId: bound });
    const draft = (await service.inspectExplicitInteraction(bound)).draft;
    if (draft === undefined) throw new Error('the task-bound clarification must produce a draft');
    await service.confirmExplicitRequirement({ draftId: draft.draftId, inputRevision: 1,
      confirmationRef: 'confirmation:bound', confirmedBy: 'human:operator', confirmedAt: '2026-11-23T00:00:00.000Z',
      payloadRef: 'asset://requirements/bound' });
    const boundResponse = await fetch(`${server.url}/api/product/session?${new URLSearchParams({
      projectKey: scope.projectKey, mode: scope.mode, sessionId: bound, taskId: task.taskId.value,
    })}`, { headers: { cookie } });
    assert.equal(boundResponse.status, 200, 'confirmed task/session must remain readable');
    const boundRead = await boundResponse.json() as typeof result;
    assert.ok(boundRead.messages.some(message => message.text === '此任务的交付目录'));
    assert.equal(boundRead.messages.filter(message => message.explicitToolStep).length, 2);
    assert.ok(boundRead.messages.every(message => message.ref.scope.taskId?.value === task.taskId.value));
    assert.equal(JSON.stringify(boundRead.messages).includes('第一个问题'), false);
    console.log('public GET: sourced answer/action, exact session isolation, unrelated task exclusion, wrong project 409');
  } finally {
    const origin = server?.url;
    await server?.close();
    if (origin !== undefined) await assert.rejects(() => fetch(`${origin}/api/product/session`));
    await rm(root, { recursive: true, force: true });
    await assert.rejects(() => access(root));
    console.log('cleanup verified: isolated listener closed and fixture directory removed');
  }
});
