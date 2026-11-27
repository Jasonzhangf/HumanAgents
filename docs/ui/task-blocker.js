import { sanitizeUserVisibleText } from './step-labels.js'

const messages = {
  'unknown.event': '模型服务返回了无法识别的响应事件，任务已暂停。',
}

const recoveryActions = {
  'inspect the runtime error and retry from a new operation': '查看执行错误，再从新一轮执行重试。',
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
  const explained = explainedToolErrorReason(error)
  if (explained !== undefined) return explained
  return Object.hasOwn(messages, error?.code) ? messages[error.code] : sanitizeUserVisibleText(error?.message)
}

export function taskBlocker(task) {
  const { error, state, nextStep } = task
  if (!error && state !== 'blocked' && state !== 'failed') return null
  const nextAction = error?.nextAction
  return {
    code: error?.code,
    reason: userFacingErrorReason(error) || (state === 'failed' ? '任务执行失败。' : '任务暂停，等待处理。'),
    next: Object.hasOwn(recoveryActions, nextAction) ? recoveryActions[nextAction]
      : sanitizeUserVisibleText(nextStep || nextAction),
  }
}
