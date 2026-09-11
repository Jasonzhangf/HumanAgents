const shell = document.querySelector('.app-shell')
const steerButton = document.querySelector('#steerButton')
const settledMessage = document.querySelector('#settledMessage')
const attentionCard = document.querySelector('.attention-card')
const ackButton = document.querySelector('#ackButton')
const diagnosticDialog = document.querySelector('#diagnosticDialog')

for (const trigger of document.querySelectorAll('[data-open-diagnostic]')) {
  trigger.addEventListener('click', () => diagnosticDialog.showModal())
}

for (const trigger of document.querySelectorAll('[data-close-diagnostic]')) {
  trigger.addEventListener('click', () => diagnosticDialog.close())
}

diagnosticDialog.addEventListener('click', event => {
  if (event.target === diagnosticDialog) diagnosticDialog.close()
})

steerButton.addEventListener('click', () => {
  shell.dataset.mode = 'stopped'
  steerButton.textContent = '已停止'
  steerButton.disabled = true
  steerButton.setAttribute('aria-disabled', 'true')
  settledMessage.hidden = false
  document.querySelector('.status-pill').innerHTML = '<span class="status-dot status-dot--wait"></span>已收拢'
  document.querySelector('.hero-heading h2').textContent = '状态已收拢'
  document.querySelector('.hero-description').textContent = '停止 operation 已完成，当前状态已经写入 checkpoint。'
  document.querySelector('.progress-track span').style.width = '100%'
})

ackButton.addEventListener('click', () => {
  attentionCard.hidden = true
  document.querySelector('.attention-count').textContent = '0'
  document.querySelector('.decision-heading .eyebrow').textContent = '已处理'
})

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab
    for (const candidate of document.querySelectorAll('[data-tab]')) {
      const active = candidate === tab
      candidate.classList.toggle('is-active', active)
      candidate.setAttribute('aria-selected', String(active))
    }
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.classList.toggle('is-visible', panel.dataset.panel === target)
    }
  })
}

