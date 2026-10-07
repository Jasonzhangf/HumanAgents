import {
  api,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderPageError,
  renderRuntimeStatus,
  taskDashboardHref,
} from './runtime-shell.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import {
  projectInteractionCardFromEntries,
  projectInteractionCardFromSnapshot,
} from './interaction-card-page.js'
import {
  planActionsForState,
  planControlErrorMessage,
  planControlKey,
  planControlPendingCopy,
  planControlResultCopy,
  planNextDueAt,
  renderPlanSection,
} from './plan-control.js'

const REFRESH_MS = 4000
const { main, status, interactionCardHosts } = makePageShell(
  'Dashboard',
  'Runtime',
  '工作总览',
  '在这里新建、跟踪、管理任务；所有数据来自 HumanAgent Runtime API。',
)
const interactionCardHost = interactionCardHosts[0]
const interactionCard = interactionCardHost
  ? mountInteractionWorkCard(interactionCardHost, {
      onAction: async (action) => {
        if (action.id === 'confirm-requirement') {
          const confirmationButton = document.querySelector('#dashboard-confirm-button')
          if (confirmationButton) void confirmationButton.click()
        }
      },
    })
  : null
interactionCard?.update(projectInteractionCardFromEntries([], 'received'))

// ── DOM regions: input panel (stable, never rebuilt) + list panel (refreshed) ──
const inputRegion = element('section', undefined, 'quick-create')
const statsRegion = element('section', undefined, 'stats')
const plansRegion = element('section', undefined, 'plan-list')
const listRegion = element('div', undefined, 'task-lists')
main.append(inputRegion)
if (interactionCardHost) main.append(interactionCardHost)
main.append(statsRegion, plansRegion, listRegion)

// ── Interaction state (surVives refresh) ──
const interaction = {
  id: null,
  draft: null,
  inFlight: false,
  sequence: 0,
  entries: [],
  state: 'received',
}

function appendCardEvent(kind, text, sourceKind = kind, detail = {}) {
  interaction.sequence += 1
  const interactionId = interaction.id || 'pending-input'
  interaction.entries = [
    ...interaction.entries,
    {
      sequence: interaction.sequence,
      interactionId,
      kind,
      sourceKind,
      eventKey: detail.eventKey || kind,
      text,
      ...detail,
    },
  ]
  interactionCard?.update(projectInteractionCardFromEntries(interaction.entries, interaction.state))
}

function appendCardError(error) {
  appendCardEvent('failure', error.message || String(error), 'error', {
    eventKey: 'request-failed',
    error: { code: error.code, message: error.message || String(error), ownerId: error.ownerId || 'humanagent.app' },
    evidenceRefs: error.evidenceRefs || [],
  })
}

function updateCardFromSnapshot(snapshot) {
  interaction.id = interaction.id || 'pending-input'
  if (snapshot?.state) interaction.state = snapshot.state
  interactionCard?.update(projectInteractionCardFromSnapshot(snapshot))
}

function createInteractionProgressWidget() {
  const root = element('div', undefined, 'progress')
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  const spinner = element('span', undefined, 'progress-spinner')
  spinner.setAttribute('aria-hidden', 'true')
  const phase = element('span', '', 'progress-phase')
  const detail = element('span', '', 'progress-detail')
  const timer = element('time', '0.0s', 'progress-timer')
  timer.setAttribute('aria-hidden', 'true')
  root.append(spinner, phase, detail, timer)

  let startTime = 0
  let handle = 0
  function tick() {
    if (!startTime) return
    const elapsed = (performance.now() - startTime) / 1000
    timer.textContent = elapsed.toFixed(1) + 's'
  }

  return {
    root,
    spinner,
    set(phaseText, detailText) {
      phase.textContent = phaseText
      detail.textContent = detailText || ''
      startTime = performance.now()
      timer.textContent = '0.0s'
      timer.hidden = false
      if (handle) clearInterval(handle)
      handle = setInterval(tick, 100)
      root.classList.add('progress--live')
      appendCardEvent('status', phaseText, 'progress')
    },
    waiting(phaseText, detailText) {
      if (handle) clearInterval(handle)
      phase.textContent = phaseText || 'waiting'
      detail.textContent = detailText || ''
      timer.textContent = '0.0s'
      root.classList.remove('progress--live')
      appendCardEvent('status', phaseText || 'waiting', 'progress')
    },
    done(phaseText, detailText) {
      if (handle) clearInterval(handle)
      tick()
      phase.textContent = phaseText || 'done'
      detail.textContent = detailText || ''
      timer.hidden = false
      root.classList.remove('progress--live')
      appendCardEvent('status', phaseText || 'done', 'result')
    },
    error(phaseText, detailText) {
      if (handle) clearInterval(handle)
      tick()
      phase.textContent = phaseText || 'failed'
      detail.textContent = detailText || ''
      timer.hidden = false
      root.classList.remove('progress--live')
      appendCardEvent('failure', phaseText || 'failed', 'error')
    },
    idle(phaseText, detailText) {
      if (handle) clearInterval(handle)
      phase.textContent = phaseText || 'idle'
      detail.textContent = detailText || ''
      timer.textContent = '0.0s'
      timer.hidden = false
      root.classList.remove('progress--live')
      appendCardEvent('status', phaseText || 'idle', 'progress')
    },
  }
}

