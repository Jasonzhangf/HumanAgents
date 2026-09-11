const nodeList = document.querySelector('[data-node-list]')
const scopeTitle = document.querySelector('[data-scope-title]')
const scopeSummary = document.querySelector('[data-scope-summary]')
const scopeSeq = document.querySelector('[data-scope-seq]')
const breadcrumbs = document.querySelector('[data-breadcrumbs]')
const backButton = document.querySelector('[data-action="back"]')
const feedback = document.querySelector('[data-feedback]')
const drawer = document.querySelector('[data-node-drawer]')
const drawerTitle = document.querySelector('[data-drawer-title]')
const drawerSummary = document.querySelector('[data-drawer-summary]')
const drawerKind = document.querySelector('[data-drawer-kind]')
const drawerStatus = document.querySelector('[data-drawer-status]')
const drawerOwner = document.querySelector('[data-drawer-owner]')
const drawerUpdated = document.querySelector('[data-drawer-updated]')
const drawerRefs = document.querySelector('[data-drawer-refs]')
const drawerEvidence = document.querySelector('[data-drawer-evidence]')
const enterScopeButton = document.querySelector('[data-action="enter-scope"]')

const scopes = {
  root: {
    title: '任务处理流水',
    summary: '从输入到任务结果的完整处理记录。',
    nodes: ['sensory.inbox', 'explicit.normalize', 'implicit.classify', 'task.correlate', 'resource.admission', 'pipeline.execute', 'task.output'],
  },
  'implicit.classify': {
    title: '分类和安排任务',
    summary: '根据输入内容选择处理方式和任务类别。',
    nodes: ['queue.interactive', 'queue.execution', 'queue.research', 'queue.maintenance'],
  },
  'queue.execution': {
    title: '任务处理队列',
    summary: '当前有一项任务等待条件检查。',
    nodes: ['requirement-184', 'requirement-183'],
  },
  'resource.admission': {
    title: '处理条件检查',
    summary: '确认权限、并发额度、依赖和可恢复性。',
    nodes: ['capability.check', 'resource.capacity', 'permission.check', 'continuity.check'],
  },
  'pipeline.execute': {
    title: '重建导出索引 · 处理记录',
    summary: '这项任务的完整处理记录，可以继续递归进入每个 operation。',
    nodes: ['checkpoint.recall', 'cycle.work', 'operation.index', 'checkpoint.completion'],
  },
}

const nodes = {
  'sensory.inbox': node('接收输入', 'sensory.inbox', 'succeeded', 'notification / human input 已接收。', '输入接收', 'root', 'sensory.inbox'),
  'explicit.normalize': node('整理任务输入', 'explicit.normalize', 'succeeded', '已去重、归并、标记来源，并形成待确认的任务内容。', '输入整理', 'root', 'explicit.normalize'),
  'implicit.classify': node('分类和安排任务', 'implicit.classify', 'running', '正在判断任务类型，并选择处理方式。', '任务安排', 'root', 'implicit.classify'),
  'task.correlate': node('关联或更新任务', 'task.correlate', 'waiting', '等待分类完成；不会直接覆盖已有任务状态。', '任务安排', 'root', 'task.correlate'),
  'resource.admission': node('检查处理条件', 'resource.admission', 'waiting', '等待任务关联结果后检查权限、依赖和可恢复性。', '条件检查', 'root', 'resource.admission'),
  'pipeline.execute': node('开始执行处理方案', 'pipeline.execute', 'waiting', '等待条件检查通过；资源不足时会进入带条件的 waiting。', '任务执行', 'root', 'pipeline.execute'),
  'task.output': node('交付任务输出', 'task.output', 'waiting', '等待任务产生可交付结果。', '任务输出', 'root', 'task.output'),
  'queue.interactive': node('需要补充信息', 'queue.interactive', 'succeeded', '当前没有等待用户补充信息的任务。', '任务安排', 'queue', 'queue.interactive'),
  'queue.execution': node('正在处理', 'queue.execution', 'running', '当前有 1 项任务等待条件检查。', '任务安排', 'queue', 'queue.execution'),
  'queue.research': node('等待调查', 'queue.research', 'succeeded', '当前没有等待外部核验的任务。', '任务安排', 'queue', 'queue.research'),
  'queue.maintenance': node('维护记录', 'queue.maintenance', 'running', '状态检查和保存点维护共享受限资源。', '任务安排', 'queue', 'queue.maintenance'),
  'requirement-184': node('重建导出索引', 'requirement-184', 'waiting', '当前任务等待条件检查；输入来自 requirement-184。', '任务处理队列', 'execution', 'requirement-184'),
  'requirement-183': node('整理周报证据', 'requirement-183', 'queued', '排在当前任务之后，等待条件满足。', '任务处理队列', 'execution', 'requirement-183'),
  'capability.check': node('能力检查', 'capability.check', 'waiting', '确认任务所需的基础能力可用。', '能力检查', 'admission', 'capability.check'),
  'resource.capacity': node('资源容量检查', 'resource.capacity', 'waiting', '检查并发、队列、存储和当前 operation 额度。', 'Admission', 'admission', 'resource.capacity'),
  'permission.check': node('权限边界检查', 'permission.check', 'waiting', '确认本 Task 被授权执行目标写入 operation。', 'Admission', 'admission', 'permission.check'),
  'continuity.check': node('可恢复性检查', 'continuity.check', 'waiting', '确认 checkpoint 和恢复状态可独立读取。', 'Admission', 'admission', 'continuity.check'),
  'checkpoint.recall': node('checkpoint recall', 'checkpoint.recall', 'queued', '从最新 checkpoint 装配有限 Working Window。', 'Runtime', 'pipeline', 'checkpoint.recall'),
  'cycle.work': node('执行一个 cycle', 'cycle.work', 'queued', '在输入、资源和 execution epoch 正确时执行。', 'Runtime', 'pipeline', 'cycle.work'),
  'operation.index': node('index.rebuild operation', 'operation.index', 'queued', '执行具体索引重建副作用并保留 evidence refs。', 'Operation', 'pipeline', 'operation.index'),
  'checkpoint.completion': node('checkpoint completion', 'checkpoint.completion', 'queued', '把结果收拢到可继续、可等待或可停止的状态。', 'Runtime', 'pipeline', 'checkpoint.completion'),
}

