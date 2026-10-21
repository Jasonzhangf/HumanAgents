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
import { mountPageTemplate } from './runtime-shell.js'

const api = createRuntimeApi()

// The entry the browser was trying to reach. `sameOriginPath` refuses anything
// that is not a same-origin absolute path, so `?next=` cannot become an open
// redirect.
const entryTarget = sameOriginPath(queryParam('next'))

// The shared template replaces the children of its root at mount. Keep every
// live login node first, then transfer the valid form/error/session nodes into
// the standalone hosts so the static DOM is never cleared without retaining
// the exact form refs and their hooks.
const sessionState = document.querySelector('[data-auth-session-state]')
const pairCard = document.querySelector('[data-pair-card]')
const form = document.querySelector('[data-pair-form]')
const codeInput = document.querySelector('[data-pair-code]')
const submitButton = document.querySelector('[data-pair-submit]')
const pairCommand = document.querySelector('[data-pair-command]')
const detailHost = document.querySelector('[data-auth-detail-host]')
const errorCard = document.querySelector('[data-auth-error]')
const errorHeading = document.querySelector('[data-auth-error-heading]')
const errorImpact = document.querySelector('[data-auth-error-impact]')
const errorRetry = document.querySelector('[data-auth-error-retry]')
const errorReturn = document.querySelector('[data-auth-error-return]')
const errorExit = document.querySelector('[data-auth-error-exit]')

const template = mountPageTemplate(document.body, {
  layout: 'standalone',
  eyebrow: '浏览器会话',
  title: '配对这台浏览器',
  lede: '用一次性配对码连接这台浏览器。配对成功后，你会回到刚才请求的页面。',
})

const statusBanner = template.hosts.status
statusBanner.dataset.authStatus = ''
template.hosts.page.id = 'main-content'
template.hosts.page.dataset.loginPage = 'true'
template.hosts.heading.append(sessionState)
template.hosts.primary.append(detailHost, pairCard, errorCard)

const protocolFooter = '配对码属于控制面：它只经 POST /api/auth/pair 交给运行时，不会写进任何业务请求。'
let pairingCommand = ''
let pageDisposed = false

errorExit.href = entryTarget

function setPairingCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  pairingCommand = command
  pairCommand.textContent = command
  return true
}

function retryInstruction() {
  if (pairingCommand) {
    return `重试：在运行 HumanAgent 的机器上重新执行 ${pairingCommand}，再把新的配对码填回上面的输入框。`
  }
  return '重试：在运行 HumanAgent 的机器上重新获取配对码，再把新的配对码填回上面的输入框。'
}

function setBanner(tone, text) {
  statusBanner.dataset.tone = tone
  clearNode(statusBanner)
  statusBanner.append(element('span', text))
}

// Exact typed values keep their original per-field hooks, but they live in the
// contextual 技术详情 layer. The primary layer reads in human language instead.
function typedEntries(error) {
  return [
    ['code', error?.code ?? 'auth.pair.failed', 'data-auth-error-code'],
    ['owner', error?.ownerId ?? 'unknown', 'data-auth-error-owner'],
    ['message', error?.message ?? String(error), 'data-auth-error-message'],
    ['nextAction', error?.nextAction ?? 'inspect the runtime error', 'data-auth-error-next'],
  ]
}

function renderDetail(error) {
  clearNode(detailHost)
  const detail = {
    title: '技术详情',
    entries: typedEntries(error),
    footer: protocolFooter,
  }
  const trigger = element('button', '技术详情', 'button button--quiet')
  trigger.type = 'button'
  trigger.dataset.technicalDetailTrigger = 'true'
  trigger.addEventListener('click', () => template.detail.open(detail, trigger))
  detailHost.append(trigger)
}

function clearTypedError() {
  errorCard.hidden = true
  errorCard.dataset.errorKind = ''
  errorRetry.hidden = true
  codeInput.removeAttribute('aria-invalid')
  clearNode(detailHost)
}

