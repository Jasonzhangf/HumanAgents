import { createRuntimeApi, clearNode, element } from './runtime-api.js'

const api = createRuntimeApi()
const feedback = document.querySelector('[data-action-feedback]')
const diagnostic = document.querySelector('[data-diagnostic-output]')
const serverResult = document.querySelector('[data-server-result]')
const runtimeMode = document.querySelector('[data-runtime-mode]')
const visibleState = document.querySelector('[data-visible-state]')
const interactionIdLabel = document.querySelector('[data-interaction-id]')
const inspection = document.querySelector('[data-inspection]')
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

let interactionId
let currentInspection

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

function showServerResult(result) {
  serverResult.textContent = JSON.stringify(result, null, 2)
}

function showError(error) {
  const message = `${readable(error.message, 'Runtime API request failed')} · owner=${readable(error.ownerId, 'unknown')} · next=${readable(error.nextAction, 'inspect runtime error')}`
  setFeedback(message)
  diagnostic.textContent = message
  showServerResult({ error: message, code: readable(error.code, 'runtime.request.failed') })
}

function renderInspection(snapshot) {
  currentInspection = snapshot
  visibleState.textContent = readable(snapshot.state)
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
  showServerResult(snapshot)
  if (snapshot.draft) {
    field(confirmationForm, 'draftId').value = snapshot.draft.draftId
    field(confirmationForm, 'inputRevision').value = String(snapshot.draft.inputRevision)
    field(matchingForm, 'normalizedInput').value = snapshot.draft.normalizedInput
  }
  const state = snapshot.state
  matchButton.disabled = !(interactionId && state === 'received')
  for (const button of statusButtons) button.disabled = !(interactionId && ['received', 'matching', 'awaiting-intent'].includes(state))
  proposalButton.disabled = !(interactionId && ['awaiting-intent', 'awaiting-confirmation'].includes(state))
  confirmationButton.disabled = !(interactionId && state === 'awaiting-confirmation' && snapshot.draft)
  dispatchButton.disabled = !(interactionId && state === 'confirmed')
}

async function refreshInspection() {
  if (!interactionId) return
  const snapshot = await api.inspectExplicitInteraction(interactionId)
  renderInspection(snapshot)
  return snapshot
}

async function run(action, successMessage) {
  try {
    const result = await action()
    if (interactionId) await refreshInspection()
    if (result !== undefined) showServerResult(result)
    if (successMessage) setFeedback(successMessage)
    return result
  } catch (error) {
    showError(error)
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
    field(matchingForm, 'normalizedInput').value = value(inputForm, 'rawInput')
    return result
  }, '输入已接收；当前状态来自服务端 inspection。')
})

matchingForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(async () => {
    const matchedTasksText = value(matchingForm, 'matchedTasks') || '[]'
    const matchedTasks = JSON.parse(matchedTasksText)
    if (!Array.isArray(matchedTasks)) throw new Error('matchedTasks must be a JSON array')
    if (currentInspection?.state === 'received') await api.beginExplicitMatching(interactionId)
    await api.recordExplicitMatch(interactionId, {
      normalizedInput: value(matchingForm, 'normalizedInput'),
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

void api.status().then((status) => {
  runtimeMode.textContent = `mode=${readable(status.mode)}`
}).catch(showError)
