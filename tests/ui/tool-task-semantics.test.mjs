import test from 'node:test'
import assert from 'node:assert/strict'
import { taskSemantics } from '../../docs/ui/tool-task-semantics.js'

// Scope/plan: explain production goal/todo/present/end calls and unknown tools;
// assert actions + returned facts, missing body, bounded previews and no mutation.
// Sources: provider-tool-execution.ts (schemas and execute* return reports),
// contracts/standard-turn-end.ts and ui-runtime/standard-turn-control.ts.
// Existing DAG: human-readable-ux-reading truth → semantic → purpose → necessary
// → present is closed; this pure mapper adds no control edge or task transition.
// Failure risk: unknown; impact: false completion or hidden result on tool cards.
// Cost: local node:test only; no model, browser, runtime or persistent resources.
// Progress: title-only mapper failed the semantic assertions; implementation
// passes the same checks, plus long-list missing-body/refusal regressions.
// Goal/todo/end fixtures follow production return statements; present below
// additionally covers a saved executor report from the original audit tree.
const text = (view) => [view.title, view.subject, view.summary, ...(view.lines ?? []).map((line) => line.text)].filter((x) => x !== undefined).join('\n')
const goal = { id: 'g1', revision: 2, objective: '整理用户需求', phase: 'active', roundsStarted: 0 }
const end = {
  outcome: 'continue',
  summary: { goal: '交付报告', actions: ['查阅资料', '生成报告'], result: { status: 'partial', text: '已生成初稿' }, nextStep: '补充结论' },
  deliveryRefs: ['asset:report'],
}

test('goal calls distinguish requested action from returned goal phase and absence', () => {
  assert.match(text(taskSemantics('create_goal', { objective: goal.objective })), /创建目标/)
  assert.match(text(taskSemantics('create_goal', { objective: goal.objective })), /尚无结果正文/)
  assert.match(text(taskSemantics('get_goal', {}, { goal: null })), /尚未设置目标/)
  assert.match(text(taskSemantics('get_goal', {}, { goal })), /整理用户需求/)
  assert.match(text(taskSemantics('get_goal', {}, { goal })), /目标进行中/)
  for (const [action, label, phase, state] of [
    ['edit', '修改目标', 'active', '目标进行中'],
    ['pause', '暂停目标', 'paused', '目标已暂停'],
    ['resume', '恢复目标', 'active', '目标进行中'],
    ['complete', '标记目标完成', 'complete', '目标已标记完成'],
    ['blocked', '记录目标阻塞', 'blocked', '目标受阻'],
  ]) {
    const view = taskSemantics('update_goal', { action }, { goal: { ...goal, phase, blockedReason: '缺少资料' } })
    assert.match(view.title, new RegExp(label))
    assert.ok(text(view).includes(state))
    assert.doesNotMatch(text(view), /任务已完成|任务已暂停/)
    if (phase === 'blocked') assert.match(text(view), /缺少资料/)
    else assert.doesNotMatch(text(view), /缺少资料/)
  }
  const refused = taskSemantics('create_goal', { objective: '新目标' }, { status: 'failed', code: 'tool.argument.invalid', message: 'active goal already exists', recoverable: true })
  assert.match(text(refused), /active goal already exists/)
  assert.doesNotMatch(text(refused), /已创建|目标进行中/)
})

test('todo preview uses returned complete list, labels item states and keeps empty distinct from missing', () => {
  const todos = [{ content: '收集资料', status: 'completed' }, { content: '撰写报告', status: 'in_progress' }, { content: '核对结论', status: 'pending' }]
  const view = taskSemantics('todo_write', { todos: [{ content: '旧清单', status: 'pending' }] }, { todos, counts: { pending: 1, inProgress: 1, completed: 1 } })
  assert.match(text(view), /已完成：收集资料/)
  assert.match(text(view), /进行中：撰写报告/)
  assert.match(text(view), /待处理：核对结论/)
  assert.doesNotMatch(text(view), /旧清单|任务已完成/)
  assert.match(text(taskSemantics('todo_write', { todos: [] }, { todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } })), /清单为空/)
  assert.match(text(taskSemantics('todo_write', { todos })), /尚无结果正文/)
})

test('present explains requested files and returned deliverables without claiming publication or task completion', () => {
  const files = [{ path: '报告.html', description: '分析结果' }]
  const args = { files }
  assert.match(text(taskSemantics('present', args)), /准备交付文件/)
  const report = { turn: 1, files, artifacts: [{ path: '报告.html', assetRef: 'asset:report', digest: 'existing-descriptor', size: 128 }] }
  const view = taskSemantics('present', args, report)
  assert.match(text(view), /报告.html/)
  assert.match(text(view), /分析结果/)
  assert.match(text(view), /128 字节/)
  assert.doesNotMatch(text(view), /任务已完成|已发布/)
  assert.match(text(taskSemantics('present', args, null)), /结果正文为空/)
})

