import assert from 'node:assert/strict'
import test from 'node:test'
import { toolPresentations, toolOutputText } from '../../docs/ui/tool-presentation.js'
import { createRuntimeApi } from '../../docs/ui/runtime-api.js'

const event = (kind, callId, seq, extra = {}) => ({
  kind, callId, seq, taskId: { scope: 'task', value: 'finance' },
  operationId: 'read', executionEpoch: 1, toolId: 'file.read',
  occurredAt: '2026-11-23T00:00:00Z', ...extra,
})
test('same-name calls pair only by task, operation, epoch and callId', () => {
  const rows = toolPresentations([
    event('provider.tool', 'a', 1, { arguments: { path: '甲.txt' } }),
    event('provider.tool', 'b', 2, { arguments: { path: '乙.txt' } }),
    event('provider.tool-result', 'a', 3, { executionEpoch: 2, status: 'succeeded' }),
    event('provider.tool-result', 'a', 4, { operationId: 'other', status: 'succeeded' }),
    event('provider.tool-result', 'a', 5, { taskId: { scope: 'task', value: 'other' }, status: 'succeeded' }),
    event('provider.tool-result', 'b', 6, { status: 'succeeded', outputRef: 'output:乙', outputDigest: 'recorded' }),
  ])
  assert.equal(rows.find((row) => row.call?.callId === 'a').result, undefined)
  const b = rows.find((row) => row.call?.callId === 'b')
  assert.equal(b.result.seq, 6)
  assert.equal(b.outputTarget.taskId.value, 'finance')
  assert.equal(rows.filter((row) => !row.call).length, 3)
})
test('unknown, failed, result-only and missing identity keep facts without guessing', () => {
  const error = { code: 'file.denied', message: '不允许读取' }
  const rows = toolPresentations([
    event('provider.tool', 'x', 1, { toolId: 'new.tool', arguments: { query: '原参数' } }),
    event('provider.tool-result', 'x', 2, { toolId: 'new.tool', status: 'failed', error }),
    event('provider.tool', undefined, 3),
    event('provider.tool-result', undefined, 4, { status: 'succeeded' }),
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].result.error, error)
  assert.equal(rows[0].outputTarget, undefined)
  assert.equal(rows[1].result, undefined)
  assert.equal(rows[2].call, undefined)
  assert.equal(toolOutputText('file.read', { content: '财务全文\n'.repeat(2000) }), '财务全文\n'.repeat(2000))
  assert.equal(toolOutputText('new.tool', { answer: '<script>原文</script>' }), '{\n  "answer": "<script>原文</script>"\n}')
})
test('tool output consumer uses existing scoped endpoint and typed HTTP errors', async () => {
  let called
  const api = createRuntimeApi({ fetchImpl: async (url) => {
    called = url
    return new Response(JSON.stringify({ error: { code: 'tool-output.not-available', message: '正文不可读' } }), { status: 409 })
  } })
  await assert.rejects(api.readToolOutput({ taskId: { value: '财务/甲' }, operationId: 'read/1', executionEpoch: 2, seq: 6 }), /正文不可读/)
  assert.equal(called, '/api/tasks/%E8%B4%A2%E5%8A%A1%2F%E7%94%B2/operations/read%2F1/executions/2/events/6/tool-output')
})