function node(title, kind, status, summary, owner, parentScope, childScope) {
  return { title, kind, status, summary, owner, parentScope, childScope, updated: '刚刚', refs: [`input:${kind}`, `output:${kind}`], evidence: `projection:${kind}\nsource: task journal / typed evidence\ncontrol: read-only` }
}

const statusText = { succeeded: '已完成', running: '处理中', waiting: '等待', queued: '排队中', degraded: '降级', failed: '失败', cancelled: '已取消', stale: '过期' }

let scopeStack = ['root']
let currentNode = null

function renderNode(nodeId, index) {
  const item = document.createElement('li')
  const button = document.createElement('button')
  const indexLabel = document.createElement('span')
  const copy = document.createElement('span')
  const title = document.createElement('strong')
  const kind = document.createElement('small')
  const status = document.createElement('span')

  button.className = 'pipeline-node'
  button.type = 'button'
  button.dataset.nodeId = nodeId
  indexLabel.className = 'node-index'
  indexLabel.textContent = String(index + 1).padStart(2, '0')
  copy.append(title, kind)
  title.textContent = nodes[nodeId].title
  kind.textContent = nodes[nodeId].kind
  status.className = `node-status node-status--${nodes[nodeId].status === 'running' ? 'active' : nodes[nodeId].status === 'succeeded' ? 'done' : 'waiting'}`
  status.textContent = statusText[nodes[nodeId].status]
  button.append(indexLabel, copy, status)
  button.addEventListener('click', () => openDrawer(nodeId))
  item.append(button)
  return item
}

function renderScope() {
  const scopeId = scopeStack[scopeStack.length - 1]
  const scope = scopes[scopeId]
  scopeTitle.textContent = scope.title
  scopeSummary.textContent = scope.summary
  scopeSeq.textContent = `projection seq ${184 + scopeStack.length - 1}`
  nodeList.replaceChildren(...scope.nodes.map(renderNode))
  backButton.disabled = scopeStack.length === 1

  breadcrumbs.replaceChildren()
  scopeStack.forEach((id, index) => {
    const link = document.createElement('a')
    link.href = `#${id}`
    link.textContent = scopes[id].title
    link.addEventListener('click', (event) => {
      event.preventDefault()
      scopeStack = scopeStack.slice(0, index + 1)
      renderScope()
      announce(`已返回：${scopes[id].title}。`)
    })
    breadcrumbs.append(link)
    if (index < scopeStack.length - 1) breadcrumbs.append(document.createTextNode(' / '))
  })
}

function openDrawer(nodeId) {
  currentNode = nodes[nodeId]
  drawerTitle.textContent = currentNode.title
  drawerSummary.textContent = currentNode.summary
  drawerKind.textContent = currentNode.kind
  drawerStatus.textContent = statusText[currentNode.status]
  drawerOwner.textContent = currentNode.owner
  drawerUpdated.textContent = currentNode.updated
  drawerRefs.replaceChildren(...currentNode.refs.map((ref) => {
    const item = document.createElement('li')
    item.textContent = ref
    return item
  }))
  drawerEvidence.textContent = currentNode.evidence
  enterScopeButton.hidden = !scopes[currentNode.childScope]
  drawer.showModal()
  announce(`已打开节点详情：${currentNode.title}。`)
}

function announce(message) {
  feedback.textContent = message
}

backButton.addEventListener('click', () => {
  if (scopeStack.length === 1) return
  scopeStack.pop()
  renderScope()
  announce('已返回上一级观测 scope。')
})

enterScopeButton.addEventListener('click', () => {
  if (!currentNode || !scopes[currentNode.childScope]) return
  scopeStack.push(currentNode.childScope)
  drawer.close()
  renderScope()
  announce(`已进入下一层：${scopes[currentNode.childScope].title}。`)
})

renderScope()
