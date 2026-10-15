import { createRuntimeApi, clearNode, element, formatTime, stateTone } from './runtime-api.js'
import { appendPairingEntry } from './runtime-shell.js'

const api = createRuntimeApi()

function safe(selector, root) {
  try { return (root || document).querySelector(selector) } catch (_) { return element('span') }
}
function safeAll(selector, root) {
  try { return Array.from((root || document).querySelectorAll(selector)) } catch (_) { return [] }
}

const feedback = document.querySelector('[data-action-feedback]')
const diagnostic = document.querySelector('[data-diagnostic-output]')
const serverResult = document.querySelector('[data-server-result]')
const runtimeMode = document.querySelector('[data-runtime-mode]')
const runtimeStatus = (function(){try {return document.querySelector('[data-runtime-status]')} catch (_) {return element('span')}})()
const visibleState = document.querySelector('[data-visible-state]')
const interactionIdLabel = document.querySelector('[data-interaction-id]')
const inspection = document.querySelector('[data-inspection]')
const draftFeedback = document.querySelector('[data-draft-feedback]')
const inputForm = document.querySelector('[data-explicit-input]')
const matchingForm = document.querySelector('[data-explicit-match]')
const proposalForm = document.querySelector('[data-explicit-proposal]')
const confirmationForm = document.querySelector('[data-explicit-confirmation]')
const controlForm = document.querySelector('[data-control-form]')
const matchButton = matchingForm.querySelector('button[type="submit"]')
const proposalButton = proposalForm.querySelector('button[type="submit"]')
const confirmationButton = confirmationForm.querySelector('button[type="submit"]')
const dispatchButton = document.querySelector('[data-action="dispatch"]')
const statusButtons = document.querySelectorAll('[data-action="status-only"]')
const flowState = safe('[data-flow-state]')
const flowTask = safe('[data-flow-task]')
const flowAction = safe('[data-flow-action]')
const flowNote = safe('[data-flow-note]')
const flowMeta = safe('[data-flow-meta]')
const taskList = safe('[data-task-list]')
const taskQueueMeta = safe('[data-task-queue-meta]')
const createTaskForm = safe('[data-create-task-form]')
const createTaskFeedback = safe('[data-create-task-feedback]')
const createTaskButton = safe('[data-action="create"]', createTaskForm)
const updateTaskButton = safe('[data-action="update"]', createTaskForm)
const deleteTaskButton = safe('[data-action="delete"]', createTaskForm)
const liveEventList = safe('[data-task-live-events]')
const liveEventMeta = safe('[data-task-live-meta]')
const confirmPolicyRadios = safeAll('[data-confirm-policy] input[name="confirmPolicy"]')
const existingChangeIntake = safe('[data-existing-change-intake]')
const existingChangeState = safe('[data-existing-change-state]')
const existingChangeFeedback = safe('[data-existing-change-feedback]')
const existingChangeError = safe('[data-existing-change-error]')
const existingChangeProposal = safe('[data-existing-change-proposal]')
const existingChangeTask = safe('[data-existing-change-task]')
const existingChangeRevision = safe('[data-existing-change-revision]')
const existingChangeEdit = safe('[data-existing-change-edit]')
const existingChangeConfirmation = safe('[data-existing-change-confirmation]')
const existingChangeOrganizeButton = safe('[data-action="organize-existing-change"]', existingChangeIntake)
const existingChangeSaveButton = safe('[data-action="save-existing-change"]', existingChangeEdit)
const existingChangeConfirmButton = safe('[data-action="confirm-existing-change"]', existingChangeProposal)

const INTERPRET_TIMEOUT_MS = 8000

let interactionId
let currentInspection
let confirmPolicy = 'manual'
let selectedTaskId
let tasks = []
let existingChangeInteractionId
let existingChangeSnapshot
let existingChangeIdentity
let existingChangeLastInput
let existingChangeLastTaskRef
let existingChangeInFlight = false
let existingChangeSaveRejected = false

function field(form, name) {
  return form.elements.namedItem(name)
}

function value(form, name) {
  return field(form, name).value.trim()
}

function readable(input, placeholder = '暂无信息') {
  if (input === undefined || input === null || input === '') return placeholder
  if (Array.isArray(input)) return input.length ? input.map((item) => readable(item)).join('；') : placeholder
  if (typeof input === 'object') return JSON.stringify(input)
  return String(input)
}

function setFeedback(message) {
  feedback.textContent = message
}

function setCreateFeedback(message) {
  createTaskFeedback.textContent = message
}

