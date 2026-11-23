import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToolBody, disposeToolBody, toolOutputText, toolSemantics } from '../../docs/ui/tool-presentation.js'

// Minimal DOM port for this component. No browser, network, model or execution.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.hidden = false; this.isConnected = true; this.listeners = {} }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node) } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn }
  showModal() { this.open = true }
  close() { this.open = false; this.listeners.close?.() }
  focus() {}
  set innerHTML(_) { assert.fail('tool text must never be parsed as HTML') }
}
globalThis.document = { createElement: (tag) => new Node(tag) }
const find = (node, cls) => node.className === cls ? node : node.children.map((child) => find(child, cls)).find(Boolean)
const text = (node) => [node.textContent, ...node.children.map(text)].join('\n')
const open = (node) => node.children[0].listeners.click()
const call = (id, command = 'true') => ({ kind: 'provider.tool', taskId: { scope: 'task', value: 't' }, operationId: 'op', executionEpoch: 1, callId: id, seq: 1, toolId: 'bash', arguments: { command, description: '受控调用', workdir: '子目录' } })
const result = (id, extra = {}) => ({ ...call(id), kind: 'provider.tool-result', seq: 2, status: 'succeeded', outputRef: 'report', outputDigest: 'recorded', ...extra })
const report = (extra = {}) => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, ...extra })

test('a changed scoped reader cannot retain another scope report for the same event identity', async () => {
  const host = new Node('main')
  const events = [call('a'), result('a')]
  const first = async () => report({ stdout: { text: 'PROJECT-A', truncated: false } })
  let secondReads = 0
  const second = async () => { secondReads++; return report({ stdout: { text: 'PROJECT-B', truncated: false } }) }
  renderToolBody(host, events, first)
  await find(host, 'tool-read-output').listeners.click()
  renderToolBody(host, events, second)
  await find(host, 'tool-read-output').listeners.click()
  assert.equal(secondReads, 1)
  assert.doesNotMatch(text(host), /PROJECT-A/)
  assert.match(text(host), /PROJECT-B/)
})

// Failure mode: the card stays generic after a real report, or a viewport read
// races a click/poll and reads the same output twice. Impact: unreadable or
// mismatched results. Cost: a deterministic component test; no runtime/model.
test('plugins provide immediate subjects and update the same card from one visible read', async () => {
  const pending = toolSemantics('file.edit', { file_path: '目录/<x>.txt', old_string: 'old', new_string: 'new' })
  assert.equal(pending.subject, '目录/<x>.txt')
  assert.ok(pending.title)
  const observers = []
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); observers.push(this) }
    observe(node) { this.nodes.add(node) }
    unobserve(node) { this.nodes.delete(node) }
    disconnect() { this.nodes.clear() }
  }
  try {
    const host = new Node('main'); let reads = 0; let finish
    const reader = () => { reads++; return new Promise((resolve) => { finish = resolve }) }
    const events = [call('a'), result('a'), call('b'), result('b')]
    renderToolBody(host, events, reader)
    assert.equal(reads, 0, 'offscreen history is not prefetched')
    const card = host.children[0]
    const observer = observers.find((entry) => entry.nodes.has(card))
    assert.ok(observer, 'readable card is observed')
    observer.callback([{ target: card, isIntersecting: false }])
    assert.equal(reads, 0)
    observer.callback([{ target: card, isIntersecting: true }])
    const click = find(card, 'tool-read-output').listeners.click()
    renderToolBody(host, events, reader)
    assert.equal(reads, 1)
    finish(report({ stdout: { text: '<script>literal</script>\n', truncated: false } }))
    await click
    assert.equal(host.children[0], card)
    assert.ok(text(find(card, 'tool-semantic')).includes('<script>literal</script>'))
    assert.equal(text(find(host.children[1], 'tool-semantic')).includes('literal'), false)
    assert.equal(find(card, 'tool-output').hidden, false, 'explicit click expands full output')
    renderToolBody(host, events, reader)
    assert.equal(reads, 1)
    renderToolBody(host, [], reader)
    assert.ok(observers.every((entry) => entry.nodes.size === 0), 'removed cards release observers')
  } finally { delete globalThis.IntersectionObserver }
})

test('late output cannot repaint a rebuilt card; arriving result keeps original call card', async () => {
  const host = new Node('main'); let finish
  const reader = () => new Promise((resolve) => { finish = resolve })
  renderToolBody(host, [call('a')], reader)
  const card = host.children[0]
  renderToolBody(host, [call('a'), result('a')], reader)
  assert.equal(host.children[0], card, 'result updates the original call card')
  const loading = find(card, 'tool-read-output').listeners.click()
  renderToolBody(host, [call('a'), result('a', { seq: 3, outputRef: 'replacement' })], async () => report({ stdout: { text: 'NEW', truncated: false } }))
  finish(report({ stdout: { text: 'STALE', truncated: false } }))
  await loading
  assert.equal(text(host).includes('STALE'), false)
  await find(card, 'tool-read-output').listeners.click()
  assert.ok(text(host).includes('NEW'))
  renderToolBody(host, [], reader)
  assert.equal(host.children.length, 0)
})

