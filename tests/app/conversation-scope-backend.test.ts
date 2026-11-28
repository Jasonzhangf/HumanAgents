import assert from 'node:assert/strict'
import test from 'node:test'
import { ScopedConversationBackend } from '../../packages/app/src/conversation-scope-backend.js'
import type { MainTopicProjection } from '../../packages/ui/projection/main-topic.js'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js'
import { FakeReplayExecutionRuntimePort, FileCheckpointStore, UiRuntimeJournal, UiRuntimeService } from '../../packages/app/src/ui-runtime/index.js'
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js'
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js'
import { id, type OperationId, type ProviderBinding } from '../../packages/contracts/src/index.js'
import type { RuntimeSseEvent } from '../../packages/ui/contracts/runtime.js'
import { scopedSessionFromUiRuntime } from '../../packages/app/src/conversation-scope-backend.js'
import { CONFIRMED_LEGACY_ALEX_BINDING } from '../../packages/config/src/conversation-scope.js'

function session(name: string) {
  const interactions: string[] = []
  return {
    readMainTopic: async () => ({ surface: 'main-topic', projectKey: name, projectName: name, workspaceCwd: `/tmp/${name}`, mode: 'fake', interactions: interactions.map((id) => ({ interactionId: id })), tasks: [], usage: { calls: [] } } as unknown as MainTopicProjection),
    receiveInput: async (input: { readonly rawInput: string }) => {
      const id = `${name}:${interactions.length + 1}:${input.rawInput}`
      interactions.push(id)
      return id
    },
    inspectInteraction: async (interactionId: string) => ({ name, interactionId }),
    interpretInteraction: async (interactionId: string) => ({ name, interactionId, interpreted: true }),
    continueInteraction: async (interactionId: string, partialRef: string) => ({ name, interactionId, partialRef, continued: true }),
    answerClarification: async (interactionId: string, answer: string) => ({ name, interactionId, answer, clarified: true }),
    subscribeExplicitSteps: async () => ({
      replay: [{ seq: 1, kind: 'response.status', occurredAt: new Date(0).toISOString(), summary: 'test' } as never],
      unsubscribe() {},
    }),
  }
}

function executionSession(name: string) {
  const taskId = id('task', 'shared-task')
  return {
    ...session(name),
    listTasks: () => ({
      surface: 'runtime-task-list', mode: 'rcc',
      running: [{ taskId, title: `${name}-task`, state: 'running' }],
      waiting: [], completed: [], stopped: [], draft: [], failed: [],
      counts: { running: 1, waiting: 0, completed: 0, stopped: 0, draft: 0, failed: 0, total: 1 },
    } as never),
    operationTask: () => taskId,
    subscribeExecution: (_operationId: OperationId, _lastEventId: string | undefined, listener: (event: RuntimeSseEvent) => void) => {
      const event: RuntimeSseEvent = {
        eventId: `${name}-event`, seq: 1, occurredAt: '2026-11-25T12:00:00.000Z',
        taskId, operationId: 'shared-operation', executionEpoch: 1,
        kind: 'execution.terminal', terminalPhase: 'final', state: 'completed', summary: `${name}-tool`, evidenceRefs: [],
      }
      queueMicrotask(() => listener(event))
      return { replay: [event], unsubscribe() {} }
    },
    toolOutput: async () => ({ workspaceRef: `workspace:${name}`, content: `${name}-result` }),
  }
}

function memoryDispatcher(backend: ScopedConversationBackend, service: unknown = {}) {
  return createUiRuntimeRequestDispatcher({
    service: service as never,
    scopedConversationBackend: backend,
    accessControl: {
      readProductPrincipalOwner: () => 'test-principal',
      verifySession: async () => ({ state: 'valid', session: { sessionId: 'test-session', sessionGeneration: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 } }),
      readPersistedGeneration: async () => 1,
      isExpired: () => false,
      nextExpiryDelayMs: () => undefined,
    } as never,
    productRoot: '/tmp/humanagent-scope-test',
    uiRoot: '/tmp/humanagent-scope-test-ui',
    isClosing: () => false,
  })
}