// A rejected pairing attempt is the only state that shows the danger card. Carried session
// context and a session-check failure stay out of it, so ordinary setup is never presented as
// a failed attempt.
// The runtime refuses a pairing code with one of these two typed codes. Only a typed result proves
// that the code was rejected, so a request that never got a typed answer, such as a network failure,
// is reported as an unconfirmed pairing instead of as a refusal.
const PAIR_REJECTION_CODES = Object.freeze(['auth.pair.invalid', 'auth.pair.expired'])

function isPairRejection(error) {
  return typeof error?.code === 'string' && PAIR_REJECTION_CODES.includes(error.code)
}

function showPairFailure(error) {
  errorHeading.textContent = '配对未完成'
  if (isPairRejection(error)) {
    errorImpact.textContent = '这次配对码没有被接受，请重新获取配对码后再试。'
    errorRetry.textContent = retryInstruction()
  } else {
    errorImpact.textContent = '这次配对请求没有完成，运行时没有给出配对结果。'
    errorRetry.textContent = `重试：确认网络和运行中的 HumanAgent 都正常后，再重新提交配对码；这次请求的确切信息在技术详情里。${pairingCommand ? ` 当前配对命令：${pairingCommand}` : ''}`
  }
  errorImpact.hidden = false
  errorRetry.dataset.authErrorRetry = 'true'
  errorRetry.hidden = false
  codeInput.setAttribute('aria-invalid', 'true')
  errorCard.dataset.errorKind = 'pair'
  errorCard.dataset.tone = 'danger'
  errorCard.hidden = false
  renderDetail(error)
}

async function submitPairing(code) {
  submitButton.disabled = true
  setBanner('warning', '正在提交配对码…')
  try {
    await api.authPair(code)
    if (pageDisposed) return false
    clearTypedError()
    sessionState.textContent = '已配对'
    setBanner('success', '配对成功，正在回到刚才请求的那个页面…')
    location.assign(entryTarget)
    return true
  } catch (error) {
    if (pageDisposed) return false
    setBanner('danger', '配对未完成')
    showPairFailure(error)
    codeInput.focus()
    return false
  } finally {
    if (!pageDisposed) submitButton.disabled = false
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitPairing(codeInput.value.trim())
})

errorReturn.addEventListener('click', () => {
  clearTypedError()
  setBanner('warning', '请修改或重新填写配对码，再提交。')
  codeInput.focus()
})

async function boot() {
  // A shell that already hit a typed session rejection carries those exact fields here as
  // setup context. They stay in the 技术详情 layer; they do not mean this browser just made a
  // failed pairing attempt.
  const carriedCode = queryParam('authCode')
  const carried = typeof carriedCode === 'string' && carriedCode.startsWith('auth.')
    ? {
        code: carriedCode,
        ownerId: queryParam('authOwner') ?? '',
        message: queryParam('authMessage') ?? '',
        nextAction: queryParam('authNext') ?? '',
      }
    : null

  setBanner('warning', '正在检查浏览器会话…')
  try {
    const session = await api.authSession()
    if (pageDisposed) return
    setPairingCommand(session?.pairingCommand)
    if (session?.authenticated === true) {
      sessionState.textContent = `已配对 · 到期 ${formatTime(session.expiresAt)}`
      setBanner('success', '这台浏览器已经配对，正在回到刚才请求的那个页面…')
      location.assign(entryTarget)
      return
    }
    sessionState.textContent = '未配对'
    setBanner('warning', '这台浏览器还没有配对会话。填入一次性配对码即可继续。')
    if (!pairingCommand) pairCommand.textContent = '配对命令暂不可用'
    // The pairing card stays hidden until the session read says this browser is
    // unpaired. A paired browser following a stale pairing link is redirected
    // without ever seeing a code field it does not need.
    pairCard.hidden = false
    codeInput.focus()
    if (carried) renderDetail(carried)
  } catch (error) {
    if (pageDisposed) return
    sessionState.textContent = '会话检查失败'
    setBanner('danger', '无法读取浏览器会话，暂时无法确认这台浏览器是否已配对。')
    pairCommand.textContent = '配对命令暂不可用'
    renderDetail(error)
    // The session could not be read, so pairing is the only remedy left; offer
    // it instead of leaving the page with no action.
    pairCard.hidden = false
  }
}

window.addEventListener('pagehide', () => {
  pageDisposed = true
  template.dispose()
}, { once: true })

void boot()