test('disposing an in-flight card releases it and cannot populate a later render', async () => {
  const host = new Node('main'); let finish
  renderToolBody(host, [call('a'), result('a')], () => new Promise((resolve) => { finish = resolve }))
  const loading = find(host, 'tool-read-output').listeners.click()
  disposeToolBody(host)
  renderToolBody(host, [call('b')], () => assert.fail('pending call'))
  finish(report({ stdout: { text: 'OLD-CARD-OUTPUT', truncated: false } }))
  await loading
  assert.equal(host.children.length, 1)
  assert.equal(text(host).includes('OLD-CARD-OUTPUT'), false)
  disposeToolBody(host)
  assert.equal(host.children.length, 0)
})

test('edit preview carries literal plus/minus lines while raw arguments remain available', async () => {
  const host = new Node('main')
  renderToolBody(host, [
    { ...call('edit'), toolId: 'file.edit', arguments: { file_path: 'a.txt', old_string: '<old>\nkeep\n', new_string: '<new>\nkeep\n' } },
    { ...result('edit'), toolId: 'file.edit' },
  ], async () => ({ path: 'a.txt', before: '<old>\nkeep\n', after: '<new>\nkeep\n' }))
  await find(host, 'tool-read-output').listeners.click()
  const lines = find(host, 'tool-preview').children
  assert.ok(lines.some((line) => line.dataset.kind === 'remove' && line.textContent.includes('- <old>')))
  assert.ok(lines.some((line) => line.dataset.kind === 'add' && line.textContent.includes('+ <new>')))
  const facts = find(host, 'tool-facts')
  assert.equal(find(facts, 'tool-arguments'), undefined)
  open(facts)
  assert.ok(text(facts).includes('old_string'))
})

// Failure mode: before/after and input content are serialized during polling
// and again in two full-result nodes. Impact: large allocations and slow cards.
// Cost: local DOM only, one report read, no runtime or provider resources.
test('large write arguments and report serialize once only when their details open', async () => {
  const host = new Node('main')
  let argumentsSerialized = 0; let reportSerialized = 0
  const args = { file_path: 'large.txt', content: 'new\n'.repeat(20000), toJSON() { argumentsSerialized++; return { file_path: this.file_path, content: this.content } } }
  const body = { path: 'large.txt', before: 'old\n'.repeat(20000), after: args.content, toJSON() { reportSerialized++; return { path: this.path, before: this.before, after: this.after } } }
  const events = [{ ...call('write'), toolId: 'file.write', arguments: args }, { ...result('write'), toolId: 'file.write' }]
  let reads = 0
  const reader = async () => { reads++; return body }
  renderToolBody(host, events, reader)
  renderToolBody(host, events, reader)
  assert.equal(argumentsSerialized, 0)
  assert.equal(find(host, 'tool-arguments'), undefined)
  await find(host, 'tool-read-output').listeners.click()
  assert.equal(reportSerialized, 0)
  assert.equal(find(host, 'tool-report-original'), undefined)
  assert.equal(find(host, 'tool-output').textContent, '')
  assert.equal(find(host, 'tool-output').hidden, true)
  assert.match(text(find(host, 'tool-semantic')), /修改/)
  assert.doesNotMatch(text(host), /等待结果正文|尚无结果正文|执行工具等待结果/)
  const raw = find(host, 'tool-raw-report')
  open(raw)
  assert.equal(reportSerialized, 1)
  assert.equal(find(raw, 'tool-report-original').textContent, JSON.stringify({ path: body.path, before: body.before, after: body.after }, null, 2))
  open(raw)
  assert.equal(reportSerialized, 1)
  open(find(host, 'tool-facts'))
  assert.equal(argumentsSerialized, 1)
  renderToolBody(host, events, reader)
  assert.equal(reads, 1, 'loaded report is reused for the same reader')
  assert.equal(argumentsSerialized, 1)
  assert.equal(reportSerialized, 1)
  disposeToolBody(host)
})