/**
 * The task form's own feedback line, plus the shared pairing entry. A typed
 * session rejection must offer the login page on every mutation this form
 * performs; plain text would drop the runtime's code/owner/nextAction and leave
 * the user with no way to pair.
 */
function setCreateFeedbackError(error) {
  setCreateFeedback(`${error.message} · ${error.nextAction || 'inspect runtime'}`)
  appendPairingEntry(createTaskFeedback, error)
}

function setExistingChangeFeedback(message) {
  existingChangeFeedback.textContent = message
}

function clearExistingChangeError() {
  clearNode(existingChangeError)
  existingChangeError.hidden = true
}

function showExistingChangeError(error) {
  clearNode(existingChangeError)
  existingChangeError.hidden = false
  existingChangeError.append(
    element('strong', error.code || 'runtime.request.failed'),
    element('p', `${error.message || String(error)} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the runtime error'}`),
  )
  appendPairingEntry(existingChangeError, error)
}

function newExistingChangeIdentity() {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    confirmationRef: `confirmation:existing-change:${nonce}`,
    payloadRef: `asset://requirements/existing-change:${nonce}`,
    idempotencyKey: `existing-change:${nonce}`,
    confirmedAt: new Date().toISOString(),
    submitted: false,
    invalidated: false,
  }
}

function resetExistingChange() {
  existingChangeInteractionId = undefined
  existingChangeSnapshot = undefined
  existingChangeIdentity = undefined
  existingChangeLastInput = undefined
  existingChangeLastTaskRef = undefined
  existingChangeInFlight = false
  existingChangeSaveRejected = false
  existingChangeProposal.hidden = true
  existingChangeState.textContent = '尚未整理'
  clearExistingChangeError()
}

function existingChangeCurrentTaskRef(snapshot) {
  return snapshot?.draft?.matchedTasks?.find((task) => task.relation === 'current')?.taskId?.value
}

function existingChangeEditorFields() {
  return {
    goal: value(existingChangeEdit, 'goal'),
    scope: value(existingChangeEdit, 'scope'),
    proposal: value(existingChangeEdit, 'proposal'),
  }
}

/**
 * A confirmation authorizes exactly the revision the runtime last returned for
 * the fields on screen. Editing those fields, or having a save rejected, leaves
 * the displayed text without a server revision, so the confirmation stays
 * unavailable. Only a revision returned by the runtime clears this gate; the UI
 * never mints a domain revision of its own.
 */
function existingChangeConfirmBlocker() {
  const snapshot = existingChangeSnapshot
  const revision = snapshot?.revision
  if (!snapshot || !revision) return 'missing-revision'
  if (snapshot.state !== 'awaiting-confirmation') return 'state'
  if (existingChangeIdentity?.submitted) return 'submitted'
  if (existingChangeSaveRejected) return 'stale-edit'
  const fields = existingChangeEditorFields()
  const saved = {
    goal: revision.goal ?? '',
    scope: revision.scope ?? '',
    proposal: revision.proposal ?? '',
  }
  if (fields.goal !== saved.goal || fields.scope !== saved.scope || fields.proposal !== saved.proposal) return 'unsaved-edit'
  return undefined
}

function existingChangeBlockerRefusal(blocker) {
  return blocker === 'unsaved-edit'
    ? {
        code: 'ui.existing-change.unsaved-edit',
        message: 'the edited fields are not a saved draft revision',
        nextAction: 'save the edited revision before confirming the change',
        feedback: '编辑尚未保存；当前修订不能确认。',
      }
    : {
        code: 'ui.existing-change.stale-edit',
        message: 'the last save was rejected; the displayed revision is not the current server revision',
        nextAction: 'reload the reviewable revision before confirming the change',
        feedback: '保存修改被拒绝；当前修订不能确认。',
      }
}

function existingChangeConfirmationText(blocker) {
  if (existingChangeIdentity?.submitted) return `已提交：${existingChangeIdentity.receiptText || 'requirement accepted'}`
  if (blocker === 'unsaved-edit') return '编辑尚未保存；当前修订不能确认。'
  if (blocker === 'stale-edit') return '保存修改被拒绝；当前修订不能确认，请重新整理或重新保存。'
  if (existingChangeIdentity?.invalidated) return '修改已保存；旧确认已失效，请确认当前修订。'
  return '确认是独立动作；保存修改会使旧确认失效。'
}

