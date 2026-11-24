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
// Failure mode: providers may reuse a call id in another turn or request.
// Impact: a result can close the wrong card while the present call looks pending.
// Cost: one pure fixture; no DOM, runtime or provider.
test('a reused call id stays inside its exact turn and request', () => {
  const rows = toolPresentations([
    event('provider.tool', 'same', 1, { requestId: 'r1', turnId: 'turn-1', arguments: { path: '甲.txt' } }),
    event('provider.tool-result', 'same', 2, { requestId: 'r1', turnId: 'turn-1', status: 'succeeded', outputRef: 'output:甲', outputDigest: 'recorded' }),
    event('provider.tool', 'same', 3, { requestId: 'r2', turnId: 'turn-1', arguments: { path: '乙.txt' } }),
    event('provider.tool-result', 'same', 4, { requestId: 'r2', turnId: 'turn-1', status: 'failed', error: { code: 'file.denied', message: '乙拒绝读取' } }),
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => [row.call.requestId, row.result.requestId, row.result.seq]), [
    ['r1', 'r1', 2],
    ['r2', 'r2', 4],
  ])
  assert.equal(rows[0].outputTarget.seq, 2)
  assert.equal(rows.filter((row) => row.outputTarget).length, 1)
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

test('production static dispatcher serves every presentation plugin as JavaScript', async () => {
  // Real request dispatcher, no socket, runtime state, browser or model. A
  // missing shipped dependency makes the complete presentation module fail.
  const { createUiRuntimeRequestDispatcher } = await import('../../dist/app/app/src/ui-runtime/server.js')
  const { readFile } = await import('node:fs/promises')
  const dispatcher = createUiRuntimeRequestDispatcher({
    service: {}, accessControl: {}, productRoot: '/unused',
    uiRoot: new URL('../../docs/ui/', import.meta.url).pathname,
    isClosing: () => false,
  })
  for (const [file, exported] of [
    ['tool-presentation.js', 'toolSemantics'],
    ['tool-file-semantics.js', 'fileSemantics'],
    ['tool-shell-semantics.js', 'shellSemantics'],
    ['tool-task-semantics.js', 'taskSemantics'],
  ]) {
    const response = await new Promise((resolve) => {
      const result = {}
      dispatcher.listener({ url: `/${file}`, method: 'GET', headers: {} }, {
        writeHead(status, headers) { Object.assign(result, { status, headers }) },
        end(body) { resolve({ ...result, body: String(body) }) },
      })
    })
    assert.equal(response.status, 200, file)
    assert.match(response.headers['content-type'], /text\/javascript/)
    assert.equal(response.body, await readFile(new URL(`../../docs/ui/${file}`, import.meta.url), 'utf8'))
    assert.match(response.body, new RegExp(`export function ${exported}\\(`))
  }
})