async function memoryCall(
  dispatcher: ReturnType<typeof memoryDispatcher>,
  path: string,
  method = 'GET',
  body?: string,
  stream = false,
) {
  let resolveHeaders!: () => void
  let resolveEnded!: () => void
  const headersReady = new Promise<void>((resolve) => { resolveHeaders = resolve })
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve })
  const writes: string[] = []
  let status = 0
  let headers: Record<string, string | number | readonly string[]> = {}
  const response = {
    setHeader(name: string, value: string | number | readonly string[]) { headers[name.toLowerCase()] = value },
    writeHead(code: number, value: Record<string, string | number | readonly string[]>) {
      status = code
      headers = value
      resolveHeaders()
      return response
    },
    write(chunk: string | Uint8Array) { writes.push(String(chunk)); return true },
    end(chunk?: string | Uint8Array | (() => void), callback?: () => void) {
      if (typeof chunk === 'function') {
        callback = chunk
        chunk = undefined
      }
      if (chunk !== undefined) writes.push(String(chunk))
      callback?.()
      resolveEnded()
      return response
    },
    once() { return response },
    destroy() { resolveEnded() },
  } as unknown as ServerResponse
  const request = {
    method,
    url: path,
    headers: { accept: stream ? 'text/event-stream' : 'application/json', cookie: 'humanagent_session=test' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  } as unknown as IncomingMessage
  dispatcher.listener(request, response)
  if (stream) {
    await Promise.race([headersReady, ended])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  } else {
    await ended
  }
  const text = writes.join('')
  const contentType = String(headers['content-type'] ?? '')
  return {
    status,
    headers,
    text,
    body: contentType.startsWith('application/json') && text.trim() !== '' ? JSON.parse(text) as Record<string, unknown> : {},
  }
}

