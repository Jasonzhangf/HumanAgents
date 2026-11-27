import { sanitizeUserVisibleText } from './step-labels.js'

const messages = {
  'unknown.event': '模型服务返回了无法识别的响应事件，任务已暂停。',
  'http.401': '模型服务鉴权失败，请检查账号凭据后重试。',
  'http.403': '模型服务无权访问所选模型或路由，请检查账号权限。',
  'transport.failure': '模型服务网络连接异常，请求未能完成。',
}

const recoveryActions = {
  'inspect the runtime error and retry from a new operation': '查看执行错误，再从新一轮执行重试。',
}

function isAllAccountsExhausted429(message) {
  return typeof message === 'string' && /所有候选账号对模型.*均已限额或禁用/.test(message)
}

function extractRecoveryTime(message) {
  if (typeof message !== 'string') return ''
  const match = /恢复时间[：:]\s*([^\s"'\\}]+)/.exec(message)
  return match?.[1] ? `（预计恢复时间：${match[1]}）` : ''
}

function http429Reason(error) {
  const raw = typeof error?.message === 'string' ? error.message : ''
  if (isAllAccountsExhausted429(raw)) {
    return `模型服务候选账号均已限额或禁用，当前暂无可用配额${extractRecoveryTime(raw)}。`
  }
  return '模型服务请求过于频繁或配额受限，请稍后重试。'
}

function localizedRecoveryAction(action, error) {
  const value = typeof action === 'string' ? action.trim() : ''
  if (Object.hasOwn(recoveryActions, value)) return recoveryActions[value]
  if (error?.code === 'http.429' && isAllAccountsExhausted429(error?.message)) {
    return '请先恢复或切换可用模型账号，再重新执行任务。'
  }
  if (/^recover:humanagent\.provider-adapter(?:\.|$)/.test(value)) {
    return '检查模型服务账号、配额或连接状态后重试。'
  }
  if (/^recover:(?:execution|assignment)\.retry\./.test(value)) {
    return '等待重试结果，或查看原因后重新执行。'
  }
  if (/^recover:/.test(value)) {
    return '查看暂停原因并处理后继续执行。'
  }
  return sanitizeUserVisibleText(value)
}

export function explainedToolErrorReason(error) {
  if (error?.code === 'tool.argument.invalid' && error?.message === 'search path escapes the bound workspace') {
    return '路径无效；请改用项目工作区内的相对路径。'
  }
  if (error?.code === 'tool.argument.invalid' && error.message === 'bash timeoutMs must be an integer from 1 to 120000') {
    return 'Bash 等待上限必须是 1 到 120,000 毫秒之间的整数。'
  }
  if (error?.code === 'tool.result.failure' && error.message === 'tool settled after stop; admitted effects require reconciliation') {
    return '工具在停止后才返回，运行时需核对这次调用的影响。'
  }
}

export function userFacingErrorReason(error) {
  if (/^http\.5\d\d$/.test(error?.code ?? '')) return '模型服务暂时不可用'
  if (error?.code === 'http.429') return http429Reason(error)
  const explained = explainedToolErrorReason(error)
  if (explained !== undefined) return explained
  return Object.hasOwn(messages, error?.code) ? messages[error.code] : sanitizeUserVisibleText(error?.message)
}

export function taskBlocker(task) {
  const { error, state, nextStep } = task
  if (!error && state !== 'blocked' && state !== 'failed') return null
  const nextAction = error?.nextAction
  const rawNext = nextStep || nextAction
  return {
    code: error?.code,
    reason: userFacingErrorReason(error) || (state === 'failed' ? '任务执行失败。' : '任务暂停，等待处理。'),
    next: localizedRecoveryAction(rawNext, error),
  }
}
