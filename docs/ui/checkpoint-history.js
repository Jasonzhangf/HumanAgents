import { element as defaultElement, stateTone } from './runtime-api.js'

// C5 shared checkpoint-history renderer and query-syntax helper.
//
// This module is read-only. It consumes an actual
// RuntimeReadResult<RuntimeCheckpointReadProjection> and renders it. It never
// fetches, persists, retries, steers, re-enters, or opens an overlay. Callers
// inject the shell's shared drawer and supply every action as a callback.

export const CHECKPOINT_QUERY_KEYS = Object.freeze({
  checkpointId: 'checkpointId',
  commitId: 'checkpointCommitId',
  journalSeq: 'checkpointJournalSeq',
  recordDigest: 'checkpointRecordDigest',
})

const RECEIPT_FIELDS = Object.freeze(['commitId', 'journalSeq', 'recordDigest'])
const QUERY_KEYS = Object.freeze(Object.values(CHECKPOINT_QUERY_KEYS))
const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/

const OUTCOME_TEXT = Object.freeze({
  succeeded: '已完成',
  waiting: '等待中',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已停止',
  unknown: '结果未知',
})

const NEXT_TEXT = Object.freeze({
  continue: '继续执行',
  wait: '等待',
  stop: '停止',
  recover: '从检查点恢复',
})

const SOURCE_TEXT = Object.freeze({
  'agent-tool': '代理工具提交',
  'harness-control': 'Harness 控制提交',
  recovery: '恢复流程提交',
})

const CONTEXT_MODE_TEXT = Object.freeze({
  observation: '观察模式',
  orchestration: '编排模式',
})

const CHECKPOINT_FILTER_TEXT = Object.freeze({
  directiveRevision: '指令修订',
  executionEpoch: '执行轮',
  cycleId: '周期',
  occurrenceRef: 'Occurrence 关联',
})

function invalidSelection(message) {
  return {
    ok: false,
    failure: {
      code: 'checkpoint-history.invalid-selection',
      ownerId: 'humanagent.ui.checkpoint-history',
      message,
      nextAction: '请选择完整的 checkpoint，或清除选择并返回当前执行位置。',
    },
  }
}

function asParams(params) {
  if (typeof params === 'string') return new URLSearchParams(params)
  if (params !== null && typeof params === 'object' && typeof params.getAll === 'function') return params
  return null
}

/** Validate the caller-side view target. This is syntax only, never identity. */
function normalizeViewed(viewed) {
  if (viewed === undefined || viewed === null) return { ok: true, value: undefined }
  if (typeof viewed !== 'object') return invalidSelection('checkpoint 查看目标无效。')
  const normalized = {}
  if (viewed.checkpointId !== undefined) {
    if (typeof viewed.checkpointId !== 'string' || !viewed.checkpointId.trim()) {
      return invalidSelection('checkpoint 标识无效。')
    }
    normalized.checkpointId = viewed.checkpointId
  }
  if (viewed.commitRef !== undefined) {
    const ref = viewed.commitRef
    if (ref === null || typeof ref !== 'object') return invalidSelection('checkpoint 物理收据无效。')
    if (RECEIPT_FIELDS.some((field) => ref[field] === undefined)) {
      return invalidSelection('物理 checkpoint 收据不完整：需要 commitId、journalSeq、recordDigest 三项。')
    }
    if (typeof ref.commitId !== 'string' || !ref.commitId.trim()) {
      return invalidSelection('checkpoint commitId 无效。')
    }
    if (!Number.isSafeInteger(ref.journalSeq) || ref.journalSeq < 0) {
      return invalidSelection('checkpoint 物理 journal 序号无效。')
    }
    if (typeof ref.recordDigest !== 'string' || !ref.recordDigest.trim()) {
      return invalidSelection('checkpoint recordDigest 无效。')
    }
    normalized.commitRef = {
      commitId: ref.commitId,
      journalSeq: ref.journalSeq,
      recordDigest: ref.recordDigest,
    }
  }
  if (normalized.checkpointId === undefined && normalized.commitRef === undefined) {
    return invalidSelection('checkpoint 查看目标缺少标识或物理收据。')
  }
  return { ok: true, value: normalized }
}

