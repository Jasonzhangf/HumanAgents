// Production schemas/reports: app/provider-tool-execution.ts and
// app/ui-runtime/standard-turn-control.ts. This is a read-only explanation,
// never a task-state projection. Consumers must render these strings as textContent.
const LIMIT = 240
const MAX_LINES = 8
const clip = (text) => text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const string = (value) => typeof value === 'string' ? value : undefined
const raw = (value) => typeof value === 'string' ? (value === '' ? '（空字符串）' : value) : JSON.stringify(value)
const ownLabel = (labels, value, fallback) => Object.hasOwn(labels, value) ? labels[value] : fallback
const GOAL_PHASE = { active: '目标进行中', paused: '目标已暂停', complete: '目标已标记完成', blocked: '目标受阻' }
const GOAL_ACTION = { edit: '修改目标', pause: '暂停目标', resume: '恢复目标', complete: '标记目标完成', blocked: '记录目标阻塞' }
const TODO_STATE = { pending: '待处理', in_progress: '进行中', completed: '已完成' }
const END_OUTCOME = { completed: '请求结束本轮', continue: '继续执行', blocked: '本轮报告受阻', 'input-required': '需要用户输入' }
const RESULT_STATE = { completed: '完成', partial: '部分完成', blocked: '受阻' }

/** Pure plugin: report === undefined means no body has been read yet.
 * Lines are a bounded main-card preview; the caller retains the full report.
 * @returns {{title:string,subject?:string,summary?:string,lines:Array<{kind:'text'|'add'|'remove'|'context',text:string}>}}
 */
