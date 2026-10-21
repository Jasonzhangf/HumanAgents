import {
  api,
  appendPairingEntry,
  clearNode,
  element,
  loadRuntimeStatus,
  mountPageTemplate,
  renderRuntimeStatus,
  stateTone,
} from './runtime-shell.js'
import { bindMemoryReviewAction } from './memory-actions.js'

const template = mountPageTemplate(document.getElementById('page-root'), {
  layout: 'collection',
  active: 'Memory',
  eyebrow: 'Memory Agent',
  title: '记忆与候选审核',
  lede: '查看模型整理状态、证据来源和作用域；接受、拒绝或延期都由你明确决定。',
})
const { primary, support, status } = template.hosts

const reasonField = element('label', '审核理由')
const reasonInput = element('textarea')
reasonInput.dataset.memoryReviewReason = ''
reasonInput.placeholder = '写明审核理由'
reasonInput.setAttribute('aria-label', '审核理由')
reasonField.append(reasonInput)
const reasonSection = element('section', undefined, 'section')
reasonSection.dataset.memorySupport = 'review-reason'
reasonSection.append(
  element('h2', '审核理由'),
  element('p', '接受、拒绝或延期前，请写明理由。理由会随这次决定提交。', 'muted'),
  reasonField,
)
support.append(reasonSection)

function memoryTechnicalDetail(label, buildDetail) {
  const button = element('button', label, 'button button--quiet')
  button.type = 'button'
  button.dataset.memoryTechnicalDetail = ''
  button.addEventListener('click', () => template.detail.open(buildDetail(), button))
  return button
}

function readReviewReason() {
  const reason = reasonInput.value.trim()
  if (!reason) reasonInput.focus()
  return reason
}

function showReviewError(error) {
  status.dataset.tone = 'danger'
  clearNode(status)
  status.append(
    element('strong', error.code),
    element('span', ` · ${error.message} · owner=${error.ownerId} · next=${error.nextAction}`),
  )
  appendPairingEntry(status, error)
}

function render(view) {
  for (const section of primary.querySelectorAll('[data-memory-section]')) section.remove()

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
      ? '整理过程有失败记录，可打开技术详情核对。'
      : view.analysis.operationRef
        ? '已有记忆整理操作记录，可打开技术详情核对。'
        : '尚无记忆整理 operation。', 'muted'),
    memoryTechnicalDetail('技术详情', () => ({
      title: '记忆整理技术详情',
      eyebrow: '只读证据',
      entries: [
        ['analysis.state', view.analysis.state],
        ['analysis.mode', view.analysis.mode],
        ['autoUpdate', String(view.autoUpdate)],
        ['analysis.operationRef', view.analysis.operationRef ?? ''],
        ['analysis.failureRef', view.analysis.failureRef ?? ''],
      ],
    })),
  )
  analysis.append(panel)
  primary.append(analysis)

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
      element('p', `来源：${candidate.sourceRefs.length} 条 · digest：${candidate.sourceDigests.length} 条`, 'muted'),
      memoryTechnicalDetail('技术详情', () => ({
        title: '候选技术详情',
        eyebrow: '只读证据',
        entries: [
          ['candidateId', candidate.candidateId],
          ['state', candidate.state],
          ['namespace', candidate.namespace],
          ['projectKey', candidate.projectKey],
          ['taskId', candidate.taskId ?? ''],
          ...candidate.sourceRefs.map((sourceRef, index) => [
            `sourceRefs[${index}]`,
            sourceRef,
            'data-memory-source-ref',
          ]),
          ...candidate.sourceDigests.map((digest, index) => [
            `sourceDigests[${index}]`,
            digest,
            'data-memory-source-digest',
          ]),
        ],
      })),
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
          readReason: readReviewReason,
          review: api.reviewMemoryCandidate,
          refresh: refreshAfterReview,
          showError: showReviewError,
        })
        actions.append(button)
      }
      card.append(actions)
    }
    candidates.append(card)
  }
  primary.append(candidates)
}

async function refresh() {
  try {
    const [{ status: runtimeStatus, error }, view] = await Promise.all([
      loadRuntimeStatus(),
      api.memorySummary({ namespace: 'project', limit: 20 }),
    ])
    renderRuntimeStatus(status, runtimeStatus, error)
    render(view)
  } catch (error) {
    status.dataset.tone = 'danger'
    clearNode(status)
    status.append(
      element('strong', error.code || 'memory.request.failed'),
      element('span', ` · ${error.message} · owner=${error.ownerId} · next=${error.nextAction}`),
    )
    appendPairingEntry(status, error)
  }
}

async function refreshAfterReview() {
  await refresh()
  reasonInput.value = ''
}

window.addEventListener('pagehide', () => template.dispose(), { once: true })

void refresh()