// ── Input panel ──
function renderInputPanel() {
  clearNode(inputRegion)
  const form = element('form', undefined, 'quick-create-form')
  const label = element('label', '新建任务', 'quick-create-label')
  const textarea = element('textarea')
  textarea.name = 'directive'
  textarea.required = true
  textarea.rows = 3
  textarea.placeholder = '一句话告诉显式大脑要做什么。'
  label.append(textarea)

  const submit = element('button', '提交给显式大脑', 'button button--primary')
  submit.type = 'submit'

  const progress = createInteractionProgressWidget()
  progress.root.classList.add('quick-create-progress')
  progress.idle('空闲', '输入任务后点击提交，显式大脑按 理解 → 匹配 → 确认 → 派发 处理')

  const policyRow = element('label', undefined, 'quick-create-policy')
  const autoConfirm = element('input')
  autoConfirm.type = 'checkbox'
  autoConfirm.name = 'autoConfirm'
  autoConfirm.dataset.testid = 'auto-confirm'
  policyRow.append(autoConfirm, element('span', '自动确认并派发（跳过手动确认步骤）'))

  // Interaction actions (shown after draft is produced)
  const draftArea = element('div', undefined, 'draft-area')
  draftArea.hidden = true

  const actions = element('div', undefined, 'quick-create-actions')
  actions.append(submit)
  form.append(label, actions, progress.root, policyRow, draftArea)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (interaction.inFlight) return
    const rawInput = textarea.value.trim()
    if (!rawInput) {
      progress.error('请填写任务内容', '')
      textarea.focus()
      return
    }
    interaction.inFlight = true
    submit.disabled = true
    textarea.readOnly = true
    submit.textContent = '正在处理…'
    progress.set('显式大脑正在理解输入', '正在接收并解析你的输入')
    try {
      if (!interaction.id) {
        // First turn: send raw input to explicit brain intake. The interaction
        // must declare its typed request kind, otherwise the intake refuses to
        // mint the reviewable draft revision and the 修改 / 重新整理 / 放弃
        // closure has no revision identity to act on.
        const received = await api.receiveExplicitInput({
          sourceRef: 'ui:dashboard',
          rawInput,
          inputRevision: 1,
          requestKind: 'new-task-preview',
        })
        interaction.id = received.interactionId
        appendCardEvent('user', rawInput, 'user', { eventKey: 'explicit.raw-input' })
      }
      // Check current interaction state
      let snap = await api.inspectExplicitInteraction(interaction.id)
      updateCardFromSnapshot(snap)
      if (snap.state === 'awaiting-clarification') {
        // Second turn: user answered the clarification question
        progress.set('显式大脑正在理解你的回答', '正在将补充信息交给显式大脑')
        snap = await api.answerExplicitClarification(interaction.id, rawInput)
        appendCardEvent('user', rawInput, 'user', { eventKey: 'explicit.clarification-answer' })
        // After answering, re-interpret to produce a draft
        progress.set('显式大脑正在重新整理意图', '显式大脑正在生成任务草案')
        snap = await api.interpretExplicitInput(interaction.id)
        updateCardFromSnapshot(snap)
      } else if (snap.state === 'received' || snap.state === 'matching') {
        // First turn: drive interpretation + matching
        progress.set('显式大脑正在匹配任务', '显式大脑正在整理意图')
        snap = await api.interpretExplicitInput(interaction.id)
        updateCardFromSnapshot(snap)
      }
      if (snap.state === 'awaiting-clarification') {
        progress.done('需要补充信息', snap.reply || '请回答显式大脑的问题')
        textarea.value = ''
        textarea.readOnly = false
        textarea.placeholder = snap.reply || '请补充显式大脑需要的信息。'
        submit.textContent = '回答并继续'
        submit.disabled = false
        interaction.inFlight = false
        textarea.focus()
        return
      }
      if (snap.state === 'awaiting-confirmation' && snap.draft) {
        progress.waiting('等待你确认任务草案', '查看下方显式大脑整理结果')
        interaction.draft = snap.draft
        // Reset inFlight so the confirm/cancel buttons inside the draft panel
        // are not blocked by the submit guard.
        interaction.inFlight = false
        draftNotice = ''
        renderDraftConfirmation(draftArea, snap, textarea, submit, progress, autoConfirm.checked)
        return
      }
      // status-only or other terminal
      progress.done('已处理', snap.reply || snap.nextAction || '')
      textarea.readOnly = false
      textarea.value = ''
      submit.textContent = '提交给显式大脑'
      submit.disabled = false
      interaction.id = null
      interaction.inFlight = false
      textarea.focus()
    } catch (error) {
      progress.error('请求失败', error.message || String(error))
      appendCardError(error)
      submit.textContent = '重试'
      submit.disabled = false
      textarea.readOnly = false
      interaction.inFlight = false
      textarea.focus()
    }
  })

  inputRegion.append(form)
}