function sameViewed(left, right) {
  if (left === undefined || right === undefined) return left === right
  if (left.checkpointId !== right.checkpointId) return false
  if ((left.commitRef === undefined) !== (right.commitRef === undefined)) return false
  if (left.commitRef === undefined) return true
  return left.commitRef.commitId === right.commitRef.commitId
    && left.commitRef.journalSeq === right.commitRef.journalSeq
    && left.commitRef.recordDigest === right.commitRef.recordDigest
}

/**
 * Decode the view target from URL parameters. Omitted target keys mean "follow
 * the authoritative current"; they never select the first history entry.
 */
export function checkpointSelectionFromQuery(params) {
  const source = asParams(params)
  if (!source) return invalidSelection('checkpoint 选择参数无效。')
  const raw = {}
  for (const [field, key] of Object.entries(CHECKPOINT_QUERY_KEYS)) {
    const values = source.getAll(key)
    if (values.length > 1) return invalidSelection(`checkpoint 选择参数重复：${key}`)
    if (values.length === 1) {
      if (!values[0].trim()) return invalidSelection(`checkpoint 选择参数为空：${key}`)
      raw[field] = values[0]
    }
  }
  if (Object.keys(raw).length === 0) return { ok: true, value: {} }
  const receiptFields = RECEIPT_FIELDS.filter((field) => raw[field] !== undefined)
  if (receiptFields.length > 0 && receiptFields.length < RECEIPT_FIELDS.length) {
    return invalidSelection('物理 checkpoint 收据不完整：需要 commitId、journalSeq、recordDigest 三项。')
  }
  const viewed = {}
  if (raw.checkpointId !== undefined) viewed.checkpointId = raw.checkpointId
  if (receiptFields.length === RECEIPT_FIELDS.length) {
    if (!NON_NEGATIVE_INTEGER.test(raw.journalSeq)) {
      return invalidSelection('checkpoint 物理 journal 序号无效。')
    }
    const journalSeq = Number(raw.journalSeq)
    if (!Number.isSafeInteger(journalSeq)) return invalidSelection('checkpoint 物理 journal 序号无效。')
    viewed.commitRef = { commitId: raw.commitId, journalSeq, recordDigest: raw.recordDigest }
  }
  const normalized = normalizeViewed(viewed)
  if (!normalized.ok) return normalized
  return { ok: true, value: { viewed: normalized.value } }
}

/**
 * Encode the view target. Every unrelated parameter and duplicate is preserved.
 * Only the four documented checkpoint keys are removed and rewritten.
 */
export function checkpointQuery(params, query = {}) {
  const source = asParams(params)
  if (!source) return invalidSelection('checkpoint 父级查询参数无效。')
  const normalized = normalizeViewed(query === null || typeof query !== 'object' ? undefined : query.viewed)
  if (!normalized.ok) return normalized
  const result = new URLSearchParams(source)
  for (const key of QUERY_KEYS) result.delete(key)
  const viewed = normalized.value
  if (viewed !== undefined) {
    if (viewed.checkpointId !== undefined) result.set(CHECKPOINT_QUERY_KEYS.checkpointId, viewed.checkpointId)
    if (viewed.commitRef !== undefined) {
      result.set(CHECKPOINT_QUERY_KEYS.commitId, viewed.commitRef.commitId)
      result.set(CHECKPOINT_QUERY_KEYS.journalSeq, String(viewed.commitRef.journalSeq))
      result.set(CHECKPOINT_QUERY_KEYS.recordDigest, viewed.commitRef.recordDigest)
    }
  }
  const roundTrip = checkpointSelectionFromQuery(result)
  if (!roundTrip.ok) return roundTrip
  if (!sameViewed(roundTrip.value.viewed, viewed)) {
    return invalidSelection('checkpoint 选择参数无法稳定往返。')
  }
  return { ok: true, value: result }
}

function outcomeText(outcome) {
  return OUTCOME_TEXT[outcome] ?? String(outcome)
}

function nextActionText(next) {
  if (!next) return '未提供'
  return NEXT_TEXT[next.kind] ?? String(next.kind)
}

