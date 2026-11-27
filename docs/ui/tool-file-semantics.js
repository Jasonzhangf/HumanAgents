// Report-only presentation. No execution state, I/O, HTML or argument mutation.
// Protocol owners: app/provider-tool-execution.ts, operations/file-read-route.ts,
// contracts/hand-services.ts and contracts/web-search.ts.
const TITLES = { 'file.read': '读取文件', 'file.write': '写入文件', 'file.edit': '编辑文件', 'file.list': '列出文件', 'file.search': '搜索文件', 'web.search': '搜索网页' }
const MAX_LINES = 24
const MAX_TEXT = 400
const DIFF_CHARS = 64 * 1024
const DIFF_LINES = 400
const DIFF_CELLS = 40_000
const string = value => typeof value === 'string' ? value : undefined
const bounded = value => value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value
const line = (kind, text) => ({ kind, text })

// Take only a bounded prefix, even for a very large single line or report.
function textLines(text, kind) {
  return text.slice(0, DIFF_CHARS).split('\n', MAX_LINES + 1).map(text => line(kind, text))
}

function preview(card, lines, omitted = false) {
  const truncated = omitted || lines.length > MAX_LINES || lines.some(l => l.text.length > MAX_TEXT)
  return {
    ...card,
    ...(card.subject !== undefined ? { subject: bounded(card.subject) } : {}),
    ...(truncated ? { summary: `${card.summary}；预览已截断，省略内容见完整报告` } : {}),
    lines: lines.slice(0, MAX_LINES).map(l => line(l.kind, bounded(l.text))),
  }
}

function tokens(text) {
  // Retain newline identity so a change at EOF is not silently lost.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function diff(before, after) {
  // Linear trimming precedes every budget check. Only the differing middle
  // needs quadratic alignment; large common regions do not consume its budget.
  const fullA = tokens(before)
  const fullB = tokens(after)
  let start = 0
  let endA = fullA.length
  let endB = fullB.length
  while (start < endA && start < endB && fullA[start] === fullB[start]) start++
  while (endA > start && endB > start && fullA[endA - 1] === fullB[endB - 1]) { endA--; endB-- }
  const a = fullA.slice(start, endA)
  const b = fullB.slice(start, endB)
  const excerpts = () => ({
    lines: [line('context', '修改前片段（未对齐）'), ...textLines(before, 'text').slice(0, 10), line('context', '修改后片段（未对齐）'), ...textLines(after, 'text').slice(0, 10)],
    omitted: true, note: '超过差异计算预览上限，无法精确统计改行；以下仅为修改前/后片段',
  })
  // Pure insertions/deletions need no alignment and always have exact counts.
  const oneSided = a.length === 0 || b.length === 0
  // One differing line on each side is exactly +1/-1, regardless of its size.
  const singleLine = a.length === 1 && b.length === 1
  if (!oneSided && !singleLine && (a.reduce((n, s) => n + s.length, 0) + b.reduce((n, s) => n + s.length, 0) > DIFF_CHARS || a.length > DIFF_LINES || b.length > DIFF_LINES || a.length * b.length > DIFF_CELLS)) return excerpts()
  if (oneSided) return {
    lines: [...a.slice(0, MAX_LINES + 1).map(s => line('remove', s.replace(/\n$/, ''))), ...b.slice(0, MAX_LINES + 1).map(s => line('add', s.replace(/\n$/, '')))],
    omitted: a.length + b.length > MAX_LINES || start > 0 || endA < fullA.length,
    added: b.length, removed: a.length,
  }
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? 1 + table[(i + 1) * width + j + 1]
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const changes = fullA.slice(Math.max(0, start - 2), start).map(s => line('context', s.replace(/\n$/, '')))
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changes.push(line('context', a[i++].replace(/\n$/, '')))
      j++
    } else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      changes.push(line('remove', a[i++].replace(/\n$/, '')))
    } else {
      changes.push(line('add', b[j++].replace(/\n$/, '')))
    }
  }
  changes.push(...fullA.slice(endA, endA + 2).map(s => line('context', s.replace(/\n$/, ''))))
  const added = changes.filter(l => l.kind === 'add').length
  const removed = changes.filter(l => l.kind === 'remove').length
  // Keep context near changes, so a long unchanged prefix cannot hide edits.
  const visible = new Set()
  changes.forEach((change, index) => {
    if (change.kind === 'context') return
    for (let n = Math.max(0, index - 2); n <= Math.min(changes.length - 1, index + 2); n++) visible.add(n)
  })
  let lines = changes.filter((_, index) => visible.has(index))
  const omitted = lines.length > MAX_LINES || visible.size < changes.length || start > 2 || fullA.length - endA > 2
  if (lines.length > MAX_LINES && lines.some(l => l.kind === 'add') && lines.some(l => l.kind === 'remove')) {
    // Reserve space for both sides; a long deletion must not hide all additions.
    const counts = { add: 0, remove: 0, context: 0 }
    lines = lines.filter(l => ++counts[l.kind] <= (l.kind === 'context' ? 2 : 10))
  }
  return { lines, omitted, added, removed }
}

