import { api, element } from './runtime-shell.js'
import { renderToolBody, disposeToolBody } from './tool-presentation.js'
import { mainTopicActorLabel } from './main-topic.js'
import { explicitToolActivityFinished, renderExplicitToolActivity } from './explicit-tool-activity.js'
import { conversationStatus, elapsedSeconds } from './conversation-status.js'

// Membership and ordering come only from the owner's round references.
export function renderMainTopicHistoryDetail(round, turns, { readOutput = api.readToolOutput } = {}) {
  const content = element('div', undefined, 'stack mt-history-detail')
  content.style.alignContent = 'start'
  content.style.alignSelf = 'start'
  const byId = new Map(turns.map(turn => [turn.turnId, turn]))
  const inputRef = round.interactionId && `user:${round.interactionId}`
  if (round.userText && !(round.messageRefs.includes(inputRef) && byId.get(inputRef)?.role === 'user')) {
    content.append(element('p', round.userText, 'mt-history-user mt-turn mt-turn--user'))
  }
  for (const ref of round.messageRefs) {
    const turn = byId.get(ref)
    if (!turn) {
      content.append(element('p', '本轮消息暂不可读', 'conversation-status-error'))
      continue
    }
    const article = element('article', undefined, `mt-turn mt-turn--${turn.role} mt-turn--${turn.kind}`)
    article.dataset.turnId = turn.turnId
    article.append(element('strong', mainTopicActorLabel(turn.role), 'mt-turn-head'))
    const bubble = element('div', undefined, 'mt-bubble')
    if (turn.quote) bubble.append(element('blockquote', turn.quote, 'mt-quote'))
    bubble.append(element('p', turn.text, 'mt-text'))
    if (turn.detailReadError) bubble.append(element('p', turn.detailReadError.message, 'conversation-status-error'))
    const statusRows = turn.statusFacts === undefined
      ? []
      : conversationStatus(turn.statusFacts, { allRequests: true }).filter((row) => row.phase !== 'tool')
    if (statusRows.length) {
      const status = element('div', undefined, 'conversation-status')
      status.setAttribute('aria-label', '模型响应阶段与计时')
      for (const row of statusRows) {
        const line = element('div', undefined, 'conversation-status-row')
        line.dataset.phase = row.phase
        line.dataset.tone = row.tone
        line.dataset.running = String(row.running)
        line.append(element('span', row.label))
        const seconds = elapsedSeconds(row)
        if (seconds !== undefined) line.append(element('span', `${seconds} 秒`, 'conversation-status-time'))
        if (row.error) line.append(element('span', [row.error.code, row.error.message].filter(Boolean).join('：'), 'conversation-status-error'))
        status.append(line)
      }
      bubble.append(status)
    }
    renderExplicitToolActivity(bubble, turn.statusFacts?.steps, true)
    if (turn.toolEvents?.length) {
      const tools = element('div', undefined, 'tool-body')
      bubble.append(tools)
      renderToolBody(tools, turn.toolEvents, readOutput, { finished: explicitToolActivityFinished(turn) })
    }
    article.append(bubble)
    content.append(article)
  }
  return { content, dispose: () => {
    for (const tools of content.querySelectorAll('.tool-body')) disposeToolBody(tools)
  } }
}
