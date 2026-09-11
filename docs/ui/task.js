const root = document.querySelector('.task-wireframe')
const inputForm = document.querySelector('[data-brain-input-form]')
const input = document.querySelector('#brain-input')
const feedback = document.querySelector('[data-action-feedback]')
const taskStatus = document.querySelector('[data-task-status]')
const lifecycle = document.querySelector('[data-task-lifecycle]')
const overallProgress = document.querySelector('[data-overall-progress]')
const interactionState = document.querySelector('[data-interaction-state]')
const currentLabel = document.querySelector('[data-current-node-label]')
const currentSummary = document.querySelector('[data-current-node-summary]')
const currentTaskFocus = document.querySelector('[data-current-task-focus]')
const currentBackend = document.querySelector('[data-current-node-backend]')
const actionFocus = document.querySelector('[data-action-focus]')
const nextLabel = document.querySelector('[data-next-node-label]')
const nextSummary = document.querySelector('[data-next-node-summary]')
const brainFeedback = document.querySelector('[data-brain-feedback]')
const dialog = document.querySelector('[data-dialog="node-detail"]')
const drawerPath = document.querySelector('[data-drawer-path]')
const drawerFocus = document.querySelector('[data-drawer-focus]')
const drawerCurrent = document.querySelector('[data-drawer-current]')
const drawerLocation = document.querySelector('[data-drawer-location]')
const drawerPast = document.querySelector('[data-drawer-past]')
const drawerNext = document.querySelector('[data-drawer-next]')
const drawerUser = document.querySelector('[data-drawer-user]')
const detailBody = document.querySelector('[data-node-details]')

const flow = [
  ['input.received', '收到输入', '已完成'],
  ['task.match', '匹配任务', '已完成'],
  ['status.lookup', '查询状态', '已完成'],
  ['intent.query', '询问意图', '当前'],
  ['explicit.brain.feedback', '反馈整理', '待确认'],
  ['user.confirm', '用户确认', '待确认'],
  ['requirement.dispatch', '需求派发', '未启动'],
  ['subconscious.queue', '后台队列', '未启动'],
  ['resource.admission', '资源准入', '未启动'],
  ['execution.pipeline', '执行流水线', '未启动'],
]

const nodeDetails = {
  'input.received': ['收到输入', '已完成', 'source: human-input:08', 'projection:normalized-input:08', 'evidence:input-receipt:08', '输入整理', '收到“先整理证据，再决定是否发布周报”。'],
  'task.match': ['找到相关任务', '已完成', 'projection:normalized-input:08', 'match:weekly-report:input-08', 'evidence:match:08', '任务匹配', '当前任务“整理周报证据”是最匹配项，另外保留两个参考任务。'],
  'status.lookup': ['完成状态调查', '已完成', 'task:weekly-report', 'projection:weekly-report:status-19', 'evidence:status-snapshot:19', '状态调查', '当前任务 waiting，cycle-19 可恢复；文件和结果保存能力受限。'],
  'intent.query': ['确认处理方式', '等待用户', 'human-input:08', 'draft:intent:08', 'evidence:interaction:08', '处理方式确认', '等待用户选择按建议执行、调整目标、另建任务、只查看或自定义。'],
  'explicit.brain.feedback': ['提出建议', '待确认', 'draft:intent:08', 'projection:brain-feedback:08', 'evidence:decision:08', '建议反馈', '建议沿用当前任务，补齐证据并保持不发布。'],
  'user.confirm': ['用户确认', '待确认', 'projection:brain-feedback:08', '尚未确认', 'evidence:confirmation:pending', '人类 · confirmation gate', '需要用户确认整理结果和处理意图。'],
  'requirement.dispatch': ['开始处理', '未启动', 'draft:intent:08', '尚未开始', '选择后继续', '任务处理', '选择处理方式后开始执行建议方案。'],
  'subconscious.queue': ['安排后台处理', '未启动', '待处理方式确认', '尚未安排', '选择后继续', '后台安排', '把已确认的处理内容交给后台继续。'],
  'resource.admission': ['检查处理条件', '未启动', '待后台安排', '尚未检查', '开始处理后检查', '条件检查', '检查权限、依赖和保存空间是否满足。'],
  'execution.pipeline': ['执行处理方案', '未启动', '待条件检查', '尚未开始', '条件满足后开始', '任务执行', '条件满足后继续执行处理方案。'],
  'task.output': ['任务输出', '部分结果可用', 'task:weekly-report', 'artifact:weekly-evidence-draft', 'evidence:output:19', 'runtime · output projection', '周报证据草稿可审阅，发布范围仍未确认。'],
  history: ['连续历史', '可追溯', 'cycle-19 / prior outputs', 'journal:weekly-report', 'evidence:history:19', 'Journal projection', '按时间保留输入、checkpoint 和输出节点。'],
}

let lastTrigger = null

function announce(message) {
  feedback.textContent = message
}

function selectedIntent() {
  return document.querySelector('input[name="intent"]:checked')?.value || 'append'
}

function renderPath(nodeId) {
  drawerPath.innerHTML = flow.map(([id, label, status]) => `<li><button type="button" data-drawer-node="${id}" class="${id === nodeId ? 'is-focus' : ''}" ${id === nodeId ? 'aria-current="step"' : ''}><strong>${label}</strong><small>${status}</small></button></li>`).join('')
}