function renderExistingChange(snapshot) {
  existingChangeSnapshot = snapshot
  existingChangeState.textContent = readable(snapshot?.state)
  const draft = snapshot?.draft
  const revision = snapshot?.revision
  existingChangeProposal.hidden = !draft
  if (!draft) return

  const target = existingChangeCurrentTaskRef(snapshot)
  existingChangeTask.textContent = target ? `目标任务：${target}` : '目标任务：未匹配到当前任务'
  existingChangeRevision.textContent = revision
    ? `修订 v${revision.revisionVersion} · ${revision.revisionHash}`
    : '修订：未提供'
  if (revision) {
    field(existingChangeEdit, 'goal').value = revision.goal ?? draft.proposal ?? ''
    field(existingChangeEdit, 'scope').value = revision.scope ?? draft.normalizedInput ?? ''
    field(existingChangeEdit, 'proposal').value = revision.proposal ?? draft.proposal ?? ''
  }
  // The confirmation stays available only for the revision the runtime last
  // returned and while the fields on screen still match it. Target validity is
  // checked by the confirmation action itself, so a wrong target surfaces as a
  // typed runtime error instead of a silently disabled button that never
  // explains why.
  const blocker = existingChangeConfirmBlocker()
  existingChangeSaveButton.disabled = !revision || existingChangeIdentity?.submitted === true
  existingChangeConfirmButton.disabled = Boolean(blocker)
  existingChangeConfirmation.textContent = existingChangeConfirmationText(blocker)
  showServerResult(snapshot)
}

async function organizeExistingChange(event) {
  event.preventDefault()
  if (existingChangeInFlight) return
  const target = value(existingChangeIntake, 'taskRef')
  const rawInput = value(existingChangeIntake, 'changeInput')
  if (!target || !rawInput) {
    setExistingChangeFeedback('请填写任务引用和变更输入。')
    return
  }
  if (existingChangeLastTaskRef !== undefined
    && (existingChangeLastTaskRef !== target || existingChangeLastInput !== rawInput)) {
    resetExistingChange()
  }
  existingChangeInFlight = true
  existingChangeOrganizeButton.disabled = true
  clearExistingChangeError()
  setExistingChangeFeedback('正在整理变更提案…')
  try {
    let snapshot
    if (!existingChangeInteractionId) {
      const received = await api.receiveExplicitInput({
        sourceRef: 'ui:interaction:existing-change',
        rawInput,
        inputRevision: 1,
        requestKind: 'existing-task-change',
      })
      existingChangeInteractionId = received.interactionId
      snapshot = await api.interpretExplicitInput(existingChangeInteractionId)
    } else {
      snapshot = await api.inspectExplicitInteraction(existingChangeInteractionId)
      if (snapshot.state === 'received' || snapshot.state === 'matching') {
        snapshot = await api.interpretExplicitInput(existingChangeInteractionId)
      }
    }
    existingChangeLastTaskRef = target
    existingChangeLastInput = rawInput
    // The runtime just returned its current revision for these fields, so a
    // previously rejected save no longer owns the gate.
    existingChangeSaveRejected = false
    renderExistingChange(snapshot)
    const runtimeTarget = existingChangeCurrentTaskRef(snapshot)
    if (snapshot.state === 'awaiting-clarification') {
      setExistingChangeFeedback(snapshot.reply || '显式大脑需要补充信息；请修改变更输入后重新整理。')
      return
    }
    if (snapshot.state !== 'awaiting-confirmation') {
      setExistingChangeFeedback(`当前状态：${snapshot.state}。${snapshot.nextAction || ''}`)
      return
    }
    if (!runtimeTarget) {
      existingChangeIdentity = undefined
      showExistingChangeError(Object.assign(new Error('整理结果没有绑定当前任务，不能提交变更。'), {
        code: 'explicit-brain.missing-existing-task-target',
        ownerId: 'humanagent.runtime.explicit-brain',
        nextAction: 'select the task that owns the confirmed draft revision before submitting the change',
      }))
      return
    }
    if (runtimeTarget !== target) {
      existingChangeIdentity = undefined
      showExistingChangeError(Object.assign(new Error(`变更目标 ${target} 与整理结果 ${runtimeTarget} 不一致。`), {
        code: 'explicit-brain.task-target-mismatch',
        ownerId: 'humanagent.runtime.explicit-brain',
        nextAction: 'select the task that owns the confirmed draft revision before submitting the change',
      }))
      return
    }
    if (!existingChangeIdentity) existingChangeIdentity = newExistingChangeIdentity()
    setExistingChangeFeedback('提案已整理；请检查后单独确认。')
  } catch (error) {
    showExistingChangeError(error)
    setExistingChangeFeedback(`${error.message} · ${error.nextAction || 'inspect the runtime'}`)
  } finally {
    existingChangeInFlight = false
    existingChangeOrganizeButton.disabled = false
  }
}

