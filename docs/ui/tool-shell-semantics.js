// Static description only: never execute or expand shell input.
// Returned strings are literal text for textContent. Dynamic syntax is marked
// unsafe so the card can name the known operation without inventing arguments.
function lex(command) {
  const items = []
  let word = '', active = false, quote = '', unsafe = false, incomplete = false
  const flush = () => {
    if (!active) return
    items.push(unsafe ? { word, unsafe: true } : { word })
    word = ''
    active = false
    unsafe = false
  }
  const append = (text, isUnsafe = false) => {
    word += text
    active = true
    if (isUnsafe) unsafe = true
  }
  const balanced = (start, open, close) => {
    let depth = 0
    for (let i = start; i < command.length; i++) {
      const ch = command[i]
      append(ch, true)
      if (ch === open) depth++
      else if (ch === close && --depth === 0) return i + 1
    }
    incomplete = true
    return command.length
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = ''
      else append(ch)
      continue
    }
    if (quote === '"') {
      if (ch === '"') { quote = ''; continue }
      if (ch === '\\') {
        const next = command[++i]
        if (next === undefined) { incomplete = true; break }
        append(next)
        continue
      }
      if (ch === '$' || ch === '`') {
        if (ch === '$' && command[i + 1] === '(') {
          append('$(', true)
          i = balanced(i + 1, '(', ')') - 1
        } else if (ch === '$' && command[i + 1] === '{') {
          append('${', true)
          i = balanced(i + 1, '{', '}') - 1
        } else {
          append(ch, true)
        }
        continue
      }
      append(ch)
      continue
    }
    if (ch === '\\') {
      const next = command[++i]
      if (next === undefined || next === '\n') { incomplete = next === undefined; continue }
      append(next)
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue }
    if (ch === '$') {
      if (command[i + 1] === '(') {
        append('$(', true)
        i = balanced(i + 1, '(', ')') - 1
      } else if (command[i + 1] === '{') {
        append('${', true)
        i = balanced(i + 1, '{', '}') - 1
      } else {
        let end = i + 1
        while (/[A-Za-z0-9_]/.test(command[end] ?? '')) end++
        append(command.slice(i, Math.max(end, i + 1)), true)
        i = end - 1
      }
      continue
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1)
      if (end < 0) {
        append(command.slice(i + 1), true)
        incomplete = true
        break
      }
      append(command.slice(i, end + 1), true)
      i = end
      continue
    }
    if (ch === ';') { flush(); items.push({ op: ';' }); continue }
    if (ch === '\n' || ch === '\r') { flush(); items.push({ op: ';' }); continue }
    if (ch === '&') {
      if (command[i + 1] === '&') { flush(); items.push({ op: '&&' }); i++ }
      else { flush(); items.push({ op: '&' }) }
      continue
    }
    if ('(){}[]*?~#'.includes(ch)) { append(ch, true); continue }
    if (/\s/.test(ch)) { flush(); continue }
    if (ch === '|' || ch === '<' || ch === '>') {
      if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
        append(ch, true)
        i = balanced(i + 1, '(', ')') - 1
        continue
      }
      let fd
      if ((ch === '<' || ch === '>') && active && /^\d+$/.test(word)) {
        fd = word
        word = ''
        active = false
        unsafe = false
      }
      flush()
      let op = ch
      if (command[i + 1] === ch) { op += ch; i++ }
      if (op === '<<' || op === '<>') { items.push({ op: '?' }); continue }
      items.push(fd ? { op, fd } : { op })
      continue
    }
    append(ch)
  }
  if (quote) incomplete = true
  flush()
  return { items, incomplete }
}

const bounded = (value, limit = 160) => value.length > limit ? value.slice(0, limit) + '…' : value
const targets = (values, fallback) => values.length ? values.map((value) => bounded(value)).join('、') : fallback

