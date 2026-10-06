const TASK_SCOPE = 'task'
const OPERATION_SCOPE = 'operation'

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
// its key, kind, text and the interaction's own occurrence time. Anything the
// owner did not report stays absent; the page never mints a turn id, a request
// id, a tool call, an authorization record or an event time.
function interactiveEntry(entry) {
  return {
    kind: entry.kind,
    text: entry.text || '',
    eventKey: entry.eventKey,
    sequence: entry.sequence,
    ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
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

// The interaction id is the only real scope an explicit interaction has. The
// operation id is the interaction's runtime operation; it is derived from the
// interaction id so both scoped ids identify the same real owner.
function sourceFor(entry) {
  const interactionId = entry?.interactionId || 'pending-input'
  return {
    taskId: scopedId(TASK_SCOPE, interactionId),
    operationId: scopedId(OPERATION_SCOPE, interactionId),
  }
}

// The card status is built from the interaction facts the runtime reported. The
// only timestamp used is the occurrence time the interaction owner stamped, and
// it stays absent when the owner reported none.
function cardFromEntries(entries, state = 'received', latestOccurredAt) {
  const latest = entries.at(-1)
  const source = sourceFor(latest)
  const reportedAt = latestOccurredAt ?? latest?.occurredAt
  return {
    source,
    currentNode: 'explicit.brain',
    ownerId: 'humanagent.runtime.explicit-brain',
    nextStep: fallbackText(latest?.text, '等待交互事件'),
    nextAction: latest?.eventKey || 'inspect-explicit-interaction',
    waitingOn: state.includes('awaiting') ? 'human' : 'runtime',
    ...(reportedAt === undefined ? {} : { startedAt: reportedAt }),
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
    },
    conversation: {
      summary: input.conversation?.summary || { missing: true },
      turns: input.conversation?.turns || [],
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
export function projectInteractionCardFromSnapshot(snapshot, state) {
  const interactionId = snapshot?.interactionId || 'pending-input'
  const draft = snapshot?.draft || null
  const enteredAt = snapshot?.occurredAt
  const userTurn = {
    sourceKind: 'user',
    ...(enteredAt === undefined ? {} : { occurredAt: enteredAt }),
    markdown: snapshot?.rawInput || fallbackText(snapshot?.reply, '尚未收到输入'),
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
  const stateLabel = snapshot?.state || state

  return projectInteractionCard({
    taskState: taskStateFor(stateLabel),
    source: {
      state: 'ready',
      label: '显式大脑',
      detail: stateLabel,
      ...(enteredAt === undefined ? {} : { updatedAt: enteredAt }),
    },
    card: cardFromEntries(entries, stateLabel, enteredAt),
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
  const latestOccurredAt = effectiveEntries.reduce(
    (found, entry) => entry.occurredAt ?? found,
    undefined,
  )
  return projectInteractionCard({
    taskState: toLifecycleState(state),
    source: {
      state: 'ready',
      label: '显式大脑',
      detail: state,
      ...(latestOccurredAt === undefined ? {} : { updatedAt: latestOccurredAt }),
    },
    card: cardFromEntries(effectiveEntries, state, latestOccurredAt),
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
  return {
    ...projection,
    cardMetadata: latest
      ? {
          ...projection.cardMetadata,
          source: {
            taskId: latest.taskId,
            operationId: latest.operationId,
            executionEpoch: latest.executionEpoch,
            ...(latest.requestId === undefined ? {} : { requestId: latest.requestId }),
            ...(latest.turnId === undefined ? {} : { turnId: latest.turnId }),
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
