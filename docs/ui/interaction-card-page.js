const TASK_SCOPE = 'task'
const OPERATION_SCOPE = 'operation'

// The declared task-lifecycle vocabulary (`LifecycleState`). `toLifecycleState`
// passes these values through untouched; every other value it recognizes is an
// explicit-interaction state that it maps onto this vocabulary.
const LIFECYCLE_STATES = new Set([
  'created',
  'admitted',
  'waiting',
  'running',
  'settling',
  'succeeded',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'stale',
  'unknown',
])

export function scopedId(scope, value) {
  return { scope, value }
}

function fallbackText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value
  if (Array.isArray(value) && value.length) {
    const text = value
      .map((item) => (item && typeof item === 'object' ? item.label ?? item.value ?? item.text : item))
      .filter((item) => typeof item === 'string' && item.trim())
      .join('\n')
    if (text) return text
  }
  return fallback
}

// A real interaction event carries only what the explicit-intake owner reported:
// its key, kind, text, the interaction's own id and its occurrence time.
// Anything the owner did not report stays absent; the page never mints a turn
// id, a request id, a tool call, an authorization record, an event time or an
// interaction id.
function interactiveEntry(entry) {
  return {
    kind: entry.kind,
    text: entry.text || '',
    eventKey: entry.eventKey,
    sequence: entry.sequence,
    ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(typeof entry.interactionId === 'string' && entry.interactionId.trim() !== ''
      ? { interactionId: entry.interactionId }
      : {}),
  }
}

// The explicit-intake lifecycle is not a task lifecycle, so this page projects
// it onto the card's declared `LifecycleState` vocabulary and never mints a
// state of its own. `confirmed` and `dispatched` mean the human authorization is
// recorded and the requirement is handed to the runtime: the runtime owns the
// next step, so they are a real `waiting` state, not a running one. A
// confirmation never claims execution progress. A value that is already a
// declared `LifecycleState` passes through untouched; anything else stays the
// explicit `unknown` instead of being guessed.
function toLifecycleState(state) {
  switch (state) {
    case 'awaiting-clarification':
    case 'awaiting-confirmation':
      return 'waiting'
    case 'received':
    case 'matching':
      return 'created'
    case 'confirmed':
    case 'dispatched':
      return 'waiting'
    case 'status-only':
    case 'submitted':
    case 'answered':
      return 'succeeded'
    default:
      return LIFECYCLE_STATES.has(state) ? state : 'unknown'
  }
}

// The human label for an explicit-interaction state. The raw enum never reaches
// the card, and a confirmation reads as waiting for the runtime instead of as a
// running task or a second human decision.
function interactionStateLabel(state) {
  switch (state) {
    case 'received':
      return '已收到'
    case 'matching':
      return '正在处理'
    case 'awaiting-clarification':
      return '等待补充信息'
    case 'awaiting-confirmation':
      return '等待确认'
    case 'confirmed':
      return '已确认，等待调度'
    case 'dispatched':
      return '已入队，等待执行'
    case 'status-only':
      return '状态已回执'
    case 'submitted':
      return '已提交'
    case 'answered':
      return '已回答'
    default:
      return undefined
  }
}

// A scoped id is only ever the value the source reported. A non-empty string is
// wrapped with the scope it is declared under; a missing or empty value stays
// absent instead of being invented.
function normalizeScopedId(scope, raw) {
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : scopedId(scope, raw)
  if (raw && typeof raw === 'object' && typeof raw.value === 'string' && raw.value.trim() !== '') {
    return scopedId(scope, raw.value)
  }
  return undefined
}

