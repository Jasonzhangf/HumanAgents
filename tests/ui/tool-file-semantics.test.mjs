import test from 'node:test'
import assert from 'node:assert/strict'
import { fileSemantics } from '../../docs/ui/tool-file-semantics.js'

// Goal: report -> semantic card preview, on the existing read-only UX DAG.
// Owner scope: this test and tool-file-semantics.js only. No DOM/runtime effects.
// Risk: actual snake_case args and structured reports otherwise become raw JSON,
// false empty/success states, or unbounded previews. Pure fixtures are cheap to run.
// 2026-11-23 receipt: node --test tests/ui/tool-file-semantics.test.mjs
// RED: missing module; then replacement preview hid every added line.
// Audit 2026-11-23: RED exit 1 (6 failures: scope/counts/empty read/fallback).
// GREEN receipt below is for this public semantic function, not browser QA.
// DAG: decoded report/arguments -> semantic card -> existing textContent UI.
// Pure read-only mapping; no execution/control edges or topology changes.
// Audit GREEN: node --test tests/ui/tool-file-semantics.test.mjs
// tests/ui/tool-presentation-semantics.test.mjs tests/ui/tool-presentation.test.mjs
// exit 0, 25/25. Long single-line replacement separately reproduced RED first.
// Remaining integration gate: real frontend tester receipt; not claimed here.
// Remaining: host DOM integration belongs to its writer; no browser/model/service
// or persistent resource was started here. This is a white-box subtask receipt.
test('actual arguments identify each tool before a report exists', () => {
  for (const [id, args, title, subject] of [
    ['file.read', { path: 'a' }, '读取文件', 'a'],
    ['file.write', { file_path: 'b', content: 'uncommitted' }, '写入文件', 'b'],
    ['file.edit', { file_path: 'c', old_string: 'old', new_string: 'new' }, '编辑文件', 'c'],
    ['file.list', { path: '.' }, '列出文件', '.'],
    ['file.search', { path: 'src', query: 'needle' }, '搜索文件', '在 src 搜索 needle'],
    ['web.search', { query: 'news' }, '搜索网页', '在公开网络搜索 news；时间不限'],
  ]) {
    const card = fileSemantics(id, args)
    assert.equal(card.title, title)
    assert.equal(card.subject, subject)
    assert.match(card.summary, /等待.*正文/)
    assert.equal(card.lines?.length ?? 0, 0)
  }
})

test('read distinguishes empty, absent, and literal markup content', () => {
  assert.match(fileSemantics('file.read', {}, { content: '' }).summary, /本次读取内容为空/)
  assert.match(fileSemantics('file.read', {}, {}).summary, /未提供/)
  assert.match(fileSemantics('file.read', {}, null).summary, /未提供/)
  assert.deepEqual(fileSemantics('file.read', { path: 'wrong' }, { path: 'actual', content: '<img onerror=x>\nnext' }), {
    title: '读取文件', subject: 'actual', summary: '文件内容预览',
    lines: [{ kind: 'text', text: '<img onerror=x>' }, { kind: 'text', text: 'next' }],
  })
})

test('write creation uses returned after, including empty creation', () => {
  const card = fileSemantics('file.write', { file_path: 'x', content: 'not the result' }, { path: 'x', operation: 'create', before: null, after: 'created\n' })
  assert.match(card.summary, /新建/)
  assert.deepEqual(card.lines, [{ kind: 'add', text: 'created' }])
  assert.match(fileSemantics('file.write', {}, { operation: 'create', before: null, after: '' }).summary, /空文件/)
})