/** Pure semantic plugin. All strings are literal text for a textContent consumer. */
export function fileSemantics(toolId, args = {}, report) {
  const search = toolId === 'file.search' || toolId === 'web.search'
  const query = string(report?.query) ?? string(args?.query) ?? '（关键词未提供）'
  const domains = report?.domains ?? args?.domains
  const recency = report?.recency ?? args?.recency ?? 'any'
  const time = { day: '最近一天', week: '最近一周', month: '最近一月', year: '最近一年', any: '时间不限' }[recency] ?? `时间限制：${recency}`
  const subject = search
    ? toolId === 'file.search'
      ? `在 ${string(report?.path) ?? string(args?.path) ?? '（路径未提供）'} 搜索 ${query}`
      : `在${Array.isArray(domains) && domains.length ? ` ${domains.join('、')} ` : '公开网络'}搜索 ${query}；${time}`
    : string(report?.path) ?? string(toolId === 'file.write' || toolId === 'file.edit' ? args?.file_path : args?.path)
  const card = { title: TITLES[toolId] ?? '工具结果', ...(subject !== undefined ? { subject } : {}) }
  const finish = (summary, lines = [], omitted = false) => preview({ ...card, summary }, lines, omitted)
  if (report === undefined) return finish('等待结果正文')
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return finish('结果正文未提供可解析字段')

  if (toolId === 'file.read') {
    if (typeof report.content !== 'string') return finish('文件内容未提供')
    if (report.content === '') return finish('本次读取内容为空')
    return finish('已读取文件内容')
  }
  if (toolId === 'file.write' || toolId === 'file.edit') {
    const { before, after } = report
    if (typeof after !== 'string' || (typeof before !== 'string' && !(toolId === 'file.write' && before === null))) {
      return finish('修改前后内容未提供，无法展示差异')
    }
    if (before === null) {
      const added = textLines(after, 'add')
      // Remove only the EOF split token, never a real blank line in a prefix.
      if (after.length <= DIFF_CHARS && added.length <= MAX_LINES && after.endsWith('\n')) added.pop()
      return finish(`${after === '' ? '已新建空文件' : '已新建文件'}；+${tokens(after).length}/-0`, after === '' ? [] : added, after.length > DIFF_CHARS)
    }
    if (before === after) return finish('文件内容未变化；+0/-0')
    const result = diff(before, after)
    const newline = before.endsWith('\n') !== after.endsWith('\n') ? '；文件末尾换行已变化' : ''
    return finish(`${toolId === 'file.write' ? '已覆盖文件' : '已编辑文件'}${result.added !== undefined ? `；+${result.added}/-${result.removed}` : ''}${newline}${result.note ? `；${result.note}` : ''}`, result.lines, result.omitted)
  }
  if (toolId === 'file.list') {
    if (!Array.isArray(report.entries)) return finish('文件列表未提供')
    const incomplete = report.unresolvedPaths?.length > 0
    const summary = report.entries.length ? `返回 ${report.entries.length} 个文件` : incomplete || report.truncated ? '当前返回列表为空' : '未找到文件'
    return finish(`${summary}${incomplete ? '；目录读取未完成' : ''}${report.truncated ? '；文件列表已截断' : ''}`,
      report.entries.slice(0, MAX_LINES + 1).map(entry => line('text', string(entry?.path) ?? '（路径未提供）')),
      report.entries.length > MAX_LINES)
  }
  if (search) {
    const web = toolId === 'web.search'
    const items = report[web ? 'results' : 'matches']
    if (!Array.isArray(items)) return finish('搜索结果未提供')
    const incomplete = report.searchComplete === false || (web ? report.unresolvedSources?.length : report.unresolvedPaths?.length) > 0
    const count = report[web ? 'resultsFound' : 'matchesFound']
    const summary = report.status === 'failed'
      ? `搜索失败：${bounded(string(report.failure?.message) ?? '原因未提供')}`
      : items.length === 0 ? (incomplete || report.resultsTruncated ? '当前返回结果为空' : '无命中')
        : `返回 ${items.length} 项${Number.isSafeInteger(count) ? `，共 ${count} 项命中` : '命中'}`
    const lines = []
    let consumed = 0
    for (const item of items) {
      if (lines.length >= MAX_LINES) break
      consumed++
      if (web) {
        lines.push(line('text', string(item?.title) ?? '（标题未提供）'), line('text', string(item?.url) ?? '（网址未提供）'))
        if (typeof item?.sourceName === 'string') lines.push(line('context', `来源：${item.sourceName}`))
        lines.push(line('text', item?.snippet === '' ? '（摘要为空）' : string(item?.snippet) ?? '（摘要未提供）'))
      } else {
        lines.push(line('text', `${string(item?.path) ?? '（路径未提供）'}:${item?.line ?? '?'}:${item?.column ?? '?'}`))
        for (const text of (item?.contextBefore ?? []).slice(0, MAX_LINES)) lines.push(line('context', text))
        lines.push(line('text', item?.text === '' ? '（命中行为空）' : string(item?.text) ?? '（命中内容未提供）'))
        for (const text of (item?.contextAfter ?? []).slice(0, MAX_LINES)) lines.push(line('context', text))
      }
    }
    return finish(`${summary}${incomplete ? '；搜索未完成' : ''}${report.resultsTruncated ? '；搜索结果已截断' : ''}`, lines, consumed < items.length)
  }
  return finish('此工具暂无语义预览')
}