function rendering(options, title) {
  const make = typeof options.element === 'function' ? options.element : defaultElement
  const root = make('section', undefined, 'panel')
  root.setAttribute('aria-label', title)
  const listeners = []
  function action(parent, label, callback, payload, className = 'button button--quiet') {
    if (typeof callback !== 'function') return undefined
    const button = make('button', label, className)
    button.type = 'button'
    const listener = () => callback(payload)
    button.addEventListener('click', listener)
    listeners.push(() => button.removeEventListener('click', listener))
    parent.append(button)
    return button
  }
  return {
    make,
    root,
    action,
    result: {
      element: root,
      dispose() { for (const remove of listeners.splice(0)) remove() },
    },
  }
}

function heading(ui, text, detail = false) {
  const head = ui.make('div', undefined, 'section-head')
  head.append(ui.make('h3', text))
  if (detail) head.append(ui.make('span', '技术层', 'section-meta'))
  return head
}

function chip(ui, text, tone) {
  const node = ui.make('span', text, 'state-chip')
  if (tone) node.dataset.tone = tone
  return node
}

function failureBlock(ui, failure, technical) {
  const block = ui.make('div', undefined, 'status-banner')
  block.setAttribute('data-tone', 'danger')
  block.setAttribute('data-checkpoint-role', 'failure')
  block.append(ui.make('p', failure.message))
  block.append(ui.make('p', failure.nextAction, 'muted'))
  if (technical) block.append(ui.make('p', `${failure.code} · ${failure.ownerId}`, 'muted'))
  ui.root.append(block)
}

function facts(ui, parent, pairs) {
  const list = ui.make('dl', undefined, 'detail-grid')
  for (const [label, value] of pairs) {
    if (value === undefined || value === null) continue
    const cell = ui.make('div', undefined, 'detail-cell')
    cell.append(ui.make('dt', label))
    cell.append(ui.make('dd', String(value)))
    list.append(cell)
  }
  parent.append(list)
}

function evidenceRef(ui, parent, label, ref, options, role) {
  const box = ui.make('div', undefined, 'item')
  if (role) box.setAttribute('data-checkpoint-role', role)
  box.append(ui.make('strong', label))
  if (ref === undefined || ref === null) {
    box.append(ui.make('p', '不可用：读取结果未提供该引用。', 'muted'))
    parent.append(box)
    return
  }
  // The locator is shown as text only. This module never turns it into a URL.
  facts(ui, box, [
    ['证据 ID', ref.evidenceId?.value],
    ['类型', ref.kind],
    ['来源', ref.source],
    ['定位', ref.locator],
    ['摘要', ref.digest],
  ])
  ui.action(box, '打开精确引用', options.onOpenReference, { kind: 'evidence', ref }, 'button button--sm')
  parent.append(box)
}

function commitRef(ui, parent, label, ref, options, role) {
  const box = ui.make('div', undefined, 'item')
  if (role) box.setAttribute('data-checkpoint-role', role)
  box.append(ui.make('strong', label))
  if (ref === undefined || ref === null) {
    box.append(ui.make('p', '不可用：读取结果未提供该提交凭据。', 'muted'))
  } else {
    facts(ui, box, [
      ['物理 Journal 序号', ref.journalSeq],
      ['提交 ID', ref.commitId],
      ['记录摘要', ref.recordDigest],
    ])
    ui.action(box, '打开精确提交凭据', options.onOpenReference, { kind: 'commit', ref }, 'button button--sm')
  }
  parent.append(box)
}

function assetDescriptor(ui, parent, label, asset, options, role) {
  const box = ui.make('div', undefined, 'item')
  if (role) box.setAttribute('data-checkpoint-role', role)
  box.append(ui.make('strong', label))
  if (asset === undefined || asset === null) {
    box.append(ui.make('p', '不可用：读取结果未提供该资产描述。', 'muted'))
  } else {
    facts(ui, box, [
      ['资产证据 ID', asset.ref?.evidenceId?.value],
      ['读取视图', asset.view?.kind],
    ])
    ui.action(box, '打开精确资产引用', options.onOpenReference, { kind: 'asset', ref: asset }, 'button button--sm')
  }
  parent.append(box)
}

