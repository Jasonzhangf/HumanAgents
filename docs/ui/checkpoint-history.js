import { element as defaultElement } from './runtime-api.js'

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

const REVIEW_STATUS_TEXT = Object.freeze({
  passed: '通过',
  failed: '未通过',
  inconclusive: '未定',
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

function rendering(options, title, rootClassName = 'panel') {
  const make = typeof options.element === 'function' ? options.element : defaultElement
  const root = make('section', undefined, rootClassName)
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

function technicalDetails(ui, role, pairs, label = '技术详情') {
  const details = ui.make('details', undefined, 'history-detail')
  details.setAttribute('data-checkpoint-role', role)
  details.append(ui.make('summary', label))
  facts(ui, details, pairs)
  return details
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

// `body` is the exact body-read address for this descriptor: the clicked
// checkpoint identity plus full receipt (`target`) and the selector (`selector`).
// It is undefined when the caller cannot read the asset body, and then the
// descriptor keeps its existing reference action.
function assetDescriptor(ui, parent, label, asset, options, role, body) {
  const box = ui.make('div', undefined, 'item')
  if (role) box.setAttribute('data-checkpoint-role', role)
  box.append(ui.make('strong', label))
  if (asset === undefined || asset === null) {
    box.append(ui.make('p', '不可用：读取结果未提供该资产描述。', 'muted'))
  } else {
    box.append(technicalDetails(ui, 'asset-descriptor-technical', [
      ['资产证据 ID', asset.ref?.evidenceId?.value],
      ['读取视图', asset.view?.kind],
    ]))
    // A persisted asset descriptor now has an exact body read. The descriptor-only
    // deep link stays dead, so this trigger replaces it instead of adding a second
    // path to the same descriptor.
    if (body?.selector !== undefined) {
      const trigger = ui.action(box, body.label, options.onReadAssetBody, {
        target: body.target,
        selector: body.selector,
      }, 'button button--sm')
      if (trigger) {
        trigger.setAttribute('data-checkpoint-role', 'asset-body-trigger')
        trigger.setAttribute('data-asset-body-selector', String(body.selector.kind))
      }
    } else {
      ui.action(box, '打开精确资产引用', options.onOpenReference, { kind: 'asset', ref: asset }, 'button button--sm')
    }
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

// One rendered semantics field. An empty or missing value is explicit ("未提供")
// and is never filled from the raw summary or description.
function semanticPart(ui, label, role, value) {
  const part = ui.make('div', undefined, 'item')
  part.setAttribute('data-checkpoint-role', role)
  part.append(ui.make('strong', label))
  part.append(ui.make('p', typeof value === 'string' && value.trim() ? value : '未提供', 'muted'))
  return part
}

// The four DTO semantics fields in their existing order. Shared by the human
// main layer and the technical layer so both render the same exact values and
// keep the same `semantic-*` roles. The main layer names the last field as a
// saved-time suggestion; the technical layer keeps the shorter label.
function appendSemanticParts(ui, parent, semantics, nextStepLabel = '下一步') {
  parent.append(semanticPart(ui, '目标', 'semantic-goal', semantics?.goal))
  parent.append(semanticPart(ui, '做了什么', 'semantic-actions', semantics?.actions))
  parent.append(semanticPart(ui, '结果', 'semantic-result', semantics?.result))
  parent.append(semanticPart(ui, nextStepLabel, 'semantic-next-step', semantics?.nextStep))
}

function semanticBlock(ui, semantic, onOpenReference, bodyTarget, readOptions) {
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
  appendSemanticParts(ui, box, semantic.semantics)
  if (semantic.save) {
    box.append(ui.make('p', `保存提交：${semantic.save.checkpoint?.checkpointRef ?? '未提供'}`, 'muted'))
    box.append(ui.make('p', `Context 阶段提交：Journal #${semantic.save.contextView?.journalSeq ?? '未提供'}`, 'muted'))
    box.append(ui.make('p', `历史发布阶段提交：Journal #${semantic.save.historyPublication?.journalSeq ?? '未提供'}`, 'muted'))
  }
  for (const ref of semantic.evidenceRefs ?? []) evidenceRef(ui, box, '语义证据引用', ref, { onOpenReference })
  for (const child of semantic.adoptedChildren ?? []) {
    const adopted = ui.make('div', undefined, 'item')
    adopted.setAttribute('data-checkpoint-role', 'adopted-child')
    adopted.append(ui.make('strong', `采用子交付 · ${child.kind === 'review' ? '审查' : child.kind === 'execution' ? '执行' : String(child.kind)}`))
    adopted.append(technicalDetails(ui, 'adopted-child-technical', [
      ['调用 ID', child.invocationId],
      ['子回合 ID', child.childTurnId],
      ['交付序号', child.deliverySeq],
      ['前置检查点', child.preCallCheckpointRef],
      ['审查后检查点', child.postReviewCheckpointRef],
      ['分段 ID', child.segmentId],
    ]))
    // The exact adopted-child triple plus the exact clicked checkpoint receipt
    // are bound when this row is rendered, before any body read starts.
    assetDescriptor(ui, adopted, '精炼交付', child.refinedDelivery, {
      onOpenReference,
      onReadAssetBody: readOptions?.onReadAssetBody,
    }, undefined, {
      label: '查看精炼交付正文',
      target: bodyTarget,
      selector: {
        kind: 'adopted-child',
        invocationId: child.invocationId,
        childTurnId: child.childTurnId,
        deliverySeq: child.deliverySeq,
      },
    })
    box.append(adopted)
  }
  if (semantic.recovery) {
    box.append(ui.make('p', `语义恢复责任：${semantic.recovery.recoveryResponsibilityRef}`, 'muted'))
    box.append(ui.make('p', `未决操作数：${semantic.recovery.unresolvedOperationRefs.length}`, 'muted'))
  }
  return box
}

function captureBlock(ui, capture, onOpenReference, bodyTarget, readOptions) {
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
  assetDescriptor(ui, box, '捕获资产描述', capture.capture, {
    onOpenReference,
    onReadAssetBody: readOptions?.onReadAssetBody,
  }, 'capture-asset', {
    label: '查看捕获正文',
    target: bodyTarget,
    selector: { kind: 'capture' },
  })
  return box
}

function compactCommitRef(ref) {
  if (!ref) return undefined
  if (typeof ref.commitId !== 'string' || !ref.commitId.trim()) return undefined
  if (!Number.isSafeInteger(ref.journalSeq) || ref.journalSeq < 0) return undefined
  if (typeof ref.recordDigest !== 'string' || !ref.recordDigest.trim()) return undefined
  return {
    commitId: ref.commitId,
    journalSeq: ref.journalSeq,
    recordDigest: ref.recordDigest,
  }
}

function controlFailureBlock(ui, parent) {
  const block = ui.make('div', undefined, 'status-banner')
  block.hidden = true
  block.setAttribute('data-tone', 'danger')
  const message = ui.make('p')
  const next = ui.make('p', undefined, 'muted')
  block.append(message, next)
  parent.append(block)
  return {
    element: block,
    show(error) {
      block.setAttribute('data-checkpoint-role', 'checkpoint-control-failure')
      message.textContent = error?.message || '这次控制提交未完成。'
      next.textContent = error?.nextAction || '重新读取检查点后再确认。'
      block.hidden = false
    },
    hide() {
      block.setAttribute('data-checkpoint-role', 'checkpoint-control-message')
      block.hidden = true
    },
  }
}

function setPending(ui, parent) {
  const status = ui.make('p', undefined, 'muted')
  status.hidden = true
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.setAttribute('data-checkpoint-role', 'checkpoint-control-pending')
  parent.append(status)
  return {
    element: status,
    set(text) {
      status.textContent = text
      status.hidden = false
    },
    clear() {
      status.textContent = ''
      status.hidden = true
    },
  }
}

function controlHeading(ui, text) {
  const head = ui.make('div', undefined, 'section-head')
  const title = ui.make('h3', text)
  head.append(title)
  return head
}

function correctionFields(ui, activeRefs) {
  const refs = ui.make('fieldset')
  refs.append(ui.make('legend', '选择要排除的当前引用'))
  const options = []
  for (const ref of activeRefs) {
    const label = ui.make('label', undefined, 'check')
    const input = ui.make('input')
    input.type = 'checkbox'
    input.value = String(ref)
    input.setAttribute('data-checkpoint-role', 'wrong-ref-option')
    label.append(input, ui.make('span', String(ref)))
    refs.append(label)
    options.push(input)
  }
  const extraLabel = ui.make('label')
  extraLabel.append(ui.make('span', '其他精确引用（每行一个）'))
  const extra = ui.make('textarea')
  extra.rows = 2
  extra.setAttribute('data-checkpoint-role', 'wrong-ref-input')
  extraLabel.append(extra)
  refs.append(extraLabel)
  return { refs, options, extra }
}

function confirmedControl(ui, value, options, kind) {
  const current = value.current
  const viewed = value.viewed
  const sourceCheckpointReceipt = compactCommitRef(viewed?.identity?.commitRef)
  const expectedControlReceipt = compactCommitRef(current?.position?.controlCommitRef)
  const activeRefs = current?.context?.activeRefs
  const isCorrection = kind === 'correction'
  const sectionTitle = isCorrection ? '修正当前 Context' : '从该检查点继续'
  const section = ui.make('section', undefined, 'item')
  section.setAttribute('data-checkpoint-role', isCorrection ? 'context-correction' : 'checkpoint-reentry')
  section.append(controlHeading(ui, sectionTitle))
  section.append(ui.make(
    'p',
    isCorrection
      ? '只排除你确认错误的 Context 引用。保留历史、恢复记录与其他业务事实。'
      : '保留历史与实际副作用，并把未完成义务交给新的执行轮；不会撤销已发生的外部操作。',
    'muted',
  ))

  if (current?.state !== 'known' || !sourceCheckpointReceipt || !expectedControlReceipt
    || (isCorrection && !Array.isArray(activeRefs))) {
    const reason = current?.state !== 'known'
      ? `当前执行位置未知，不能确认这次${isCorrection ? '修正' : '重入'}的控制基线。`
      : !sourceCheckpointReceipt
        ? `查看目标缺少完整提交凭据，不能${isCorrection ? '修正 Context' : '重入'}。`
        : !expectedControlReceipt
          ? `当前控制提交凭据缺失，不能确认这次${isCorrection ? '修正' : '重入'}。`
          : '当前生效 Context 没有可选择的引用，不能确认修正范围。'
    section.append(ui.make('p', `当前不能${isCorrection ? '提交修正' : '重入'}：${reason}`, 'muted'))
    return section
  }

  const form = ui.make('div', undefined, 'stack')
  form.hidden = true
  form.setAttribute('data-checkpoint-role', isCorrection ? 'context-correction-form' : 'checkpoint-reentry-form')
  const trigger = ui.action(section, sectionTitle, () => {
    form.hidden = false
    trigger?.setAttribute('aria-expanded', 'true')
  }, undefined, 'button button--quiet')
  trigger?.setAttribute('data-checkpoint-role', isCorrection ? 'context-correction-trigger' : 'checkpoint-reentry-trigger')
  trigger?.setAttribute('aria-expanded', 'false')

  let fields
  let repair
  let repairLabel
  if (isCorrection) {
    fields = correctionFields(ui, activeRefs)
    form.append(fields.refs)
    repairLabel = ui.make('label')
    repairLabel.append(ui.make('span', '修正说明'))
    repair = ui.make('textarea')
    repair.rows = 3
    repair.required = true
    repair.setAttribute('data-checkpoint-role', 'repair-text')
    repairLabel.append(repair)
    form.append(repairLabel)
  } else {
    form.append(ui.make('p', '该操作追加新的控制记录，并保留历史、未完成义务和已发生的外部副作用。', 'muted'))
    const target = ui.make('p', `重入目标：Journal #${sourceCheckpointReceipt.journalSeq} · ${sourceCheckpointReceipt.commitId}`, 'muted')
    target.setAttribute('data-checkpoint-role', 'checkpoint-reentry-target')
    const baseline = ui.make('p', `当前控制基线：Journal #${expectedControlReceipt.journalSeq} · ${expectedControlReceipt.commitId}`, 'muted')
    baseline.setAttribute('data-checkpoint-role', 'checkpoint-reentry-baseline')
    form.append(target, baseline)
  }

  const summary = ui.make('p', undefined, 'muted')
  summary.hidden = true
  summary.setAttribute('data-checkpoint-role', 'context-correction-summary')
  const failure = controlFailureBlock(ui, form)
  const pending = setPending(ui, form)
  const actions = ui.make('div', undefined, 'actions')
  const cancel = ui.action(actions, '取消', () => {
    form.hidden = true
    trigger?.setAttribute('aria-expanded', 'false')
  }, undefined, 'button button--quiet')
  cancel?.setAttribute('data-checkpoint-role', isCorrection ? 'context-correction-cancel' : 'checkpoint-reentry-cancel')
  const confirm = ui.action(
    actions,
    isCorrection ? '确认修正' : '确认重入',
    () => void submit(),
    undefined,
    'button button--primary',
  )
  confirm?.setAttribute('data-checkpoint-role', isCorrection ? 'context-correction-confirm' : 'checkpoint-reentry-confirm')
  form.append(summary, failure.element, pending.element, actions)
  section.append(form)

  let submitted = false
  let submitting = false
  async function submit() {
    if (submitted || submitting) return
    let body
    if (isCorrection) {
      const wrongRefs = activeRefs.filter((ref, index) => fields.options[index]?.checked === true).map(String)
      for (const line of fields.extra.value.split('\n')) {
        const ref = line.trim()
        if (ref && !wrongRefs.includes(ref)) wrongRefs.push(ref)
      }
      const repairText = repair.value.trim()
      if (wrongRefs.length === 0 || !repairText) {
        failure.show({
          message: wrongRefs.length === 0 ? '请选择或输入至少一个要排除的精确引用。' : '请填写修正说明。',
          nextAction: '补齐必要输入后再确认。',
        })
        return
      }
      failure.hide()
      summary.textContent = `将排除引用：${wrongRefs.join('、')}。修正说明：${repairText}`
      summary.hidden = false
      body = { wrongRefs, repairText, sourceCheckpointReceipt, expectedControlReceipt }
    } else {
      body = { targetCheckpointCommitRef: sourceCheckpointReceipt, expectedCurrentControlCommitRef: expectedControlReceipt }
    }
    pending.set(isCorrection ? '正在提交 Context 修正' : '正在提交检查点重入')
    submitting = true
    confirm.disabled = true
    try {
      await (isCorrection ? options.onContextCorrection : options.onCheckpointReentry)(body)
      submitted = true
      pending.set(`${isCorrection ? '修正' : '重入'}已提交。正在读取权威 Current 与 Viewed。`)
    } catch (error) {
      failure.show(error)
      pending.clear()
      // A post-commit refresh failure is not an uncommitted request: the control
      // record already exists, so the confirm must never become a second write.
      if (error?.committed === true) {
        submitted = true
      } else {
        confirm.disabled = false
      }
    } finally {
      submitting = false
    }
  }
  return section
}

function confirmedControlSections(ui, value, options) {
  if (typeof options.onContextCorrection !== 'function'
    && typeof options.onCheckpointReentry !== 'function') return []
  const sections = []
  if (typeof options.onContextCorrection === 'function') {
    sections.push(confirmedControl(ui, value, options, 'correction'))
  }
  if (typeof options.onCheckpointReentry === 'function') {
    sections.push(confirmedControl(ui, value, options, 'reentry'))
  }
  return sections
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
  section.append(head)
  // The authority is the position, not the saved record's outcome or next
  // action. The saved summary and next action stay in the technical layer.
  section.append(ui.make('p', '此处表示当前执行关联的检查点位置。记录保存时状态与建议不代表任务当前业务状态。', 'muted'))
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
  section.append(chipRow)
  // The saved record's outcome and typed next action are shown as saved-time
  // facts. They are never a recovery control and never a task's current status.
  section.append(ui.make('p', `记录保存时状态：${outcomeText(identity.outcome)}`, 'muted'))
  section.append(ui.make('p', `记录保存时的下一动作：${nextActionText(identity.next)}`, 'muted'))
  const semantic = viewed.semantic
  if (!semantic || semantic.state === 'unavailable') {
    section.append(ui.make('p', '此记录未提供结构化阶段说明。原始摘要可在技术详情查看。', 'muted'))
  } else {
    // The structured Chinese four-part semantics come straight from the DTO.
    appendSemanticParts(ui, section, semantic.semantics, '下一步（保存时建议）')
  }
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
      head.append(ui.make('strong', `检查点 ${entry.seq}`))
      ui.action(head, '查看此检查点', options.onSelect, {
        checkpointId: entry.checkpointId.value,
        commitRef: entry.commitRef,
      }, 'button button--sm')
      card.append(head)
      // The list carries only navigation facts: number, saved-time status and
      // the original select trigger. No flattened summary or next line repeats.
      card.append(ui.make('p', `保存时状态：${outcomeText(entry.outcome)}`, 'muted'))
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
  const ui = rendering(options, '检查点精确详情', 'panel checkpoint-history-detail')
  ui.root.setAttribute('data-checkpoint-role', 'checkpoint-history-detail')
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
      ['原始摘要', identity.summary],
      ['记录保存时状态', outcomeText(identity.outcome)],
      ['记录保存时下一动作', nextActionText(identity.next)],
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
      ['原始摘要', identity.summary],
      ['记录保存时状态', outcomeText(identity.outcome)],
      ['记录保存时下一动作', nextActionText(identity.next)],
      ['提交时间', identity.committedAt],
      ['提交时间不可用原因', identity.committedAtUnavailableReason],
      ['时间权威', identity.timeAuthority?.authorityRef],
    ])
    commitRef(ui, viewedDetail, '查看目标提交凭据', identity.commitRef, options, 'viewed-commit-ref')
    // The body read addresses this exact checkpoint identity plus its full
    // physical receipt. It is bound here, before any async body read starts, so a
    // late response can only ever be about the checkpoint the user opened.
    const bodyTarget = {
      checkpointId: identity.checkpointId?.value,
      commitRef: identity.commitRef,
    }
    viewedDetail.append(recoveryBindingBlock(ui, value.viewed.recoveryBinding, options.onOpenReference))
    viewedDetail.append(contextBlock(ui, value.viewed.context, '该检查点的历史 Context', options.onOpenReference))
    viewedDetail.append(semanticBlock(ui, value.viewed.semantic, options.onOpenReference, bodyTarget, options))
    viewedDetail.append(captureBlock(ui, value.viewed.capture, options.onOpenReference, bodyTarget, options))
    for (const ref of identity.evidenceRefs ?? []) evidenceRef(ui, viewedDetail, '检查点证据引用', ref, options)
    evidenceRef(ui, viewedDetail, '检查点恢复状态引用', identity.recoveryStateRef, options)
  }
  ui.root.append(viewedDetail)

  for (const section of confirmedControlSections(ui, value, options)) {
    ui.root.append(section)
  }

  const capabilities = capabilitySection(ui, value.capabilities)
  if (capabilities) ui.root.append(capabilities)
  return ui.result
}

function assetViewText(view) {
  if (!view || typeof view !== 'object') return '未提供'
  return view.kind === 'text-field' || view.kind === 'thinking-field'
    ? `${view.kind} · ${view.field}`
    : view.kind === 'content-part'
      ? `${view.kind} · ${view.partIndex}`
      : view.kind === 'reasoning-item'
        ? `${view.kind} · ${view.selector}`
        : String(view.kind)
}

function checkpointAssetLabel(selector) {
  if (selector?.kind === 'adopted-child') {
    return '已采用子交付'
  }
  return '恢复捕获'
}

function knownEnvelope(text) {
  let candidate
  try {
    candidate = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  if (typeof candidate.summary === 'string'
    && Array.isArray(candidate.producedArtifactBodies)
    && candidate.producedArtifactBodies.every((body) => typeof body === 'string')) {
    return { kind: 'execution', value: candidate }
  }
  if (REVIEW_STATUS_TEXT[candidate.status] !== undefined && Array.isArray(candidate.findings)) {
    return { kind: 'review', value: candidate }
  }
  return undefined
}

function humanText(ui, role, text, className = 'muted') {
  const node = ui.make('p', text, className)
  node.setAttribute('data-checkpoint-role', role)
  return node
}

function reviewFindings(ui, findings) {
  if (findings.length === 0) {
    return humanText(ui, 'asset-body-review-findings-empty', '本次审查未列出审查发现。')
  }
  const list = ui.make('div', undefined, 'stack')
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue
    const problem = typeof finding.problem === 'string' ? finding.problem : ''
    const expected = typeof finding.expected === 'string' ? finding.expected : ''
    const detail = problem || expected
    if (!detail) continue
    const row = ui.make('div', undefined, 'item')
    row.setAttribute('data-checkpoint-role', 'asset-body-review-finding')
    row.append(humanText(ui, 'asset-body-review-finding-problem', `发现：${problem || '未提供问题说明'}`))
    if (expected) row.append(humanText(ui, 'asset-body-review-finding-expected', `期望：${expected}`))
    list.append(row)
  }
  return list
}

function rawEnvelopeDetails(ui, originalText) {
  const details = ui.make('details', undefined, 'history-detail')
  details.setAttribute('data-checkpoint-role', 'asset-body-raw')
  details.append(ui.make('summary', '原始正文（未改写）'))
  const raw = ui.make('pre', originalText)
  raw.setAttribute('data-checkpoint-role', 'asset-body-raw-text')
  details.append(raw)
  return details
}

function knownExecutionBody(ui, value) {
  if (typeof value.summary === 'string' && value.summary.trim()) {
    ui.root.append(humanText(ui, 'asset-body-summary', `摘要：${value.summary}`))
  }
  if (value.producedArtifactBodies.length === 0) {
    ui.root.append(humanText(ui, 'asset-body-produced-empty', '未提供产出正文。'))
    return
  }
  for (const [index, produced] of value.producedArtifactBodies.entries()) {
    const section = ui.make('section')
    section.append(ui.make('strong', `产出正文 ${index + 1}`))
    const body = ui.make('pre', produced)
    body.setAttribute('data-checkpoint-role', 'asset-body-produced')
    section.append(body)
    ui.root.append(section)
  }
}

function knownReviewBody(ui, value) {
  ui.root.append(humanText(ui, 'asset-body-review-status', `审查状态：${REVIEW_STATUS_TEXT[value.status]}`))
  ui.root.append(reviewFindings(ui, value.findings))
  ui.root.append(humanText(ui, 'asset-body-review-fulltext', '本次读取未包含完整审查正文；资产引用不是完整审查正文。'))
}

// The folded provenance of one body read. Every identity and machine field the
// service actually returned stays here as exact text: the checkpoint and its
// full physical receipt, the selector, and the durable descriptor (evidence id,
// locator, digest and view). The primary body layer never shows this as a dump.
function assetBodyProvenance(ui, value) {
  const details = ui.make('details', undefined, 'history-detail')
  details.setAttribute('data-checkpoint-role', 'asset-body-provenance')
  details.append(ui.make('summary', '来源详情'))
  const body = ui.make('div', undefined, 'item')
  const identity = value.checkpoint
  const receipt = identity?.commitRef
  const asset = value.asset
  facts(ui, body, [
    ['检查点 ID', identity?.checkpointId?.value],
    ['业务序号', identity?.seq],
    ['物理 Journal 序号', receipt?.journalSeq],
    ['提交 ID', receipt?.commitId],
    ['记录摘要', receipt?.recordDigest],
    ['资产角色', value.selector?.kind],
    ['调用 ID', value.selector?.invocationId],
    ['子回合 ID', value.selector?.childTurnId],
    ['交付序号', value.selector?.deliverySeq],
    ['资产证据 ID', asset?.ref?.evidenceId?.value],
    ['资产类型', asset?.ref?.kind],
    ['资产来源', asset?.ref?.source],
    ['资产定位', asset?.ref?.locator],
    ['资产摘要', asset?.ref?.digest],
    ['读取视图', assetViewText(asset?.view)],
  ])
  details.append(body)
  return details
}

/**
 * The exact asset body of one checkpoint. The body is the service's decoded
 * text and is rendered as text only: no HTML execution, no re-interpretation of
 * the view, and no invented fallback. `onBack` returns to the checkpoint detail,
 * `onRetry` re-reads this same target.
 */
export function renderCheckpointAssetBody(result, options = {}) {
  const ui = rendering(options, '资产正文')
  if (result?.pending) {
    const pending = ui.make('div', undefined, 'item')
    pending.setAttribute('data-checkpoint-role', 'asset-body-loading')
    pending.append(ui.make('strong', '正在读取资产正文…'))
    const actions = ui.make('div', undefined, 'section-head')
    ui.action(actions, '重试这次读取', options.onRetry, undefined, 'button button--sm')
    ui.action(actions, '返回检查点详情', options.onBack, undefined, 'button button--quiet')
    pending.append(actions)
    ui.root.append(pending)
    return ui.result
  }
  if (!result?.ok) {
    const failure = result?.failure ?? { message: '资产正文读取失败。', nextAction: '请重试这次读取，或返回检查点详情。' }
    const block = ui.make('div', undefined, 'status-banner')
    block.setAttribute('data-tone', 'danger')
    block.setAttribute('data-checkpoint-role', 'asset-body-failure')
    block.append(ui.make('p', failure.message))
    block.append(ui.make('p', failure.nextAction, 'muted'))
    block.append(ui.make('p', `${failure.code} · ${failure.ownerId}`, 'muted'))
    const actions = ui.make('div', undefined, 'section-head')
    ui.action(actions, '重试这次读取', options.onRetry, undefined, 'button button--sm')
    ui.action(actions, '返回检查点详情', options.onBack, undefined, 'button button--quiet')
    block.append(actions)
    ui.root.append(block)
    return ui.result
  }

  const value = result.value
  const head = ui.make('div', undefined, 'stack')
  const title = ui.make('h3', checkpointAssetLabel(value.selector))
  title.setAttribute('data-checkpoint-role', 'asset-body-title')
  head.append(title)
  head.append(ui.make('p', `检查点 ${value.checkpoint?.seq ?? '未提供'}`, 'muted'))
  const actions = ui.make('div', undefined, 'history-actions')
  ui.action(actions, '返回检查点详情', options.onBack, undefined, 'button button--quiet')
  head.append(actions)
  ui.root.append(head)

  const bodyText = typeof value.text === 'string' ? value.text : ''
  const envelope = value.selector?.kind === 'adopted-child' ? knownEnvelope(bodyText) : undefined
  if (envelope?.kind === 'execution') {
    title.textContent = '执行交付'
    knownExecutionBody(ui, envelope.value)
    ui.root.append(rawEnvelopeDetails(ui, bodyText))
  } else if (envelope?.kind === 'review') {
    title.textContent = '审查结果'
    knownReviewBody(ui, envelope.value)
    ui.root.append(rawEnvelopeDetails(ui, bodyText))
  } else if (bodyText.length === 0) {
    const empty = ui.make('div', undefined, 'item')
    empty.setAttribute('data-checkpoint-role', 'asset-body-empty')
    empty.append(ui.make('p', '该资产的正文为空，本次读取没有返回任何字符。'))
    ui.root.append(empty)
  } else {
    // Capture, ordinary text and unrecognized payloads keep their exact text.
    const body = ui.make('pre', bodyText)
    body.setAttribute('data-checkpoint-role', 'asset-body-text')
    ui.root.append(body)
  }
  ui.root.append(assetBodyProvenance(ui, value))
  return ui.result
}