async function saveExistingChange(event) {
  event.preventDefault()
  const revision = existingChangeSnapshot?.revision
  if (!revision) {
    setExistingChangeFeedback('请先整理变更提案。')
    return
  }
  const fields = {
    goal: value(existingChangeEdit, 'goal'),
    scope: value(existingChangeEdit, 'scope'),
    proposal: value(existingChangeEdit, 'proposal'),
  }
  if (!fields.goal || !fields.scope || !fields.proposal) {
    setExistingChangeFeedback('目标、范围和处理方式都需要填写。')
    return
  }
  const changed = fields.goal !== revision.goal
    || fields.scope !== revision.scope
    || fields.proposal !== revision.proposal
  if (!changed) {
    setExistingChangeFeedback(existingChangeSaveRejected
      ? '没有检测到修改；请重新整理以取得服务端当前修订。'
      : '没有检测到修改；当前修订仍可确认。')
    return
  }
  // An edit is a new revision identity. Clear the previous confirmation before
  // asking the runtime to mint it, so a failed edit can never leave the old
  // confirmation usable for the edited text.
  existingChangeIdentity = undefined
  existingChangeConfirmButton.disabled = true
  existingChangeConfirmation.textContent = existingChangeConfirmationText('unsaved-edit')
  existingChangeSaveButton.disabled = true
  clearExistingChangeError()
  setExistingChangeFeedback('正在保存修改…')
  try {
    const snapshot = await api.refineExplicitDraft(existingChangeInteractionId, {
      draftId: revision.draftId,
      baseRevisionVersion: revision.revisionVersion,
      requestedRevisionHash: revision.revisionHash,
      fields,
      instructionRef: 'existing-change-edit',
      idempotencyKey: `existing-change-edit:${revision.draftId}:${revision.revisionVersion}:${Date.now().toString(36)}`,
    })
    existingChangeIdentity = newExistingChangeIdentity()
    existingChangeIdentity.invalidated = true
    // Only the revision the runtime just returned may re-arm the confirmation.
    existingChangeSaveRejected = false
    renderExistingChange(snapshot)
    setExistingChangeFeedback('修改已保存；旧确认已失效，请确认当前修订。')
  } catch (error) {
    existingChangeSaveRejected = true
    existingChangeConfirmButton.disabled = true
    existingChangeConfirmation.textContent = existingChangeConfirmationText('stale-edit')
    showExistingChangeError(error)
    setExistingChangeFeedback(`修改未保存：${error.message} · ${error.nextAction || 'inspect the runtime'}`)
  } finally {
    existingChangeSaveButton.disabled = false
  }
}