export function taskSemantics(toolId, args, report) {
  const input = record(args)
  const body = record(report)
  const lines = []
  const add = (text, kind = 'text') => { if (typeof text === 'string' && text !== '') lines.push({ kind, text: clip(text) }) }
  const field = (label, value) => { if (typeof value === 'string' && value !== '') add(`${label}：${value}`) }
  const preview = (label, value) => {
    if (value !== undefined) add(`${label}：${raw(value)}`)
  }
  let title = `调用工具：${typeof toolId === 'string' ? toolId : '未知工具'}`
  let subject
  let summary
  let explained = false

  if (toolId === 'child.call') {
    const review = input.kind === 'review' || body.kind === 'review'
    title = review ? '请求审查' : '委派执行'
    const purpose = string(input.purpose)
    if (purpose) subject = clip(purpose)
    field('接收方', input.agentId)
    if (body.state === 'returned') {
      summary = review ? '审查结果已返回' : '执行结果已返回'
      field('结果', body.summary)
      if (Number.isSafeInteger(body.findings)) add(`发现 ${body.findings} 项`)
      field('受阻原因', body.reason)
      explained = true
    }
  } else if (toolId === 'child.adopt' || toolId === 'child.not_select') {
    title = toolId === 'child.adopt' ? '采纳返回结果' : '记录不采纳决定'
    if (toolId === 'child.adopt' && body.state === 'adopted') {
      summary = '已采纳返回结果'
      explained = true
    } else if (toolId === 'child.not_select' && body.state === 'not-selected') {
      summary = '已记录不采纳决定'
      explained = true
    }
  } else if (toolId === 'humanagent_child_deliver') {
    title = '提交委派结果'
    field('提交内容', input.body)
    if (body.state === 'delivered') {
      summary = '执行方的交付已记录'
      explained = true
    }
  } else if (['get_goal', 'create_goal', 'update_goal'].includes(toolId)) {
    title = toolId === 'get_goal' ? '读取目标' : toolId === 'create_goal' ? '创建目标' : ownLabel(GOAL_ACTION, input.action, '更新目标')
    const goal = record(body.goal)
    subject = string(goal.objective) ?? string(input.objective)
    if (body.goal === null) {
      summary = '尚未设置目标'
      explained = true
    } else if (Object.hasOwn(body, 'goal') && body.goal !== null && typeof body.goal === 'object' && !Array.isArray(body.goal)) {
      summary = ownLabel(GOAL_PHASE, goal.phase, '目标阶段未提供或无法识别')
      // A resumed goal can still carry an old blockedReason in the report.
      if (goal.phase === 'blocked') field('阻塞原因', goal.blockedReason)
      explained = true
    }
    if (toolId === 'update_goal' && subject === undefined) field('目标引用', input.goal_id)
  } else if (toolId === 'todo_write') {
    title = '更新行动清单'
    const todos = Array.isArray(body.todos) ? body.todos : report === undefined && Array.isArray(input.todos) ? input.todos : undefined
    if (todos !== undefined) {
      summary = report === undefined ? '拟替换当前行动清单' : todos.length === 0 ? '返回的行动清单为空' : '已返回更新后的行动清单'
      // The returned complete list, rather than the request, owns result text.
      for (const item of todos.slice(0, MAX_LINES + 1)) {
        const todo = record(item)
        if (typeof todo.content === 'string') add(`${ownLabel(TODO_STATE, todo.status, '状态未知')}：${todo.content}`)
      }
      if (todos.length > MAX_LINES) add('更多行动见完整报告')
      explained = report !== undefined
    }
  } else if (toolId === 'present') {
    title = report === undefined ? '准备交付文件' : '读取文件交付结果'
    const files = Array.isArray(body.files) ? body.files : report === undefined && Array.isArray(input.files) ? input.files : undefined
    if (files !== undefined) {
      if (report !== undefined) summary = '已返回文件交付清单'
      for (const item of files.slice(0, MAX_LINES + 1)) {
        const file = record(item)
        const artifact = Array.isArray(body.artifacts) ? body.artifacts.find((entry) => record(entry).path === file.path) : undefined
        if (typeof file.path === 'string') add(`${file.path}${typeof file.description === 'string' ? ` · ${file.description}` : ''}${typeof artifact?.size === 'number' ? ` · ${artifact.size} 字节` : ''}`)
      }
      explained = report !== undefined
    }
  } else if (toolId === 'humanagent.turn.end' || toolId === 'humanagent_turn_end') {
    title = '提交本轮结果与后续安排'
    const turnSummary = record(input.summary)
    const result = record(turnSummary.result)
    const request = record(input.inputRequest)
    subject = string(turnSummary.goal)
    summary = string(result.text)
    add(`${ownLabel(END_OUTCOME, input.outcome, '本轮结束意图未知')} · 汇报结果：${ownLabel(RESULT_STATE, result.status, '状态未知')}`)
    field('下一步', turnSummary.nextStep)
    // Questions and blockers precede potentially long action/asset lists.
    if (input.outcome === 'input-required') {
      field('待回答', request.question)
      field('原因', request.reason)
      field('影响', request.impact)
      if (Array.isArray(request.options)) add(`选项：${request.options.filter((item) => typeof item === 'string').join('；')}`)
    }
    if (body.accepted === true) {
      lines.unshift({ kind: 'text', text: '本轮结束请求已接受；任务结果由后续结算确定' })
      explained = true
    } else if (body.accepted === false) {
      lines.unshift({ kind: 'text', text: '本轮结束请求未被接受' })
      explained = true
    }
    if (body.error !== undefined) lines.unshift({ kind: 'text', text: clip(`拒绝原因：${raw(body.error)}`) })
    if (Array.isArray(turnSummary.actions)) add(`本轮动作：${turnSummary.actions.filter((item) => typeof item === 'string').join('；')}`)
    if (Array.isArray(input.deliveryRefs) && input.deliveryRefs.length) add(`交付材料：${input.deliveryRefs.filter((item) => typeof item === 'string').join('；')}`)
  } else {
    preview('调用参数', args)
  }

  // Failure bodies are tool evidence, never user-task lifecycle decisions.
  if (body.status === 'failed') {
    summary = '工具报告失败'
    field('错误代码', body.code)
    field('原因', body.message)
    if (body.error !== undefined) preview('错误', body.error)
    explained = true
  }
  if (report === undefined) lines.unshift({ kind: 'context', text: '尚无结果正文' })
  else if (report === null) add('结果正文为空（null）', 'context')
  else if (!explained) preview('工具返回', report)

  // Preserve an explicit omission marker instead of silently dropping rows.
  const bounded = lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES - 1), { kind: 'context', text: '更多内容见完整报告' }]
    : lines
  return {
    title: clip(title),
    ...(subject === undefined ? {} : { subject: clip(subject) }),
    ...(summary === undefined ? {} : { summary: clip(summary) }),
    lines: bounded,
  }
}
