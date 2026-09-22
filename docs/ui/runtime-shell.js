import {
  clearNode,
  createRuntimeApi,
  element,
  formatTime,
  queryParam,
  stateTone,
} from './runtime-api.js'

export const api = createRuntimeApi()

export async function loadRuntimeStatus() {
  try {
    const status = await api.status()
    return { status, error: null }
  } catch (error) {
    return { status: null, error }
  }
}

export function renderRuntimeStatus(target, status, error) {
  clearNode(target)
  if (error) {
    target.dataset.tone = 'danger'
    target.append(
      element('strong', 'Runtime 未连接'),
      element('span', ` ${error.message} · ${error.ownerId} · ${error.nextAction}`),
    )
    return
  }
  target.dataset.tone = status.state === 'ready' ? 'success' : 'warning'
  const provider = status.providerError
    ? ` · ${status.providerError.code} · owner=${status.providerError.ownerId} · ${status.providerError.nextAction}`
    : ''
  const implicit = status.implicitScheduling
    ? ` · requirement=${status.implicitScheduling.requirementId} · ${status.implicitScheduling.code} · owner=${status.implicitScheduling.ownerId} · next=${status.implicitScheduling.nextAction}`
    : ''
  if (status.implicitScheduling) target.dataset.tone = status.implicitScheduling.state === 'failed' ? 'danger' : 'warning'
  target.append(
    element('strong', `mode=${status.mode}`),
    element('span', ` · provider=${status.providerState} · ${status.connected ? 'connected' : 'disconnected'}${provider}${implicit}`),
  )
}

export function makeTopbar(active) {
  const header = element('header', undefined, 'topbar')
  const brand = element('a', 'HumanAgent', 'brand')
  brand.href = './dashboard.html'
  const nav = element('nav', undefined, 'topnav')
  nav.setAttribute('aria-label', '主导航')
  const links = [
    ['dashboard.html', 'Dashboard'],
    ['tasks.html', 'Task List'],
    ['task.html?task=new', '新建 Task'],
    ['memory.html', 'Memory'],
  ]
  for (const [href, label] of links) {
    const link = element('a', label)
    link.href = href
    if (label === active) link.setAttribute('aria-current', 'page')
    nav.append(link)
  }
  header.append(brand, nav)
  return header
}

export function makePageShell(active, eyebrow, title, lede) {
  document.body.replaceChildren()
  const header = makeTopbar(active)
  const main = element('main', undefined, 'page')
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', eyebrow, 'eyebrow'), element('h1', title))
  if (lede) copy.append(element('p', lede, 'lede'))
  const status = element('div', undefined, 'status-banner')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.textContent = '正在连接 Runtime API…'
  heading.append(copy, status)
  main.append(heading)
  document.body.append(header, main)
  return { main, status }
}

export function showError(target, error) {
  clearNode(target)
  target.dataset.tone = 'danger'
  target.append(
    element('strong', error.code || 'request.failed'),
    element('p', `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`),
  )
}

export function taskIdFromQuery(required = true) {
  const taskId = queryParam('task')
  if (!taskId && required) throw new Error('URL 缺少 task 参数')
  return taskId
}

export function observationHref(taskId) {
  return `./observation.html?task=${encodeURIComponent(taskId)}`
}

export function taskDashboardHref(taskId) {
  return `./task-dashboard.html?task=${encodeURIComponent(taskId)}`
}

export function taskDetailHref(taskId) {
  return `./task.html?task=${encodeURIComponent(taskId)}`
}

export { clearNode, element, formatTime, queryParam, stateTone }