function updateDrawer(nodeId) {
  const detail = nodeDetails[nodeId] || nodeDetails['intent.query']
  renderPath(nodeId)
  drawerFocus.textContent = detail[0]
  drawerCurrent.textContent = `整理周报证据 · ${detail[1]}`
  drawerLocation.textContent = `${detail[0]}。${detail[6]}`
  drawerPast.textContent = nodeId === 'input.received' ? '这是这条输入的起点，尚无更早记录。' : '已收到输入、找到相关任务，并完成状态调查。'
  drawerNext.textContent = nodeId === 'execution.pipeline' ? '当前正在执行处理方案；后续状态会在任务详情中更新。' : '当前记录完成后继续下一项处理；如果需要你选择，会回到任务页面。'
  drawerUser.textContent = nodeId === 'user.confirm' || nodeId === 'intent.query' ? '选择按建议执行、调整目标、另建任务、只查看或自定义。' : '当前不需要你执行额外操作；如需查看依据，可继续查看任务观测。'
  const labels = ['状态', '输入引用', '输出引用', '证据', '负责者']
  detailBody.innerHTML = labels.map((label, index) => `<div><dt>${label}</dt><dd>${detail[index + 1]}</dd></div>`).join('')
}

function openDrawer(nodeId, trigger) {
  lastTrigger = trigger || document.querySelector(`[data-node-trigger="${nodeId}"]`)
  updateDrawer(nodeId)
  dialog.showModal()
  requestAnimationFrame(() => dialog.querySelector(`[data-drawer-node="${nodeId}"]`)?.focus())
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-node-trigger]')
  if (trigger) openDrawer(trigger.dataset.nodeTrigger, trigger)

  const pathNode = event.target.closest('[data-drawer-node]')
  if (pathNode) {
    const nodeId = pathNode.dataset.drawerNode
    updateDrawer(nodeId)
    requestAnimationFrame(() => dialog.querySelector(`[data-drawer-node="${nodeId}"]`)?.focus())
  }
})

document.querySelector('[data-action="open-history"]').addEventListener('click', (event) => openDrawer('history', event.currentTarget))

dialog.addEventListener('close', () => {
  lastTrigger?.focus()
})

inputForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = input.value.trim()
  if (!value) {
    announce('请先输入你希望处理的内容。')
    input.focus()
    return
  }
  root.dataset.taskState = 'intent'
  lifecycle.textContent = '等待确认'
  taskStatus.textContent = '等待你的意图确认'
  interactionState.textContent = '需要你选择意图'
  overallProgress.textContent = '等待你的选择'
  currentLabel.textContent = '正在确认怎么处理'
  currentSummary.textContent = '输入已经重新整理，相关任务和当前状态也已查清。现在需要你选择是否按建议继续。'
  currentTaskFocus.textContent = '整理周报证据 · 等待确认'
  currentBackend.textContent = '尚未开始处理'
  announce('输入已经重新整理。请确认接下来怎么处理。')
})

const feedbackText = {
  append: '建议沿用当前的“整理周报证据”任务，补齐证据并保持不发布。',
  change: '你选择调整当前任务的目标；已有调查结果和历史记录会保留。',
  new: '你选择另建一项任务；当前任务只作为参考，不会被覆盖。',
  status: '你选择只查看当前状态，不继续处理这项任务。',
  custom: '请按你填写的内容处理；如果内容改变目标或范围，会再次请你确认。',
}

for (const radio of document.querySelectorAll('input[name="intent"]')) {
  radio.addEventListener('change', () => {
    brainFeedback.textContent = feedbackText[selectedIntent()]
  })
}

document.querySelector('[data-action="edit-understanding"]').addEventListener('click', () => {
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  announce('请修改输入或处理方式。修改后需要重新整理，任务仍未开始处理。')
})

document.querySelector('[data-action="confirm-dispatch"]').addEventListener('click', () => {
  const intent = selectedIntent()
  if (intent === 'status') {
    root.dataset.taskState = 'waiting'
    taskStatus.textContent = '已记录状态查询'
    interactionState.textContent = '不继续处理'
    lifecycle.textContent = '已记录状态'
    overallProgress.textContent = '状态已反馈'
    currentLabel.textContent = '状态已反馈'
    currentSummary.textContent = '当前状态已经反馈给你。按你的选择，这项任务不会继续处理。'
    currentBackend.textContent = '本次不继续处理'
    actionFocus.textContent = '整理周报证据 · 已记录状态'
    nextLabel.textContent = '等待新的输入'
    nextSummary.textContent = '如果你之后想继续处理，可以补充新的输入；当前结果不会自动改变任务。'
    announce('已记录状态。按你的选择，这项任务不会继续处理。')
    return
  }
  root.dataset.taskState = 'dispatched'
  taskStatus.textContent = '已确认 · 正在处理'
  interactionState.textContent = '已确认并开始处理'
    lifecycle.textContent = '处理中'
  overallProgress.textContent = '已开始处理'
  currentLabel.textContent = '正在执行处理方案'
  currentSummary.textContent = '已经按你的选择开始处理。没有额外批准要求的步骤会直接继续，结果会在任务状态中更新。'
  currentTaskFocus.textContent = '整理周报证据 · 处理中'
  actionFocus.textContent = '整理周报证据 · 处理中'
  currentBackend.textContent = '正在处理'
  nextLabel.textContent = '等待处理结果'
  nextSummary.textContent = '任务完成后会在这里显示结果；如果遇到需要你决定的事项，任务会重新出现在待处理事项中。'
  brainFeedback.textContent = '已经按你的选择开始处理。后续状态、结果和需要你决定的事项会从任务详情中更新。'
  announce('已确认，任务开始处理。')
})