// The draft panel reports only what the runtime returned. The confirm edge binds
// the displayed revision identity so the runtime can refuse an outdated
// confirmation, the refine edge names the displayed base revision version and
// hash, and the abandon edge renders the closure receipt the reject route
// returned instead of claiming a local "已取消".
let draftNotice = ''

function draftRevisionIdentity(revision) {
  return {
    version: revision?.revisionVersion === undefined ? '' : String(revision.revisionVersion),
    hash: revision?.revisionHash ?? '',
  }
}

function typedErrorText(error) {
  return `${error.code || 'runtime.request.failed'} · owner=${error.ownerId || 'unknown'} · ${error.message || String(error)} · next=${error.nextAction || 'inspect the runtime error'}`
}

function draftField(labelText, control) {
  const row = element('label', undefined, 'draft-field')
  row.append(element('span', labelText, 'draft-field-label'), control)
  return row
}

function draftLines(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function showDraftEditor(area, kind) {
  for (const node of area.querySelectorAll('[data-draft-editor]')) {
    node.hidden = node.dataset.draftEditor !== kind
  }
}

/**
 * Replace the confirmable panel with the abandon closure the reject route
 * returned. Every row is a field of that receipt; nothing is inferred.
 */
function renderDraftClosure(area, closure, state) {
  area.hidden = false
  clearNode(area)
  area.append(
    element('p', '显式大脑整理结果', 'eyebrow'),
    element('p', '草案已放弃，交互已关闭。', 'draft-proposal'),
  )
  const receipt = element('dl', undefined, 'draft-receipt')
  receipt.dataset.draftReceipt = 'true'
  for (const [label, value] of [
    ['交互状态', state],
    ['rejectionId', closure.rejectionId],
    ['closedAt', closure.closedAt],
    ['reason', closure.reason],
    ['durable', closure.durable === true ? 'true' : '未提供'],
    ['draftRevisionVersion', closure.draftRevisionVersion],
    ['draftRevisionHash', closure.draftRevisionHash],
  ]) {
    const row = element('div')
    row.append(
      element('dt', label),
      element('dd', value === undefined || value === null || value === '' ? '未提供' : String(value)),
    )
    receipt.append(row)
  }
  area.append(receipt)
  const status = element('p', `放弃回执：${closure.rejectionId ?? '未提供'} · ${closure.closedAt ?? '未提供'}`, 'muted')
  status.dataset.draftStatus = 'true'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  area.append(status)
}

/** Re-read the interaction and re-render the panel from the runtime's answer. */
async function reloadDraftConfirmation(area, textarea, submit, progress) {
  const current = await api.inspectExplicitInteraction(interaction.id)
  interaction.draft = current.draft ?? null
  if (current.state === 'awaiting-confirmation' && current.draft) {
    renderDraftConfirmation(area, current, textarea, submit, progress, false)
    return current
  }
  area.hidden = true
  clearNode(area)
  interaction.id = null
  interaction.draft = null
  interaction.inFlight = false
  textarea.readOnly = false
  textarea.placeholder = '一句话告诉显式大脑要做什么。'
  submit.textContent = '提交给显式大脑'
  submit.disabled = false
  progress.idle(`交互状态：${current.state}`, current.nextAction || '')
  textarea.focus()
  return current
}

function renderDraftConfirmation(area, snap, textarea, submit, progress, autoConfirm) {
  area.hidden = false
  clearNode(area)
  const proposal = snap.draft?.proposal || snap.rawInput || ''
  const normalized = snap.draft?.normalizedInput || ''
  const intent = snap.draft?.proposedIntent || ''
  const revision = snap.revision
  const identity = draftRevisionIdentity(revision)
  area.append(
    element('p', '显式大脑整理结果', 'eyebrow'),
    element('p', proposal, 'draft-proposal'),
  )
  if (normalized) area.append(element('p', `标准化输入：${normalized}`, 'draft-meta'))
  if (intent) area.append(element('p', `意图：${intent}`, 'draft-meta'))
  const revisionNode = element(
    'p',
    `修订 ${identity.version ? `v${identity.version}` : '未提供'} · ${identity.hash || '未提供'}`,
    'draft-meta draft-revision',
  )
  revisionNode.dataset.draftRevision = 'true'
  revisionNode.dataset.draftRevisionVersion = identity.version
  revisionNode.dataset.draftRevisionHash = identity.hash
  area.append(revisionNode)

  const confirmBtn = element('button', '确认并执行', 'button button--primary')
  confirmBtn.type = 'button'
  confirmBtn.id = 'dashboard-confirm-button'
  confirmBtn.dataset.draftAction = 'confirm'
  const regenerateBtn = element('button', '重新整理', 'button button--quiet')
  regenerateBtn.type = 'button'
  regenerateBtn.dataset.draftAction = 'regenerate'
  const rejectBtn = element('button', '放弃', 'button button--danger')
  rejectBtn.type = 'button'
  rejectBtn.dataset.draftAction = 'reject'
  // 修改 names the exact revision the human is looking at, so it exists only
  // when the runtime reported a typed revision to refine against.
  const refineBtn = revision === undefined ? null : element('button', '修改', 'button button--quiet')
  if (refineBtn) {
    refineBtn.type = 'button'
    refineBtn.dataset.draftAction = 'refine'
  }
  const draftActions = element('div', undefined, 'draft-actions')
  draftActions.append(confirmBtn)
  if (refineBtn) draftActions.append(refineBtn)
  draftActions.append(regenerateBtn, rejectBtn)

  const editors = element('div', undefined, 'draft-editors')
  const refineEditor = element('div', undefined, 'draft-editor')
  refineEditor.dataset.draftEditor = 'refine'
  refineEditor.hidden = true
  const refineGoal = element('input')
  refineGoal.name = 'goal'
  refineGoal.value = revision?.goal ?? ''
  const refineScope = element('input')
  refineScope.name = 'scope'
  refineScope.value = revision?.scope ?? ''
  const refineConstraints = element('textarea')
  refineConstraints.name = 'constraints'
  refineConstraints.value = (revision?.constraints ?? []).join('\n')
  const refineDeliverables = element('textarea')
  refineDeliverables.name = 'deliverables'
  refineDeliverables.value = (revision?.deliverables ?? []).join('\n')
  const refineSubmit = element('button', '保存修改', 'button button--primary')
  refineSubmit.type = 'button'
  refineSubmit.dataset.draftSubmit = 'refine'
  refineEditor.append(
    draftField('目标', refineGoal),
    draftField('范围', refineScope),
    draftField('约束（每行一条）', refineConstraints),
    draftField('交付物（每行一条）', refineDeliverables),
    refineSubmit,
  )

  const regenerateEditor = element('div', undefined, 'draft-editor')
  regenerateEditor.dataset.draftEditor = 'regenerate'
  regenerateEditor.hidden = true
  const regenerateInstruction = element('textarea')
  regenerateInstruction.name = 'instruction'
  regenerateInstruction.placeholder = '可选的修正说明；留空则按原始输入重新整理。'
  const regenerateSubmit = element('button', '重新整理草案', 'button button--quiet')
  regenerateSubmit.type = 'button'
  regenerateSubmit.dataset.draftSubmit = 'regenerate'
  regenerateEditor.append(draftField('修正说明（可选）', regenerateInstruction), regenerateSubmit)

  const rejectEditor = element('div', undefined, 'draft-editor')
  rejectEditor.dataset.draftEditor = 'reject'
  rejectEditor.hidden = true
  const rejectReason = element('textarea')
  rejectReason.name = 'reason'
  rejectReason.placeholder = '放弃原因（必填，会写入放弃回执）'
  const rejectSubmit = element('button', '确认放弃', 'button button--danger')
  rejectSubmit.type = 'button'
  rejectSubmit.dataset.draftSubmit = 'reject'
  rejectEditor.append(draftField('放弃原因', rejectReason), rejectSubmit)

  editors.append(refineEditor, regenerateEditor, rejectEditor)

  const confirmStatus = element(
    'p',
    draftNotice || `当前修订 ${identity.version ? `v${identity.version}` : '未提供'}；确认后进入隐式队列。`,
    'muted',
  )
  confirmStatus.dataset.draftStatus = 'true'
  confirmStatus.setAttribute('role', 'status')
  confirmStatus.setAttribute('aria-live', 'polite')

  area.append(draftActions, editors, confirmStatus)

  const disableControls = () => {
    confirmBtn.disabled = true
    regenerateBtn.disabled = true
    rejectBtn.disabled = true
    if (refineBtn) refineBtn.disabled = true
  }
  const failDraftEdge = async (label, error) => {
    interaction.inFlight = false
    draftNotice = typedErrorText(error)
    progress.error(label, error.message || error)
    appendCardError(error)
    await reloadDraftConfirmation(area, textarea, submit, progress).catch(() => disableControls())
  }

  confirmBtn.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (interaction.inFlight) return
    interaction.inFlight = true
    disableControls()
    progress.set('显式大脑正在提交任务', '正在写入任务需求并进入执行队列')
    try {
      const confirmed = await api.confirmExplicitRequirement(interaction.id, {
        draftId: snap.draft.draftId,
        inputRevision: snap.draft.inputRevision || 1,
        // Bind the revision the human is looking at. Without this the runtime
        // cannot tell an outdated confirmation from a current one.
        ...(identity.version ? { draftRevisionVersion: Number(identity.version) } : {}),
        ...(identity.hash ? { draftRevisionHash: identity.hash } : {}),
        confirmationRef: `confirmation:dashboard-${Date.now()}`,
        confirmedBy: 'human:operator',
        confirmedAt: new Date().toISOString(),
        payloadRef: `asset://requirements/dashboard-${Date.now()}`,
      })
      draftNotice = ''
      appendCardEvent('decision', '任务已确认，等待队列消费', 'decision', { eventKey: 'explicit.confirmation-submitted' })
      progress.done('已入队 · 隐式大脑将消费', '任务需求已进入隐式大脑队列')
      // Implicit dispatch is async — wait for the task to appear in the list
      // and jump straight to its dashboard so the user sees live turns instead
      // of a stale "已入队" message on the input panel.
      const dispatchedTaskId = await findDispatchedTaskId()
      if (dispatchedTaskId) {
        window.location.href = taskDashboardHref(dispatchedTaskId)
        return
      }
      area.hidden = true
      clearNode(area)
      // Reset input for next task
      textarea.value = ''
      textarea.readOnly = false
      textarea.placeholder = '一句话告诉显式大脑要做什么。'
      submit.textContent = '提交给显式大脑'
      submit.disabled = false
      interaction.id = null
      interaction.draft = null
      interaction.inFlight = false
      textarea.focus()
      void refreshLists()
    } catch (error) {
      // A refused confirmation is never retried automatically: the panel is
      // re-read so the human sees the revision the runtime actually holds.
      await failDraftEdge('确认失败', error)
    }
  })

  // Auto-confirm uses the same confirmation edge as the manual button.
  if (autoConfirm) {
    progress.set('显式大脑正在自动确认', '已开启跳过手动确认')
    setTimeout(() => confirmBtn.click(), 0)
  }

  if (refineBtn) {
    refineBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      showDraftEditor(area, 'refine')
    })
    refineSubmit.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (interaction.inFlight) return
      const fields = {
        goal: refineGoal.value.trim(),
        scope: refineScope.value.trim(),
        constraints: draftLines(refineConstraints.value),
        deliverables: draftLines(refineDeliverables.value),
      }
      if (!fields.goal || !fields.scope) {
        draftNotice = 'request.invalid-field · owner=humanagent.app.ui · 修改需要目标与范围 · next=补齐修改内容后再提交'
        renderDraftConfirmation(area, snap, textarea, submit, progress, false)
        return
      }
      interaction.inFlight = true
      disableControls()
      progress.set('显式大脑正在修改草案', '正在按当前修订提交 typed 修改')
      try {
        const next = await api.refineExplicitDraft(interaction.id, {
          draftId: revision.draftId,
          baseRevisionVersion: revision.revisionVersion,
          requestedRevisionHash: revision.revisionHash,
          fields,
          instructionRef: 'user-edit',
        })
        interaction.inFlight = false
        interaction.draft = next.draft ?? null
        const nextIdentity = draftRevisionIdentity(next.revision)
        draftNotice = `修改已应用 · 修订 ${nextIdentity.version ? `v${nextIdentity.version}` : '未提供'} · ${nextIdentity.hash || '未提供'}`
        progress.done('草案已修改', `当前修订 ${nextIdentity.version ? `v${nextIdentity.version}` : '未提供'}`)
        appendCardEvent('decision', '草案已按 typed 修改更新', 'decision', { eventKey: 'explicit.draft-refined' })
        renderDraftConfirmation(area, next, textarea, submit, progress, false)
      } catch (error) {
        await failDraftEdge('修改失败', error)
      }
    })
  }

  regenerateBtn.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    showDraftEditor(area, 'regenerate')
  })
  regenerateSubmit.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (interaction.inFlight) return
    const instruction = regenerateInstruction.value.trim()
    interaction.inFlight = true
    disableControls()
    progress.set('显式大脑正在重新整理草案', '正在按原始输入重新整理')
    try {
      const next = await api.regenerateExplicitDraft(interaction.id, instruction ? { instruction } : {})
      interaction.inFlight = false
      interaction.draft = next.draft ?? null
      const nextIdentity = draftRevisionIdentity(next.revision)
      const minted = nextIdentity.version !== '' && nextIdentity.version !== identity.version
      draftNotice = minted
        ? `重新整理已产生新修订 v${nextIdentity.version} · ${nextIdentity.hash || '未提供'}`
        : `重新整理后仍是修订 ${nextIdentity.version ? `v${nextIdentity.version}` : '未提供'}：解释器返回了相同的执行输入，当前修订保持有效。`
      progress.done('草案已重新整理', minted ? `新修订 v${nextIdentity.version}` : '修订未变化')
      appendCardEvent('decision', '草案已重新整理', 'decision', { eventKey: 'explicit.draft-regenerated' })
      renderDraftConfirmation(area, next, textarea, submit, progress, false)
    } catch (error) {
      await failDraftEdge('重新整理失败', error)
    }
  })

  rejectBtn.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    showDraftEditor(area, 'reject')
  })
  rejectSubmit.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (interaction.inFlight) return
    const reason = rejectReason.value.trim()
    if (!reason) {
      draftNotice = 'request.invalid-field · owner=humanagent.app.ui · 放弃原因必填 · next=填写放弃原因后再提交'
      renderDraftConfirmation(area, snap, textarea, submit, progress, false)
      return
    }
    interaction.inFlight = true
    disableControls()
    progress.set('显式大脑正在放弃草案', '正在写入放弃回执')
    try {
      const result = await api.rejectExplicitDraft(interaction.id, { reason })
      interaction.inFlight = false
      interaction.draft = null
      interaction.id = null
      const closure = result.closure ?? {}
      progress.done('草案已放弃', `放弃回执 ${closure.rejectionId ?? '未提供'}`)
      appendCardEvent('decision', '草案已放弃并写入回执', 'decision', { eventKey: 'explicit.draft-abandoned' })
      renderDraftClosure(area, closure, result.state)
      textarea.readOnly = false
      textarea.placeholder = '一句话告诉显式大脑要做什么。'
      submit.textContent = '提交给显式大脑'
      submit.disabled = false
      void refreshLists()
    } catch (error) {
      await failDraftEdge('放弃失败', error)
    }
  })

}