function contextBlock(ui, context, title, onOpenReference) {
  const box = ui.make('div', undefined, 'item')
  box.append(ui.make('strong', title))
  if (!context || context.state === 'unavailable') {
    box.setAttribute('data-checkpoint-role', 'context-unavailable')
    box.append(ui.make('p', context?.reason ? `不可用：${context.reason}` : '不可用：读取结果未提供 Context。', 'muted'))
    return box
  }
  facts(ui, box, [
    ['空闲执行实例', context.agentRuntimeId],
    ['Context 视图', context.contextViewRef],
    ['执行轮', context.executionEpoch],
    ['持久摘要', context.durableContextDigest],
    ['生效引用数', context.activeRefs.length],
    ['已淘汰引用数', context.omittedRefs.length],
    ['循环检查点序号', context.loopCheckpoint?.sequence],
    ['循环模式', CONTEXT_MODE_TEXT[context.loopControl?.mode] ?? context.loopControl?.mode],
    ['替换原因', context.replacement?.reason],
  ])
  if (context.replacement) {
    box.append(ui.make('p', `替换：${context.replacement.fromContextViewRef} → ${context.replacement.toContextViewRef}`, 'muted'))
  }
  if (typeof onOpenReference === 'function' && context.previousContextCommitRef) {
    ui.action(box, '打开既往 Context 提交凭据', onOpenReference, {
      kind: 'commit', ref: context.previousContextCommitRef,
    }, 'button button--sm')
  }
  return box
}

function recoveryBindingBlock(ui, binding, onOpenReference) {
  const box = ui.make('div', undefined, 'item')
  box.setAttribute('data-checkpoint-role', 'recovery')
  box.append(ui.make('strong', '恢复绑定'))
  if (!binding || binding.state === 'unavailable') {
    box.append(ui.make('p', binding?.reason ? `不可用：${binding.reason}` : '不可用：读取结果未提供恢复绑定。', 'muted'))
    return box
  }
  const closure = binding.coreClosure
  facts(ui, box, [
    ['收拢来源', SOURCE_TEXT[closure.source] ?? closure.source],
    ['收拢原因', closure.closureReason],
    ['收拢执行轮', closure.executionEpoch],
    ['已提交', closure.committed ? '是' : '否'],
    ['控制记录：允许重新进入', closure.reentryAllowed ? '是（仅记录事实）' : '否（仅记录事实）'],
    ['未决操作数', closure.pendingOperations.length],
    ['未知操作数', closure.unknownOperations.length],
    ['收拢下一步', nextActionText(closure.nextAction)],
    ['收拢时间', closure.closedAt],
    ['准备引用', binding.preparationRef],
    ['回合恢复引用', binding.turnRecoveryRef],
    ['回合收拢引用', binding.turnClosureRef],
    ['对齐引用', binding.alignmentRef],
  ])
  evidenceRef(ui, box, '收拢恢复状态引用', closure.recoveryStateRef, { onOpenReference }, 'recovery-state-ref')
  commitRef(ui, box, '恢复绑定提交凭据', binding.checkpointCommitRef, { onOpenReference }, 'recovery-commit-ref')
  return box
}

