const TASK_SCOPE = 'task'
const OPERATION_SCOPE = 'operation'
const EVIDENCE_SCOPE = 'evidence'

export function scopedId(scope, value) {
  return { scope, value }
}

function nowIso() {
  return new Date().toISOString()
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

function evidenceFor(kind, value, occurredAt) {
  return [{
    evidenceId: scopedId(EVIDENCE_SCOPE, `${kind}:${value}:${occurredAt}`),
    kind,
    source: 'humanagent.explicit-interaction',
    locator: `explicit/${kind}/${value}`,
    digest: `ui:${kind}:${value}`,
    scope: { taskId: scopedId(TASK_SCOPE, 'explicit-interaction'), operationId: scopedId(OPERATION_SCOPE, 'explicit-interaction') },
  }]
}

function sourceFor(entry) {
  const interactionId = entry.interactionId || 'pending-input'
  const reference = entry.eventKey || `event:${entry.sequence}`
  return {
    taskId: scopedId(TASK_SCOPE, interactionId),
    operationId: scopedId(OPERATION_SCOPE, interactionId),
    executionEpoch: 1,
    requestId: reference,
    turnId: `${entry.sequence}.${reference}`,
  }
}

function traceEntry(entry) {
  const occurredAt = nowIso()
  const source = sourceFor(entry)
  const status = entry.sourceKind === 'error' ? 'failed' : 'succeeded'
  const state = entry.sourceKind === 'error' ? 'failed' : 'observed'
  return {
    turnId: source.turnId,
    requestId: source.requestId,
    seq: entry.sequence,
    occurredAt,
    kind: entry.kind,
    modelRef: 'explicit-brain',
    taskId: source.taskId,
    operationId: source.operationId,
    executionEpoch: 1,
    tool: {
      callId: `explicit-${entry.sequence}`,
      toolId: 'explicit.interaction',
      argumentsRef: `interaction://${source.taskId.value}/${entry.sequence}`,
      argumentsDigest: `ui:${source.taskId.value}:${entry.sequence}`,
      status,
      outputRef: status === 'failed' ? undefined : `interaction://${source.taskId.value}/${entry.sequence}`,
      outputDigest: status === 'failed' ? undefined : `ui:${source.taskId.value}:${entry.sequence}`,
      error: entry.error ? { code: entry.error.code, message: entry.error.message, ownerId: entry.error.ownerId || 'humanagent.app', evidenceRefs: entry.evidenceRefs || [] } : undefined,
      startedAt: occurredAt,
      durationMs: 0,
    },
    authorization: {
      scope: { taskId: source.taskId, operationId: source.operationId },
      taskId: source.taskId,
      operationId: source.operationId,
      executionEpoch: 1,
      requestedCapabilities: ['explicit.interaction'],
      permissionRefs: [`explicit:${source.taskId.value}`],
      toolOutputRef: `interaction://${source.taskId.value}/${entry.sequence}`,
    },
    evidenceRefs: evidenceFor(entry.kind, entry.sequence, occurredAt),
    state,
    allowedActions: [],
    provider: { state: entry.sourceKind === 'error' ? 'unavailable' : 'ready', lastEventAt: occurredAt },
    transport: { connected: entry.sourceKind !== 'error', lastSyncedAt: occurredAt, cursor: `explicit:${source.taskId.value}:${entry.sequence}` },
    settlement: { providerStopped: false, checkpointCommitted: false },
    lastBusiness: { kind: entry.kind, at: occurredAt, ref: `${source.taskId.value}:${entry.sequence}` },
  }
}

function toLifecycleState(state) {
  switch (state) {
    case 'awaiting-clarification':
    case 'awaiting-confirmation':
      return 'waiting'
    case 'received':
    case 'matching':
      return 'created'
    case 'status-only':
    case 'submitted':
      return 'succeeded'
    default:
      return 'unknown'
  }
}

function taskStateFor(state) {
  switch (state) {
    case 'awaiting-clarification':
    case 'awaiting-confirmation':
      return 'waiting'
    case 'submitted':
      return 'succeeded'
    case 'received':
    case 'matching':
      return 'created'
    default:
      return 'running'
  }
}

function cardFromEntries(entries, state = 'received') {
  const now = nowIso()
  const latest = entries.at(-1)
  const source = latest ? sourceFor(latest) : {
    taskId: scopedId(TASK_SCOPE, 'pending-input'),
    operationId: scopedId(OPERATION_SCOPE, 'pending-input'),
    executionEpoch: 1,
    requestId: 'pending-input',
    turnId: 'pending-input',
  }
  return {
    source,
    currentNode: 'explicit.brain',
    ownerId: 'humanagent.runtime.explicit-brain',
    nextStep: fallbackText(latest?.text, '等待交互事件'),
    nextAction: latest?.eventKey || 'inspect-explicit-interaction',
    waitingOn: state.includes('awaiting') ? 'human' : 'runtime',
    startedAt: now,
    provider: { state: 'ready', lastEventAt: now },
    transport: { connected: true, lastSyncedAt: now, cursor: `explicit:${source.taskId.value}` },
    settlement: { providerStopped: false, checkpointCommitted: false },
    lastBusiness: latest
      ? { kind: latest.kind, at: now, ref: `${source.taskId.value}:${latest.sequence}` }
      : { kind: 'status', at: now, ref: source.taskId.value },
  }
}

function projectInteractionCard(input) {
  return {
    surface: 'interaction-work-card',
    taskState: input.taskState,
    statusbar: input.source,
    cardMetadata: {
      source: input.card.source,
      currentNode: input.card.currentNode,
      ownerId: input.card.ownerId,
      nextStep: input.card.nextStep,
      nextAction: input.card.nextAction,
      waitingOn: input.card.waitingOn,
      startedAt: input.card.startedAt,
      provider: input.card.provider,
      transport: input.card.transport,
      settlement: input.card.settlement,
      lastBusiness: input.card.lastBusiness,
    },
    conversation: {
      summary: input.conversation?.summary || { missing: true },
      turns: input.conversation?.turns || [],
    },
    actions: input.actions || [],
    trace: { count: input.history?.result?.page?.items?.length ?? 0, items: input.history?.result?.page?.items ?? [] },
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

export function projectInteractionCardFromSnapshot(snapshot, state) {
  const now = nowIso()
  const interactionId = snapshot?.interactionId || 'pending-input'
  const draft = snapshot?.draft || null
  const userTurn = {
    sourceKind: 'user',
    occurredAt: now,
    markdown: snapshot?.rawInput || fallbackText(snapshot?.reply, '尚未收到输入'),
  }
  const entries = [{ sequence: 1, kind: 'user', sourceKind: 'user', eventKey: 'explicit.raw-input', interactionId, text: userTurn.markdown }]
  let sequence = 1
  for (const clarification of snapshot?.clarifications || []) {
    sequence += 1
    entries.push({ sequence, kind: 'user', sourceKind: 'user', eventKey: 'explicit.clarification-answer', interactionId, text: clarification.answer || '' })
  }
  if (draft) {
    sequence += 1
    entries.push({ sequence, kind: 'decision', sourceKind: 'draft', eventKey: 'explicit.draft-confirmation', interactionId, text: draft.proposal || draft.normalizedInput || '草稿等待确认' })
  } else if (snapshot?.reply) {
    sequence += 1
    entries.push({ sequence, kind: 'assistant', sourceKind: 'assistant', eventKey: 'explicit.reply', interactionId, text: snapshot.reply })
  }

  const turnKind = draft ? 'draft' : 'assistant'
  const turnText = draft
    ? draft.proposal || draft.normalizedInput || '草稿已生成'
    : snapshot?.reply || snapshot?.nextAction || '交互处理中'

  return projectInteractionCard({
    taskState: taskStateFor(snapshot?.state || state),
    source: {
      state: 'ready',
      label: '显式大脑',
      detail: snapshot?.state || state,
      updatedAt: now,
    },
    card: cardFromEntries(entries, snapshot?.state || state),
    conversation: {
      summary: {
        goal: { text: snapshot?.rawInput || '尚未收到输入' },
        scope: draft ? { text: fallbackText(draft.proposedIntent, '当前交互范围') } : undefined,
        constraints: snapshot?.clarifications?.at(-1)?.question ? [{ text: snapshot.clarifications.at(-1).question }] : undefined,
        deliverables: draft ? [{ text: fallbackText(draft.normalizedInput, '整理后的任务要求') }] : undefined,
      },
      turns: [
        userTurn,
        ...entries.slice(1).map((entry) => ({
          sourceKind: turnKind === 'draft' && entry.kind === 'decision' ? 'draft' : 'progress',
          occurredAt: now,
          markdown: entry.text,
        })),
        { sourceKind: turnKind, occurredAt: now, markdown: turnText },
      ],
    },
    actions: draft
      ? [{ id: 'confirm-requirement', label: '确认并进入队列', executable: true }]
      : [],
    history: {
      query: { filter: { taskId: scopedId(TASK_SCOPE, interactionId) }, limit: 20, replay: true },
      result: {
        ok: true,
        page: {
          hasMore: false,
          filter: { taskId: scopedId(TASK_SCOPE, interactionId) },
          replay: true,
          items: entries.map(traceEntry),
        },
      },
    },
    nodeCards: [],
  })
}

export function projectInteractionCardFromEntries(entries, state = 'received') {
  const effectiveEntries = entries.length > 0
    ? entries
    : [{
        sequence: 1,
        interactionId: 'pending-input',
        kind: 'status',
        sourceKind: 'progress',
        eventKey: 'explicit.ready',
        text: '等待新的交互事件',
      }]
  return projectInteractionCard({
    taskState: toLifecycleState(state),
    source: {
      state: 'ready',
      label: '显式大脑',
      detail: state,
      updatedAt: nowIso(),
    },
    card: cardFromEntries(effectiveEntries, state),
    conversation: {
      summary: { missing: true },
      turns: effectiveEntries.map((entry) => ({
        sourceKind: entry.sourceKind || 'progress',
        occurredAt: nowIso(),
        markdown: entry.text || '',
        error: entry.error,
      })),
    },
    actions: [],
    history: {
      query: { filter: { taskId: scopedId(TASK_SCOPE, effectiveEntries.at(-1)?.interactionId || 'pending-input') }, limit: 50, replay: true },
      result: {
        ok: true,
        page: {
          hasMore: false,
          filter: { taskId: scopedId(TASK_SCOPE, effectiveEntries.at(-1)?.interactionId || 'pending-input') },
          replay: true,
          items: effectiveEntries.map(traceEntry),
        },
      },
    },
    nodeCards: [],
  })
}