function genericAction(name) {
  const label = name.length ? name : '未知'
  const known = {
    rg: ['搜索文件内容', '搜索文件内容（参数无法完整解析）'],
    grep: ['搜索文件内容', '搜索文件内容（参数无法完整解析）'],
    cat: ['读取文件', '读取文件（参数无法完整解析）'],
    head: ['读取文件开头节选', '读取文件开头节选（参数无法完整解析）'],
    tail: ['读取文件末尾节选', '读取文件末尾节选（参数无法完整解析）'],
    ls: ['列出文件与目录', '列出文件与目录（参数无法完整解析）'],
    find: ['列出文件与目录', '查找文件（参数无法完整解析）'],
    pwd: ['显示当前工作目录', '显示当前工作目录'],
    cd: ['切换工作目录', '切换工作目录（目标无法完整解析）'],
    echo: ['输出文本', '输出文本（内容无法完整解析）'],
    printf: ['输出文本', '格式化输出文本（参数无法完整解析）'],
    git: ['执行 Git 命令', '执行 Git 命令（参数无法完整解析）'],
    rm: ['删除文件', '删除文件（目标无法完整解析）'],
  }[name]
  return known
    ? { title: known[0], subject: known[1], generic: true }
    : { title: '执行命令', subject: '执行 ' + bounded(label) + ' 命令（参数无法完整解析）', generic: true }
}

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
      if (!(/^-[niwFxsHo]+$/.test(arg) || ['--line-number', '--ignore-case', '--fixed-strings', '--word-regexp'].includes(arg) || (name === 'rg' && ['-S', '--smart-case', '--hidden', '--no-heading'].includes(arg)) || (name === 'grep' && /^-[Eh]+$/.test(arg)))) return undefined
    } else positional.push(arg)
  }
  if (files) {
    if (patterns.length) return undefined
    return { title: '列出文件名', type: 'list', subject: '列出 ' + targets(positional, '当前目录') + ' 的文件名' + (globs.length ? '（匹配 ' + targets(globs) + '）' : '') }
  }
  if (!patterns.length && positional.length) patterns.push(positional.shift())
  if (!patterns.length) return undefined
  return { title: '搜索文件内容', type: 'search', subject: '在 ' + targets(positional, '标准输入') + ' 搜索 ' + targets(patterns) + (globs.length ? '（文件匹配 ' + targets(globs) + '）' : '') }
}

function action(words, input) {
  const [name, ...args] = words
  if (name === 'rg' || name === 'grep') return search(name, args)
  if (name === 'cat') {
    if (args.some((arg) => arg.startsWith('-'))) return undefined
    return { title: '读取文件', type: 'read', subject: '读取 ' + targets(args.length ? args : input ? [input] : [], '标准输入') }
  }
  if (name === 'head' || name === 'tail') {
    let count = '10', rest = args
    if (args[0] === '-n' && /^\d+$/.test(args[1] ?? '')) { count = args[1]; rest = args.slice(2) }
    else if (/^-\d+$/.test(args[0] ?? '')) { count = args[0].slice(1); rest = args.slice(1) }
    if (rest.some((arg) => arg.startsWith('-'))) return undefined
    return { title: name === 'head' ? '读取文件开头节选' : '读取文件末尾节选', type: 'read', subject: (rest.length ? '从 ' + targets(rest) + ' ' : '') + '取' + (name === 'head' ? '前' : '后') + ' ' + bounded(count) + ' 行' }
  }
  if (name === 'printf' || name === 'echo') return { title: '输出文本', subject: name === 'printf' ? '格式化输出文本' : '输出文本' }
  if (name === 'pwd') return { title: '显示当前工作目录', subject: '显示当前工作目录' }
  if (name === 'cd') return { title: '切换工作目录', subject: args.length ? '切换到 ' + targets(args) : '切换工作目录' }
  if (name === 'ls') {
    const names = args.filter((arg) => !arg.startsWith('-'))
    return { title: '列出文件与目录', subject: names.length ? '列出 ' + targets(names) : '列出文件与目录' }
  }
  if (name === 'find') {
    if (args.some((arg) => ['-exec', '-execdir', '-delete', '-ok', '-okdir'].includes(arg))) return undefined
    const root = args.find((arg) => !arg.startsWith('-'))
    return { title: '列出文件与目录', subject: '在 ' + (root ? bounded(root) : '当前目录') + ' 查找文件' }
  }
  if (name === 'git' && args[0] === 'diff') return { title: '查看代码差异', subject: '查看代码差异' }
  if (name === 'git' && args[0] === 'status') return { title: '查看工作区状态', subject: '查看工作区状态' }
  if (name === 'git' && args[0] === 'log') return { title: '查看提交历史', subject: '查看提交历史' }
  if (name === 'rm') {
    const names = args.filter((arg) => !arg.startsWith('-'))
    if (!names.length) return undefined
    return { title: '删除文件', subject: '删除 ' + targets(names) }
  }
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(name) && /^(?:run )?(?:test|test:[\w:-]+)(?: |$)/.test(args.join(' '))) || (name === 'node' && args[0] === '--test') || ['pytest', 'vitest', 'jest'].includes(name) || (name === 'cargo' && args[0] === 'test')) return { title: '运行测试', subject: '运行测试' }
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(name) && /^(?:run )?build(?::[\w:-]+)?(?: |$)/.test(args.join(' '))) || ['make', 'cmake', 'tsc'].includes(name) || (name === 'cargo' && args[0] === 'build')) return { title: '构建项目', subject: '构建项目' }
  return { title: '执行命令', subject: '执行 ' + bounded(name) + ' 命令' }
}