async function confirmExistingChange() {
  if (existingChangeInFlight) return
  const snapshot = existingChangeSnapshot
  const revision = snapshot?.revision
  const target = value(existingChangeIntake, 'taskRef')
  if (!existingChangeInteractionId || !revision) {
    setExistingChangeFeedback('请先整理变更提案。')
    return
  }
  if (snapshot.state !== 'awaiting-confirmation') {
    setExistingChangeFeedback(`当前状态：${snapshot.state}。${snapshot.nextAction || ''}`)
    return
  }
  // The confirmation action re-checks the screen itself: a disabled button is
  // not the authorization boundary, the exact revision is.
  const blocker = existingChangeConfirmBlocker()
  if (blocker === 'unsaved-edit' || blocker === 'stale-edit') {
    const refusal = existingChangeBlockerRefusal(blocker)
    existingChangeConfirmButton.disabled = true
    showExistingChangeError(Object.assign(new Error(refusal.message), {
      code: refusal.code,
      ownerId: 'humanagent.ui.existing-change',
      nextAction: refusal.nextAction,
    }))
    setExistingChangeFeedback(refusal.feedback)
    return
  }
  const draftTarget = existingChangeCurrentTaskRef(snapshot)
  if (!draftTarget) {
    existingChangeConfirmButton.disabled = true
    showExistingChangeError(Object.assign(new Error('整理结果没有绑定当前任务，不能提交变更。'), {
      code: 'explicit-brain.missing-existing-task-target',
      ownerId: 'humanagent.runtime.explicit-brain',
      nextAction: 'select the task that owns the confirmed draft revision before submitting the change',
    }))
    return
  }
  if (draftTarget !== target) {
    existingChangeConfirmButton.disabled = true
    showExistingChangeError(Object.assign(new Error(`变更目标 ${target} 与整理结果 ${draftTarget} 不一致。`), {
      code: 'explicit-brain.task-target-mismatch',
      ownerId: 'humanagent.runtime.explicit-brain',
      nextAction: 'select the task that owns the confirmed draft revision before submitting the change',
    }))
    return
  }
  if (!existingChangeIdentity) existingChangeIdentity = newExistingChangeIdentity()
  existingChangeInFlight = true
  existingChangeConfirmButton.disabled = true
  existingChangeSaveButton.disabled = true
  clearExistingChangeError()
  setExistingChangeFeedback('正在单独确认并提交变更…')
  try {
    const receipt = await api.confirmExplicitRequirement(existingChangeInteractionId, {
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      draftRevisionVersion: revision.revisionVersion,
      draftRevisionHash: revision.revisionHash,
      confirmationRef: existingChangeIdentity.confirmationRef,
      confirmedBy: 'human:operator',
      confirmedAt: existingChangeIdentity.confirmedAt,
      payloadRef: existingChangeIdentity.payloadRef,
      idempotencyKey: existingChangeIdentity.idempotencyKey,
      requestKind: 'existing-task-change',
      taskRef: { scope: 'task', value: target },
    })
    const requirement = receipt?.requirement
    existingChangeIdentity.submitted = true
    existingChangeIdentity.receiptText = requirement
      ? `requirement=${requirement.requirementId} · draft=${requirement.draftId} · inputRevision=${requirement.inputRevision}`
      : 'requirement accepted'
    renderExistingChange(snapshot)
    setExistingChangeFeedback(`变更已提交：${existingChangeIdentity.receiptText}`)
    showServerResult(receipt)
  } catch (error) {
    showExistingChangeError(error)
    setExistingChangeFeedback(`${error.message} · ${error.nextAction || 'inspect the runtime'}`)
    existingChangeConfirmButton.disabled = Boolean(existingChangeConfirmBlocker())
    existingChangeSaveButton.disabled = false
  } finally {
    existingChangeInFlight = false
  }
}

function showServerResult(result) {
  serverResult.textContent = JSON.stringify(result, null, 2)
}

function showError(error) {
  const message = `${readable(error.message, 'Runtime API request failed')} · owner=${readable(error.ownerId, 'unknown')} · next=${readable(error.nextAction, 'inspect runtime error')}`
  setFeedback(message)
  appendPairingEntry(feedback, error)
  diagnostic.textContent = message
  showServerResult({ error: message, code: readable(error.code, 'runtime.request.failed') })
}

function setFlow({ state, task, action, note, meta }) {
  if (state !== undefined) flowState.textContent = state
  if (task !== undefined) flowTask.textContent = task
  if (action !== undefined) flowAction.textContent = action
  if (note !== undefined) flowNote.textContent = note
  if (meta !== undefined) flowMeta.textContent = meta
}

function renderDraftFeedback(draft) {
  clearNode(draftFeedback)
  const fields = draft
    ? [
        ['意图', draft.proposedIntent],
        ['规范化输入', draft.normalizedInput],
        ['已知事实', draft.knownFacts],
        ['建议', draft.proposal],
      ]
    : [['状态', '尚未生成整理反馈。']]
  for (const [label, content] of fields) {
    const row = element('div')
    row.append(element('dt', label), element('dd', readable(content)))
    draftFeedback.append(row)
  }
}

