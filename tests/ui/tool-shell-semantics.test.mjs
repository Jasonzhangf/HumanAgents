import test from 'node:test'
import assert from 'node:assert/strict'
import { shellSemantics } from '../../docs/ui/tool-shell-semantics.js'

// Goal: readable bash previews on the existing truth → semantic → present DAG.
// Risk: shell syntax or empty redirected stdout can fabricate search/write success.
// These cheap public-function checks use the production bash report shape. No execution.
const report = (stdout = '', extra = {}) => ({ exitCode: 0, signal: null, timedOut: false, aborted: false,
  stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false }, ...extra })
const card = (command, result) => shellSemantics('bash', { command }, result)
const text = (value) => JSON.stringify(value)

test('search shows actual hits; reading distinguishes whole file and excerpts', () => {
  const hits = card('rg -n TODO src', report('src/a.ts:12:TODO fix\n'))
  assert.match(hits.title, /搜索/)
  assert.equal(hits.subject, '在 src 搜索 TODO')
  assert.match(hits.summary, /搜索命中/)
  assert.equal(hits.lines[0].text, 'src/a.ts:12:TODO fix')
  assert.match(card('grep -n TODO src/a.ts', report('', { exitCode: 1 })).summary, /未找到匹配/)
  assert.match(card('rg TODO missing', report('', { exitCode: 2 })).summary, /退出码：2/)
  assert.match(card('cat README.md', report('hello')).title, /读取文件/)
  assert.match(card('head -n 20 README.md', report('hello')).title, /文件开头节选/)
  assert.match(card('tail -20 app.log', report('last')).title, /文件末尾节选/)
})

test('quoted metacharacters are literal, dynamic and compound syntax stay conservative', () => {
  for (const value of ['a|b', 'a>b', 'a;b', 'a&&b', '$(date)', '`date`']) {
    const view = card(`rg -n '${value}' 'src file'`, report('literal'))
    assert.match(view.title, /搜索/)
    assert.ok(view.subject.includes(value))
    assert.doesNotMatch(text(view), /管道|重定向/)
  }
  assert.match(card('cat "a|b.txt"').title, /读取文件/)
  const quoted = card('rg -n "a|b > c; d" "src file"', report('literal'))
  assert.match(quoted.title, /搜索/)
  assert.ok(quoted.subject.includes('a|b > c; d'))
  assert.doesNotMatch(text(quoted), /管道|重定向/)
  for (const command of ['rg "$PATTERN" src', 'cat $(find .)', 'cat `pwd`', 'cat *.txt', 'cat <(echo hi)', 'cat a; rm b', "cat 'unclosed"]) {
    assert.equal(card(command).title, '执行命令', command)
  }
})

test('pipeline and output redirection describe intent without verified writes or per-action success', () => {
  const view = card('rg -n TODO src | head -20 > todo.txt', report())
  assert.match(view.title, /搜索/)
  assert.equal(view.subject, '在 src 搜索 TODO → 取前 20 行 → 输出到 todo.txt')
  assert.match(view.summary, /管道整体.*退出码：0/)
  assert.match(view.summary, /重定向.*todo.txt.*未验证/)
  assert.doesNotMatch(text(view), /写入成功|已写入|未找到匹配|搜索命中/)
  assert.match(card('cat input > output', report()).summary, /未验证/)
  assert.match(card('rg TODO src | head -20', report()).summary, /各步骤/)
  // Observed red: the implementation labeled wc's count as file content.
  // Green requires only the actual pipeline stdout, with no upstream attribution.
  assert.doesNotMatch(card('cat input | wc -l', report('42')).summary, /文件内容节选/)
  assert.equal(card('cat input | wc -l', report('42')).lines[0].text, '42')
})