function semanticBlock(ui, semantic, onOpenReference) {
  const box = ui.make('div', undefined, 'item')
  box.append(ui.make('strong', '语义（目标 / 行动 / 结果 / 下一步）'))
  if (!semantic || semantic.state === 'unavailable') {
    box.setAttribute('data-checkpoint-role', 'semantic-unavailable')
    box.append(ui.make('p', semantic?.reason ? `不可用：${semantic.reason}` : '不可用：读取结果未提供语义。', 'muted'))
    return box
  }
  // The version is the real DTO field. No version is inferred from any string.
  if (semantic.version !== undefined) box.append(ui.make('p', `语义版本 ${semantic.version}`, 'muted'))
  if (semantic.description) box.append(ui.make('p', semantic.description, 'muted'))
  const fourPart = [
    ['目标', 'semantic-goal', semantic.semantics?.goal],
    ['做了什么', 'semantic-actions', semantic.semantics?.actions],
    ['结果', 'semantic-result', semantic.semantics?.result],
    ['下一步', 'semantic-next-step', semantic.semantics?.nextStep],
  ]
  for (const [label, role, value] of fourPart) {
    const part = ui.make('div', undefined, 'item')
    part.setAttribute('data-checkpoint-role', role)
    part.append(ui.make('strong', label))
    part.append(ui.make('p', typeof value === 'string' && value.trim() ? value : '未提供', 'muted'))
    box.append(part)
  }
  if (semantic.save) {
    box.append(ui.make('p', `保存提交：${semantic.save.checkpoint?.checkpointRef ?? '未提供'}`, 'muted'))
    box.append(ui.make('p', `Context 阶段提交：Journal #${semantic.save.contextView?.journalSeq ?? '未提供'}`, 'muted'))
    box.append(ui.make('p', `历史发布阶段提交：Journal #${semantic.save.historyPublication?.journalSeq ?? '未提供'}`, 'muted'))
  }
  for (const ref of semantic.evidenceRefs ?? []) evidenceRef(ui, box, '语义证据引用', ref, { onOpenReference })
  for (const child of semantic.adoptedChildren ?? []) {
    const adopted = ui.make('div', undefined, 'item')
    adopted.append(ui.make('strong', `采用子交付 ${child.kind}`))
    facts(ui, adopted, [
      ['调用 ID', child.invocationId],
      ['子回合 ID', child.childTurnId],
      ['交付序号', child.deliverySeq],
      ['前置检查点', child.preCallCheckpointRef],
      ['审查后检查点', child.postReviewCheckpointRef],
      ['分段 ID', child.segmentId],
    ])
    assetDescriptor(ui, adopted, '精炼交付', child.refinedDelivery, { onOpenReference })
    box.append(adopted)
  }
  if (semantic.recovery) {
    box.append(ui.make('p', `语义恢复责任：${semantic.recovery.recoveryResponsibilityRef}`, 'muted'))
    box.append(ui.make('p', `未决操作数：${semantic.recovery.unresolvedOperationRefs.length}`, 'muted'))
  }
  return box
}

function captureBlock(ui, capture, onOpenReference) {
  const box = ui.make('div', undefined, 'item')
  box.append(ui.make('strong', '恢复捕获'))
  if (!capture || capture.state === 'unavailable') {
    box.setAttribute('data-checkpoint-role', 'capture-unavailable')
    box.append(ui.make('p', capture?.reason ? `不可用：${capture.reason}` : '不可用：读取结果未提供捕获描述。', 'muted'))
    return box
  }
  facts(ui, box, [
    ['回合恢复引用', capture.turnRecoveryRef],
    ['控制记录数', capture.controlRecordCount],
    ['恢复责任', capture.recovery?.recoveryResponsibilityRef],
    ['未决操作数', capture.recovery?.unresolvedOperationRefs?.length],
  ])
  assetDescriptor(ui, box, '捕获资产描述', capture.capture, { onOpenReference }, 'capture-asset')
  return box
}

function currentSection(ui, current) {
  const section = ui.make('section')
  section.setAttribute('data-checkpoint-role', 'current')
  section.append(heading(ui, '当前执行位置（权威）'))
  if (!current || current.state !== 'known') {
    const box = ui.make('div', undefined, 'status-banner')
    box.setAttribute('data-checkpoint-role', 'current-unknown')
    box.append(ui.make('p', '当前执行位置未知。'))
    box.append(ui.make('p', '历史检查点仍可查看；当前点不会用最新历史条目代替。', 'muted'))
    section.append(box)
    return section
  }
  const identity = current.identity
  const head = ui.make('div', undefined, 'section-head')
  head.append(ui.make('h4', `检查点 ${identity.seq}`))
  head.append(chip(ui, outcomeText(identity.outcome), stateTone(identity.outcome)))
  section.append(head)
  section.append(ui.make('p', identity.summary))
  section.append(ui.make('p', `下一步：${nextActionText(identity.next)}`, 'muted'))
  section.append(ui.make('p', `当前生效执行轮 ${current.position.effectiveExecutionEpoch} · 该检查点提交轮 ${identity.originalExecutionEpoch}`, 'muted'))
  return section
}

