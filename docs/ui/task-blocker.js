import { sanitizeUserVisibleText } from './step-labels.js'

const messages = {
  'unknown.event': '模型服务返回了无法识别的响应事件，任务已暂停。',
}

const recoveryActions = {
  'inspect the runtime error and retry from a new operation': '查看执行错误，再从新一轮执行重试。',
}

export function taskBlocker(task) {
  const { error, state, nextStep } = task
  if (!error && state !== 'blocked' && state !== 'failed') return null
  const nextAction = error?.nextAction
  return {
    code: error?.code,
    reason: Object.hasOwn(messages, error?.code) ? messages[error.code]
      : sanitizeUserVisibleText(error?.message) || (state === 'failed' ? '任务执行失败。' : '任务暂停，等待处理。'),
    next: Object.hasOwn(recoveryActions, nextAction) ? recoveryActions[nextAction]
      : sanitizeUserVisibleText(nextStep || nextAction),
  }
}
