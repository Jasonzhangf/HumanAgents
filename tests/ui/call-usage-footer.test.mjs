import test from 'node:test'
import assert from 'node:assert/strict'
import * as usageUI from '../../docs/ui/call-usage-footer.js'

// Old debug-only rendering is known to lack these fields. Wrong units, stale
// rows and missing-as-zero mislead users. Public DOM cases are cheap to maintain.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.attributes = {}; this.open = false }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => {
      const matches = selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)]
    })
  }
  set innerHTML(_) { assert.fail('usage must be rendered as text') }
}
globalThis.document = { createElement: (tag) => new Node(tag) }
const text = (node) => [node.textContent, ...node.children.map(text)].join('\n')
const call = (changes = {}) => ({
  callId: 'call-a', turnId: 'turn-a', inputTokens: 1200, outputTokens: 40,
  cacheReadTokens: 600, cacheWriteTokens: 0,
  context: { used: 1200, limit: 8000, percent: 15 },
  currentCallCacheHitRate: .5, previousCallCacheHitRate: .25,
  previousBusinessTurnCacheHitRate: .125, taskCacheHitRate: .375,
  outputSpeed: { tokensPerSecond: 20, basis: 'response-elapsed' }, ...changes,
})
const usage = (calls) => ({ calls, coverage: { calls: calls.length, callsWithKnownInput: 1, callsWithKnownCacheRead: 1 } })
const facts = (node) => {
  const dl = node.querySelector('dl')
  return Object.fromEntries(dl.children.filter((_, i) => i % 2 === 0).map((label, i) => [label.textContent, dl.children[i * 2 + 1].textContent]))
}

test('partial failure is visible once in the closed summary with technical recovery in disclosure', () => {
  const error = { code: 'usage.source.failed', ownerId: 'journal-owner', message: '调用统计暂时无法读取', nextAction: '稍后刷新统计' }
  const footer = usageUI.renderCallUsageFooter(null, { error })
  const summary = footer.querySelector('.call-usage-summary')
  assert.match(text(summary), /usage.source.failed.*调用统计暂时无法读取/s)
  assert.equal(text(footer).split('统计加载失败').length - 1, 1)
  assert.match(text(footer), /journal-owner/)
  assert.match(text(footer), /稍后刷新统计/)
  assert.doesNotMatch(text(footer), /暂无调用统计|\[object Object\]/)
  usageUI.updateCallUsageFooter(footer, undefined, { pending: true })
  assert.doesNotMatch(text(footer), /暂无调用统计|usage.source.failed/)
  usageUI.updateCallUsageFooter(footer, usage([]))
  assert.match(text(footer), /暂无调用统计/)
  assert.doesNotMatch(text(footer), /usage.source.failed|统计加载失败/)
})

test('public usage shows latest and each call with exact units, four rates and two speed bases', () => {
  const footer = usageUI.renderCallUsageFooter(usage([call(), call({ callId: 'call-b', outputTokens: 99, outputSpeed: { tokensPerSecond: 12.5, basis: 'generation-elapsed' } })]))
  assert.equal(footer.tagName, 'footer')
  assert.match(text(footer.querySelector('.call-usage-summary')), /99/)
  const rows = footer.querySelectorAll('.call-usage-call')
  assert.equal(rows.length, 2)
  assert.deepEqual(facts(rows[0]), {
    '输入 tokens': '1200', '输出 tokens': '40', '缓存读取 tokens': '600', '缓存写入 tokens': '0',
    '上下文已用 tokens': '1200', '上下文上限 tokens': '8000', '上下文使用率': '15%',
    '本次调用缓存命中率': '50%', '上次调用缓存命中率': '25%',
    '上一业务轮缓存命中率': '12.5%', '本任务缓存命中率': '37.5%',
    '输出速度': '20 tokens/s（响应总耗时）',
  })
  assert.match(text(rows[1]), /12.5 tokens\/s（生成耗时）/)
  assert.match(text(footer), /共 2 次调用，输入已知 1 次，缓存读取已知 1 次/)
  assert.doesNotMatch(text(footer), /response-elapsed|generation-elapsed|call-a|turn-a|\{"/)
})

test('missing, empty, pending and error are explicit; known zero differs from unknown', () => {
  for (const input of [undefined, usage([])]) assert.match(text(usageUI.renderCallUsageFooter(input)), /暂无调用统计/)
  const pending = usageUI.renderCallUsageFooter(undefined, { pending: true })
  assert.equal(pending.attributes['aria-busy'], 'true')
  assert.match(text(pending.querySelector('.call-usage-summary')), /加载中/)
  assert.match(text(usageUI.renderCallUsageFooter(undefined, { error: '<请求失败>' })), /统计加载失败：<请求失败>/)
  assert.doesNotMatch(text(usageUI.renderCallUsageFooter(undefined, { error: new Error('HTTP 503') })), /暂无调用统计/)
  const footer = usageUI.renderCallUsageFooter(usage([call({ inputTokens: 0, outputTokens: null, currentCallCacheHitRate: 0, context: { used: 0, limit: null, percent: null }, outputSpeed: { tokensPerSecond: null, basis: 'response-elapsed' } })]))
  const displayed = facts(footer)
  assert.equal(displayed['输入 tokens'], '0')
  assert.equal(displayed['输出 tokens'], '未知')
  assert.equal(displayed['本次调用缓存命中率'], '0%')
  assert.equal(displayed['上下文使用率'], '未知')
  assert.equal(displayed['输出速度'], '未知（响应总耗时）')
})

test('refresh reuses footer/disclosure, replaces same call, retains expansion and clears stale scope', () => {
  const footer = usageUI.renderCallUsageFooter(usage([call()]))
  const details = footer.querySelector('dialog')
  details.open = true
  usageUI.updateCallUsageFooter(footer, usage([call({ outputTokens: 88 })]), { pending: true })
  assert.equal(footer.querySelector('dialog'), details)
  assert.equal(details.open, true)
  assert.equal(footer.querySelectorAll('.call-usage-call').length, 1)
  assert.match(text(footer.querySelector('.call-usage-summary')), /88/)
  assert.match(text(footer), /加载中/)
  usageUI.updateCallUsageFooter(footer, usage([call({ callId: 'scope-b-call', inputTokens: 321 })]), { error: '读取失败' })
  assert.match(text(footer), /321/)
  assert.equal(facts(footer)['输入 tokens'], '321')
  assert.equal(footer.querySelectorAll('.call-usage-call').length, 1)
  assert.equal(footer.querySelector('.call-usage-call').dataset.callId, 'scope-b-call')
  assert.match(text(footer.querySelector('.call-usage-summary')), /加载失败/)
  usageUI.updateCallUsageFooter(footer, usage([]))
  assert.equal(footer.querySelectorAll('.call-usage-call').length, 0)
  assert.equal(footer.attributes['aria-busy'], 'false')
  assert.equal(details.open, true)
  assert.doesNotMatch(text(footer), /读取失败|加载中/)
})
