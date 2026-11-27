import assert from 'node:assert/strict'
import test from 'node:test'
import { assertConversationScope, conversationScopeFromQuery, isConversationScope } from '../../packages/contracts/src/conversation-scope.js'

test('conversation scope accepts only the server-resolvable Alex or project forms', () => {
  assert.equal(isConversationScope({ kind: 'alex' }), true)
  assert.equal(isConversationScope({ kind: 'project', projectKey: 'project-a' }), true)
  assert.equal(isConversationScope({ kind: 'alex', projectKey: 'project-a' }), false)
  assert.equal(isConversationScope({ kind: 'project' }), false)
  assert.equal(isConversationScope({ kind: 'project', projectKey: 'project-a', agentId: 'Alex' }), false)
  assert.equal(isConversationScope({ kind: 'alex', scope: 'system' }), false)
  assert.throws(() => assertConversationScope({ kind: 'alex', workspaceCwd: '/tmp' }), Error)
  assert.deepEqual(conversationScopeFromQuery({ scope: 'system' }), { kind: 'alex' })
  assert.deepEqual(conversationScopeFromQuery({ scope: 'project', projectKey: ' project-a ' }), { kind: 'project', projectKey: 'project-a' })
  assert.throws(() => conversationScopeFromQuery({ scope: 'alex', projectKey: 'project-a' }), Error)
})