// ── List panel (refreshed by polling) ──
async function refreshLists() {
  try {
    const [{ status: runtimeStatus, error }, dashboard, tasks, scheduler] = await Promise.all([
      loadRuntimeStatus(),
      api.dashboard(),
      api.listTasks(),
      // The scheduler read is the only surface that lists a plan which has no
      // coordinator task yet. A failure here must not blank the task lists, so
      // it is reported as its own typed notice instead of failing the page.
      api.scheduler().catch((schedulerError) => ({ __error: schedulerError })),
    ])
    renderRuntimeStatus(status, runtimeStatus, error)
    renderStats(dashboard)
    renderTaskLists(dashboard, tasks)
    renderPlanList(scheduler)
  } catch (error) {
    renderPageError(status, error)
  }
}

/**
 * The control notice belongs to the one plan it was issued against, so a
 * result for plan A is never rendered under plan B.
 */
let planControlNotice = { subscriptionId: '', text: '' }

async function runPlanControl(subscriptionId, action) {
  planControlNotice = { subscriptionId, text: planControlPendingCopy(action) }
  renderPlanList(lastSchedulerRead)
  try {
    const result = await api.planControl(subscriptionId, {
      action,
      idempotencyKey: planControlKey(subscriptionId, action),
      requestedAt: new Date().toISOString(),
    })
    planControlNotice = { subscriptionId, text: planControlResultCopy(action, result) }
  } catch (error) {
    planControlNotice = { subscriptionId, text: planControlErrorMessage(error) }
  }
  await refreshLists()
}

