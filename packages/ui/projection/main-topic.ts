import type { ExplicitTurnPartialResult, TaskId, TaskInputRequest } from '../../contracts/src/index.js'
import type { RuntimeSseEvent, ExplicitInteractionStepProjection } from '../contracts/runtime.js'

export interface ConversationStatusFacts {
  readonly state: string
  readonly events?: readonly ConversationStatusEvent[]
  readonly steps?: readonly ExplicitInteractionStepProjection[]
  readonly waitingForUser?: boolean
  readonly error?: MainTopicTaskInput['error']
}

export interface ConversationStatusEvent extends Pick<RuntimeSseEvent,
  'seq' | 'occurredAt' | 'taskId' | 'operationId' | 'executionEpoch' | 'kind' | 'state' | 'callId' | 'status' | 'error' | 'terminalPhase'> {
  readonly requestId?: string
  readonly turnId?: string
}

type ExplicitInteractionPartial = ExplicitTurnPartialResult & { readonly resumed?: boolean }

export type MainTopicTurnRole = 'user' | 'jenny'
export type MainTopicTurnKind =
  | 'message'
  | 'draft'
  | 'clarification'
  | 'input-request'
  | 'status'
  | 'result'
  | 'partial'
  | 'error'

export interface MainTopicClarification {
  readonly question: string
  readonly options?: readonly string[]
  readonly answer?: string
}

export interface MainTopicInteractionInput {
  readonly steps?: readonly ExplicitInteractionStepProjection[]
  readonly interactionId: string
  readonly rawInput: string
  readonly occurredAt?: string
  readonly state: string
  readonly reply?: string
  readonly partial?: ExplicitInteractionPartial
  readonly clarifications?: readonly MainTopicClarification[]
  readonly draftProposal?: string
  readonly taskId?: TaskId
}

export interface MainTopicTaskInput {
  readonly detailReadError?: { readonly message: string }
  readonly events?: readonly (RuntimeSseEvent & { readonly requestId?: string; readonly turnId?: string })[]
  readonly taskId: TaskId
  readonly parentTaskId?: TaskId
  readonly title: string
  readonly state: string
  readonly stateLabel: string
  readonly currentNode: string
  readonly nextStep: string
  readonly output: string
  readonly updatedAt: string
  readonly startedAt?: string
  readonly latestSummary?: string
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly nextAction?: string
  }
  readonly inputRequest?: TaskInputRequest
  readonly consumedInputRequests?: readonly {
    readonly request: TaskInputRequest
    readonly answer: string
  }[]
  readonly sourceInteractionId?: string
}

export interface MainTopicTurn {
  readonly detailReadError?: MainTopicTaskInput['detailReadError']
  readonly toolEvents?: readonly RuntimeSseEvent[]
  readonly statusFacts?: ConversationStatusFacts
  readonly turnId: string
  readonly role: MainTopicTurnRole
  readonly kind: MainTopicTurnKind
  readonly text: string
  readonly occurredAt?: string
  readonly interactionId?: string
  readonly taskId?: TaskId
  readonly requestId?: string
  readonly expectedRevision?: number
  readonly quote?: string
  readonly options?: readonly string[]
  readonly partial?: ExplicitInteractionPartial
}

export interface MainTopicTaskView {
  readonly detailReadError?: MainTopicTaskInput['detailReadError']
  readonly taskId: TaskId
  readonly title: string
  readonly state: string
  readonly stateLabel: string
  readonly currentNode: string
  readonly currentStepLabel: string
  readonly nextStep: string
  readonly output: string
  readonly updatedAt: string
  readonly startedAt?: string
  readonly latestSummary?: string
  readonly error?: MainTopicTaskInput['error']
  readonly sourceInteractionId?: string
}

export interface MainTopicConversationRound {
  readonly roundKey: string
  readonly interactionId?: string
  readonly taskId?: TaskId
  readonly lane: 'history' | 'active' | 'unknown'
  readonly userText?: string
  readonly summary?: {
    readonly text: string
    readonly source: 'recorded-summary' | 'answer-excerpt' | 'result-excerpt'
    readonly sourceRef: string
  }
  readonly messageRefs: readonly string[]
}