function renderInspection(snapshot) {
  currentInspection = snapshot
  if (visibleState) visibleState.textContent = readable(snapshot.state)
  interactionIdLabel.textContent = `interaction=${readable(snapshot.interactionId)}`
  clearNode(inspection)
  for (const [label, content] of [
    ['state', snapshot.state],
    ['owner', snapshot.owner],
    ['next action', snapshot.nextAction],
    ['condition', snapshot.condition],
    ['input', snapshot.rawInput],
    ['draft', snapshot.draft],
    ['confirmation', snapshot.confirmation],
    ['history', snapshot.history],
  ]) {
    const row = element('div')
    row.append(element('dt', label), element('dd', readable(content)))
    inspection.append(row)
  }
  renderDraftFeedback(snapshot.draft)
  showServerResult(snapshot)
  if (snapshot.draft) {
    field(confirmationForm, 'draftId').value = snapshot.draft.draftId
    field(confirmationForm, 'inputRevision').value = String(snapshot.draft.inputRevision)
  }
  const state = snapshot.state
  matchButton.disabled = !(interactionId && state === 'received')
  for (const button of statusButtons) button.disabled = !(interactionId && ['received', 'matching', 'awaiting-intent'].includes(state))
  proposalButton.disabled = !(interactionId && ['awaiting-intent', 'awaiting-confirmation'].includes(state))
  confirmationButton.disabled = !(interactionId && state === 'awaiting-confirmation' && snapshot.draft)
  dispatchButton.disabled = !(interactionId && state === 'confirmed')
  setFlow({
    state: readable(snapshot.state),
    task: snapshot.taskId?.value ?? snapshot.draft?.proposedIntent ?? '—',
    action: snapshot.nextAction ?? '—',
    note: snapshot.condition ?? '等待输入或继续操作。',
    meta: snapshot.owner ?? '',
  })
}

async function refreshInspection() {
  if (!interactionId) return
  const snapshot = await api.inspectExplicitInteraction(interactionId)
  renderInspection(snapshot)
  return snapshot
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'request.timeout', ownerId: 'ui.timeout', nextAction: 'retry the request or check the runtime' })), ms)
  })
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}

async function run(action, successMessage, options = {}) {
  try {
    const promise = action()
    const result = options.timeoutMs ? await withTimeout(promise, options.timeoutMs, options.label || 'request') : await promise
    if (interactionId) await refreshInspection()
    if (result !== undefined) showServerResult(result)
    if (successMessage) setFeedback(successMessage)
    return result
  } catch (error) {
    showError(error)
    setFlow({ note: `${error.message} · ${error.nextAction || 'inspect the runtime'}` })
    return undefined
  }
}

inputForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(async () => {
    const result = await api.receiveExplicitInput({
      sourceRef: value(inputForm, 'sourceRef'),
      rawInput: value(inputForm, 'rawInput'),
      inputRevision: Number(value(inputForm, 'inputRevision')),
    })
    interactionId = result.interactionId
    await refreshInspection()
    return result
  }, '输入已接收；正在调用 interpret。', { timeoutMs: INTERPRET_TIMEOUT_MS, label: 'interpretExplicitInput' })
})

matchingForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(async () => {
    const matchedTasksText = value(matchingForm, 'matchedTasks') || '[]'
    const matchedTasks = JSON.parse(matchedTasksText)
    if (!Array.isArray(matchedTasks)) throw new Error('matchedTasks must be a JSON array')
    if (currentInspection?.state === 'received') await api.beginExplicitMatching(interactionId)
    await api.recordExplicitMatch(interactionId, {
      normalizedInput: currentInspection?.draft?.normalizedInput || currentInspection?.rawInput || '',
      matchedTasks,
      knownFacts: value(matchingForm, 'knownFacts').split('\n').map((item) => item.trim()).filter(Boolean),
    })
  }, 'match result 已由服务端记录。')
})

proposalForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(() => api.proposeExplicitRequirement(interactionId, {
    proposedIntent: value(proposalForm, 'proposedIntent'),
    proposal: value(proposalForm, 'proposal'),
    decisionRefs: value(proposalForm, 'decisionRefs').split('\n').map((item) => item.trim()).filter(Boolean),
  }), 'proposal 已提交；确认前不会进入 FIFO。')
})

confirmationForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(() => api.confirmExplicitRequirement(interactionId, {
    draftId: value(confirmationForm, 'draftId'),
    inputRevision: Number(value(confirmationForm, 'inputRevision')),
    confirmationRef: value(confirmationForm, 'confirmationRef'),
    confirmedBy: value(confirmationForm, 'confirmedBy'),
    confirmedAt: new Date(value(confirmationForm, 'confirmedAt')).toISOString(),
    payloadRef: value(confirmationForm, 'payloadRef'),
  }), 'confirmation receipt 已返回；现在才允许 dispatch。')
})