let lastSchedulerRead

/**
 * Present every persisted execution plan the patrol reports. This includes a
 * plan whose first occurrence has not been claimed yet, which no task page can
 * show. Each plan renders its own durable state and only the controls that read
 * makes available.
 */
function renderPlanList(scheduler) {
  lastSchedulerRead = scheduler
  clearNode(plansRegion)
  const head = element('header', undefined, 'section-head')
  const plans = scheduler?.plans ?? []
  head.append(element('h2', '执行计划'), element('span', `${plans.length} 项`, 'section-meta'))
  plansRegion.append(head)
  const panel = element('div', undefined, 'panel')
  if (scheduler?.__error) {
    panel.append(element(
      'p',
      `读取执行计划失败 · ${scheduler.__error.message} · owner=${scheduler.__error.ownerId || 'unknown'} · next=${scheduler.__error.nextAction || 'inspect the runtime error'}`,
      'empty',
    ))
  } else if (scheduler?.issue) {
    panel.append(element('p', `计划巡逻上报：${scheduler.issue.code} · ${scheduler.issue.message} · next=${scheduler.issue.nextAction}`, 'empty'))
  } else if (plans.length === 0) {
    panel.append(element('p', '当前没有已持久化的执行计划。', 'empty'))
  }
  for (const plan of plans) {
    panel.append(renderPlanSection(projectSchedulerPlan(plan), {
      ...(planControlNotice.subscriptionId === plan.subscriptionId
        ? { notice: planControlNotice.text }
        : {}),
      onControl: (action) => runPlanControl(plan.subscriptionId, action),
    }))
  }
  plansRegion.append(panel)
}

