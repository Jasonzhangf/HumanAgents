import {
  api,
  clearNode,
  element,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  stateTone,
  taskIdFromQuery,
} from './runtime-shell.js'

const taskId = taskIdFromQuery()
const { main, status } = makePageShell(
  'Task List',
  'Pipeline Observation',
  '任务观测',
  '只读查看节点树、输入输出和 evidence；操作必须回到 Task Dashboard 的正式 Runtime operation。',
)

let drawer
let lastTrigger

function buildDrawer() {
  drawer = element('dialog')
  drawer.setAttribute('aria-labelledby', 'drawer-title')
  const body = element('div', undefined, 'dialog-body')
  const head = element('header', undefined, 'dialog-head')
  const title = element('h2', '节点详情')
  title.id = 'drawer-title'
  const close = element('button', '关闭', 'button')
  close.type = 'button'
  close.addEventListener('click', () => drawer.close())
  head.append(title, close)
  body.append(head)
  drawer.append(body)
  drawer.addEventListener('close', () => lastTrigger?.focus())
  document.body.append(drawer)
}

function openNode(node, trigger) {
  lastTrigger = trigger
  clearNode(drawer.querySelector('.dialog-body'))
  const head = element('header', undefined, 'dialog-head')
  const titleWrap = element('div')
  titleWrap.append(element('p', '节点详情 · 只读', 'eyebrow'), element('h2', node.title))
  const close = element('button', '关闭', 'button')
  close.type = 'button'
  close.addEventListener('click', () => drawer.close())
  head.append(titleWrap, close)
  const body = drawer.querySelector('.dialog-body')
  body.append(head, element('p', node.summary))
  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['节点类型', node.kindDisplay],
    ['状态', node.stateDisplay],
    ['Owner', node.owner],
    ['输入引用', node.inputRefs.join(', ') || '无'],
    ['输出引用', node.outputRefs.join(', ') || '无'],
    ['Evidence', node.evidenceRefs.map((ref) => ref.locator).join(', ') || '无'],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
    facts.append(cell)
  }
  body.append(facts)
  if (node.childScopeRef) {
    const enter = element('button', '进入下一层观测', 'button')
    enter.type = 'button'
    enter.addEventListener('click', () => {
      drawer.close()
      void load(node.childScopeRef)
    })
    body.append(enter)
  }
  drawer.showModal()
}

function renderObservation(projection) {
  clearNode(main)
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', '只读 Observation', 'eyebrow'), element('h1', projection.title), element('p', projection.summary, 'lede'))
  heading.append(copy)
  main.append(heading)

  const breadcrumbs = element('nav', undefined, 'breadcrumbs')
  breadcrumbs.setAttribute('aria-label', '当前观测路径')
  projection.breadcrumbs.forEach((crumb, index) => {
    const button = element('button', crumb.title, 'segment')
    button.type = 'button'
    button.addEventListener('click', () => {
      void load(index === 0 ? undefined : `task://${taskId}/observation`)
    })
    breadcrumbs.append(button)
  })
  main.append(breadcrumbs)

  const panel = element('section', undefined, 'panel')
  if (projection.nodes.length === 0) {
    panel.append(element('p', '当前 scope 没有节点。', 'empty'))
  } else {
    const list = element('ol', undefined, 'node-list')
    projection.nodes.forEach((node, index) => {
      const item = element('li')
      const button = element('button', undefined, 'node-button')
      button.type = 'button'
      const copy = element('span', undefined, 'node-copy')
      copy.append(element('strong', node.title), element('small', `${node.kindDisplay} · ${node.owner}`), element('small', node.summary))
      button.append(element('span', String(index + 1).padStart(2, '0'), 'node-index'), copy)
      const chip = element('span', node.stateDisplay, 'state-chip')
      chip.dataset.tone = stateTone(node.state)
      button.append(chip)
      button.addEventListener('click', () => openNode(node, button))
      item.append(button)
      list.append(item)
    })
    panel.append(list)
  }
  main.append(panel)
}

async function load(scopeRef) {
  try {
    const projection = await api.observation(taskId, scopeRef)
    renderObservation(projection)
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

buildDrawer()
void (async () => {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  renderRuntimeStatus(status, runtimeStatus, error)
  await load()
})()