existingChangeIntake.addEventListener('submit', (event) => void organizeExistingChange(event))
existingChangeEdit.addEventListener('submit', (event) => void saveExistingChange(event))
existingChangeConfirmButton.addEventListener('click', () => void confirmExistingChange())
const existingChangeTaskRefInput = (() => {
  try { return existingChangeIntake?.elements?.namedItem?.('taskRef') ?? null } catch (_) { return null }
})()
existingChangeTaskRefInput?.addEventListener('input', () => {
  const snapshot = existingChangeSnapshot
  if (!snapshot?.revision || existingChangeIdentity?.submitted) return
  const target = value(existingChangeIntake, 'taskRef')
  const draftTarget = existingChangeCurrentTaskRef(snapshot)
  // Correcting the target clears only the previous mismatch. A wrong target is
  // not refused here: the human still presses the separate confirmation and
  // gets the runtime-typed mismatch error. An unsaved edit or a rejected save
  // keeps its own gate closed, because no server revision owns those fields.
  if (snapshot.state === 'awaiting-confirmation' && Boolean(draftTarget) && draftTarget === target
    && !existingChangeConfirmBlocker()) {
    existingChangeConfirmButton.disabled = false
    clearExistingChangeError()
  }
})

// Typing in the reviewable fields makes the confirmation unavailable at once:
// the displayed text no longer belongs to any revision the runtime returned.
for (const name of ['goal', 'scope', 'proposal']) {
  const editorInput = (() => {
    try { return existingChangeEdit?.elements?.namedItem?.(name) ?? null } catch (_) { return null }
  })()
  editorInput?.addEventListener('input', () => {
    if (!existingChangeSnapshot?.revision) return
    const blocker = existingChangeConfirmBlocker()
    existingChangeConfirmButton.disabled = Boolean(blocker)
    existingChangeConfirmation.textContent = existingChangeConfirmationText(blocker)
  })
}

// A Task Detail deep link can name the exact task whose change is being
// proposed. The input stays editable, but the default is the selected task.
try {
  const linkedTask = new URLSearchParams(globalThis.location?.search || '').get('task')
  if (linkedTask && existingChangeTaskRefInput) existingChangeTaskRefInput.value = linkedTask
} catch (_) {
  // A missing or non-browser location only means there is no deep link to apply.
}

for (const button of statusButtons) {
  button.addEventListener('click', () => void run(async () => {
    if (currentInspection?.state === 'received') await api.beginExplicitMatching(interactionId)
    return api.completeExplicitStatusQuery(interactionId)
  }, 'status-only receipt 已返回；未创建 FIFO 或 Task。'))
}

dispatchButton.addEventListener('click', () => void run(
  () => api.dispatchNextExplicitRequirement(),
  'dispatch receipt 已返回；Task 状态请继续从 Runtime projection 查询。',
))

document.querySelector('[data-action="steer"]').addEventListener('click', () => void run(
  () => api.stop(value(controlForm, 'taskId')),
  'steer/stop 已通过正式 stop operation route 请求。',
))

document.querySelector('[data-action="continue"]').addEventListener('click', () => void run(
  async () => {
    const status = await api.status()
    return api.startExecution(value(controlForm, 'taskId'), { mode: status.mode, prompt: value(controlForm, 'prompt') })
  },
  'continue 已通过正式 execution route 请求。',
))

for (const radio of confirmPolicyRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return
    confirmPolicy = radio.value
    setFlow({ note: confirmPolicy === 'auto' ? '自动确认已启用；提交后将直接 confirm + dispatch。' : '手动确认已启用；proposal 后需要点击确认。' })
  })
}

function renderTasks(tasksData) {
  clearNode(taskList)
  const all = []
  for (const group of ['running', 'waiting', 'draft', 'completed', 'stopped', 'failed']) {
    for (const task of tasksData[group] ?? []) all.push({ task, group })
  }
  if (all.length === 0) {
    taskList.append(element('li', '当前没有任务。请使用“直接创建任务”或在输入框提交需求。', 'task-row-empty'))
    taskQueueMeta.textContent = '0 项'
    return
  }
  taskQueueMeta.textContent = `${all.length} 项`
  for (const { task, group } of all) {
    const row = element('li', undefined, 'task-row')
    if (task.taskId?.value === selectedTaskId) row.classList.add('is-selected')
    const info = element('div')
    info.append(
      element('strong', task.title || task.taskId?.value),
      element('small', `${group} · ${task.currentState || task.stateLabel || task.state}`),
    )
    const chip = element('span', task.stateLabel || task.state, 'state-chip')
    chip.dataset.tone = stateTone(task.state)
    info.append(chip)
    const meta = element('div', undefined, 'task-row-meta')
    meta.append(element('time', formatTime(task.updatedAt)))
    row.append(info, meta)
    row.tabIndex = 0
    row.addEventListener('click', () => selectTask(task.taskId?.value, task.title))
    taskList.append(row)
  }
}