// The interaction id is the only real scope an explicit interaction has. The
// card reports it when the interaction owner reported it, and it never derives a
// Task or Operation identity from it. Real Task/Operation/epoch identity comes
// only from the runtime execution facts (`execution`), and a reported operation
// or epoch must belong to a real task.
function sourceFor(entry, execution) {
  const interactionId = typeof entry?.interactionId === 'string' && entry.interactionId.trim() !== ''
    ? entry.interactionId
    : undefined
  const taskId = normalizeScopedId(TASK_SCOPE, execution?.taskId)
  const operationId = taskId === undefined ? undefined : normalizeScopedId(OPERATION_SCOPE, execution?.operationId)
  const executionEpoch = taskId === undefined || execution?.executionEpoch === undefined
    ? undefined
    : execution.executionEpoch
  return {
    ...(interactionId === undefined ? {} : { interactionId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(executionEpoch === undefined ? {} : { executionEpoch }),
  }
}

// The card status is built from the interaction facts the runtime reported. The
// only timestamp used is the occurrence time the interaction owner stamped, and
// it stays absent when the owner reported none. The waiting target follows the
// interaction's own awaiting-* states; the runtime execution facts a page
// forwards may override it.
function cardFromEntries(entries, state = 'received', latestOccurredAt, execution) {
  const latest = entries.at(-1)
  const source = sourceFor(latest, execution)
  const reportedAt = latestOccurredAt ?? latest?.occurredAt
  return {
    source,
    currentNode: 'explicit.brain',
    ownerId: 'humanagent.runtime.explicit-brain',
    nextStep: fallbackText(latest?.text, '等待交互事件'),
    nextAction: latest?.eventKey || 'inspect-explicit-interaction',
    waitingOn: execution?.waitingOn ?? (state.includes('awaiting') ? 'human' : 'runtime'),
    ...(reportedAt === undefined ? {} : { startedAt: reportedAt }),
  }
}

/**
 * The only liveness copy the card may show. Every value comes from the runtime's
 * own liveness projection (`projectRuntimeLiveness`); the card derives no timer
 * and mints no state of its own. A state the runtime did not report stays
 * absent instead of being guessed.
 */
const LIVENESS_LABELS = Object.freeze({
  working: '工作中',
  'no-activity': '无活动',
  'waiting-for-answer': '待回答',
  failed: '已失败',
  idle: '空闲',
  unknown: '未知',
})

function statusSeconds(millis) {
  return millis === undefined ? undefined : Math.max(0, Math.round(millis / 1000))
}

/**
 * The runtime's own execution error, lifted onto the card as a readable error
 * turn. This is the only place the card may describe a failure: the message is
 * the string the runtime reported, and the next action is the one it reported.
 * Nothing is synthesized when the runtime reported no error.
 */
function executionErrorTurn(error) {
  if (!error || !error.message) return undefined
  return {
    sourceKind: 'error',
    markdown: error.message,
    error: {
      code: error.code,
      message: error.message,
      ownerId: error.ownerId,
      nextStep: error.nextAction,
    },
  }
}

function livenessCopy(liveness) {
  if (liveness === undefined || liveness === null) return undefined
  const label = LIVENESS_LABELS[liveness.state]
  if (label === undefined) return undefined
  // Both figures are reported by the runtime; neither is a UI timer.
  const seconds = statusSeconds(liveness.silentForMs)
  if (seconds === undefined) return label
  const budgetMs = Number(liveness.silenceBudgetMs)
  return Number.isFinite(budgetMs)
    ? `${label}，已静默 ${seconds} 秒（阈值 ${budgetMs} 毫秒）`
    : `${label}，已静默 ${seconds} 秒`
}

function projectInteractionCard(input) {
  const liveCopy = livenessCopy(input.liveness)
  const executionTurn = executionErrorTurn(input.execution?.error)
  // The runtime's own localized label wins when this page observed the real
  // execution (`input.execution.stateLabel`). Otherwise the interaction's own
  // human label is used, so a raw interaction enum never reaches the card.
  const stateLabel = input.execution?.stateLabel ?? input.stateLabel
  return {
    surface: 'interaction-work-card',
    // When the page observed the real execution, its state is the truth this
    // card must show. The interaction's own lifecycle only supplies the state
    // while there is no execution to observe. `toLifecycleState` passes a real
    // lifecycle state through unchanged, so a genuine dashboard state is never
    // replaced by the interaction's.
    taskState: toLifecycleState(input.execution?.state ?? input.taskState),
    ...(stateLabel === undefined ? {} : { stateLabel }),
    statusbar: liveCopy === undefined
      ? input.source
      : {
          ...input.source,
          detail: input.source?.detail
            ? `${input.source.detail} · ${liveCopy}`
            : liveCopy,
        },
    cardMetadata: {
      source: input.card.source,
      currentNode: input.card.currentNode,
      ownerId: input.card.ownerId,
      nextStep: input.card.nextStep,
      nextAction: input.card.nextAction,
      waitingOn: input.card.waitingOn,
      startedAt: input.card.startedAt,
      ...(input.liveness === undefined ? {} : { liveness: input.liveness }),
      // The page-local stream fact has its own carrier. `cardMetadata.transport`
      // is the typed `InteractionTraceTransport` and must not be overloaded with
      // a four-value page-local state.
      ...(input.stream === undefined ? {} : { stream: input.stream }),
    },
    conversation: {
      summary: input.conversation?.summary || { missing: true },
      turns: [
        ...(input.conversation?.turns || []),
        ...(executionTurn === undefined ? [] : [executionTurn]),
      ],
    },
    actions: input.actions || [],
    trace: { count: input.history?.items?.length ?? 0, items: input.history?.items ?? [] },
    history: input.history
      ? {
          result: 'ok',
          query: input.history.query,
          cursor: input.history.cursor,
          hasMore: input.history.hasMore ?? false,
          filter: input.history.filter,
          replay: input.history.replay,
          count: input.history.items?.length ?? 0,
          items: input.history.items ?? [],
        }
      : { result: 'missing', count: 0, items: [] },
    nodeCards: input.nodeCards || [],
  }
}

/**
 * Projects one explicit-interaction snapshot onto the shared work card.
 *
 * The interaction snapshot has no provider turn identity: an explicit
 * interaction is owned by explicit intake, not by a provider request. The card
 * therefore reports the absent turn/trace state explicitly instead of
 * inventing a turn id, and the conversation carries only the occurrence times
 * the snapshot itself reported.
 */
export function projectInteractionCardFromSnapshot(snapshot) {
  const interactionId = typeof snapshot?.interactionId === 'string' && snapshot.interactionId.trim() !== ''
    ? snapshot.interactionId
    : undefined
  // A snapshot is an interaction-owned source. Without its real interaction id
  // there is no card to mount.
  if (interactionId === undefined) return undefined
  const draft = snapshot?.draft || null
  const enteredAt = snapshot?.occurredAt
  const requestNumber = snapshot?.requestNumber
  const userTurn = {
    sourceKind: 'user',
    ...(enteredAt === undefined ? {} : { occurredAt: enteredAt }),
    markdown: typeof requestNumber === 'number'
      ? `第 ${requestNumber} 次请求 · ${snapshot?.rawInput || fallbackText(snapshot?.reply, '尚未收到输入')}`
      : snapshot?.rawInput || fallbackText(snapshot?.reply, '尚未收到输入'),
  }
  const entries = [interactiveEntry({
    sequence: 1,
    kind: 'user',
    sourceKind: 'user',
    eventKey: 'explicit.raw-input',
    interactionId,
    text: userTurn.markdown,
    occurredAt: enteredAt,
  })]
  let sequence = 1
  for (const clarification of snapshot?.clarifications || []) {
    sequence += 1
    entries.push(interactiveEntry({
      sequence,
      kind: 'user',
      sourceKind: 'user',
      eventKey: 'explicit.clarification-answer',
      interactionId,
      text: clarification.answer || '',
    }))
  }
  if (draft) {
    sequence += 1
    entries.push(interactiveEntry({
      sequence,
      kind: 'decision',
      sourceKind: 'draft',
      eventKey: 'explicit.draft-confirmation',
      interactionId,
      text: draft.proposal || draft.normalizedInput || '草稿等待确认',
    }))
  } else if (snapshot?.reply) {
    sequence += 1
    entries.push(interactiveEntry({
      sequence,
      kind: 'assistant',
      sourceKind: 'assistant',
      eventKey: 'explicit.reply',
      interactionId,
      text: snapshot.reply,
    }))
  }

  const turnKind = draft ? 'draft' : 'assistant'
  const turnText = draft
    ? draft.proposal || draft.normalizedInput || '草稿已生成'
    : snapshot?.reply || snapshot?.nextAction || '交互处理中'
  const interactionState = snapshot?.state
  const stateLabel = interactionStateLabel(interactionState)

  return projectInteractionCard({
    taskState: toLifecycleState(interactionState),
    ...(stateLabel === undefined ? {} : { stateLabel }),
    source: {
      state: 'ready',
      label: '显式大脑',
      detail: stateLabel,
      ...(enteredAt === undefined ? {} : { updatedAt: enteredAt }),
    },
    card: cardFromEntries(entries, interactionState, enteredAt),
    conversation: {
      summary: {
        ...(typeof snapshot?.rawInput === 'string' && snapshot.rawInput.trim() !== ''
          ? { goal: { text: snapshot.rawInput } }
          : {}),
        ...(draft?.proposedIntent ? { scope: { text: draft.proposedIntent } } : {}),
        ...(snapshot?.clarifications?.at(-1)?.question ? { constraints: [{ text: snapshot.clarifications.at(-1).question }] } : {}),
        ...(draft?.normalizedInput ? { deliverables: [{ text: draft.normalizedInput }] } : {}),
      },
      turns: [
        userTurn,
        ...entries.slice(1).map((entry) => ({
          sourceKind: turnKind === 'draft' && entry.kind === 'decision' ? 'draft' : 'progress',
          ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
          markdown: entry.text,
        })),
        {
          sourceKind: turnKind,
          ...(enteredAt === undefined ? {} : { occurredAt: enteredAt }),
          markdown: turnText,
        },
      ],
    },
    actions: draft
      ? [{ id: 'confirm-requirement', label: '确认并进入队列', executable: true }]
      : [],
    // An explicit interaction is owned by explicit intake, not by a provider
    // request. It has no runtime event to project, so the page reports the
    // absent history source explicitly instead of a synthesized trace.
    nodeCards: [],
  })
}

/**
 * Projects the interaction card for a task. `context` carries the execution
 * facts the page obtained from the runtime dashboard read model — the liveness
 * projection and the runtime's own error. Both are facts the runtime reported;
 * neither is derived here. They stay absent when the read reported none.
 */
export function projectInteractionCardFromEntries(entries, state = 'received', context = {}) {
  const latest = entries.at(-1)
  const hasInteractionId = typeof latest?.interactionId === 'string' && latest.interactionId.trim() !== ''
  const hasTaskId = normalizeScopedId(TASK_SCOPE, context.execution?.taskId) !== undefined
  // Without a real interaction id or a real Task id there is no source to
  // report, so the page must leave the card host empty instead of projecting a
  // source-less card.
  if (!hasInteractionId && !hasTaskId) return undefined
  const effectiveEntries = entries.length > 0
    ? entries
    : [{
        sequence: 1,
        kind: 'status',
        sourceKind: 'progress',
        eventKey: 'explicit.ready',
        text: '等待新的交互事件',
      }]
  const latestOccurredAt = effectiveEntries.reduce(
    (found, entry) => entry.occurredAt ?? found,
    undefined,
  )
  // The runtime's own localized label wins when this page observed the real
  // execution. Otherwise the interaction's own human label is used, so a raw
  // interaction enum never reaches the card.
  const stateLabel = context.execution?.stateLabel ?? interactionStateLabel(state)
  return projectInteractionCard({
    taskState: toLifecycleState(state),
    ...(stateLabel === undefined ? {} : { stateLabel }),
    source: {
      state: 'ready',
      label: '显式大脑',
      detail: stateLabel,
      ...(latestOccurredAt === undefined ? {} : { updatedAt: latestOccurredAt }),
    },
    card: cardFromEntries(effectiveEntries, state, latestOccurredAt, context.execution),
    conversation: {
      summary: { missing: true },
      turns: effectiveEntries.map((entry) => ({
        sourceKind: entry.sourceKind || 'progress',
        ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
        markdown: entry.text || '',
        error: entry.error,
      })),
    },
    actions: [],
    ...(context.liveness === undefined ? {} : { liveness: context.liveness }),
    ...(context.execution === undefined ? {} : { execution: context.execution }),
    // Same as the snapshot projection: the interaction page itself is not a
    // provider trace source, so the card reports the absent history explicitly.
    nodeCards: [],
  })
}

/**
 * Replaces a card's history with the runtime's own history result.
 *
 * `result` is the contract-shaped `InteractionHistoryResult` the runtime
 * history surface returned. The trace items are used verbatim: their turn ids,
 * request ids and occurrence times are the values the provider binding and the
 * runtime reported. A failed read keeps the typed failure visible and shows no
 * invented entries.
 */
export function withTaskHistory(projection, query, result) {
  if (!result || result.ok !== true) {
    return {
      ...projection,
      trace: { count: 0, items: [] },
      history: {
        result: 'failed',
        query,
        code: result?.failure?.code ?? 'unavailable',
        message: result?.failure?.message ?? '运行时未返回历史记录',
        retryable: result?.failure?.retryable ?? false,
        evidenceRefs: result?.failure?.evidenceRefs,
        count: 0,
        items: [],
      },
    }
  }
  const page = result.page || {}
  const items = Array.isArray(page.items) ? page.items : []
  const latest = items.at(-1)
  // Identity is a real reported fact, so it comes from the newest entry that
  // actually reported it. A later turn-less entry (for example
  // `execution.terminal`) must not erase a real turn or request id.
  const turnCarrier = [...items].reverse().find((item) => item.turnId !== undefined && item.turnId !== null)
  const requestCarrier = [...items].reverse().find((item) => item.requestId !== undefined && item.requestId !== null)
  // The interaction id the card already carries is a real reported fact too, so
  // the trace's own identity is layered on top of it instead of replacing it.
  // Task/Operation/epoch are included only when a real value was reported.
  const currentSource = projection.cardMetadata?.source
  const interactionId = currentSource?.interactionId
  const taskId = latest?.taskId ?? currentSource?.taskId
  const operationId = latest?.operationId ?? currentSource?.operationId
  const executionEpoch = latest?.executionEpoch ?? currentSource?.executionEpoch
  return {
    ...projection,
    cardMetadata: latest
      ? {
          ...projection.cardMetadata,
          source: {
            ...(interactionId === undefined ? {} : { interactionId }),
            ...(taskId === undefined ? {} : { taskId }),
            ...(operationId === undefined ? {} : { operationId }),
            ...(executionEpoch === undefined ? {} : { executionEpoch }),
            ...(requestCarrier === undefined ? {} : { requestId: requestCarrier.requestId }),
            ...(turnCarrier === undefined ? {} : { turnId: turnCarrier.turnId }),
          },
          ...(projection.cardMetadata?.startedAt === undefined && items[0]?.occurredAt !== undefined
            ? { startedAt: items[0].occurredAt }
            : {}),
        }
      : projection.cardMetadata,
    trace: { count: items.length, items },
    history: {
      result: 'ok',
      query,
      cursor: page.cursor,
      hasMore: page.hasMore ?? false,
      filter: page.filter,
      replay: page.replay,
      count: items.length,
      items,
    },
  }
}