test('scoped backend routes Alex and project sessions independently and preserves the old Task reference', async () => {
  const backend = new ScopedConversationBackend({
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
      { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
    ],
    sessions: new Map([['alex', session('alex')], ['project:project-a', session('project-a')]]),
    legacyBinding: CONFIRMED_LEGACY_ALEX_BINDING,
  })
  const alex = await backend.receiveInput({ kind: 'alex' }, { sourceRef: 'test', rawInput: 'hello', channel: 'business' })
  const project = await backend.receiveInput({ kind: 'project', projectKey: 'project-a' }, { sourceRef: 'test', rawInput: 'project', channel: 'business' })
  assert.equal(alex.scope.kind, 'alex')
  assert.equal(alex.canonicalAddress, 'machine.CEO')
  assert.equal(alex.legacySessionRef, '50661')
  assert.deepEqual(alex.preservedInteractionRefs, ['interaction-1', 'interaction-2'])
  assert.deepEqual(alex.preservedTaskRefs, ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'])
  assert.equal(project.scope.kind, 'project')
  assert.equal(project.canonicalAddress, 'machine.project-a.Jenny')
  assert.equal(project.legacySessionRef, undefined)
  assert.deepEqual((await backend.inspectInteraction({ kind: 'alex' }, alex.value.interactionId)).value, { name: 'alex', interactionId: alex.value.interactionId })
  const preserved = await backend.inspectInteraction({ kind: 'alex' }, 'interaction-1')
  assert.deepEqual(preserved.value, { name: 'alex', interactionId: 'interaction-1' })
  assert.deepEqual(preserved.preservedTaskRefs, ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'])
  assert.deepEqual((await backend.interpretInteraction({ kind: 'project', projectKey: 'project-a' }, project.value.interactionId)).scope, { kind: 'project', projectKey: 'project-a' })
})

test('scoped backend factory creates one session per logical scope and rejects cross-scope interaction reads', async () => {
  const created: string[] = []
  const backend = new ScopedConversationBackend({
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
      { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
    ],
    createSession: (descriptor) => { created.push(descriptor.scopeKey); return session(descriptor.scopeKey) },
  })
  const alex = await backend.receiveInput({ kind: 'alex' }, { sourceRef: 'factory', rawInput: 'alex', channel: 'business' })
  await backend.receiveInput({ kind: 'project', projectKey: 'project-a' }, { sourceRef: 'factory', rawInput: 'project', channel: 'business' })
  assert.deepEqual(created.sort(), ['alex', 'project:project-a'])
  await assert.rejects(() => backend.inspectInteraction({ kind: 'project', projectKey: 'project-a' }, alex.value.interactionId), /not recorded/)
})

test('concurrent first requests create exactly one session for one scope', async () => {
  let created = 0
  const backend = new ScopedConversationBackend({
    descriptors: [{ scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }],
    createSession: async (descriptor) => {
      created += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return session(descriptor.scopeKey)
    },
  })
  await Promise.all([
    backend.receiveInput({ kind: 'alex' }, { sourceRef: 'concurrent-a', rawInput: 'a', channel: 'business' }),
    backend.receiveInput({ kind: 'alex' }, { sourceRef: 'concurrent-b', rawInput: 'b', channel: 'business' }),
  ])
  assert.equal(created, 1)
})

test('read does not create a session or persist scope state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scope-readonly-'))
  try {
    let created = 0
    const backend = new ScopedConversationBackend({
      descriptors: [{ scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }],
      createSession: () => { created += 1; return session('alex') },
      stateRoot: join(root, 'state'),
    })
    const topic = await backend.readMainTopic({ kind: 'alex' })
    assert.equal(topic.value.agentName, 'Alex')
    assert.equal(topic.value.projectKey, undefined)
    assert.deepEqual(topic.value.turns, [])
    assert.equal(created, 0)
    assert.deepEqual((await backend.readState({ kind: 'alex' })).interactionIds, [])
    await assert.rejects(() => readdir(join(root, 'state')), (error: unknown) => (error as { code?: string }).code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('idempotent first input is received once and a conflicting reuse is rejected', async () => {
  let receives = 0
  const idempotentSession = {
    ...session('alex'),
    receiveInput: async () => { receives += 1; return 'interaction-idempotent' },
    inspectInteraction: async () => ({ interactionId: 'interaction-idempotent', occurredAt: '2026-11-25T08:00:00.000Z' }),
  }
  const backend = new ScopedConversationBackend({
    descriptors: [{ scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }],
    sessions: new Map([['alex', idempotentSession]]),
  })
  const input = { sourceRef: 'test', rawInput: 'hello', channel: 'business' as const, idempotencyKey: 'first-alex-send' }
  const first = await backend.receiveInput({ kind: 'alex' }, input)
  const replay = await backend.receiveInput({ kind: 'alex' }, input)
  assert.equal(first.value.interactionId, 'interaction-idempotent')
  assert.equal(replay.value.interactionId, 'interaction-idempotent')
  assert.equal((first.value as { readonly occurredAt?: string }).occurredAt, '2026-11-25T08:00:00.000Z')
  assert.equal(receives, 1)
  await assert.rejects(() => backend.receiveInput({ kind: 'alex' }, { ...input, rawInput: 'changed' }), /idempotency key/)
})

test('scoped backend rejects an unregistered scope before invoking a session', async () => {
  const backend = new ScopedConversationBackend({ descriptors: [], sessions: new Map() })
  await assert.rejects(() => backend.readMainTopic({ kind: 'alex' }), /not registered/)
})

test('file-backed scoped state is cold-readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scope-'))
  try {
    const options = {
      descriptors: [{ scope: { kind: 'alex' } as const, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' as const }],
      sessions: new Map([['alex', session('alex')]]),
      stateRoot: root,
    }
    const first = new ScopedConversationBackend(options)
    const created = await first.receiveInput({ kind: 'alex' }, { sourceRef: 'test', rawInput: 'persist', channel: 'business' })
    const cold = new ScopedConversationBackend({ ...options, sessions: new Map([['alex', session('cold-alex')]]) })
    const read = await cold.readMainTopic({ kind: 'alex' })
    assert.deepEqual(read.scope, { kind: 'alex' })
    assert.equal(typeof created.value.interactionId, 'string')
    assert.equal(read.agentId, 'alex-agent')
    assert.deepEqual((await cold.readState({ kind: 'alex' })).interactionIds, [created.value.interactionId])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('backend refuses a legacy binding other than the confirmed 50661 Alex carrier', () => {
  assert.throws(() => new ScopedConversationBackend({
    descriptors: [],
    sessions: new Map(),
    legacyBinding: { legacySessionRef: 'other', scope: { kind: 'alex' }, preservedInteractionRefs: [], preservedTaskRefs: [], sourceEvidenceRef: 'evidence' },
  }), /50661/)
})

test('backend requires preserved Task refs and evidence for the 50661 binding', () => {
  assert.throws(() => new ScopedConversationBackend({ descriptors: [], sessions: new Map(), legacyBinding: { legacySessionRef: '50661', scope: { kind: 'alex' }, preservedInteractionRefs: ['interaction-1'], preservedTaskRefs: [], sourceEvidenceRef: 'evidence' } }), /Task reference/)
  assert.throws(() => new ScopedConversationBackend({ descriptors: [], sessions: new Map(), legacyBinding: { legacySessionRef: '50661', scope: { kind: 'alex' }, preservedInteractionRefs: ['interaction-1'], preservedTaskRefs: ['task'], sourceEvidenceRef: ' ' } }), /evidence/)
  assert.throws(() => new ScopedConversationBackend({ descriptors: [], sessions: new Map(), legacyBinding: { legacySessionRef: '50661', scope: { kind: 'alex' }, preservedInteractionRefs: [], preservedTaskRefs: ['task'], sourceEvidenceRef: 'evidence' } }), /interaction reference/)
})

test('scoped backend keeps two real explicit engines isolated after a cold read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-real-scoped-engines-'))
  const bindingFor = (name: string): ProviderBinding => ({
    bindingId: `scope-${name}`, providerId: 'fake', protocol: 'responses', endpointRef: `fake://${name}`,
    modelRef: 'fake', configDigest: 'test', capabilityDigest: 'test',
  })
  const serviceFor = (name: string) => {
    const binding = bindingFor(name)
    const journal = new UiRuntimeJournal(join(root, name, 'journal.jsonl'))
    return new UiRuntimeService({
      mode: 'fake', organId: id('organ', `scoped-${name}`),
      ...(name === 'alex' ? {} : { projectKey: name }),
      binding, port: new FakeReplayExecutionRuntimePort({ binding }), providerState: 'ready',
      journal, closurePort: journal,
      checkpointStoreFor: (_taskId, _cycleId) => new FileCheckpointStore(join(root, name, 'checkpoint.jsonl')),
      attentionPort: {
        async publish(input) { return { attentionId: input.attentionId, delivered: true } },
        async resolve(input) { return { attentionId: input.attentionId, delivered: true } },
      },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: name },
      explicitBrainInterpreter: {
        async interpret(input) {
          return { kind: 'answer', answer: `${name}:${input.rawInput}`, normalizedInput: input.rawInput, knownFacts: [], decisionRefs: [] }
        },
      },
    })
  }
  try {
    const alexService = serviceFor('alex')
    const projectService = serviceFor('project-a')
    const backend = new ScopedConversationBackend({
      descriptors: [
        { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
        { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
      ],
      sessions: new Map([['alex', scopedSessionFromUiRuntime(alexService)], ['project:project-a', scopedSessionFromUiRuntime(projectService)]]),
      stateRoot: join(root, 'scope-state'),
      legacyBinding: CONFIRMED_LEGACY_ALEX_BINDING,
    })
    const alexInput = await backend.receiveInput({ kind: 'alex' }, { sourceRef: 'real-alex', rawInput: 'alex marker', channel: 'business' })
    await backend.interpretInteraction({ kind: 'alex' }, alexInput.value.interactionId)
    const projectInput = await backend.receiveInput({ kind: 'project', projectKey: 'project-a' }, { sourceRef: 'real-project', rawInput: 'project marker', channel: 'business' })
    await backend.interpretInteraction({ kind: 'project', projectKey: 'project-a' }, projectInput.value.interactionId)

    const alexTopic = await backend.readMainTopic({ kind: 'alex' })
    const projectTopic = await backend.readMainTopic({ kind: 'project', projectKey: 'project-a' })
    assert.equal(alexTopic.value.agentName, 'Alex')
    assert.equal(projectTopic.value.agentName, 'Jenny')
    assert.equal('projectKey' in alexTopic.value, false)
    assert.equal('projectName' in alexTopic.value, false)
    assert.equal('workspaceCwd' in alexTopic.value, false)
    assert.ok(alexTopic.value.turns.some((turn) => turn.text === 'alex marker'))
    assert.equal(alexTopic.value.turns.some((turn) => turn.text === 'project marker'), false)
    assert.ok(projectTopic.value.turns.some((turn) => turn.text === 'project marker'))
    assert.equal(projectTopic.value.turns.some((turn) => turn.text === 'alex marker'), false)

    const cold = new ScopedConversationBackend({
      descriptors: [
        { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
        { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
      ],
      sessions: new Map([['alex', scopedSessionFromUiRuntime(serviceFor('alex'))], ['project:project-a', scopedSessionFromUiRuntime(serviceFor('project-a'))]]),
      stateRoot: join(root, 'scope-state'),
      legacyBinding: CONFIRMED_LEGACY_ALEX_BINDING,
    })
    assert.deepEqual((await cold.readState({ kind: 'alex' })).interactionIds, [alexInput.value.interactionId])
    assert.deepEqual((await cold.readState({ kind: 'project', projectKey: 'project-a' })).interactionIds, [projectInput.value.interactionId])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTP scoped routes keep legacy top-level response shape and reject unsupported scope actions', async () => {
  const confirmationSessions: string[] = []
  const alexSession = {
    ...session('alex'),
    confirmRequirement: async (interactionId: string, confirmation: unknown) => {
      confirmationSessions.push('alex')
      return { name: 'alex', interactionId, confirmation }
    },
  }
  const projectSession = {
    ...session('project-a'),
    confirmRequirement: async (interactionId: string, confirmation: unknown) => {
      confirmationSessions.push('project-a')
      return { name: 'project-a', interactionId, confirmation }
    },
  }
  const backend = new ScopedConversationBackend({
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
      { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
    ],
    sessions: new Map([['alex', alexSession], ['project:project-a', projectSession]]),
    legacyBinding: CONFIRMED_LEGACY_ALEX_BINDING,
  })
  const dispatcher = memoryDispatcher(backend)
  const call = (path: string, method = 'GET', body?: string) => memoryCall(dispatcher, path, method, body)
  try {
    const defaultTopic = await call('/api/main-topic')
    assert.equal(defaultTopic.status, 200)
    assert.equal((defaultTopic.body.scope as { kind: string }).kind, 'alex')
    const topic = await call('/api/main-topic?scope=system')
    assert.equal(topic.status, 200)
    assert.equal((topic.body.scope as { kind: string }).kind, 'alex')
    assert.equal('value' in topic.body, false)
    assert.equal('projectKey' in topic.body, false)
    assert.equal('workspaceCwd' in topic.body, false)
    assert.deepEqual(topic.body.preservedInteractionRefs, ['interaction-1', 'interaction-2'])
    assert.deepEqual(topic.body.preservedTaskRefs, ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'])
    const conflict = await call('/api/explicit/inputs?scope=alex', 'POST', JSON.stringify({ sourceRef: 'http-test', rawInput: 'hello', channel: 'business', workspace: '/tmp/project' }))
    assert.equal(conflict.status, 400)
    assert.equal((conflict.body.error as { code: string }).code, 'conversation.scope.conflict')
    const input = await call('/api/explicit/inputs?scope=alex', 'POST', JSON.stringify({ sourceRef: 'http-test', rawInput: 'hello', channel: 'business', idempotencyKey: 'http-first' }))
    assert.equal(input.status, 201)
    assert.equal(typeof input.body.interactionId, 'string')
    const projectInput = await call('/api/explicit/inputs?scope=project&projectKey=project-a', 'POST', JSON.stringify({ sourceRef: 'http-project', rawInput: 'project', channel: 'business' }))
    assert.equal(projectInput.status, 201)
    const crossScopeEvents = await call(`/api/explicit/interactions/${encodeURIComponent(projectInput.body.interactionId as string)}/events?scope=alex`)
    assert.equal(crossScopeEvents.status, 404)
    assert.equal((crossScopeEvents.body.error as { code: string }).code, 'scope.interaction-not-found')
    const events = await memoryCall(dispatcher, `/api/explicit/interactions/${encodeURIComponent(input.body.interactionId as string)}/events?scope=alex`, 'GET', undefined, true)
    assert.equal(events.status, 200)
    assert.match(String(events.headers['content-type'] ?? ''), /^text\/event-stream/)
    const clarification = await call(`/api/explicit/interactions/${encodeURIComponent(input.body.interactionId as string)}/clarification?scope=alex`, 'POST', JSON.stringify({ answer: 'clarified' }))
    assert.equal(clarification.status, 200)
    const confirmationPayload = JSON.stringify({
      draftId: 'draft-1',
      inputRevision: 1,
      confirmationRef: 'confirmation-1',
      confirmedBy: 'client-forged',
      confirmedAt: '2026-11-25T12:00:00.000Z',
      payloadRef: 'payload-1',
      requestKind: 'new-task-create',
    })
    const crossScopeConfirmation = await call(`/api/explicit/interactions/${encodeURIComponent(input.body.interactionId as string)}/confirmation?scope=project&projectKey=project-a`, 'POST', confirmationPayload)
    assert.equal(crossScopeConfirmation.status, 404)
    assert.equal((crossScopeConfirmation.body.error as { code: string }).code, 'scope.interaction-not-found')
    const confirmation = await call(`/api/explicit/interactions/${encodeURIComponent(input.body.interactionId as string)}/confirmation?scope=alex`, 'POST', confirmationPayload)
    assert.equal(confirmation.status, 200)
    assert.deepEqual(confirmation.body.scope, { kind: 'alex' })
    assert.equal(confirmation.body.name, 'alex')
    assert.equal((confirmation.body.confirmation as { confirmedBy: string }).confirmedBy, 'test-principal')
    assert.deepEqual(confirmationSessions, ['alex'])
    const unsupported = await call('/api/explicit/decision?scope=alex', 'POST', '{}')
    assert.equal(unsupported.status, 501)
    assert.equal((unsupported.body.error as { code: string }).code, 'conversation.scope.unsupported')
  } finally { await dispatcher.sseRegistry.closeAll('server.shutdown') }
})

test('Alex execution reads select the Alex session even when the project exposes the same task and operation identities', async () => {
  const backend = new ScopedConversationBackend({
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
      { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
    ],
    sessions: new Map([['alex', executionSession('alex')], ['project:project-a', executionSession('project-a')]]),
  })
  const taskId = id('task', 'shared-task')
  const operationId = id('operation', 'shared-operation')
  const alexTasks = await backend.listTasks({ kind: 'alex' }) as { readonly running: readonly { readonly title: string }[] }
  const projectTasks = await backend.listTasks({ kind: 'project', projectKey: 'project-a' }) as { readonly running: readonly { readonly title: string }[] }
  assert.equal(alexTasks.running[0]?.title, 'alex-task')
  assert.equal(projectTasks.running[0]?.title, 'project-a-task')

  const alexEvents = await backend.subscribeExecution({ kind: 'alex' }, operationId, undefined, () => undefined)
  const projectEvents = await backend.subscribeExecution({ kind: 'project', projectKey: 'project-a' }, operationId, undefined, () => undefined)
  assert.equal((alexEvents.replay[0] as { readonly summary: string }).summary, 'alex-tool')
  assert.equal((projectEvents.replay[0] as { readonly summary: string }).summary, 'project-a-tool')

  const alexOutput = await backend.toolOutput({ kind: 'alex' }, taskId, operationId, 1, 1)
  const projectOutput = await backend.toolOutput({ kind: 'project', projectKey: 'project-a' }, taskId, operationId, 1, 1)
  assert.equal((alexOutput as { readonly workspaceRef: string }).workspaceRef, 'workspace:alex')
  assert.equal((projectOutput as { readonly workspaceRef: string }).workspaceRef, 'workspace:project-a')
})

test('HTTP Alex execution events and tool output select the Alex session before normal auth', async () => {
  const backend = new ScopedConversationBackend({
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
      { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
    ],
    sessions: new Map([['alex', executionSession('alex')], ['project:project-a', executionSession('project-a')]]),
  })
  const dispatcher = memoryDispatcher(backend, {
    operationTask: () => { throw new Error('default project service must not receive Alex execution reads') },
  })
  const call = async (url: string) => {
    return memoryCall(dispatcher, url, 'GET', undefined, url.includes('/events'))
  }
  try {
    const toolOutput = await call('/api/tasks/shared-task/operations/shared-operation/executions/1/events/1/tool-output?scope=alex')
    assert.equal(toolOutput.status, 200)
    assert.match(toolOutput.text, /alex-result/)
    const events = await call('/api/executions/shared-operation/events?scope=alex')
    assert.equal(events.status, 200)
    assert.match(events.text, /alex-tool/)
    assert.ok(!/project-a-tool/.test(events.text))
    const crossScope = await call('/api/executions/shared-operation/events?scope=project&projectKey=project-a')
    assert.equal(crossScope.status, 200)
    assert.match(crossScope.text, /project-a-tool/)
    assert.ok(!/alex-tool/.test(crossScope.text))
  } finally {
    await dispatcher.sseRegistry.closeAll('server.shutdown')
  }
})

test('HTTP opted-in scope recovery delegates exact task and operation to the existing authority', async () => {
  const taskId = id('task', 'ui-task-implicit-draft-4')
  const operationId = id('operation', 'retained-alex-operation')
  const receipt = { state: 'released', taskId: taskId.value, operationId: operationId.value, businessTurnId: 'retained-turn' }
  const recovered = { state: 'blocked', taskId, allowedActions: ['recover'], checkpoint: { ref: 'retained-checkpoint' } }
  const calls: unknown[] = []
  const refusal = new Error('admitted effects require reconciliation')
  const authority = (name: string) => ({
    listTasks: () => ({ running: [], waiting: [], completed: [], stopped: [], draft: [], failed: [{ taskId }] }),
    operationTask: (selected: OperationId) => {
      if (selected.value === operationId.value) return taskId
      if (selected.value === 'other-task-operation') return id('task', 'other-task')
      throw new Error('unknown retained operation')
    },
    resumeExecution: async (...args: unknown[]) => { calls.push([name, 'resume', ...args]); return receipt },
    recoverTask: async (...args: unknown[]) => { calls.push([name, 'recover', ...args]); return recovered },
    stop: async (...args: unknown[]) => { calls.push([name, 'stop', ...args]); return { state: 'stopping', operationId: operationId.value } },
    removeMainTopicHistory: async (input: unknown) => {
      calls.push([name, 'remove-history', input])
      return {
        removedRoundKeys: ['interaction:r1'],
        projection: { surface: 'main-topic', projectKey: name, projectName: name, workspaceCwd: `/tmp/${name}`, mode: 'fake', turns: [], rounds: [], tasks: [] },
      }
    },
  })
  const alex = authority('alex')
  const project = authority('project-a')
  const backend = new ScopedConversationBackend({
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
      { scope: { kind: 'project', projectKey: 'project-a' }, scopeKey: 'project:project-a', canonicalAddress: 'machine.project-a.Jenny', agentId: 'jenny-agent', role: 'project-lead', projectKey: 'project-a', workspaceCwd: '/tmp/project-a' },
    ],
    sessions: new Map([
      ['alex', scopedSessionFromUiRuntime(alex as unknown as UiRuntimeService)],
      ['project:project-a', scopedSessionFromUiRuntime(project as unknown as UiRuntimeService)],
    ]),
  })
  const normal = authority('default')
  const dispatcher = memoryDispatcher(backend, normal)
  const post = (action: string, query: string, body: unknown, selectedTask = taskId.value) => memoryCall(
    dispatcher, `/api/tasks/${selectedTask}/${action}${query}`, 'POST', JSON.stringify(body),
  )
  try {
    const resumed = await post('resume', '?scope=system', { operationId: operationId.value })
    assert.equal(resumed.status, 202)
    assert.deepEqual(resumed.body, receipt)
    assert.deepEqual(calls.pop(), ['alex', 'resume', taskId, { operationId }])
    const recovery = await post('recover', '?scope=alex', { operatorNote: '  operator confirms settlement  ' })
    assert.equal(recovery.status, 200)
    assert.deepEqual(recovery.body, { ...recovered, taskId: taskId.value })
    assert.deepEqual(calls.pop(), ['alex', 'recover', taskId, { operatorNote: 'operator confirms settlement' }])

    // Identical task IDs in another scope still select only that scope's authority.
    await post('resume', '?scope=project&projectKey=project-a', { operationId: operationId.value })
    assert.deepEqual(calls.pop(), ['project-a', 'resume', taskId, { operationId }])
    project.operationTask = () => { throw new Error('operation absent in project-a') }
    assert.equal((await post('resume', '?scope=project&projectKey=project-a', { operationId: operationId.value })).status, 404)
    assert.equal((await post('resume', '?scope=alex', { operationId: 'unknown-operation' })).status, 404)
    assert.equal((await post('resume', '?scope=alex', { operationId: 'other-task-operation' })).status, 404)
    assert.equal((await post('recover', '?scope=alex', {}, 'other-task')).status, 404)
    assert.equal((await post('recover', '?scope=project&projectKey=unknown', {})).status, 404)
    assert.equal((await post('resume', '?scope=alex', { operationId: operationId.value, operatorNote: 'bypass' })).status, 400)
    assert.deepEqual(calls, [])

    alex.recoverTask = async () => { throw refusal }
    await assert.rejects(() => backend.recoverTask({ kind: 'alex' }, taskId, {}), (error) => error === refusal)
    alex.resumeExecution = async () => { throw refusal }
    await assert.rejects(() => backend.resumeExecution({ kind: 'alex' }, taskId, { operationId }), (error) => error === refusal)

    assert.deepEqual((await post('resume', '', { operationId: operationId.value })).body, receipt)
    assert.deepEqual(calls.pop(), ['default', 'resume', taskId, { operationId }])
    assert.equal((await post('recover', '', {})).status, 200)
    assert.deepEqual(calls.pop(), ['default', 'recover', taskId, {}])

    const stopped = await post('stop', '?scope=alex', {})
    assert.equal(stopped.status, 202)
    assert.deepEqual(calls.pop(), ['alex', 'stop', taskId])
    assert.equal((await post('stop', '?scope=alex', {}, 'other-task')).status, 404)

    const removedAlex = await memoryCall(dispatcher, '/api/main-topic/history/remove?scope=alex', 'POST', JSON.stringify({ roundKey: 'interaction:r1' }))
    assert.equal(removedAlex.status, 200)
    assert.equal((removedAlex.body as { readonly projection?: { readonly agentName?: string } }).projection?.agentName, 'Alex')
    assert.deepEqual(calls.pop(), ['alex', 'remove-history', { roundKey: 'interaction:r1' }])
  } finally {
    await dispatcher.sseRegistry.closeAll('server.shutdown')
  }
})

test('HTTP system dashboard projects connected conversationSession per registered project and resolves dynamic project scopes', async () => {
  const dynamicBackend = new ScopedConversationBackend({
    defaultMode: 'rcc',
    descriptors: [
      { scope: { kind: 'alex' }, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' },
    ],
    resolveProjectDescriptor: async (projectKey) => projectKey === 'project-dyn'
      ? { scope: { kind: 'project', projectKey: 'project-dyn' }, scopeKey: 'project:project-dyn', canonicalAddress: 'machine.project-dyn.Jenny', agentId: 'interaction-default', role: 'project-lead', projectKey: 'project-dyn', workspaceCwd: '/tmp/project-dyn' }
      : undefined,
    createSession: async (descriptor) => session(descriptor.scopeKey),
  })
  const dispatcher = memoryDispatcher(dynamicBackend, {
    systemRead: async () => ({
      surface: 'runtime-system',
      scope: { kind: 'system' },
      observedAt: new Date(0).toISOString(),
      runtime: { state: 'ready', mode: 'fake', connected: true },
      coverage: 'configured-projects-in-current-control-root',
      projects: [
        { surface: 'runtime-project', scope: { kind: 'project', projectKey: 'project-dyn' }, label: 'DynProj', workspaceCwd: '/tmp/project-dyn', observedAt: new Date(0).toISOString(), tasks: [], taskCount: 0, complete: true, failures: [] },
        { surface: 'runtime-project', scope: { kind: 'project', projectKey: 'project-missing' }, label: 'MissingProj', workspaceCwd: '/tmp/project-missing', observedAt: new Date(0).toISOString(), tasks: [], taskCount: 0, complete: true, failures: [] },
      ],
      taskCount: 0,
      complete: true,
      failures: [],
    }),
  })
  try {
    const sysRes = await memoryCall(dispatcher, '/api/dashboard?scope=system')
    assert.equal(sysRes.status, 200)
    const projects = (sysRes.body as { projects: Array<{ scope: { projectKey: string }; conversationSession?: { connected: boolean; agentName: string; agentId: string } }> }).projects
    assert.deepEqual(projects[0]?.conversationSession, { connected: true, agentName: 'Jenny', agentId: 'interaction-default' })
    assert.equal(projects[1]?.conversationSession, undefined)
    const dynTopic = await memoryCall(dispatcher, '/api/main-topic?scope=project&projectKey=project-dyn')
    assert.equal(dynTopic.status, 200)
    assert.equal((dynTopic.body as { agentName: string }).agentName, 'Jenny')
    assert.equal((dynTopic.body as { projectName?: string }).projectName, 'project-dyn')
    assert.equal((dynTopic.body as { mode?: string }).mode, 'rcc')
  } finally {
    await dispatcher.sseRegistry.closeAll('server.shutdown')
  }
})
