const dialog = document.querySelector('[data-agent-dialog]')
const title = document.querySelector('#agent-dialog-title')
const intro = document.querySelector('[data-dialog-intro]')
const processList = document.querySelector('[data-process-list]')
const output = document.querySelector('[data-dialog-output]')
let lastTrigger = null

const agentDetails = {
  input: {
    title: '交互 agent · 输入与任务目标',
    intro: '把用户输入整理成当前任务可以继续处理的目标。',
    steps: [['收到输入', '“重建导出索引，先检查现有分片。”'], ['确认任务', '匹配到“重建导出索引”，保留原始输入。'], ['交给任务编排', '任务目标已明确，不需要用户追加说明。']],
    output: '目标明确，进入“重建导出索引”任务。',
  },
  routing: {
    title: '任务编排 agent · 任务检查与派发',
    intro: '检查任务现状、可用条件和已完成工作，再把可执行部分交给对应 agent。',
    steps: [['收到任务', '接收任务目标和目录检查结果。'], ['检查条件', '确认目录可读，发现 4 个待处理分片。'], ['派发处理', '安排索引整理 agent 处理分片，并等待反馈。'], ['跟进结果', '收到 2/4 分片完成反馈，继续保持任务运行。']],
    output: '索引整理 agent 正在工作，暂时不需要用户处理。',
  },
  memory: {
    title: '记忆 agent · 经验与 skill 整理',
    intro: '检查这项任务是否产生可复用的经验或 skill 整理候选。',
    steps: [['接收记录', '等待任务产生完整处理结果。'], ['检查候选', '当前没有足够的新模式可以沉淀。'], ['保持等待', '任务结束后再次检查是否需要提交 review。']],
    output: '暂未发现需要整理的新 skill。',
  },
  'index-worker': {
    title: '索引整理 agent · 重建导出分片',
    intro: '这里显示当前 agent 的输入、处理摘要和输出，不展示私有思维链。',
    steps: [['接收输入', '导出目录和第 2 个分片。'], ['读取分片', '已完成目录检查，确认分片可读。'], ['写入索引', '正在写入第 2 个分片的索引。'], ['当前处理', '已完成 2/4 个分片，继续处理下一分片。']],
    output: '已完成 2/4 个分片，正在写入索引。',
  },
  verification: {
    title: '校验 agent · 等待索引结果',
    intro: '等待上游结果后，检查索引与导出分片是否一致。',
    steps: [['等待输入', '等待完整索引和分片结果。'], ['尚未开始', '没有可供校验的完整结果。']],
    output: '尚未开始校验。',
  },
}

function openAgent(agent, trigger) {
  const detail = agentDetails[agent]
  if (!detail) return
  lastTrigger = trigger
  title.textContent = detail.title
  intro.textContent = detail.intro
  output.textContent = detail.output
  processList.innerHTML = detail.steps.map(([label, summary], index) => `<li class="${index === detail.steps.length - 1 ? 'is-current' : ''}"><div><strong>${label}</strong><small>${summary}</small></div></li>`).join('')
  dialog.showModal()
  requestAnimationFrame(() => dialog.querySelector('button[type="submit"]')?.focus())
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-agent-trigger]')
  if (trigger) openAgent(trigger.dataset.agentTrigger, trigger)
})

dialog.addEventListener('close', () => lastTrigger?.focus())
