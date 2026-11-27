import { element, formatTime } from './runtime-api.js'
import { conversationStatus, conversationStatusTime } from './conversation-status.js'
import { explicitRequestMetadata, explicitStepsWithToolEvents, explicitToolActivityFinished } from './explicit-tool-activity.js'
import { sanitizeUserVisibleText } from './step-labels.js'
import { userFacingErrorReason } from './task-blocker.js'
import { disposeToolBody, renderToolBody } from './tool-presentation.js'

export function renderTurnProgressDetail(turn, { readOutput } = {}) {
  const content = element('div', undefined, 'stack progress-detail-body')
  const statusRows = turn.statusFacts && !turn.localStatus?.some(row => row.error)
    ? conversationStatus(turn.statusFacts, { allRequests: true })
    : turn.localStatus ?? []
  const list = element('ol', undefined, 'progress-step-list')
  for (const row of statusRows.filter(row => row.phase !== 'tool')) {
    const item = element('li', undefined, 'progress-step')
    item.dataset.phase = row.phase
    item.dataset.tone = row.tone
    item.dataset.running = String(row.running)
    item.append(element('span', row.label))
    const time = conversationStatusTime(row)
    if (time) item.append(element('span', time))
    if (row.statusLabel) item.append(element('span', row.statusLabel))
    if (row.error) {
      const reason = userFacingErrorReason(row.error)
      const message = reason || sanitizeUserVisibleText([row.error.code, row.error.message].filter(Boolean).join('：'))
      if (message) item.append(element('span', message))
    }
    if (row.startedAt) item.append(element('time', formatTime(row.startedAt)))
    list.append(item)
  }
  if (list.children.length) content.append(list)

  let toolBody
  const explicitSteps = turn.explicitSteps ?? turn.statusFacts?.steps
  const metadata = explicitRequestMetadata(explicitSteps)
  if (metadata) content.append(element('p', metadata.label, 'progress-request-metadata'))
  const toolEvents = [...(turn.toolEvents ?? []), ...explicitStepsWithToolEvents(explicitSteps, turn.interactionId)]
  if (toolEvents.length) {
    toolBody = element('div', undefined, 'tool-body')
    renderToolBody(toolBody, toolEvents, readOutput, { finished: explicitToolActivityFinished(turn) })
    content.append(toolBody)
  }
  if (!content.children.length) content.append(element('p', '尚无实际步骤。', 'empty'))
  return { content, dispose() { if (toolBody) disposeToolBody(toolBody) } }
}