function sameCommitRef(left, right) {
  if (!left || !right) return false
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest
}

function viewedSection(ui, current, viewed, options) {
  const section = ui.make('section')
  section.setAttribute('data-checkpoint-role', 'viewed')
  const isCurrent = current?.state === 'known' && viewed
    ? sameCommitRef(current.identity.commitRef, viewed.identity.commitRef)
    : false
  const head = heading(ui, isCurrent ? '正在查看：当前执行点' : '正在查看的历史点')
  if (viewed && !isCurrent) ui.action(head, '回到当前', options.onReturnToCurrent, undefined, 'button button--sm')
  section.append(head)
  if (!viewed) {
    section.append(ui.make('p', '本次读取未提供可显示的 checkpoint 详情。', 'empty'))
    return section
  }
  const identity = viewed.identity
  const chipRow = ui.make('div', undefined, 'section-head')
  chipRow.append(ui.make('h4', `检查点 ${identity.seq}`))
  chipRow.append(chip(ui, outcomeText(identity.outcome), stateTone(identity.outcome)))
  section.append(chipRow)
  section.append(ui.make('p', identity.summary))
  section.append(ui.make('p', `下一步：${nextActionText(identity.next)}`, 'muted'))
  section.append(ui.make('p', `该检查点提交轮 ${identity.originalExecutionEpoch}`, 'muted'))
  if (!isCurrent) section.append(ui.make('p', '这不是当前执行位置。', 'muted'))
  return section
}

function historySection(ui, value, options) {
  const section = ui.make('section')
  section.setAttribute('data-checkpoint-role', 'history')
  section.append(heading(ui, '历史检查点'))
  if (value.checkpoints.length === 0) {
    const empty = ui.make('p', '本次读取未包含历史条目，不表示该任务没有历史。', 'empty')
    empty.setAttribute('data-checkpoint-role', 'history-empty')
    section.append(empty)
  } else {
    const list = ui.make('div', undefined, 'stack')
    for (const entry of value.checkpoints) {
      const card = ui.make('article', undefined, 'item')
      card.setAttribute('data-checkpoint-role', 'history-entry')
      card.setAttribute('data-checkpoint-journal-seq', String(entry.commitRef.journalSeq))
      const head = ui.make('div', undefined, 'section-head')
      head.append(ui.make('strong', `检查点 ${entry.seq} · ${outcomeText(entry.outcome)}`))
      ui.action(head, '查看此检查点', options.onSelect, {
        checkpointId: entry.checkpointId.value,
        commitRef: entry.commitRef,
      }, 'button button--sm')
      card.append(head)
      card.append(ui.make('p', entry.summary))
      card.append(ui.make('p', `下一步：${nextActionText(entry.next)}`, 'muted'))
      list.append(card)
    }
    section.append(list)
  }
  if (value.nextCursor !== undefined) section.append(ui.make('p', '还有更早的历史检查点未加载。', 'muted'))
  return section
}

function capabilitySection(ui, capabilities) {
  const entries = Object.entries(capabilities ?? {}).filter(([, capability]) => capability?.state === 'unavailable')
  if (entries.length === 0) return null
  const section = ui.make('section')
  section.append(heading(ui, '筛选能力不可用'))
  for (const [filter, capability] of entries) {
    const label = CHECKPOINT_FILTER_TEXT[filter] ?? filter
    section.append(ui.make('p', `${label}：${capability.reason ?? '读取结果未提供原因'}`, 'muted'))
  }
  return section
}

/** Main layer: current authority, viewed target and retained history. */
export function renderCheckpointHistory(read, options = {}) {
  const ui = rendering(options, '检查点历史')
  if (!read?.ok) {
    failureBlock(ui, read?.failure ?? { message: 'checkpoint 读取失败。', nextAction: '请重试读取。' }, false)
    return ui.result
  }
  const value = read.value
  ui.root.append(currentSection(ui, value.current))
  ui.root.append(viewedSection(ui, value.current, value.viewed, options))
  ui.root.append(historySection(ui, value, options))
  return ui.result
}