function describe(command) {
  const parsed = lex(command)
  if (!parsed.items.length) return { title: '执行命令' }
  const stages = [{ words: [], redirects: [] }]
  let pipeline = false, sequence = false, unexpanded = parsed.incomplete
  for (let i = 0; i < parsed.items.length; i++) {
    const token = parsed.items[i]
    const stage = stages.at(-1)
    if (['|', '&&', '||', ';', '&'].includes(token.op)) {
      if (!stage.words.length) {
        if (i === parsed.items.length - 1) { unexpanded = true; continue }
        return { ...genericAction(parsed.items.find((item) => item.word)?.word ?? ''), sequence: true, unexpanded: true }
      }
      if (token.op === '|') pipeline = true
      else sequence = true
      stages.push({ words: [], redirects: [], connector: token.op })
      continue
    }
    if (token.op) {
      const target = parsed.items[++i]
      if (!target?.word || token.op === '?') { unexpanded = true; continue }
      if (token.op === '<') { stage.input = target.word; continue }
      if (target.word === '/dev/null') continue
      if (target.unsafe) { unexpanded = true; continue }
      stage.redirects.push({ target: target.word, append: token.op === '>>', fd: token.fd })
      continue
    }
    // Stop at grammar this reader does not interpret. Do not turn loop bodies,
    // assignment values or a substituted executable into a list of actions.
    // This is a presentation boundary, not shell validation or execution policy.
    if (!stage.words.length && (token.unsafe
      || /^(?:for|while|until|if|then|else|elif|fi|do|done|case|esac|select|function|export)$/.test(token.word)
      || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token.word))) {
      return { title: '执行脚本', subject: '复合脚本，具体步骤见调用参数与证据', compound: true, sequence: true, unexpanded: true }
    }
    stage.words.push(token)
  }
  if (!stages.at(-1).words.length) {
    if (stages.length === 1) return { ...genericAction(parsed.items.find((item) => item.word)?.word ?? ''), sequence, unexpanded: true }
    stages.pop()
    unexpanded = true
  }
  const actions = stages.map((stage) => {
    if (!stage.words.length) { unexpanded = true; return undefined }
    const unsafe = stage.words.some((word) => word.unsafe)
    const words = stage.words.map((word) => word.word)
    return unsafe ? genericAction(words[0]) : action(words, stage.input) ?? genericAction(words[0])
  })
  if (!actions[0]) return { ...genericAction(''), sequence, unexpanded }
  const parts = []
  for (let i = 0; i < stages.length; i++) {
    if (!actions[i]) continue
    const connector = stages[i].connector === '&&' ? '成功后' : stages[i].connector === '||' ? '失败后' : ''
    parts.push(connector + actions[i].subject)
    for (const redirect of stages[i].redirects) {
      if (redirect.fd === '2') parts.push('标准错误重定向到 ' + bounded(redirect.target))
      else parts.push((redirect.append ? '追加到 ' : '输出到 ') + bounded(redirect.target))
    }
  }
  if (unexpanded) {
    const text = parts.join(' → ')
    if (!/未展开|无法完整解析/.test(text)) parts.push('后续参数或命令未展开')
  }
  return {
    ...actions[0],
    subject: bounded(parts.join(' → '), 480),
    pipeline,
    sequence,
    redirects: stages.flatMap((stage) => stage.redirects),
    unexpanded,
  }
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
    summary.push((info.sequence ? '命令序列整体' : info.pipeline ? '管道整体' : '命令') + (exit === undefined ? '退出码未提供' : '退出码：' + exit))
    if (report?.timedOut === true) summary.push('已超时')
    if (report?.aborted === true) summary.push('已取消')
    if (typeof report?.signal === 'string') summary.push('信号：' + bounded(report.signal))
  }
  if (report !== undefined && (info.pipeline || info.sequence)) summary.push('各步骤结果不能由整体退出码确认')
  if (report !== undefined && info.unexpanded) summary.push('部分参数或命令未能静态解析')
  if (report !== undefined && info.redirects?.length) {
    const writable = info.redirects.filter((value) => value.fd !== '2')
    const stderr = info.redirects.filter((value) => value.fd === '2')
    if (writable.length) summary.push('输出重定向至 ' + writable.map((value) => bounded(value.target)).join('、') + '（写入结果未验证）')
    if (stderr.length) summary.push('标准错误重定向至 ' + stderr.map((value) => bounded(value.target)).join('、') + '（写入结果未验证）')
  }

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
  const budget = stdout && stderr ? 6 : 12
  for (const [label, value] of [['', stdout], ['标准错误：', stderr]]) {
    if (!value) continue
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
  const workSummary = typeof args?.description === 'string' && args.description.trim() !== ''
    ? bounded(args.description.trim(), 240)
    : undefined
  const workdir = typeof args?.workdir === 'string' && args.workdir.trim() !== ''
    ? bounded(args.workdir.trim(), 240)
    : undefined
  return {
    title: info.compound && workSummary ? workSummary : info.title,
    ...(info.subject ? { subject: info.subject } : {}),
    ...(workSummary && !info.compound ? { workSummary } : {}),
    ...(workdir ? { workdir } : {}),
    summary: summary.join('；'),
    lines,
  }
}