test('write update and edit show real changed lines with common context', () => {
  for (const id of ['file.write', 'file.edit']) {
    const report = Object.freeze({ path: 'x', operation: 'update', before: 'same\nold\ntail\n', after: 'same\nnew\ntail\n' })
    const args = Object.freeze({ file_path: 'x', old_string: 'not the file', new_string: 'not the result' })
    assert.deepEqual(fileSemantics(id, args, report).lines, [
      { kind: 'context', text: 'same' }, { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' }, { kind: 'context', text: 'tail' },
    ])
  }
})

test('diff handles insert, delete, repeated lines, no change and final newline', () => {
  const diff = (before, after) => fileSemantics('file.edit', {}, { before, after })
  assert.deepEqual(diff('', 'one\n').lines, [{ kind: 'add', text: 'one' }])
  assert.deepEqual(diff('one\n', '').lines, [{ kind: 'remove', text: 'one' }])
  assert.deepEqual(diff('a\nb\na\n', 'a\na\n').lines.filter(l => l.kind === 'remove'), [{ kind: 'remove', text: 'b' }])
  assert.match(diff('same', 'same').summary, /未变化/)
  assert.deepEqual(diff('same', 'same\n').lines.slice(0, 2), [{ kind: 'remove', text: 'same' }, { kind: 'add', text: 'same' }])
  assert.match(diff('same', 'same\n').summary, /末尾换行/)
  assert.match(diff(undefined, 'new').summary, /未提供/)
})

test('file list uses entries and separates empty, truncated, unresolved and missing', () => {
  assert.deepEqual(fileSemantics('file.list', {}, { entries: [{ path: 'src/a', kind: 'file' }], truncated: false }).lines, [{ kind: 'text', text: 'src/a' }])
  assert.match(fileSemantics('file.list', {}, { entries: [], truncated: false }).summary, /未找到文件/)
  assert.match(fileSemantics('file.list', {}, { entries: [], truncated: true }).summary, /截断/)
  assert.match(fileSemantics('file.list', {}, { entries: [], unresolvedPaths: ['secret'] }).summary, /未完成/)
  assert.match(fileSemantics('file.list', {}, {}).summary, /未提供/)
})

test('file search uses matches with path, line, column, text and context', () => {
  const card = fileSemantics('file.search', { path: 'src', query: 'find' }, {
    status: 'succeeded', matches: [{ path: 'src/a', line: 2, column: 4, text: 'find', contextBefore: ['before'], contextAfter: ['after'] }],
    matchesFound: 1, resultsTruncated: false, searchComplete: true,
  })
  assert.match(card.summary, /1.*命中/)
  assert.deepEqual(card.lines, [
    { kind: 'text', text: 'src/a:2:4' }, { kind: 'context', text: 'before' },
    { kind: 'text', text: 'find' }, { kind: 'context', text: 'after' },
  ])
})

test('search empty results are distinct from missing, failed, incomplete and truncated', () => {
  for (const [id, field] of [['file.search', 'matches'], ['web.search', 'results']]) {
    const empty = { [field]: [], status: 'succeeded', searchComplete: true }
    assert.match(fileSemantics(id, {}, empty).summary, /无命中/)
    assert.match(fileSemantics(id, {}, {}).summary, /未提供/)
    assert.match(fileSemantics(id, {}, { ...empty, resultsTruncated: true }).summary, /截断/)
    assert.match(fileSemantics(id, {}, { ...empty, searchComplete: false }).summary, /未完成/)
    const failed = fileSemantics(id, {}, { ...empty, status: 'failed', failure: { message: 'denied' } })
    assert.match(failed.summary, /失败.*denied/)
    assert.doesNotMatch(failed.summary, /无命中/)
  }
})

test('web results preserve title, URL, source and empty snippet distinction', () => {
  const card = fileSemantics('web.search', { query: 'query' }, { status: 'succeeded', results: [
    { title: 'Title', url: 'https://example.com', snippet: '', sourceName: 'Source', rank: 1 },
  ], resultsFound: 1, searchComplete: true, resultsTruncated: false })
  assert.deepEqual(card.lines, [
    { kind: 'text', text: 'Title' }, { kind: 'text', text: 'https://example.com' },
    { kind: 'context', text: '来源：Source' }, { kind: 'text', text: '（摘要为空）' },
  ])
})

test('large reports have bounded previews; a trimmed pure insertion has exact counts', () => {
  const huge = 'x'.repeat(100_000)
  for (const card of [
    fileSemantics('file.read', { path: huge }, { content: huge }),
    fileSemantics('file.read', {}, { content: 'a\n'.repeat(100_000) }),
    fileSemantics('file.list', {}, { entries: Array.from({ length: 1000 }, (_, i) => ({ path: `file${i}` })) }),
    fileSemantics('file.edit', {}, { before: huge, after: 'changed\n' + huge }),
    fileSemantics('file.edit', {}, { before: 'a\n'.repeat(1000), after: 'b\n'.repeat(1000) }),
  ]) {
    assert.ok(card.lines.length <= 25)
    assert.ok(card.lines.every(line => line.text.length <= 401))
    assert.ok((card.subject?.length ?? 0) <= 401)
    assert.match(card.summary, /截断|省略|预览上限/)
  }
  const diff = fileSemantics('file.edit', {}, { before: huge, after: 'changed\n' + huge })
  assert.deepEqual(diff.lines, [{ kind: 'add', text: 'changed' }])
  assert.match(diff.summary, /\+1\/-0/)
})

// Audit counterexamples: query-only labels, whole-file fallback +/- and empty
// range -> empty-file claims all fail on the previous implementation.
test('search scope survives waiting and zero hits, with report precedence', () => {
  const args = { path: 'wrong', query: 'old' }
  const file = fileSemantics('file.search', args, { path: 'src', query: 'needle', matches: [] })
  assert.equal(file.subject, '在 src 搜索 needle')
  assert.match(file.summary, /无命中/)
  for (const report of [undefined, { query: 'fresh', domains: ['actual.org'], recency: 'week', results: [] }]) {
    const web = fileSemantics('web.search', { query: 'old', domains: ['input.org'], recency: 'day' }, report)
    assert.equal(web.subject, report ? '在 actual.org 搜索 fresh；最近一周' : '在 input.org 搜索 old；最近一天')
  }
  assert.equal(fileSemantics('web.search', { domains: ['old.org'], recency: 'day' }, { query: 'q', domains: [], recency: 'any', results: [] }).subject, '在公开网络搜索 q；时间不限')
})

test('all exact writes report full counts, including creation, deletion and EOF', () => {
  for (const [before, after, counts] of [[null, 'a\n\n', '+2/-0'], [null, '', '+0/-0'], ['a\nb\n', '', '+0/-2'], ['a', 'a', '+0/-0'], ['a', 'a\n', '+1/-1'], ['a\n', 'a', '+1/-1'], ['old\n', 'new\n', '+1/-1']]) {
    assert.ok(fileSemantics('file.write', {}, { before, after }).summary.includes(counts), counts)
  }
  const prefix = 'shared\n'.repeat(20_000)
  const suffix = 'tail\n'.repeat(20_000)
  const card = fileSemantics('file.edit', {}, { before: prefix + 'old\n' + suffix, after: prefix + 'new\n' + suffix })
  assert.match(card.summary, /\+1\/-1/)
  assert.deepEqual(card.lines.filter(l => l.kind === 'remove' || l.kind === 'add'), [{ kind: 'remove', text: 'old' }, { kind: 'add', text: 'new' }])
  const complex = fileSemantics('file.edit', {}, { before: 'shared\n' + 'old\n'.repeat(1000), after: 'shared\n' + 'new\n'.repeat(1000) })
  assert.match(complex.summary, /无法精确统计/)
  assert.ok(complex.lines.every(l => l.kind === 'text' || l.kind === 'context'))
  assert.doesNotMatch(complex.summary, /\+\d|删除片段|新增片段/)
  const replacement = fileSemantics('file.edit', {}, { before: 'a\n'.repeat(80), after: 'b\n'.repeat(80) })
  assert.match(replacement.summary, /\+80\/-80/)
  assert.ok(replacement.lines.length <= 24)
  const longLine = fileSemantics('file.edit', {}, { before: 'x'.repeat(100_000), after: 'y'.repeat(100_000) })
  assert.match(longLine.summary, /\+1\/-1/)
  assert.deepEqual(longLine.lines.map(l => l.kind), ['remove', 'add'])
})

test('read receipts describe returned content without inventing whole-file emptiness', () => {
  const card = fileSemantics('file.read', { path: 'large', offset: 900, limit: 10 }, { path: 'large', content: '', offset: 900, limit: 10 })
  assert.doesNotMatch(card.summary, /空文件/)
  assert.match(card.summary, /本次读取内容为空/)
})

test('bounded aligned diff keeps both sides of a large replacement and late edits', () => {
  const before = Array.from({ length: 80 }, (_, i) => `old ${i}`).join('\n')
  const after = Array.from({ length: 80 }, (_, i) => `new ${i}`).join('\n')
  const card = fileSemantics('file.edit', {}, { before, after })
  assert.ok(card.lines.some(l => l.kind === 'remove'))
  assert.ok(card.lines.some(l => l.kind === 'add'), 'preview must not hide every added line')
  assert.match(card.summary, /截断|省略/)
  const prefix = 'unchanged\n'.repeat(100)
  const late = fileSemantics('file.edit', {}, { before: prefix + 'old', after: prefix + 'new' })
  assert.ok(late.lines.some(l => l.kind === 'remove' && l.text === 'old'))
  assert.ok(late.lines.some(l => l.kind === 'add' && l.text === 'new'))
})
