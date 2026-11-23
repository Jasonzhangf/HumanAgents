// Static description only: never execute or expand shell input. Unknown syntax
// keeps the generic title. Returned strings are literal text for textContent.
function tokens(command) {
  const result = []
  let word = '', active = false, quote = ''
  const flush = () => { if (active) result.push({ word }); word = ''; active = false }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = ''
      else word += ch
      continue
    }
    if (ch === '\\') {
      const next = command[++i]
      if (next === undefined || next === '\n') return undefined
      // In double quotes Bash only removes backslash before these characters.
      word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next
      active = true
      continue
    }
    if (ch === '$' || ch === '`') return undefined
    if (quote === '"') {
      if (ch === '"') quote = ''
      else word += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue }
    if (ch === '&' && command[i + 1] === '&') {
      flush(); result.push({ op: '&&' }); i++; continue
    }
    if (';&(){}[]*?~#\n\r'.includes(ch)) return undefined
    if (/\s/.test(ch)) { flush(); continue }
    if ('|<>'.includes(ch)) {
      // File-descriptor redirections need a different grammar; do not present
      // their descriptor as a filename or an argument.
      if (ch !== '|' && active && /^\d+$/.test(word)) return undefined
      flush()
      let op = ch
      if (command[i + 1] === ch) { op += ch; i++ }
      if (!['|', '<', '>', '>>'].includes(op)) return undefined
      result.push({ op })
      continue
    }
    word += ch; active = true
  }
  if (quote) return undefined
  flush()
  return result
}

const bounded = (value, limit = 160) => value.length > limit ? value.slice(0, limit) + '…' : value
const targets = (values, fallback) => values.length ? values.map((value) => bounded(value)).join('、') : fallback

function search(name, args) {
  const positional = [], patterns = [], globs = []
  let literal = false, files = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (literal) { positional.push(arg); continue }
    if (arg === '--') { literal = true; continue }
    if (name === 'rg' && arg === '--files') { files = true; continue }
    if (arg === '-e' || arg === '--regexp' || (name === 'rg' && ['-g', '--glob', '--iglob'].includes(arg))) {
      if (args[i + 1] === undefined) return undefined
      const values = arg === '-e' || arg === '--regexp' ? patterns : globs
      values.push(args[++i])
    } else if (arg.startsWith('--regexp=')) patterns.push(arg.slice(9))
    else if (name === 'rg' && /^(?:--glob=|--iglob=|-g.)/.test(arg)) globs.push(arg.replace(/^(?:--i?glob=|-g)/, ''))
    else if (arg.startsWith('-')) {
      // Only flags with known, non-consuming search semantics are skipped.
      if (!(/^-[niwFxsHo]+$/.test(arg) || ['--line-number', '--ignore-case', '--fixed-strings', '--word-regexp'].includes(arg) || (name === 'rg' && ['-S', '--smart-case', '--hidden', '--no-heading'].includes(arg)) || (name === 'grep' && /^-[Eh]+$/.test(arg)))) return undefined
    } else positional.push(arg)
  }
  if (files) {
    if (patterns.length) return undefined
    return { title: '列出文件名', type: 'list', subject: `列出 ${targets(positional, '当前目录')} 的文件名${globs.length ? `（匹配 ${targets(globs)}）` : ''}` }
  }
  if (!patterns.length && positional.length) patterns.push(positional.shift())
  if (!patterns.length) return undefined
  return { title: '搜索文件内容', type: 'search', subject: `在 ${targets(positional, '标准输入')} 搜索 ${targets(patterns)}${globs.length ? `（文件匹配 ${targets(globs)}）` : ''}` }
}

function action(words, input) {
  const [name, ...args] = words
  if (name === 'rg' || name === 'grep') return search(name, args)
  if (name === 'cat') {
    if (args.some((arg) => arg.startsWith('-'))) return undefined
    return { title: '读取文件', type: 'read', subject: `读取 ${targets(args.length ? args : input ? [input] : [], '标准输入')}` }
  }
  if (name === 'head' || name === 'tail') {
    let count = '10', rest = args
    if (args[0] === '-n' && /^\d+$/.test(args[1] ?? '')) { count = args[1]; rest = args.slice(2) }
    else if (/^-\d+$/.test(args[0] ?? '')) { count = args[0].slice(1); rest = args.slice(1) }
    if (rest.some((arg) => arg.startsWith('-'))) return undefined
    return { title: name === 'head' ? '读取文件开头节选' : '读取文件末尾节选', type: 'read', subject: `${rest.length ? `从 ${targets(rest)} ` : ''}取${name === 'head' ? '前' : '后'} ${bounded(count)} 行` }
  }
  if (name === 'printf' || name === 'echo') return { title: '输出文本', subject: name === 'printf' ? '格式化输出文本' : '输出文本' }
  if (['ls', 'find', 'pwd'].includes(name)) {
    if (name === 'find' && args.some((arg) => ['-exec', '-execdir', '-delete', '-ok', '-okdir'].includes(arg))) return undefined
    return { title: '列出文件与目录', subject: '列出文件与目录' }
  }
  if (name === 'git' && args[0] === 'diff') return { title: '查看代码差异', subject: '查看代码差异' }
  if (name === 'git' && args[0] === 'status') return { title: '查看工作区状态', subject: '查看工作区状态' }
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(name) && /^(?:run )?(?:test|test:[\w:-]+)(?: |$)/.test(args.join(' '))) || (name === 'node' && args[0] === '--test') || ['pytest', 'vitest', 'jest'].includes(name) || (name === 'cargo' && args[0] === 'test')) return { title: '运行测试', subject: '运行测试' }
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(name) && /^(?:run )?build(?::[\w:-]+)?(?: |$)/.test(args.join(' '))) || ['make', 'cmake', 'tsc'].includes(name) || (name === 'cargo' && args[0] === 'build')) return { title: '构建项目', subject: '构建项目' }
  // A static unknown stage can be named without inventing its argument meaning.
  return { title: '执行命令', subject: `执行 ${bounded(name)} 命令` }
}