export interface MainTopicProjection {
  readonly surface: 'main-topic'
  readonly projectKey: string
  readonly projectName: string
  readonly workspaceCwd: string
  readonly agentName: 'Jenny'
  readonly topicName: '主话题'
  readonly mode: 'fake' | 'rcc'
  readonly turns: readonly MainTopicTurn[]
  readonly rounds: readonly MainTopicConversationRound[]
  readonly tasks: readonly MainTopicTaskView[]
  readonly openInputRequest?: TaskInputRequest & {
    readonly sourceInteractionId?: string
    readonly sourceQuestion?: string
  }
  readonly activeTask?: MainTopicTaskView
}

export interface MainTopicProjectionInput {
  readonly projectKey: string
  readonly projectName: string
  readonly workspaceCwd: string
  readonly mode: 'fake' | 'rcc'
  readonly interactions: readonly MainTopicInteractionInput[]
  readonly tasks: readonly MainTopicTaskInput[]
}

const ACTIVE_TASK_STATES = new Set(['created', 'admitted', 'running', 'settling', 'waiting'])
const FAILED_TASK_STATES = new Set(['failed', 'blocked', 'stopped', 'cancelled', 'stale'])
const CLOSED_INTERACTION_STATES = new Set(['answered', 'status-only', 'closed', 'completed', 'succeeded'])

function excerpt(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length <= 180) return normalized
  const sentenceEnd = Math.max(normalized.lastIndexOf('。', 180), normalized.lastIndexOf('！', 180),
    normalized.lastIndexOf('？', 180), normalized.lastIndexOf('；', 180))
  const boundary = sentenceEnd > 120 ? sentenceEnd + 1 : normalized.lastIndexOf(' ', 180)
  return `${normalized.slice(0, boundary > 120 ? boundary : 180).trimEnd()}…`
}

function semanticCurrentNode(currentNode: string): string {
  const labels: Record<string, string> = {
    'provider.model': '发出请求等待响应',
    'provider.execute': '执行模型任务',
    'provider.tool': '执行工具等待结果',
    'prepare': '准备执行',
    'scheduler': '排队等待调度',
  }
  return labels[currentNode] ?? (currentNode.trim() === '' ? '等待状态' : '处理中')
}

function taskStatusText(task: MainTopicTaskInput): string {
  if (task.state === 'running') {
    return semanticCurrentNode(task.currentNode)
  }
  if (task.state === 'waiting') return '等待你的回答后继续原任务'
  if (task.state === 'settling') return '正在核对执行结果'
  return task.stateLabel || task.state
}

function interactionTurns(interaction: MainTopicInteractionInput): MainTopicTurn[] {
  const turns: MainTopicTurn[] = [{
    turnId: `user:${interaction.interactionId}`,
    role: 'user',
    kind: 'message',
    text: interaction.rawInput,
    interactionId: interaction.interactionId,
    ...(interaction.occurredAt === undefined ? {} : { occurredAt: interaction.occurredAt }),
  }]
  for (const [index, clarification] of (interaction.clarifications ?? []).entries()) {
    turns.push({
      turnId: `clarification:${interaction.interactionId}:${index}`,
      role: 'jenny',
      kind: 'clarification',
      text: clarification.question,
      interactionId: interaction.interactionId,
      quote: interaction.rawInput,
      ...(clarification.options === undefined ? {} : { options: clarification.options }),
    })
    if (clarification.answer === undefined) continue
    turns.push({
      turnId: `clarification-answer:${interaction.interactionId}:${index}`,
      role: 'user',
      kind: 'message',
      text: clarification.answer,
      interactionId: interaction.interactionId,
      quote: clarification.question,
    })
  }
  if (interaction.reply && (interaction.state === 'answered' || interaction.state === 'status-only')) {
    turns.push({
      turnId: `reply:${interaction.interactionId}`,
      role: 'jenny',
      kind: 'message',
      text: interaction.reply,
      interactionId: interaction.interactionId,
    })
  } else if (interaction.draftProposal && interaction.state !== 'answered') {
    turns.push({
      turnId: `draft:${interaction.interactionId}`,
      role: 'jenny',
      kind: 'draft',
      text: interaction.draftProposal,
      interactionId: interaction.interactionId,
      quote: interaction.rawInput,
      ...(interaction.taskId === undefined ? {} : { taskId: interaction.taskId }),
    })
  } else if ((interaction.state === 'partial' || interaction.state === 'matching') && interaction.partial) {
    turns.push({
      turnId: `partial:${interaction.interactionId}:${interaction.partial.partialRef}`,
      role: 'jenny',
      kind: 'partial',
      text: interaction.partial.userMessage,
      interactionId: interaction.interactionId,
      quote: interaction.rawInput,
      partial: interaction.partial,
    })
  }
  return turns
}