// Red observed before the fix: "-n TODO src" omitted head; "--files src"
// masqueraded as a subject; the oversized subject exceeded the preview bound.
// Impact: wrong action/result attribution. These public consumer checks are
// cheap and execute no shell; the truth → semantic → present DAG is unchanged.
test('static options describe search intent, lists, input and writes without argv stacking', () => {
  for (const [command, subject] of [
    ['rg --files src', '列出 src 的文件名'],
    ['rg --files -g "*.ts" src', '列出 src 的文件名（匹配 *.ts）'],
    ['rg -n -g "*.ts" TODO src', '在 src 搜索 TODO（文件匹配 *.ts）'],
    ['grep -n -e TODO src/a.ts', '在 src/a.ts 搜索 TODO'],
    ['grep -e "-literal | > &&" "src file"', '在 src file 搜索 -literal | > &&'],
    ['cat < input', '读取 input'],
    ['printf "%s\\n" "hello > world" > f', '格式化输出文本 → 输出到 f'],
    ['printf x >> f', '格式化输出文本 → 追加到 f'],
    ['git status && pnpm test', '查看工作区状态 → 成功后运行测试'],
    ['rg TODO src | head -n 20 >> f', '在 src 搜索 TODO → 取前 20 行 → 追加到 f'],
  ]) assert.equal(card(command, report()).subject, subject, command)
  assert.match(card('rg --files src', report('src/a.ts')).title, /文件名/)
  assert.doesNotMatch(card('rg --files src', report('src/a.ts')).summary, /搜索命中/)
  for (const command of ['rg --unknown value TODO src', 'grep -f patterns src', 'cat a || cat b', 'git status &&', 'cat a 2> err']) {
    assert.equal(card(command).title, '执行命令', command)
    assert.equal(card(command).subject, undefined, command)
  }
  const sequence = card('git status && pnpm test', report('actual only', { exitCode: 7 }))
  assert.match(sequence.summary, /整体.*退出码：7/)
  assert.match(sequence.summary, /各步骤/)
  assert.equal(sequence.lines[0].text, 'actual only')
  assert.doesNotMatch(text(sequence), /测试通过|状态检查成功/)
  assert.equal(shellSemantics('not-bash', { command: 'rg TODO src' }, report('x')).title, '执行工具')
  const written = card('printf "command text" >> f', report('actual stdout'))
  assert.equal(written.lines[0].text, 'actual stdout')
  assert.doesNotMatch(text(written), /command text|已写入|追加成功/)
})

test('all main-face parameters and both streams are bounded; stderr survives a full stdout', () => {
  const output = report('out\n'.repeat(1000), { exitCode: 2, stderr: { text: 'failure reason ' + 'e'.repeat(10000) + '\n' + 'err\n'.repeat(1000), truncated: false } })
  const before = JSON.stringify(output)
  const view = card(`rg '${'x'.repeat(20000)}' '${'p'.repeat(20000)}' > '${'f'.repeat(20000)}'`, output)
  assert.ok(view.subject.length <= 481)
  assert.ok(view.summary.length < 1000)
  assert.ok(view.lines.length <= 12)
  assert.ok(view.lines.every((line) => line.text.length <= 241))
  assert.ok(view.lines.some((line) => line.text.includes('failure reason')))
  assert.ok(view.lines.some((line) => line.text === 'out'))
  assert.equal(JSON.stringify(output), before)
})

test('classifies common list, git, build and test commands without treating arguments as commands', () => {
  for (const [command, title] of [['ls -la src', /列出/], ['find src -name "*.ts"', /列出/], ['git diff -- src/a.ts', /差异/], ['git status --short', /状态/], ['pnpm build', /构建/], ['npm run test', /测试/], ['node --test test.mjs', /测试/]]) {
    assert.match(card(command).title, title)
  }
  assert.equal(card('echo git diff').title, '输出文本')
  assert.equal(card('echo git diff').subject, '输出文本')
  assert.equal(shellSemantics('other', { command: 'cat a' }).title, '执行工具')
})

test('pending, missing, empty, failed and interrupted reports retain their real meaning', () => {
  assert.match(card('cat a').summary, /尚无结果正文/)
  assert.match(card('cat a', {}).summary, /退出码未提供/)
  assert.match(card('cat a', report()).summary, /输出为空/)
  const failed = card('cat a', report('partial', { exitCode: 7, stderr: { text: 'denied', truncated: false } }))
  assert.match(failed.summary, /退出码：7/)
  assert.ok(failed.lines.some((line) => line.text.includes('denied')))
  assert.match(card('cat a', report('', { exitCode: null, timedOut: true, aborted: true, signal: 'SIGTERM' })).summary, /超时.*取消.*SIGTERM/)
})

test('preview is bounded, literal, and leaves full report untouched', () => {
  const result = report('<img src=x onerror=bad>\n' + 'x'.repeat(10000) + '\nline\n'.repeat(100))
  const before = JSON.stringify(result)
  const view = card('cat a', result)
  assert.equal(view.lines[0].text, '<img src=x onerror=bad>')
  assert.ok(view.lines.length <= 12)
  assert.ok(view.lines.every((line) => line.text.length <= 241 && line.kind === 'text'))
  assert.match(view.summary, /预览已节选/)
  assert.equal(JSON.stringify(result), before)
  assert.match(card('head a', report('hi', { stdout: { text: 'hi', truncated: true } })).summary, /报告已截断/)
})
