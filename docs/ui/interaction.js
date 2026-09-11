const root = document.querySelector('.wireframe')
const feedback = document.querySelector('[data-action-feedback]')
const visibleState = document.querySelector('[data-visible-state]')
const currentTitle = document.querySelector('[data-current-title]')
const phase = document.querySelector('[data-phase]')
const decision = document.querySelector('[data-attention-state]')
const emptyDecision = document.querySelector('.empty-decision')
const attentionItem = document.querySelector('[data-attention-item]')
const attentionCount = document.querySelector('[data-attention-count]')
const attentionTitle = document.querySelector('[data-attention-title]')
const attentionCopy = document.querySelector('[data-attention-copy]')
const decisionMessage = document.querySelector('[data-decision-message]')
const decisionAction = document.querySelector('[data-action="approve-write"]')
const steerAction = document.querySelector('[data-action="steer"]')
const continueAction = document.querySelector('[data-action="continue"]')
const inspectAction = document.querySelector('[data-action="inspect-checkpoint"]')
const latestChange = document.querySelector('[data-region="human-timeline"] [data-task-latest]')
const diagnostic = document.querySelector('[data-dialog="diagnostic"]')

function announce(message) {
  feedback.textContent = message
}

for (const button of document.querySelectorAll('[data-action="open-diagnostic"]')) {
  button.addEventListener('click', () => diagnostic.showModal())
}

for (const button of document.querySelectorAll('[data-action="open-cause"], [data-action="open-raw-events"]')) {
  button.addEventListener('click', () => {
    diagnostic.showModal()
    announce('已打开隐式层诊断入口。')
  })
}

document.querySelector('[data-action="approve-write"]').addEventListener('click', () => {
  document.querySelector('[data-task].is-selected').dataset.taskAttention = 'acknowledged'
  decision.hidden = true
  emptyDecision.hidden = false
  attentionItem.hidden = true
  attentionCount.textContent = '0'
  announce('已确认当前决定。页面只演示显式决定完成后的状态。')
})

document.querySelector('[data-action="steer"]').addEventListener('click', () => {
  const selectedTask = document.querySelector('[data-task].is-selected')
  root.dataset.runtimeState = 'stopping'
  visibleState.textContent = '停止中 · 收拢 operation'
  selectedTask.dataset.taskStatus = '停止中 · 收拢 operation'
  selectedTask.querySelector('small').textContent = '正在收拢'
  phase.textContent = 'checkpoint completion'
  announce('已请求停止。下一步必须完成收拢并写入 stopped checkpoint。')
})

document.querySelector('[data-action="continue"]').addEventListener('click', () => {
  const selectedTask = document.querySelector('[data-task].is-selected')
  root.dataset.runtimeState = 'running'
  visibleState.textContent = '运行中'
  selectedTask.dataset.taskStatus = '运行中'
  selectedTask.querySelector('small').textContent = '运行中'
  phase.textContent = '下一轮执行'
  announce('已选择继续。页面只演示 command 到 projection 的交互路径。')
})

document.querySelector('[data-action="inspect-checkpoint"]').addEventListener('click', () => {
  document.querySelector('[data-region="implicit-entry"] details').open = true
  announce('已展开 checkpoint/后台详情入口。')
})

document.querySelector('[data-action="focus-decision"]').addEventListener('click', () => {
  document.querySelector('[data-region="human-decision"]').scrollIntoView({ behavior: 'smooth', block: 'start' })
  document.querySelector('[data-action="approve-write"]').focus()
})

for (const button of document.querySelectorAll('[data-task]')) {
  button.addEventListener('click', () => {
    for (const candidate of document.querySelectorAll('[data-task]')) {
      candidate.classList.toggle('is-selected', candidate === button)
      if (candidate === button) candidate.setAttribute('aria-current', 'page')
      else candidate.removeAttribute('aria-current')
    }

    currentTitle.textContent = button.dataset.taskTitle
    visibleState.textContent = button.dataset.taskStatus
    phase.textContent = button.dataset.taskPhase
    document.querySelector('[data-region="task-summary"] [data-task-target]').textContent = button.dataset.taskTarget
    document.querySelector('[data-region="task-summary"] [data-task-impact]').textContent = button.dataset.taskImpact
    latestChange.textContent = button.dataset.taskLatest

    const availableActions = button.dataset.taskActions.split(' ')
    steerAction.hidden = !availableActions.includes('steer')
    continueAction.hidden = !availableActions.includes('continue')
    inspectAction.hidden = !availableActions.includes('inspect')

    const hasAttention = button.dataset.taskAttention === 'open'
    decision.hidden = !hasAttention
    emptyDecision.hidden = hasAttention
    attentionItem.hidden = !hasAttention
    attentionCount.textContent = hasAttention ? '1' : '0'
    if (hasAttention) {
      attentionTitle.textContent = button.dataset.taskAttentionTitle
      attentionCopy.textContent = button.dataset.taskAttentionCopy
      decisionAction.textContent = button.dataset.taskDecisionAction
      decisionMessage.textContent = `${button.dataset.taskAttentionTitle}。现在要处理这个决定吗？`
    }
    announce(`已切换到任务：${button.querySelector('span').textContent}。`)
  })
}

for (const button of document.querySelectorAll('[data-mobile-view]')) {
  button.addEventListener('click', () => {
    for (const candidate of document.querySelectorAll('[data-mobile-view]')) {
      const selected = candidate === button
      candidate.classList.toggle('is-selected', selected)
      candidate.setAttribute('aria-pressed', String(selected))
    }

    const target = button.dataset.mobileView === 'task'
      ? document.querySelector('[data-region="current-task"]')
      : button.dataset.mobileView === 'attention'
        ? document.querySelector('[data-region="attention"]')
        : document.querySelector('[data-region="human-timeline"]')
    target.scrollIntoView({ behavior: 'auto', block: 'start' })
    announce(`已切换到手机版视图：${button.textContent}。`)
  })
}