function describe(command) {
  const parsed = tokens(command)
  if (!parsed?.length) return { title: '执行命令' }
  const stages = [{ words: [], redirects: [] }]
  let pipeline = false, sequence = false
  for (let i = 0; i < parsed.length; i++) {
    const token = parsed[i]
    const stage = stages.at(-1)
    if (token.op === '|' || token.op === '&&') {
      if (!stage.words.length) return { title: '执行命令' }
      pipeline ||= token.op === '|'
      sequence ||= token.op === '&&'
      stages.push({ words: [], redirects: [], connector: token.op })
    } else if (token.op) {
      const target = parsed[++i]?.word
      if (target === undefined) return { title: '执行命令' }
      if (token.op === '<') stage.input = target
      else stage.redirects.push({ target, append: token.op === '>>' })
    } else stage.words.push(token.word)
  }
  if (!stages.at(-1).words.length) return { title: '执行命令' }
  const actions = stages.map((stage) => action(stage.words, stage.input))
  if (actions.some((value) => !value)) return { title: '执行命令' }
  const parts = []
  for (let i = 0; i < stages.length; i++) {
    parts.push(`${stages[i].connector === '&&' ? '成功后' : ''}${actions[i].subject}`)
    for (const redirect of stages[i].redirects) parts.push(`${redirect.append ? '追加到' : '输出到'} ${bounded(redirect.target)}`)
  }
  return { ...actions[0], subject: bounded(parts.join(' → '), 480), pipeline, sequence, redirects: stages.flatMap((stage) => stage.redirects) }
}

/** Pure bash presentation plugin; the complete report belongs in folded details. */
export function shellSemantics(toolId, args, report) {
  if (toolId !== 'bash') return { title: '执行工具' }
  const info = describe(typeof args?.command === 'string' ? args.command : '')
  const summary = []
  const exit = Number.isInteger(report?.exitCode) ? report.exitCode : undefined
  const interrupted = report?.timedOut === true || report?.aborted === true || typeof report?.signal === 'string'
  if (report === undefined) summary.push('尚无结果正文')
  else {
    summary.push(`${info.sequence ? '命令序列整体' : info.pipeline ? '管道整体' : '命令'}${exit === undefined ? '退出码未提供' : `退出码：${exit}`}`)
    if (report?.timedOut === true) summary.push('已超时')
    if (report?.aborted === true) summary.push('已取消')
    if (typeof report?.signal === 'string') summary.push(`信号：${bounded(report.signal)}`)
  }
  if (info.pipeline || info.sequence) summary.push('各步骤结果不能由整体退出码确认')
  if (info.redirects?.length) summary.push(`输出重定向至 ${bounded(info.redirects.map((value) => bounded(value.target)).join('、'))}（写入结果未验证）`)

  const stdout = typeof report?.stdout?.text === 'string' ? report.stdout.text : undefined
  const stderr = typeof report?.stderr?.text === 'string' ? report.stderr.text : undefined
  const truncated = report?.stdout?.truncated === true || report?.stderr?.truncated === true
  if (truncated) summary.push('报告已截断')
  if (report !== undefined) {
    if (info.type === 'search' && !info.pipeline && !info.sequence && !info.redirects?.length && !interrupted) {
      if (exit === 0 && stdout) summary.push('搜索命中节选')
      else if (exit === 1 && stdout === '' && stderr === '' && !truncated) summary.push('未找到匹配')
    } else if (info.type === 'read' && !info.pipeline && !info.sequence && stdout) summary.push('文件内容节选')
    if (stdout === '' && stderr === '') summary.push('输出为空')
    else if (stdout === undefined || stderr === undefined) summary.push('部分输出流未提供')
  }

  const lines = []
  let shortened = false
  // Reserve space for each supplied stream. Long stdout must not hide stderr.
  const budget = stdout && stderr ? 6 : 12
  for (const [label, value] of [['', stdout], ['标准错误：', stderr]]) {
    if (!value) continue
    // Bound allocation as well as the returned preview; preserve original report.
    const prefix = value.slice(0, 4096)
    const rows = prefix.split(/\r?\n/)
    if (rows.at(-1) === '') rows.pop()
    if (prefix.length < value.length) shortened = true
    for (const [index, row] of rows.entries()) {
      if (index === budget) { shortened = true; break }
      const text = label + row
      if (text.length > 240) shortened = true
      lines.push({ kind: 'text', text: text.length > 240 ? text.slice(0, 240) + '…' : text })
    }
  }
  if (shortened) summary.push('预览已节选，完整报告见折叠详情')
  return { title: info.title, ...(info.subject ? { subject: info.subject } : {}), summary: summary.join('；'), lines }
}
