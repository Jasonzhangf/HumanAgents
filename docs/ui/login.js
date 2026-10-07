/**
 * The browser pairing entry.
 *
 * It drives only the two public auth edges the runtime publishes for a browser:
 * `GET /api/auth/session` and a same-origin `POST /api/auth/pair {code}`. The
 * pairing challenge and the supervisor token stay in the control plane, and no
 * credential is ever written into a business payload.
 */

import {
  clearNode,
  createRuntimeApi,
  element,
  formatTime,
  queryParam,
  sameOriginPath,
} from './runtime-api.js'

const api = createRuntimeApi()

// The entry the browser was trying to reach. `sameOriginPath` refuses anything
// that is not a same-origin absolute path, so `?next=` cannot become an open
// redirect.
const entryTarget = sameOriginPath(queryParam('next'))

const sessionState = document.querySelector('[data-auth-session-state]')
const statusBanner = document.querySelector('[data-auth-status]')
const pairCard = document.querySelector('[data-pair-card]')
const form = document.querySelector('[data-pair-form]')
const codeInput = document.querySelector('[data-pair-code]')
const submitButton = document.querySelector('[data-pair-submit]')
const errorCard = document.querySelector('[data-auth-error]')
const errorDetail = document.querySelector('[data-auth-error-detail]')
const errorRetry = document.querySelector('[data-auth-error-retry]')

function setBanner(tone, text) {
  statusBanner.dataset.tone = tone
  clearNode(statusBanner)
  statusBanner.append(element('span', text))
}

function clearTypedError() {
  errorCard.hidden = true
  errorRetry.hidden = true
  clearNode(errorDetail)
}

// The typed rejection is rendered field by field. Each field also carries the raw
// value on its own hook, so a reader never has to parse the rendered copy and the
// runtime's code/owner/message/nextAction stay separable.
function showTypedError(error) {
  clearNode(errorDetail)
  const fields = [
    ['code', error?.code ?? 'auth.pair.failed'],
    ['owner', error?.ownerId ?? 'unknown'],
    ['message', error?.message ?? String(error)],
    ['next', error?.nextAction ?? 'inspect the runtime error'],
  ]
  for (const [label, value] of fields) {
    const term = element('dt', label)
    const detail = element('dd', value)
    detail.setAttribute(`data-auth-error-${label}`, value)
    errorDetail.append(term, detail)
  }
  errorCard.hidden = false
  errorCard.dataset.tone = 'danger'
  errorRetry.hidden = false
  errorRetry.textContent = '重试：在运行 HumanAgent 的机器上重新执行 humanagent pair，再把新的配对码填回上面的输入框。'
  errorRetry.dataset.authErrorRetry = 'true'
}

async function submitPairing(code) {
  submitButton.disabled = true
  setBanner('warning', '正在提交配对码…')
  try {
    await api.authPair(code)
    clearTypedError()
    sessionState.textContent = '已配对'
    setBanner('success', '配对成功，正在回到刚才请求的那个页面…')
    location.assign(entryTarget)
    return true
  } catch (error) {
    setBanner('danger', '配对未完成')
    showTypedError(error)
    codeInput.value = ''
    codeInput.focus()
    return false
  } finally {
    submitButton.disabled = false
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitPairing(codeInput.value.trim())
})

async function boot() {
  // A shell that already hit a typed session rejection carries that exact
  // rejection here, so the page can show what the runtime said before it
  // re-reads the session.
  const carriedCode = queryParam('authCode')
  if (typeof carriedCode === 'string' && carriedCode.startsWith('auth.')) {
    showTypedError({
      code: carriedCode,
      ownerId: queryParam('authOwner') ?? '',
      message: queryParam('authMessage') ?? '',
      nextAction: queryParam('authNext') ?? '',
    })
  }

  setBanner('warning', '正在检查浏览器会话…')
  try {
    const session = await api.authSession()
    if (session?.authenticated === true) {
      sessionState.textContent = `已配对 · 到期 ${formatTime(session.expiresAt)}`
      setBanner('success', '这台浏览器已经配对，正在回到刚才请求的那个页面…')
      location.assign(entryTarget)
      return
    }
    sessionState.textContent = '未配对'
    setBanner('warning', '这台浏览器还没有配对会话。填入一次性配对码即可继续。')
    // The pairing card stays hidden until the session read says this browser is
    // unpaired. A paired browser following a stale pairing link is redirected
    // without ever seeing a code field it does not need.
    pairCard.hidden = false
    codeInput.focus()
  } catch (error) {
    sessionState.textContent = '会话检查失败'
    setBanner('danger', '无法读取浏览器会话')
    showTypedError(error)
    // The session could not be read, so pairing is the only remedy left; offer
    // it instead of leaving the page with no action.
    pairCard.hidden = false
  }
}

void boot()