function consumedRequestTurns(task: MainTopicTaskInput, sourceQuestion?: string): MainTopicTurn[] {
  const turns: MainTopicTurn[] = []
  const taskId = task.taskId
  const quote = sourceQuestion
  for (const consumed of task.consumedInputRequests ?? []) {
    turns.push({
      turnId: `input-request:${consumed.request.requestId}`,
      role: 'jenny',
      kind: 'input-request',
      text: consumed.request.question,
      taskId,
      requestId: consumed.request.requestId,
      expectedRevision: consumed.request.expectedRevision,
      ...(quote === undefined ? {} : { quote }),
      ...(consumed.request.options === undefined ? {} : { options: consumed.request.options }),
    }, {
      turnId: `input-answer:${consumed.request.requestId}`,
      role: 'user',
      kind: 'message',
      text: consumed.answer,
      taskId,
      requestId: consumed.request.requestId,
      expectedRevision: consumed.request.expectedRevision,
      quote: consumed.request.question,
    })
  }
  return turns
}

function taskTurns(task: MainTopicTaskInput, sourceQuestion?: string): MainTopicTurn[] {
  const turns: MainTopicTurn[] = consumedRequestTurns(task, sourceQuestion)
  const taskId = task.taskId
  const quote = sourceQuestion
  if (task.inputRequest) {
    turns.push({
      turnId: `input-request:${task.inputRequest.requestId}`,
      role: 'jenny',
      kind: 'input-request',
      text: task.inputRequest.question,
      occurredAt: task.updatedAt,
      taskId,
      requestId: task.inputRequest.requestId,
      expectedRevision: task.inputRequest.expectedRevision,
      ...(quote === undefined ? {} : { quote }),
      ...(task.inputRequest.options === undefined ? {} : { options: task.inputRequest.options }),
    })
    return turns
  }
  if (task.state === 'succeeded' && task.output.trim() !== '') {
    turns.push({
      turnId: `result:${taskId.value}`,
      role: 'jenny',
      kind: 'result',
      text: task.output,
      occurredAt: task.updatedAt,
      taskId,
      ...(quote === undefined ? {} : { quote }),
    })
    return turns
  }
  if (FAILED_TASK_STATES.has(task.state)) {
    turns.push({
      turnId: `error:${taskId.value}`,
      role: 'jenny',
      kind: 'error',
      text: task.error?.message || task.latestSummary || task.stateLabel || '任务未完成',
      occurredAt: task.updatedAt,
      taskId,
      ...(quote === undefined ? {} : { quote }),
    })
    return turns
  }
  if (ACTIVE_TASK_STATES.has(task.state)) {
    turns.push({
      turnId: `status:${taskId.value}`,
      role: 'jenny',
      kind: 'status',
      text: taskStatusText(task),
      occurredAt: task.updatedAt,
      taskId,
      ...(quote === undefined ? {} : { quote }),
    })
  }
  return turns
}

/**
 * Projects the one serve-bound project's explicit interactions and linked Tasks
 * into the visible main Topic. Every turn is derived from a durable interaction
 * or Task fact; an absent reply, output or request stays absent.
 */