/**
 * Adapt one scheduler plan projection to the shared plan section. The list read
 * carries no `can*` booleans, so the availability is restated from the durable
 * `state` by the same rule the task dashboard projection publishes.
 */
function projectSchedulerPlan(plan) {
  return {
    subscriptionId: plan.subscriptionId,
    state: plan.state,
    nextDueAt: planNextDueAt(plan),
    goalId: plan.goalId,
    scheduleRevision: plan.scheduleRevision,
    currentOccurrenceOrdinal: plan.currentOccurrenceOrdinal,
    availableActions: planActionsForState(plan.state),
  }
}

function renderStats(dashboard) {
  clearNode(statsRegion)
  for (const [label, value] of [
    ['运行中', dashboard.hasRunning ? '是' : '否'],
    ['任务数', String(dashboard.taskCount)],
    ['等待决策', String(dashboard.waitingDecisionCount)],
    ['最近失败', String((dashboard.recentFailures || []).length)],
  ]) {
    const card = element('article', undefined, 'stat')
    card.append(element('span', label), element('strong', value))
    statsRegion.append(card)
  }
}

function taskRow(row) {
  const item = element('div', undefined, 'task-item')
  const link = element('a', undefined, 'task-item-main')
  link.href = taskDashboardHref(row.taskId.value)
  link.append(
    element('h3', row.title || '未命名任务'),
    element('p', `${row.currentState || row.state || ''} · ${row.nextStep || ''}`),
  )
  const meta = element('div', undefined, 'task-item-meta')
  meta.append(
    element('span', row.stateLabel || row.state || '', 'task-state-pill'),
    element('time', formatTime(row.updatedAt)),
  )
  link.append(meta)
  const actions = element('div', undefined, 'task-item-actions')
  actions.append(
    actionButton('编辑', () => openEditDialog(row)),
    actionButton('删除', true, () => runDelete(row)),
  )
  item.append(link, actions)
  return item
}