test('recorded present report exposes the actual quote comparison description and file size', () => {
  // Original audit: 报价内容保真-最终验收2-20261122/control/sessions/*/
  // artifacts/ui-provider-evidence/provider-tools/tool-output/
  // provider-tool-output-provider-tool-ui-operation-2-call_8e694e7462a7438ab8bdf8b6-fd06b15c9214
  const files = [{ path: '报价对比结果.txt', description: '按用户执行期选定的“未税价”口径完成的甲乙报价比较结果：供应商甲最低，未税价100元，出处为 甲报价.txt 的“未税金额”字段' }]
  const view = taskSemantics('present', { files }, {
    turn: 2, files,
    artifacts: [{ path: '报价对比结果.txt', assetRef: 'asset://provider-tool/artifact/provider-tool-present-scheduled-task-665227213af5adf02045-call_8e694e7462a7438ab8bdf8b6-0', size: 519 }],
  })
  for (const value of ['报价对比结果.txt', '供应商甲最低', '未税价100元', '519 字节']) assert.ok(text(view).includes(value), value)
})

test('both standard end IDs show four-part semantic summary; acceptance is not task completion', () => {
  for (const toolId of ['humanagent.turn.end', 'humanagent_turn_end']) {
    const view = taskSemantics(toolId, end, { owner: 'humanagent.app.standard-turn-control', kind: 'standard-turn-end', turnId: 'turn-1', accepted: true })
    for (const value of ['交付报告', '查阅资料', '生成报告', '已生成初稿', '补充结论', '继续执行', '部分完成', '结束请求已接受']) assert.ok(text(view).includes(value), value)
    assert.doesNotMatch(text(view), /任务已完成/)
    assert.match(text(taskSemantics(toolId, { ...end, outcome: 'completed' })), /请求结束本轮/)
    const refused = taskSemantics(toolId, end, { kind: 'standard-turn-end', turnId: 'turn-1', accepted: false, error: { code: 'bad-ref', message: '引用不可用' } })
    assert.match(text(refused), /结束请求未被接受/)
    assert.match(text(refused), /引用不可用/)
    assert.doesNotMatch(text(refused), /结束请求已接受/)
  }
})

test('end preview keeps input question, impact and options visible even with many actions', () => {
  const view = taskSemantics('humanagent_turn_end', {
    ...end, outcome: 'input-required',
    summary: { ...end.summary, actions: Array.from({ length: 50 }, (_, i) => `动作${i}`) },
    inputRequest: { question: '选择哪个版本？', reason: '版本尚未指定', impact: '无法继续导出', options: ['简版', '完整版'] },
  }, { accepted: true })
  for (const value of ['需要用户输入', '选择哪个版本？', '无法继续导出', '简版', '完整版', '已生成初稿']) assert.ok(text(view).includes(value), value)
  assert.match(text(view), /结束请求已接受/)
})

test('long pending lists keep missing-body notice and refused ends keep the actual error', () => {
  const todos = Array.from({ length: 40 }, (_, i) => ({ content: `行动${i}`, status: 'pending' }))
  assert.match(text(taskSemantics('todo_write', { todos })), /尚无结果正文/)
  const view = taskSemantics('humanagent_turn_end', {
    ...end, outcome: 'input-required', inputRequest: { question: '哪版？', reason: '未指定', impact: '无法导出', options: ['简版', '完整版'] },
  }, { accepted: false, error: { code: 'invalid', message: '不可用的交付引用' } })
  assert.match(text(view), /不可用的交付引用/)
  assert.match(text(view), /未被接受/)
})

test('unknown tools preserve useful arguments and raw results conservatively, including falsey bodies', () => {
  const args = { query: '<img src=x onerror=alert(1)>', stage: 'plan' }
  assert.match(text(taskSemantics('new.tool', args)), /new.tool/)
  assert.match(text(taskSemantics('new.tool', args)), /尚无结果正文/)
  for (const report of [null, '', false, 0, [], {}, { status: 'succeeded', message: '工具结果' }, 'literal result']) {
    const view = taskSemantics('new.tool', args, report)
    assert.doesNotMatch(text(view), /尚无结果正文|任务已完成/)
    assert.ok(text(view).includes(args.query))
  }
  assert.match(text(taskSemantics('new.tool', args, { message: '工具结果' })), /工具结果/)
})

test('all previews are bounded plain data and do not mutate production inputs', () => {
  const args = Object.freeze({ objective: '<script>原文</script>' })
  const report = Object.freeze({ goal: Object.freeze({ ...goal, objective: args.objective }) })
  assert.ok(text(taskSemantics('get_goal', args, report)).includes(args.objective))
  const huge = 'x'.repeat(10000)
  for (const view of [
    taskSemantics(huge, { query: huge }, huge),
    taskSemantics('todo_write', {}, { todos: Array.from({ length: 500 }, () => ({ content: huge, status: 'pending' })) }),
    taskSemantics('humanagent_turn_end', { ...end, summary: { ...end.summary, result: { status: 'partial', text: huge } } }),
  ]) {
    assert.equal(typeof view.title, 'string')
    assert.ok(view.title.length <= 240)
    assert.ok((view.subject?.length ?? 0) <= 240)
    assert.ok((view.summary?.length ?? 0) <= 240)
    assert.ok(view.lines.length <= 8)
    assert.ok(view.lines.every((line) => ['text', 'add', 'remove', 'context'].includes(line.kind) && typeof line.text === 'string' && line.text.length <= 240))
  }
})
