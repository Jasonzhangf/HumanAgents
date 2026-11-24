import { element, formatTime } from './runtime-api.js'
import { conversationStatus, elapsedSeconds } from './conversation-status.js'
import { explicitToolActivityFinished, renderExplicitToolActivity } from './explicit-tool-activity.js'
import { sanitizeUserVisibleText } from './step-labels.js'
import { disposeToolBody, renderToolBody } from './tool-presentation.js'

export function renderTurnProgressDetail(turn, { readOutput } = {}) {
  const content = element('div', undefined, 'stack progress-detail-body')
  const statusRows = turn.localStatus ?? (turn.statusFacts ? conversationStatus(turn.statusFacts) : [])
  const list = element('ol', undefined, 'progress-step-list')
  for (const row of statusRows.filter(row => row.phase !== 'tool')) {
    const item = element('li', undefined, 'progress-step')
    item.dataset.phase = row.phase
    item.dataset.tone = row.tone
    item.dataset.running = String(row.running)
    item.append(element('span', row.label))
    const seconds = elapsedSeconds(row)
    if (seconds !== undefined) item.append(element('span', `${seconds} 秒`))
    if (row.statusLabel) item.append(element('span', row.statusLabel))
    if (row.error) {
      const message = sanitizeUserVisibleText([row.error.code, row.error.message].filter(Boolean).join('：'))
      item.append(element('span', message))
    }
    if (row.startedAt) item.append(element('time', formatTime(row.startedAt)))
    list.append(item)
  }
  if (list.children.length) content.append(list)

  const explicitHost = element('div', undefined, 'progress-explicit-tools')
  renderExplicitToolActivity(explicitHost, turn.explicitSteps ?? turn.statusFacts?.steps,
    explicitToolActivityFinished(turn))
  if (explicitHost.children.length) content.append(explicitHost)

  let toolBody
  if (turn.toolEvents?.length) {
    toolBody = element('div', undefined, 'tool-body')
    renderToolBody(toolBody, turn.toolEvents, readOutput)
    content.append(toolBody)
  }
  if (!content.children.length) content.append(element('p', '尚无实际步骤。', 'empty'))
  return { content, dispose() { if (toolBody) disposeToolBody(toolBody) } }
}