export function projectMainTopic(input: MainTopicProjectionInput): MainTopicProjection {
  const tasksById = new Map(input.tasks.map((task) => [task.taskId.value, task]))
  const relayedRequests = new Map<string, NonNullable<MainTopicTaskInput['inputRequest']>>()
  for (const task of input.tasks) {
    const parent = task.parentTaskId === undefined ? undefined : tasksById.get(task.parentTaskId.value)
    if (parent === undefined) continue
    if (task.inputRequest !== undefined && parent.inputRequest === undefined) {
      relayedRequests.set(parent.taskId.value, { ...task.inputRequest, taskId: parent.taskId })
    }
  }
  // A scheduled child is an execution of its user-facing parent Task. It is
  // evidence for that parent, never a second conversation item.
  const visibleTaskInputs = input.tasks
    .filter((task) => task.parentTaskId === undefined || !tasksById.has(task.parentTaskId.value))
    .map((task) => {
      const relayedRequest = relayedRequests.get(task.taskId.value)
      const consumedInputRequests = input.tasks
        .filter((child) => child.parentTaskId?.value === task.taskId.value)
        .flatMap((child) => child.consumedInputRequests ?? [])
      return {
        ...task,
        ...(relayedRequest === undefined ? {} : { inputRequest: relayedRequest }),
        ...((task.consumedInputRequests?.length ?? 0) + consumedInputRequests.length === 0
          ? {} : { consumedInputRequests: [...(task.consumedInputRequests ?? []), ...consumedInputRequests] }),
      }
    })
  const tasks = visibleTaskInputs.map((task): MainTopicTaskView => ({
    ...(task.detailReadError === undefined ? {} : { detailReadError: task.detailReadError }),
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    stateLabel: task.state === 'waiting' && task.inputRequest !== undefined
      ? '等待你的回答'
      : task.stateLabel,
    currentNode: task.currentNode,
    currentStepLabel: task.state === 'waiting' && task.inputRequest !== undefined
      ? (task.nextStep.trim() === '' ? '回答后继续同一任务' : task.nextStep)
      : semanticCurrentNode(task.currentNode),
    nextStep: task.nextStep,
    output: task.output,
    updatedAt: task.updatedAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.latestSummary === undefined ? {} : { latestSummary: task.latestSummary }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.sourceInteractionId === undefined ? {} : { sourceInteractionId: task.sourceInteractionId }),
  }))

  const turns: MainTopicTurn[] = []
  const tasksByInteraction = new Map<string, MainTopicTaskInput>()
  for (const task of visibleTaskInputs) {
    if (task.sourceInteractionId !== undefined) tasksByInteraction.set(task.sourceInteractionId, task)
  }

  const interactions = [...input.interactions].sort((left, right) =>
    (left.occurredAt ?? '').localeCompare(right.occurredAt ?? ''))
  for (const interaction of interactions) {
    const explicitTurns = interactionTurns(interaction)
    const task = tasksByInteraction.get(interaction.interactionId)
    if (task === undefined) {
      const response = [...explicitTurns].reverse().find((turn) => turn.role === 'jenny')
      const statusFacts = { state: interaction.state, steps: interaction.steps ?? [], waitingForUser: interaction.state === 'awaiting-clarification' }
      if (response) {
        const index = explicitTurns.indexOf(response)
        explicitTurns[index] = { ...response, statusFacts }
      } else explicitTurns.push({ turnId: `explicit-status:${interaction.interactionId}`, role: 'jenny', kind: 'status', text: '正在处理你的请求', interactionId: interaction.interactionId, statusFacts })
    }
    turns.push(...explicitTurns)
    if (task !== undefined) turns.push(...taskTurns(task, interaction.rawInput))
  }
  // A Task without an interaction join keeps its own answered questions, but it
  // is never attributed to a guessed chat turn. Its live status still shows
  // only while it is active.
  for (const task of visibleTaskInputs) {
    if (task.sourceInteractionId !== undefined) continue
    // Completed unlinked work keeps its own answered questions. It is still
    // never attributed to a guessed chat turn.
    turns.push(...(ACTIVE_TASK_STATES.has(task.state) ? taskTurns(task) : consumedRequestTurns(task)))
  }

  for (const task of visibleTaskInputs) {
    if (task.detailReadError !== undefined) turns.push({
      turnId: `detail-read-error:${task.taskId.value}`,
      role: 'jenny', kind: 'status', text: '执行详情读取失败',
      taskId: task.taskId, quote: task.title, detailReadError: task.detailReadError,
    })
  }

  const rounds: MainTopicConversationRound[] = []
  const turnsByInteraction = new Map<string, MainTopicTurn[]>()
  for (const turn of turns) {
    if (turn.interactionId === undefined) continue
    const group = turnsByInteraction.get(turn.interactionId) ?? []
    group.push(turn)
    turnsByInteraction.set(turn.interactionId, group)
  }
  for (const interaction of interactions) {
    const task = tasksByInteraction.get(interaction.interactionId)
    const group = [
      ...(turnsByInteraction.get(interaction.interactionId) ?? []),
      ...(task === undefined ? [] : turns.filter((turn) => turn.taskId?.value === task.taskId.value)),
    ]
    const answer = [...group].reverse().find((turn) => turn.role === 'jenny' && turn.kind === 'message')
    const result = group.find((turn) => turn.kind === 'result')
    const summaryText = task?.latestSummary?.trim()
    const summary = summaryText && task !== undefined
      ? { text: excerpt(summaryText), source: 'recorded-summary' as const, sourceRef: `task:${task.taskId.value}` }
      : answer !== undefined
        ? { text: excerpt(answer.text), source: 'answer-excerpt' as const, sourceRef: answer.turnId }
        : result !== undefined
          ? { text: excerpt(result.text), source: 'result-excerpt' as const, sourceRef: result.turnId }
          : undefined
    const lane = task !== undefined
      ? task.state === 'succeeded' ? 'history' : ACTIVE_TASK_STATES.has(task.state) || FAILED_TASK_STATES.has(task.state) ? 'active' : 'unknown'
      : CLOSED_INTERACTION_STATES.has(interaction.state) ? 'history' : 'active'
    rounds.push({
      roundKey: `interaction:${interaction.interactionId}`,
      interactionId: interaction.interactionId,
      ...(task === undefined ? {} : { taskId: task.taskId }),
      lane,
      userText: interaction.rawInput,
      ...(summary === undefined ? {} : { summary }),
      messageRefs: group.map((turn) => turn.turnId),
    })
  }
  for (const task of visibleTaskInputs) {
    if (task.sourceInteractionId !== undefined) continue
    const group = turns.filter((turn) => turn.taskId?.value === task.taskId.value)
    const result = group.find((turn) => turn.kind === 'result')
    const summaryText = task.latestSummary?.trim()
    const summary = summaryText
      ? { text: excerpt(summaryText), source: 'recorded-summary' as const, sourceRef: `task:${task.taskId.value}` }
      : result === undefined ? undefined
        : { text: excerpt(result.text), source: 'result-excerpt' as const, sourceRef: result.turnId }
    rounds.push({
      roundKey: `task:${task.taskId.value}`,
      taskId: task.taskId,
      lane: task.state === 'succeeded' ? 'history' : ACTIVE_TASK_STATES.has(task.state) || FAILED_TASK_STATES.has(task.state) ? 'active' : 'unknown',
      ...(summary === undefined ? {} : { summary }),
      messageRefs: group.map((turn) => turn.turnId),
    })
  }

  // Decorate only the current task card. Historical questions keep their own
  // answer lifecycle and never inherit the task's subsequent live phase.
  for (const task of visibleTaskInputs) {
    const last = [...turns].reverse().find((turn) => turn.taskId?.value === task.taskId.value && turn.role === 'jenny' && turn.detailReadError === undefined
      && (turn.kind !== 'input-request' || (turn.requestId === task.inputRequest?.requestId
        && turn.expectedRevision === task.inputRequest?.expectedRevision)))
    const index = last === undefined ? -1 : turns.indexOf(last)
    if (index < 0) continue
    turns[index] = { ...turns[index]!,
      toolEvents: (task.events ?? []).filter((event) => event.kind === 'provider.tool' || event.kind === 'provider.tool-result'),
      statusFacts: {
      state: task.state,
      events: (task.events ?? []).map(({ seq, occurredAt, taskId, operationId, executionEpoch, kind, state,
        requestId, turnId, callId, status, error, terminalPhase }) => ({ seq, occurredAt, taskId, operationId,
        executionEpoch, kind, state, requestId, turnId, callId, status, error, terminalPhase })),
      waitingForUser: task.inputRequest !== undefined,
      ...(task.error === undefined ? {} : { error: task.error }),
    } }
  }

  const waiting = visibleTaskInputs
    .filter((task) => task.inputRequest !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  const sourceQuestion = waiting?.sourceInteractionId === undefined
    ? undefined
    : input.interactions.find((interaction) => interaction.interactionId === waiting.sourceInteractionId)?.rawInput
  const active = visibleTaskInputs
    .filter((task) => ACTIVE_TASK_STATES.has(task.state))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  const activeView = active === undefined ? undefined : tasks.find((task) => task.taskId.value === active.taskId.value)
  const waitingView = waiting === undefined ? undefined : tasks.find((task) => task.taskId.value === waiting.taskId.value)

  return {
    surface: 'main-topic',
    projectKey: input.projectKey,
    projectName: input.projectName,
    workspaceCwd: input.workspaceCwd,
    agentName: 'Jenny',
    topicName: '主话题',
    mode: input.mode,
    turns,
    rounds,
    tasks,
    ...(waitingView?.error === undefined && waiting !== undefined
      ? {
        openInputRequest: {
          ...waiting.inputRequest!,
          ...(waiting.sourceInteractionId === undefined ? {} : { sourceInteractionId: waiting.sourceInteractionId }),
          ...(sourceQuestion === undefined ? {} : { sourceQuestion }),
        },
      }
      : {}),
    ...(activeView === undefined ? {} : { activeTask: activeView }),
  }
}