test('bash report has semantic streams, empty output, exit code and interruption facts', () => {
  const empty = toolOutputText('bash', report())
  assert.match(empty, /退出码：0/)
  assert.match(empty, /标准输出（stdout）\n（空字符串）/)
  assert.match(empty, /标准错误（stderr）\n（空字符串）/)
  const failed = toolOutputText('bash', report({ exitCode: 7, stdout: { text: 'partial\n', truncated: true }, stderr: { text: '<script>bad</script>', truncated: false } }))
  assert.match(failed, /命令退出失败/)
  assert.match(failed, /退出码：7/)
  assert.match(failed, /已截断/)
  assert.ok(failed.includes('partial\n'))
  assert.ok(failed.includes('<script>bad</script>'))
  assert.match(toolOutputText('bash', report({ exitCode: null, signal: 'SIGTERM', timedOut: true, aborted: true })), /退出码：无（null）/)
  assert.match(toolOutputText('bash', report({ signal: 'SIGTERM', timedOut: true, aborted: true })), /超时：是[\s\S]*取消：是[\s\S]*信号：SIGTERM/)
  assert.match(toolOutputText('bash', {}), /标准输出（stdout）\n（未提供）/)
  assert.equal(toolOutputText('file.read', { content: '' }), '（空字符串）')
  assert.equal(toolOutputText('future.tool', ''), '（空字符串）')
  assert.equal(toolOutputText('future.tool', { exitCode: 7 }), '{\n  "exitCode": 7\n}')
  // Existing gateway-assembly fixture: actual operation returns stdout.text.
  assert.ok(toolOutputText('bash', report({ stdout: { text: '{"ok":true}\n', truncated: false } })).includes('{"ok":true}\n'))
})

test('command syntax stays literal, cwd is explicit, unknown tools stay generic', () => {
  for (const command of ['node -p "JSON.stringify({ok:true})"', "printf '%s\\n' 'a b' | cat > 'out file'", 'echo "<img src=x onerror=bad>"\nfalse', 'bash -c \'echo "$HOME"\'']) {
    const host = new Node('main')
    renderToolBody(host, [call('a', command)], () => assert.fail('render must not read or execute'))
    const facts = find(host, 'tool-facts')
    assert.equal(find(host, 'tool-command'), undefined)
    assert.equal(facts.children[1].open, undefined)
    open(facts)
    assert.equal(find(host, 'tool-command').textContent, command)
    assert.equal(find(host, 'tool-command').parent, find(facts, 'detail-disclosure-content'))
    assert.ok(find(facts, 'tool-arguments'))
    assert.match(text(host), /工作目录：子目录/)
    assert.match(text(host), /执行工具等待结果/)
    assert.equal(find(host, 'tool-read-output'), undefined)
  }
  const host = new Node('main')
  const missingCwd = call('a'); delete missingCwd.arguments.workdir
  renderToolBody(host, [missingCwd], () => {})
  open(find(host, 'tool-facts'))
  assert.match(text(host), /绑定项目目录（实际路径未提供）/)
  renderToolBody(host, [{ ...call('b'), toolId: 'exec_command', arguments: { argv: ['echo', 'a | b'] } }], () => {})
  assert.equal(find(host, 'tool-command'), undefined)
  assert.match(text(host), /a \| b/)
})

test('DOM output reads exact target, preserves literal text and loaded state, distinguishes missing and errors', async () => {
  const host = new Node('main'); let reads = 0
  const events = [call('a'), call('b'), result('b')]
  const reader = async (target) => { reads++; assert.equal(target.seq, 2); return report({ stdout: { text: '<script>literal</script>\n', truncated: false } }) }
  renderToolBody(host, events, reader)
  const b = host.children[1]; const button = find(b, 'tool-read-output')
  assert.match(text(b), /工具已返回/)
  await button.listeners.click()
  assert.equal(reads, 1)
  assert.ok(find(b, 'tool-output').textContent.includes('<script>literal</script>\n'))
  renderToolBody(host, events, reader)
  assert.equal(host.children[1], b)
  await button.listeners.click(); assert.equal(find(b, 'tool-output').hidden, false)
  await button.listeners.click(); assert.equal(reads, 1)
  renderToolBody(host, [call('a'), result('a', { outputRef: undefined })], reader)
  assert.match(text(host), /结果正文未提供/)
  assert.doesNotMatch(text(host), /等待结果正文|尚无结果正文|执行工具等待结果/)
  let retry = false
  renderToolBody(host, [call('a'), result('a')], async () => {
    if (!retry) throw Object.assign(new Error('正文损坏'), { code: 'report.missing', nextAction: '检查输出存储' })
    return ''
  })
  await find(host, 'tool-read-output').listeners.click()
  assert.match(text(host), /report.missing.*正文损坏/)
  assert.match(text(host), /检查输出存储/)
  assert.doesNotMatch(text(host), /等待结果正文|尚无结果正文|执行工具等待结果/)
  assert.equal(find(host, 'tool-output').hidden, true)
  assert.equal(find(host, 'tool-read-output').disabled, false)
  retry = true
  await find(host, 'tool-read-output').listeners.click()
  assert.equal(find(host, 'tool-output').textContent, '（空字符串）')
  assert.equal(find(host, 'tool-output').hidden, false)
  renderToolBody(host, [call('a'), result('a', { status: 'failed', error: { code: 'tool.denied', message: '拒绝执行', ownerId: 'gateway' } })], reader)
  assert.match(text(host), /tool.denied.*拒绝执行/)
  assert.match(text(host), /gateway/)
  assert.equal(host.children[0].children[0].className, 'tool-error')
  assert.equal(text(host).split('拒绝执行').length, 2)
  assert.doesNotMatch(text(host), /等待结果正文|尚无结果正文|执行工具等待结果/)
})