function actionButton(label, danger, onClick) {
  if (typeof danger === 'function') { onClick = danger; danger = false }
  const btn = element('button', label, `button button--sm${danger ? ' button--danger' : ''}`)
  btn.type = 'button'
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void onClick(btn)
  })
  return btn
}

async function runDelete(row, btn) {
  if (!window.confirm(`删除任务"${row.title}"？`)) return
  btn.disabled = true
  try {
    await api.deleteTask(row.taskId.value)
    await refreshLists()
  } catch (error) {
    btn.disabled = false
    window.alert(`删除失败：${error.message || error}`)
  }
}

function openEditDialog(row) {
  const existing = document.querySelector('dialog.edit-dialog')
  if (existing) existing.remove()
  const dialog = element('dialog', undefined, 'edit-dialog')
  const form = element('form', undefined, 'edit-form')
  const input = element('input')
  input.type = 'text'
  input.value = row.title || ''
  input.required = true
  const cancel = element('button', '取消', 'button button--quiet')
  cancel.type = 'button'
  const save = element('button', '保存', 'button button--primary')
  save.type = 'submit'
  const err = element('p', undefined, 'edit-status')
  const editActions = element('div', undefined, 'edit-actions')
  editActions.append(cancel, save)
  form.append(
    element('label', '任务标题', 'field-label'),
    input,
    err,
    editActions,
  )
  dialog.append(form)
  document.body.append(dialog)
  dialog.showModal()
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    save.disabled = true
    err.textContent = '保存中…'
    try {
      await api.updateTask(row.taskId.value, { title: input.value.trim() })
      dialog.close()
      await refreshLists()
    } catch (error) {
      save.disabled = false
      err.textContent = `${error.message || error} · owner=${error.ownerId || 'unknown'}`
    }
  })
  cancel.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
}