/** Technical layer for the shell's shared drawer. No overlay, no I/O. */
export function renderCheckpointHistoryDetail(read, options = {}) {
  const ui = rendering(options, '检查点精确详情')
  if (!read?.ok) {
    failureBlock(ui, read?.failure ?? { message: 'checkpoint 读取失败。', nextAction: '请重试读取。' }, true)
    return ui.result
  }
  const value = read.value

  const current = ui.make('section')
  current.setAttribute('data-checkpoint-role', 'detail-current')
  current.append(heading(ui, '当前执行位置（权威）', true))
  if (!value.current || value.current.state !== 'known') {
    const box = ui.make('div', undefined, 'item')
    box.setAttribute('data-checkpoint-role', 'current-unknown')
    box.append(ui.make('p', '当前执行位置未知。'))
    box.append(ui.make('p', value.current?.reason ? `原因：${value.current.reason}` : '原因：读取结果未提供权威当前点。', 'muted'))
    current.append(box)
  } else {
    const identity = value.current.identity
    facts(ui, current, [
      ['检查点 ID', identity.checkpointId?.value],
      ['业务序号', identity.seq],
      ['周期', identity.cycleId?.value],
      ['前序检查点', identity.previousCheckpointId?.value ?? '无'],
      ['指令修订', identity.directiveRevision],
      ['该检查点提交轮', identity.originalExecutionEpoch],
      ['当前生效执行轮', value.current.position.effectiveExecutionEpoch],
      ['结果', outcomeText(identity.outcome)],
      ['下一步', nextActionText(identity.next)],
      ['提交时间', identity.committedAt],
      ['提交时间不可用原因', identity.committedAtUnavailableReason],
      ['时间权威', identity.timeAuthority?.authorityRef],
    ])
    commitRef(ui, current, '当前检查点提交凭据', identity.commitRef, options, 'current-commit-ref')
    commitRef(ui, current, '当前控制提交凭据', value.current.position.controlCommitRef, options, 'current-control-ref')
    current.append(contextBlock(ui, value.current.context, '当前生效 Context', options.onOpenReference))
  }
  ui.root.append(current)

  const viewedDetail = ui.make('section')
  viewedDetail.setAttribute('data-checkpoint-role', 'detail-viewed')
  viewedDetail.append(heading(ui, '正在查看的历史点', true))
  if (!value.viewed) {
    viewedDetail.append(ui.make('p', '本次读取未提供可显示的 checkpoint 详情。', 'empty'))
  } else {
    const identity = value.viewed.identity
    facts(ui, viewedDetail, [
      ['检查点 ID', identity.checkpointId?.value],
      ['业务序号', identity.seq],
      ['周期', identity.cycleId?.value],
      ['前序检查点', identity.previousCheckpointId?.value ?? '无'],
      ['指令修订', identity.directiveRevision],
      ['该检查点提交轮', identity.originalExecutionEpoch],
      ['结果', outcomeText(identity.outcome)],
      ['下一步', nextActionText(identity.next)],
      ['提交时间', identity.committedAt],
      ['提交时间不可用原因', identity.committedAtUnavailableReason],
      ['时间权威', identity.timeAuthority?.authorityRef],
    ])
    commitRef(ui, viewedDetail, '查看目标提交凭据', identity.commitRef, options, 'viewed-commit-ref')
    viewedDetail.append(recoveryBindingBlock(ui, value.viewed.recoveryBinding, options.onOpenReference))
    viewedDetail.append(contextBlock(ui, value.viewed.context, '该检查点的历史 Context', options.onOpenReference))
    viewedDetail.append(semanticBlock(ui, value.viewed.semantic, options.onOpenReference))
    viewedDetail.append(captureBlock(ui, value.viewed.capture, options.onOpenReference))
    for (const ref of identity.evidenceRefs ?? []) evidenceRef(ui, viewedDetail, '检查点证据引用', ref, options)
    evidenceRef(ui, viewedDetail, '检查点恢复状态引用', identity.recoveryStateRef, options)
  }
  ui.root.append(viewedDetail)

  const capabilities = capabilitySection(ui, value.capabilities)
  if (capabilities) ui.root.append(capabilities)
  return ui.result
}
