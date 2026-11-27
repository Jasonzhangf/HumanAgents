import assert from 'node:assert/strict'
import test from 'node:test'
import { ScopedConversationEngine, type ScopedConversationState } from '../../../packages/runtime/src/conversation-scope-engine.js'

class Store {
  states = new Map<string, ScopedConversationState>()
  async read(scopeKey: string) { return this.states.get(scopeKey) }
  async write(state: ScopedConversationState) { this.states.set(state.scope.scopeKey, structuredClone(state)) }
}

test('scoped engine keeps Alex state and task references isolated and reusable', async () => {
  const store = new Store()
  const engine = new ScopedConversationEngine({
    store,
    resolve: (scope) => scope.kind === 'alex'
      ? { scope, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }
      : { scope, scopeKey: `project:${scope.projectKey}`, canonicalAddress: `machine.${scope.projectKey}.Jenny`, agentId: 'jenny-agent', role: 'project-lead', projectKey: scope.projectKey, workspaceCwd: `/tmp/${scope.projectKey}` },
    legacyBinding: { legacySessionRef: '50661', scope: { kind: 'alex' }, preservedInteractionRefs: ['interaction-1', 'interaction-2'], preservedTaskRefs: ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'], sourceEvidenceRef: 'receipt' },
  })
  const alex = await engine.appendInteraction({ kind: 'alex' }, 'interaction-alex')
  const project = await engine.appendInteraction({ kind: 'project', projectKey: 'project-a' }, 'interaction-project')
  assert.deepEqual(alex.preservedTaskRefs, ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'])
  assert.equal(alex.interactionIds.includes('interaction-project'), false)
  assert.equal(project.legacySessionRef, undefined)
})

test('legacy Alex binding backfills an existing scoped state without losing interactions', async () => {
  const store = new Store()
  const engine = new ScopedConversationEngine({
    store,
    resolve: (scope) => ({ scope, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }),
  })
  const interaction = await engine.appendInteraction({ kind: 'alex' }, 'existing-interaction')
  assert.deepEqual(interaction.interactionIds, ['existing-interaction'])
  const bound = new ScopedConversationEngine({
    store,
    resolve: (scope) => ({ scope, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }),
    legacyBinding: { legacySessionRef: '50661', scope: { kind: 'alex' }, preservedInteractionRefs: ['interaction-1', 'interaction-2'], preservedTaskRefs: ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'], sourceEvidenceRef: '50661回执' },
  })
  const reopened = await bound.open({ kind: 'alex' })
  assert.deepEqual(reopened.interactionIds, ['existing-interaction'])
  assert.equal(reopened.legacySessionRef, '50661')
  assert.deepEqual(reopened.preservedInteractionRefs, ['interaction-1', 'interaction-2'])
  assert.deepEqual(reopened.preservedTaskRefs, ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'])
})

test('concurrent interaction appends preserve every ID in one scoped state', async () => {
  class DeferredStore extends Store {
    override async read(scopeKey: string) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return super.read(scopeKey)
    }
    override async write(state: ScopedConversationState) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await super.write(state)
    }
  }
  const store = new DeferredStore()
  const engine = new ScopedConversationEngine({
    store,
    resolve: (scope) => ({ scope, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }),
  })
  await Promise.all([
    engine.appendInteraction({ kind: 'alex' }, 'interaction-a'),
    engine.appendInteraction({ kind: 'alex' }, 'interaction-b'),
  ])
  const state = await engine.read({ kind: 'alex' })
  assert.deepEqual([...state.interactionIds].sort(), ['interaction-a', 'interaction-b'])
})

test('scoped read is observational and does not create or backfill state', async () => {
  class CountingStore extends Store {
    writes = 0
    override async write(state: ScopedConversationState) {
      this.writes += 1
      await super.write(state)
    }
  }
  const store = new CountingStore()
  const engine = new ScopedConversationEngine({
    store,
    resolve: (scope) => ({ scope, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }),
    legacyBinding: {
      legacySessionRef: '50661',
      scope: { kind: 'alex' },
      preservedInteractionRefs: ['interaction-1'],
      preservedTaskRefs: ['task-a'],
      sourceEvidenceRef: 'receipt',
    },
  })

  const fresh = await engine.read({ kind: 'alex' })
  assert.equal(fresh.legacySessionRef, undefined)
  assert.deepEqual(fresh.interactionIds, [])
  assert.equal(store.writes, 0)

  const opened = await engine.appendInteraction({ kind: 'alex' }, 'interaction-opened')
  assert.equal(opened.legacySessionRef, '50661')
  const writesAfterOpen = store.writes
  await engine.read({ kind: 'alex' })
  assert.equal(store.writes, writesAfterOpen)
})

test('scoped read rejects state owned by another logical scope', async () => {
  const store = new Store()
  store.states.set('alex', {
    scope: { scope: { kind: 'project', projectKey: 'other' }, scopeKey: 'project:other', canonicalAddress: 'machine.other.Jenny', agentId: 'jenny', role: 'project-lead', projectKey: 'other', workspaceCwd: '/tmp/other' },
    interactionIds: [], checkpointRefs: [], preservedInteractionRefs: [], preservedTaskRefs: [],
  })
  const engine = new ScopedConversationEngine({
    store,
    resolve: (scope) => ({ scope, scopeKey: 'alex', canonicalAddress: 'machine.CEO', agentId: 'alex-agent', role: 'ceo' }),
  })
  let readError: unknown
  try {
    await engine.read({ kind: 'alex' })
  } catch (error) {
    readError = error
  }
  assert.equal(/does not belong/.test(String(readError)), true)
})
