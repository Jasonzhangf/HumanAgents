import {
  api,
  clearNode,
  element,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  stateTone,
} from './runtime-shell.js'
import { bindMemoryReviewAction } from './memory-actions.js'

const { main, status } = makePageShell(
  'Memory',
  'Memory Agent',
  '记忆与候选审核',
  '查看模型整理状态、证据来源和作用域；接受、拒绝或延期都由你明确决定。',
)

function showReviewError(error) {
  status.dataset.tone = 'danger'
  clearNode(status)
  status.append(
    element('strong', error.code),
    element('span', ` · ${error.message} · owner=${error.ownerId} · next=${error.nextAction}`),
  )
}

function render(view) {
  for (const section of main.querySelectorAll('[data-memory-section]')) section.remove()

  const analysis = element('section', undefined, 'section')
  analysis.dataset.memorySection = 'analysis'
  analysis.append(element('h2', '整理状态'))
  const panel = element('div', undefined, 'panel')
  const chip = element('span', view.analysis.state, 'state-chip')
  chip.dataset.tone = stateTone(view.analysis.state)
  panel.append(
    chip,
    element('p', `模式：${view.analysis.mode} · 自动写入：${view.autoUpdate ? '开启' : '关闭'}`),
    element('p', view.analysis.failureRef
      ? `失败：${view.analysis.failureRef}`
      : view.analysis.operationRef ?? '尚无记忆整理 operation', 'muted'),
  )
  analysis.append(panel)
  main.append(analysis)

  const candidates = element('section', undefined, 'section')
  candidates.dataset.memorySection = 'candidates'
  candidates.append(element('h2', '待审核候选'))
  if (view.skillCandidates.length === 0) {
    candidates.append(element('p', '当前没有待审核候选。', 'panel empty'))
  }
  for (const candidate of view.skillCandidates) {
    const card = element('article', undefined, 'panel')
    card.append(
      element('h3', candidate.proposedRule),
      element('p', `状态：${candidate.state} · 作用域：${candidate.namespace}/${candidate.projectKey}${candidate.taskId ? `/${candidate.taskId}` : ''}`),
      element('p', `来源：${candidate.sourceRefs.join('、') || '无'} · digest：${candidate.sourceDigests.join('、') || '无'}`, 'muted'),
    )
    if (candidate.state === 'candidate') {
      const actions = element('div', undefined, 'actions')
      for (const [decision, label] of [['approve', '接受'], ['reject', '拒绝'], ['defer', '延期']]) {
        const button = element('button', label, `button${decision === 'approve' ? ' button--primary' : ''}`)
        button.type = 'button'
        bindMemoryReviewAction({
          button,
          candidateId: candidate.candidateId,
          decision,
          readReason: () => window.prompt('请写明审核理由'),
          review: api.reviewMemoryCandidate,
          refresh,
          showError: showReviewError,
        })
        actions.append(button)
      }
      card.append(actions)
    }
    candidates.append(card)
  }
  main.append(candidates)
}

async function refresh() {
  try {
    const [{ status: runtimeStatus, error }, view] = await Promise.all([
      loadRuntimeStatus(),
      api.memorySummary(),
    ])
    renderRuntimeStatus(status, runtimeStatus, error)
    render(view)
  } catch (error) {
    status.dataset.tone = 'danger'
    clearNode(status)
    status.append(element('strong', error.code || 'memory.request.failed'), element('span', ` · ${error.message} · ${error.nextAction}`))
  }
}

void refresh()