function selectTask(taskIdValue, title) {
  selectedTaskId = taskIdValue
  field(createTaskForm, 'taskId').value = taskIdValue || ''
  field(createTaskForm, 'title').value = title || ''
  updateTaskButton.disabled = !taskIdValue
  deleteTaskButton.disabled = !taskIdValue
  setCreateFeedback(taskIdValue ? `已选择任务 ${taskIdValue}（${title || ''}）；可以保存修改或删除。` : '尚未选择任务。')
  liveEventMeta.textContent = taskIdValue ? `已选择 ${taskIdValue}` : '尚无事件。'
  if (taskIdValue) void loadLiveEvents(taskIdValue)
  renderTasks({ running: tasks.running ?? [], waiting: tasks.waiting ?? [], draft: tasks.draft ?? [], completed: tasks.completed ?? [], stopped: tasks.stopped ?? [], failed: tasks.failed ?? [] })
}

async function loadTasks() {
  try {
    const list = await api.listTasks()
    tasks = list
    renderTasks(list)
  } catch (error) {
    clearNode(taskList)
    const failure = element('li', `${error.message} · ${error.nextAction || 'inspect runtime'}`, 'task-row-empty')
    taskList.append(failure)
    appendPairingEntry(failure, error)
  }
}

async function loadLiveEvents(taskIdValue) {
  clearNode(liveEventList)
  try {
    const detail = await api.taskDetail(taskIdValue)
    const events = detail.recentEvents ?? detail.events ?? []
    if (events.length === 0) {
      liveEventList.append(element('li', '该任务尚无事件。', 'event-row-empty'))
      return
    }
    for (const event of events.slice(-15).reverse()) {
      const row = element('li', undefined, 'event-row')
      row.append(element('time', formatTime(event.occurredAt)))
      const body = element('div')
      body.append(element('span', event.kind, 'event-row-kind'), element('p', event.summary || event.state || ''))
      row.append(body)
      liveEventList.append(row)
    }
  } catch (error) {
    liveEventList.append(element('li', `${error.message} · ${error.nextAction || 'inspect runtime'}`, 'event-row-empty'))
  }
}

createTaskForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void (async () => {
    const title = value(createTaskForm, 'title')
    const directive = value(createTaskForm, 'directive')
    if (!title) {
      setCreateFeedback('任务名称必填。')
      return
    }
    try {
      const created = await api.createTask({ title, ...(directive ? { directive } : {}) })
      setCreateFeedback(`已创建任务 ${created.taskId?.value || created.taskId}。`)
      field(createTaskForm, 'title').value = ''
      field(createTaskForm, 'directive').value = ''
      await loadTasks()
      if (created.taskId?.value) await loadLiveEvents(created.taskId.value)
    } catch (error) {
      setCreateFeedbackError(error)
    }
  })()
})

updateTaskButton.addEventListener('click', () => void (async () => {
  const taskIdValue = value(createTaskForm, 'taskId')
  const title = value(createTaskForm, 'title')
  if (!taskIdValue) {
    setCreateFeedback('请先从任务队列选择要修改的任务。')
    return
  }
  if (!title) {
    setCreateFeedback('任务名称必填。')
    return
  }
  try {
    await api.updateTask(taskIdValue, { title })
    setCreateFeedback(`已更新任务 ${taskIdValue}。`)
    await loadTasks()
  } catch (error) {
    setCreateFeedbackError(error)
  }
})())

deleteTaskButton.addEventListener('click', () => void (async () => {
  const taskIdValue = value(createTaskForm, 'taskId')
  if (!taskIdValue) {
    setCreateFeedback('请先从任务队列选择要删除的任务。')
    return
  }
  if (!window.confirm(`删除任务 ${taskIdValue}？`)) return
  try {
    await api.deleteTask(taskIdValue)
    setCreateFeedback(`已删除任务 ${taskIdValue}。`)
    field(createTaskForm, 'taskId').value = ''
    field(createTaskForm, 'title').value = ''
    selectedTaskId = undefined
    updateTaskButton.disabled = true
    deleteTaskButton.disabled = true
    await loadTasks()
  } catch (error) {
    setCreateFeedbackError(error)
  }
})())

void api.status().then((status) => {
  runtimeMode.textContent = `mode=${readable(status.mode)}`
  runtimeStatus.dataset.tone = status.state === 'ready' ? 'success' : 'warning'
  runtimeStatus.textContent = `mode=${status.mode} · provider=${status.providerState}`
}).catch(showError)

void loadTasks()
