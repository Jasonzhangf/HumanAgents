import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mainTopicTurnGroups } from '../../docs/ui/main-topic.js'
import { toolPresentations } from '../../docs/ui/tool-presentation.js'
import { renderMainTopicHistoryDetail } from '../../docs/ui/main-topic-history-detail.js'

test('the recorded user message occurs once in its history drawer', () => {
  const nodes = []
  const original = globalThis.document
  globalThis.document = { createElement() {
    const node = { style: {}, dataset: {}, append() {} }
    nodes.push(node)
    return node
  } }
  try {
    const userTurn = { turnId: 'user:i', interactionId: 'i', role: 'user', kind: 'message', text: '读取文件' }
    const reply = { turnId: 'reply:i', role: 'jenny', kind: 'message', text: '可以' }
    const round = { interactionId: 'i', userText: userTurn.text, messageRefs: [userTurn.turnId, reply.turnId] }
    renderMainTopicHistoryDetail(round, [userTurn, reply])
    assert.ok(nodes.some(node => node.textContent === 'Jenny'))
    assert.equal(nodes.filter(node => node.textContent === userTurn.text).length, 1)
    nodes.length = 0
    renderMainTopicHistoryDetail({ ...round, messageRefs: [] }, [])
    assert.equal(nodes.filter(node => node.textContent === userTurn.text).length, 1)
  } finally {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
  }
})

// Known callback mismatch loses the entire round. Impact: unreadable history.
// Small deterministic test; browser covers DOM, lazy output and focus behavior.
test('history entry binds both render paths to the distinct round detail callback', async () => {
  const entry = readFileSync(new URL('../../docs/ui/entry.js', import.meta.url), 'utf8')
  assert.equal((entry.match(/onOpenHistoryDetail: openMainTopicHistoryDetail/g) || []).length, 2)
  const history = await import('../../docs/ui/main-topic-history-detail.js')
  assert.equal(typeof history.renderMainTopicHistoryDetail, 'function')
})

test('two shuffled rounds preserve refs and pair same-name results by identity', () => {
  const event = (kind, callId, seq) => ({ kind, callId, seq, toolId: 'file.read', taskId: { scope: 'task', value: 't' }, operationId: 'read', executionEpoch: 1 })
  const turns = ['b', 'a'].map((id) => ({ turnId: id, text: `正文${id}`, toolEvents: [event('provider.tool-result', id, 2), event('provider.tool', id, 1)] }))
  const rounds = ['a', 'b'].map((id) => ({ roundKey: id, lane: 'history', messageRefs: [id] }))
  const groups = mainTopicTurnGroups({ rounds, turns })
  for (const { round, turns: selected } of groups.history) {
    assert.deepEqual(selected.map(t => t.turnId), round.messageRefs)
    const [tool] = toolPresentations(selected.flatMap(t => t.toolEvents))
    assert.equal(tool.call.callId, round.roundKey)
    assert.equal(tool.result.callId, round.roundKey)
  }
})