function section(title, rows, emptyText) {
  const sec = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', title), element('span', `${rows.length} 项`, 'section-meta'))
  const panel = element('div', undefined, 'panel')
  if (rows.length === 0) panel.append(element('p', emptyText, 'empty'))
  else for (const row of rows) panel.append(taskRow(row))
  sec.append(head, panel)
  return sec
}

function renderTaskLists(dashboard, tasks) {
  clearNode(listRegion)
  listRegion.append(
    section('运行中', tasks.running, '当前没有运行中的任务。'),
    section('等待决策', tasks.waiting, '当前没有等待决策的任务。'),
  )
  const layout = element('div', undefined, 'layout')
  const left = element('div')
  const right = element('div')
  left.append(
    section('已完成', tasks.completed, '还没有已完成的任务。'),
    section('已停止', tasks.stopped, '当前没有已停止的任务。'),
  )
  right.append(
    section('最近失败', (dashboard.recentFailures || []).map((f) => ({
      taskId: f.taskId,
      title: f.taskTitle || '失败任务',
      state: 'failed',
      stateLabel: '失败',
      currentState: f.code || 'failed',
      nextStep: f.nextAction || '',
      updatedAt: f.occurredAt,
    })), '暂无失败记录。'),
  )
  layout.append(left, right)
  listRegion.append(layout)
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

// Poll listTasks until implicit dispatch creates a task for the just-confirmed
// requirement, then return its id. Returns null if dispatch never shows up.
async function findDispatchedTaskId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const tasks = await api.listTasks()
      const candidates = []
        .concat(tasks.running || [])
        .concat(tasks.waiting || [])
        .concat(tasks.draft || [])
        .filter((task) => task && task.updatedAt)
      if (candidates.length > 0) {
        const latest = candidates
          .map((task) => ({ task, ts: new Date(task.updatedAt).getTime() }))
          .sort((left, right) => right.ts - left.ts)[0]
        if (latest?.task?.taskId?.value) return latest.task.taskId.value
      }
    } catch (_) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

// ── Init ──
renderInputPanel()
void refreshLists()
const pollHandle = setInterval(() => void refreshLists(), REFRESH_MS)
