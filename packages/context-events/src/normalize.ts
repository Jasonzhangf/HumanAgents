/**
 * Context Events —— Normalize：唯一构造入口（§9.3）+ 4 个适配器（§9.2）。
 *
 * 设计契约：docs/architecture/context-events.md §9.1–§9.5、§12。
 *
 * 职责边界：
 * - `createContextEvent` 是 `eventId` / `payloadRef` / `dataDigest` / `scope` 校验 /
 *   `status` **初值**派生的唯一 owner（§9.3）。四个适配器都是它的薄包装：只把各自输入
 *   折算成 `ContextEventInput`，不重复实现任何派生（§12 确定性由此单点保证）。
 * - `pairing` **不在这里产出**：它是派生关系，由 `pairing.ts` 的 `applyPairingOutcome`
 *   独占赋值（§8.2 / §9.3）。
 * - 依赖上限：只 import `./types.js` / `./taxonomy.js` / `./errors.js` / `./validation.js` 与
 *   `packages/contracts` 的类型。不得 import `packages/runtime`（§4）。
 * - 纯函数（§12）：不读时钟、不取随机数、不读环境变量、不读文件系统。
 *   （`node:crypto` 是确定性哈希，不读环境；见 §9.5。）
 *
 * 校验归属：`createContextEvent` 末尾调用 W1 的 `validateCanonicalContextEvent`（§11 第 1–15 项）。
 * 构造入口自身**特有**的两条契约不属 §11 判据，另立最小自检（不是重复校验）：
 * 1. §9.3 `pairing` 不由 `createContextEvent` 产出（§11 第 9–14 项在 `pairing === undefined` 时 vacuous）；
 * 2. §9.1 `eventId` / `payloadRef` 必须等于派生结果 `` `context-event:${sourceId}` ``（派生规则，非 §11 判据）。
 * import 边单向往 `validation.ts`，`validation.ts` 不反向 import 本文件，无循环。
 */

import { createHash } from 'node:crypto';

import type {
  AgentSemanticEventKind,
  EvidenceRef,
  OperationStatus,
  ProviderEventKind,
  ProviderTerminalState,
  ProviderToolStatus,
  ScopeRef,
  TaskId,
} from '../../contracts/src/index.js';
import { ContextEventError } from './errors.js';
import { defaultStatusOf, labelOf } from './taxonomy.js';
import type {
  CanonicalContextEvent,
  ContextEventInput,
  ContextEventType,
} from './types.js';
import { validateCanonicalContextEvent } from './validation.js';

/* ------------------------------------------------------------------ *
 * §9 结构化输入接口
 * ------------------------------------------------------------------ */

/** §9.1：来源不携带的权威 scope / 身份 / 时间戳由调用方补。 */
export interface NormalizeContext {
  /** 权威 scope；来源自带 scope 时以来源为准，否则用它。 */
  readonly scope?: ScopeRef;
  /** 来源无稳定身份时必须提供。 */
  readonly sourceId?: string;
  /** 来源无时间戳时必须提供。 */
  readonly occurredAt?: string;
}

export type NormalizeSourceKind =
  | 'event-record'
  | 'agent-event'
  | 'agent-semantic-event'
  | 'provider-event';

/**
 * §9.2：未映射来源必须显式登记，不得静默丢弃。
 *
 * `reason` 是 3 值闭合词表：未命中规则 / 等待不是终态 / 工具阶段不可区分。
 */
export interface UnmappedSource {
  readonly sourceKind: NormalizeSourceKind;
  readonly sourceId: string;
  readonly rawKind: string;
  readonly reason: 'unknown-kind' | 'waiting-is-not-terminal' | 'indistinguishable-tool-phase';
}

export interface NormalizeResult {
  readonly events: readonly CanonicalContextEvent[];
  readonly unmapped: readonly UnmappedSource[];
}

/**
 * `EventRecord`（`packages/runtime/src/events/types.ts`）的结构化投影。
 *
 * 只声明真实存在且本模块用到的字段：`EventEnvelope` **无** `payloadRef`；
 * `operation.status` 的真实类型是 contracts 的 `OperationStatus`（12 值），不是 string。
 */
export interface EventRecordLike {
  readonly messageId: string;
  readonly streamId: string;
  readonly kind?: string;
  readonly class: 'control' | 'data' | 'observation';
  readonly scope: ScopeRef;
  readonly occurredAt: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sequence: number;
  readonly operation?: {
    readonly status: OperationStatus;
    readonly resultRef?: string;
    readonly outputDigest?: string;
  };
}

/**
 * `AgentEvent` 的结构化投影。
 *
 * `kind` 保留自由 `string`：真实 `AgentEvent.kind` 就是自由 string，且有**两种方言**
 * （provider 方言 `provider.<kind>` / dsh 方言裸 `<kind>`，见 §9.2），此处不收紧。
 * `ProviderAgentEvent extends AgentEvent` 且带 `providerEvent`，因此必须声明该字段：
 * `provider.tool-result` 的成败判据取自 `providerEvent.toolResult.status`。
 */
export interface AgentEventLike {
  readonly kind: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly summary?: string;
  readonly terminalState?: ProviderTerminalState;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly providerEvent?: ProviderEventLike;
}

/** `AgentSemanticEvent` 的结构化投影。`kind` 是闭合 union，保留真源类型。 */
export interface AgentSemanticEventLike {
  readonly seq: number;
  readonly kind: AgentSemanticEventKind;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly terminalState?: ProviderTerminalState;
}

/**
 * `ProviderEvent`（`packages/contracts/src/index.ts`）的结构化投影。
 *
 * `ProviderEvent` 继承 `ProviderExecutionIdentityRef`，**无** `scope`、**无** `occurredAt`，
 * 也**无** `payloadRef`：前两者必须由 `NormalizeContext` 提供，后者一律兜底派生。
 * 闭合 union 一律保留真源类型，不放宽成 string（放宽会掩盖 kind 词汇不匹配）。
 */
export interface ProviderEventLike {
  readonly eventId: string;
  readonly kind: ProviderEventKind;
  readonly toolPhase?: 'invoke' | 'result';
  readonly terminalState?: ProviderTerminalState;
  readonly summary?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: { readonly message: string };
  readonly toolResult?: {
    readonly status: ProviderToolStatus;
    readonly outputRef?: string;
    readonly outputDigest?: string;
  };
}

/* ------------------------------------------------------------------ *
 * §9.3 唯一构造入口
 * ------------------------------------------------------------------ */

/**
 * canonical 事件的**唯一**构造函数。四个适配器都是它的薄包装。
 *
 * 派生（唯一 owner）：
 * - `eventId` = `payloadRef` = `` `context-event:${sourceId}` ``（§9.1 / §9.5）
 * - `dataDigest` = `sha256(JSON.stringify(按固定字段序重建的规范化对象))`（§9.5 / §12）
 * - `summary` = 来源 summary 非空时透传，否则 taxonomy `label`（§9.5）
 * - `status` 初值 = `supersededByEventId` 存在 → `'superseded'`，否则 `defaultStatusOf(type)`（§9.3）
 *
 * **没有** `status` 入参：构造期不接受调用方指定 status，否则 §8.2
 * 「`applyPairingOutcome` 是配对改写唯一 owner」被绕过。`pairing` 也不在这里产出。
 */
export function createContextEvent(input: ContextEventInput): CanonicalContextEvent {
  const eventId = contextEventRef(input.sourceId);
  const summary = input.summary !== undefined && input.summary !== '' ? input.summary : labelOf(input.type);
  const status = input.supersededByEventId !== undefined ? 'superseded' : defaultStatusOf(input.type);
  const evidenceRefs = input.evidenceRefs ?? [];

  const event: CanonicalContextEvent = {
    eventId,
    sourceId: input.sourceId,
    type: input.type,
    scope: input.scope,
    occurredAt: input.occurredAt,
    status,
    summary,
    payloadRef: contextEventRef(input.sourceId),
    dataDigest: digestOfConstructedEvent(input, summary, evidenceRefs),
    evidenceRefs,
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    ...(input.supersededByEventId === undefined
      ? {}
      : { supersededByEventId: input.supersededByEventId }),
  };

  validateCanonicalContextEvent(event);
  assertConstructionInvariants(event);
  return event;
}

/**
 * §9.1 / §9.5：`eventId` 与 `payloadRef` 共用同一派生规则。
 */
function contextEventRef(sourceId: string): string {
  return `context-event:${sourceId}`;
}

/**
 * §9.5：`dataDigest` 对**按固定字段序重建的规范化对象**求 sha256。
 *
 * 必须显式按固定字段序构造待哈希对象，不得直接哈希来源对象：`JSON.stringify` 的键序
 * 由构造顺序决定，直接哈希来源对象会让同一语义因属性插入顺序不同而得到不同摘要。
 *
 * **哈希的是最终写入事件的取值，不是原始入参**（§9.5 规则 1，由调用方传入补齐后的值）：
 * - `summary`：缺省时已补 `labelOf(type)`；
 * - `evidenceRefs`：缺省时已按 `[]`。
 *
 * **不参与哈希**（§9.5 规则 2）：`status` / `pairing` / `eventId` / `payloadRef` / `dataDigest`。
 * 因此 `dataDigest` 在 `applyPairingOutcome`（改写 `status` / `pairing`）前后保持不变。
 *
 * **值为 `undefined` 的可选字段省略该键**（不写 `null`）；数组保持输入顺序不重排。
 */
function digestOfConstructedEvent(
  input: ContextEventInput,
  summary: string,
  evidenceRefs: readonly EvidenceRef[],
): string {
  const normalized = {
    type: input.type,
    sourceId: input.sourceId,
    occurredAt: input.occurredAt,
    scope: scopeForDigest(input.scope),
    summary,
    evidenceRefs,
    supersededByEventId: input.supersededByEventId,
    cost: input.cost,
  };
  return `sha256:${sha256Hex(JSON.stringify(normalized))}`;
}

/** `ScopeRef` 的固定字段序投影，供摘要使用（§12）。 */
function scopeForDigest(scope: ScopeRef): Record<string, unknown> {
  return {
    organId: { scope: scope.organId.scope, value: scope.organId.value },
    ...(scope.taskId === undefined
      ? {}
      : { taskId: { scope: scope.taskId.scope, value: scope.taskId.value } }),
    ...(scope.cycleId === undefined
      ? {}
      : { cycleId: { scope: scope.cycleId.scope, value: scope.cycleId.value } }),
    ...(scope.operationId === undefined
      ? {}
      : { operationId: { scope: scope.operationId.scope, value: scope.operationId.value } }),
  };
}

/**
 * 构造入口**特有**的契约自检（§11 判据不覆盖，故不是重复校验）：
 *
 * 1. §9.3：`pairing` 是派生关系，由 `applyPairingOutcome` 独占赋值，构造入口不得产出它。
 *    §11 第 9–14 项只在 `pairing` 存在时适用，`pairing === undefined` 时 vacuous，
 *    因此这条必须由构造入口自己守住。
 * 2. §9.1 / §9.5：`eventId` 与 `payloadRef` 必须等于 `` `context-event:${sourceId}` ``。
 *    这是派生规则，不是 §11 判据，校验器不检查。
 *
 * §11 第 1–15 项全部由 `validateCanonicalContextEvent`（W1）覆盖，此处不重复。
 */
function assertConstructionInvariants(event: CanonicalContextEvent): void {
  if (event.pairing !== undefined) {
    throw new ContextEventError('createContextEvent must not produce pairing');
  }
  const derivedRef = contextEventRef(event.sourceId);
  if (event.eventId !== derivedRef || event.payloadRef !== derivedRef) {
    throw new ContextEventError(
      `context event eventId/payloadRef must be derived as ${derivedRef}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * §9.2 映射：raw kind → canonical type
 * ------------------------------------------------------------------ */

type UnmappedReason = UnmappedSource['reason'];

type MappingOutcome =
  | { readonly kind: 'mapped'; readonly type: ContextEventType }
  | { readonly kind: 'unmapped'; readonly reason: UnmappedReason };

function mapped(type: ContextEventType): MappingOutcome {
  return { kind: 'mapped', type };
}

function unmapped(reason: UnmappedReason): MappingOutcome {
  return { kind: 'unmapped', reason };
}

/**
 * §9.2 `terminal` 三态，三种方言同形：
 * `succeeded` → `operation.completed`；`waiting` → unmapped（等待不是终态，绝不伪装成完成）；
 * 其它 / 缺失 → `operation.failed`。
 */
function terminalOutcome(terminalState: ProviderTerminalState | undefined): MappingOutcome {
  if (terminalState === 'succeeded') return mapped('operation.completed');
  if (terminalState === 'waiting') return unmapped('waiting-is-not-terminal');
  return mapped('operation.failed');
}

/**
 * §9.2 `event-record`：优先按 `operation.status` 映射，其次按 `kind`。
 *
 * 覆盖 `OperationStatus` 全部 12 个值（无 `'pending'`，该值不存在）。
 * `cancelled` 归 `operation.failed`（取消是未成功的终态）；`blocked` 归 `operation.failed`。
 */
function typeForOperationStatus(status: OperationStatus): ContextEventType {
  switch (status) {
    case 'succeeded':
      return 'operation.completed';
    case 'failed':
    case 'blocked':
    case 'reconcile_required':
    case 'cancelled':
      return 'operation.failed';
    case 'accepted':
    case 'queued':
    case 'leased':
    case 'running':
    case 'settling':
    case 'verifying':
    case 'cancel_requested':
      return 'operation.started';
  }
}

function mapEventRecord(input: EventRecordLike): MappingOutcome {
  if (input.operation !== undefined) {
    return mapped(typeForOperationStatus(input.operation.status));
  }
  if (input.kind === 'checkpoint.committed') return mapped('checkpoint.committed');
  return unmapped('unknown-kind');
}

/**
 * §9.2 `agent-semantic-event`：闭合 8 值，**不含** tool-result / attention / transport。
 *
 * `execution.started` 的真实语义是操作开始（coordinator 以 `state: 'running'` 发出），
 * 映射到 `operation.started`，**不是** `task.confirmed`。
 */
function mapAgentSemanticEvent(input: AgentSemanticEventLike): MappingOutcome {
  switch (input.kind) {
    case 'execution.started':
    case 'provider.tool':
      return mapped('operation.started');
    case 'provider.error':
      return mapped('error.detected');
    case 'checkpoint.committed':
      return mapped('checkpoint.committed');
    case 'execution.terminal':
      return terminalOutcome(input.terminalState);
    case 'provider.model':
    case 'provider.output':
    case 'execution.settling':
      return unmapped('unknown-kind');
  }
}

/**
 * §9.2 agent-event **provider 方言**：`provider.<kind>`，另加 `provider.tool-result`。
 *
 * `provider.tool-result` 的成败取自 `providerEvent.toolResult.status`；缺 `toolResult`
 * 时进 unmapped（reason 词表本轮只有 3 值，仍用 `'unknown-kind'`）。
 */
function mapProviderDialectAgentEvent(input: AgentEventLike): MappingOutcome {
  switch (input.kind) {
    case 'provider.tool':
      return mapped('operation.started');
    case 'provider.tool-result': {
      const toolResult = input.providerEvent?.toolResult;
      if (toolResult === undefined) return unmapped('unknown-kind');
      return mapped(toolResult.status === 'succeeded' ? 'operation.completed' : 'operation.failed');
    }
    case 'provider.error':
    case 'provider.transport':
      return mapped('error.detected');
    case 'provider.attention':
      return mapped('blocker.detected');
    case 'provider.terminal':
      return terminalOutcome(input.terminalState);
    case 'provider.model':
    case 'provider.output':
      return unmapped('unknown-kind');
    default:
      return unmapped('unknown-kind');
  }
}

/**
 * §9.2 agent-event **dsh 方言**：裸 `<kind>`，同一 7 值集合。
 *
 * 该方言只复制 `kind`（`packages/adapters/dsh/src/driver.ts:62-70` 不复制 `providerEvent`），
 * 读不到 `toolPhase` / `toolResult`。真源 `real-transport.ts` 对 `tool/call` 与 `tool/result`
 * **都**产出 `kind: 'tool'` 且都不设 `toolPhase`：把 `tool` 当成调用会让每次工具完成都产出
 * `operation.started`，永不产出 `operation.completed` / `operation.failed`。
 * 因此 dsh 方言的 `tool` **必须** → unmapped（`indistinguishable-tool-phase`）。
 */
function mapDshDialectAgentEvent(input: AgentEventLike): MappingOutcome {
  switch (input.kind) {
    case 'tool':
      return unmapped('indistinguishable-tool-phase');
    case 'error':
    case 'transport':
      return mapped('error.detected');
    case 'attention':
      return mapped('blocker.detected');
    case 'terminal':
      return terminalOutcome(input.terminalState);
    case 'model':
    case 'output':
      return unmapped('unknown-kind');
    default:
      return unmapped('unknown-kind');
  }
}

/**
 * 两种方言的 `kind` 词汇表不相交：provider 方言一律 `provider.` 前缀，dsh 方言一律裸 kind
 * （§9.2）。因此用前缀判定方言，不依赖可选的 `providerEvent` 是否存在。
 */
function mapAgentEvent(input: AgentEventLike): MappingOutcome {
  return input.kind.startsWith('provider.')
    ? mapProviderDialectAgentEvent(input)
    : mapDshDialectAgentEvent(input);
}

/**
 * §9.2 `provider-event`。
 *
 * 工具调用的判据必须是 `kind === 'tool' && toolPhase !== 'result'`：真实 provider 工具调用
 * **不带** `toolPhase`（`packages/adapters/provider/src/codecs.ts:692-702` 产出 `kind:'tool'`
 * + `toolCall`，无 `toolPhase`），该形状合法；全仓没有 `'invoke'` 生产者。
 * 写成 `toolPhase === 'invoke'` 会永不命中，把真实调用误落到 `unmapped(unknown-kind)`。
 *
 * `terminal` 行只写「其它」而**不**写「其它 / 缺失」，是本表与另两张表的**真源差异**：
 * `ProviderEvent.terminalState` 由 contracts 强制（`packages/contracts/src/index.ts:1441`：
 * `kind === 'terminal' && !terminalState` 直接抛 `ContractError`），因此 provider-event 输入里
 * `terminalState` **不可能缺失**；而 `AgentEvent.terminalState` 可选，另两张表必须显式覆盖缺失。
 * 这里 `terminalOutcome` 的缺失分支在本表不可达，不额外加校验层。
 */
function mapProviderEvent(input: ProviderEventLike): MappingOutcome {
  switch (input.kind) {
    case 'tool': {
      if (input.toolPhase !== 'result') return mapped('operation.started');
      const toolResult = input.toolResult;
      if (toolResult === undefined) return unmapped('unknown-kind');
      return mapped(toolResult.status === 'succeeded' ? 'operation.completed' : 'operation.failed');
    }
    case 'error':
    case 'transport':
      return mapped('error.detected');
    case 'attention':
      return mapped('blocker.detected');
    case 'terminal':
      return terminalOutcome(input.terminalState);
    case 'model':
    case 'output':
      return unmapped('unknown-kind');
  }
}

/* ------------------------------------------------------------------ *
 * §9.1 派生辅助
 * ------------------------------------------------------------------ */

function requiredContextValue(value: string | undefined, label: string): string {
  if (value === undefined) throw new ContextEventError(`${label} is required`);
  return value;
}

function requiredScope(scope: ScopeRef | undefined, label: string): ScopeRef {
  if (scope === undefined) throw new ContextEventError(`${label} is required`);
  return scope;
}

/**
 * §9.1 `AgentEventLike` 的 scope 派生：`taskId` 来自事件自身身份，其余取自 `context.scope`。
 */
function scopeForAgentEvent(contextScope: ScopeRef, taskId: TaskId): ScopeRef {
  return {
    organId: contextScope.organId,
    taskId,
    ...(contextScope.cycleId === undefined ? {} : { cycleId: contextScope.cycleId }),
    ...(contextScope.operationId === undefined ? {} : { operationId: contextScope.operationId }),
  };
}

/** 适配器的公共收口：映射成功则构造唯一 canonical 事件，否则登记 unmapped 来源。 */
function normalizeOutcome(
  sourceKind: NormalizeSourceKind,
  sourceId: string,
  rawKind: string,
  occurredAt: string,
  scope: ScopeRef,
  summary: string | undefined,
  evidenceRefs: readonly EvidenceRef[],
  outcome: MappingOutcome,
): NormalizeResult {
  if (outcome.kind === 'unmapped') {
    return { events: [], unmapped: [{ sourceKind, sourceId, rawKind, reason: outcome.reason }] };
  }
  const event = createContextEvent({
    type: outcome.type,
    sourceId,
    occurredAt,
    scope,
    ...(summary === undefined ? {} : { summary }),
    evidenceRefs,
  });
  return { events: [event], unmapped: [] };
}

/* ------------------------------------------------------------------ *
 * §9 四个适配器（全部是 createContextEvent 的薄包装）
 * ------------------------------------------------------------------ */

/**
 * `event-record`：`sourceId` = `` `${streamId}#${sequence}` ``，`occurredAt` / `scope`
 * 均由来源自带，因此不使用 `context`（§9.1）。
 */
export function normalizeEventRecord(input: EventRecordLike, _context?: NormalizeContext): NormalizeResult {
  const sourceId = `${input.streamId}#${input.sequence}`;
  return normalizeOutcome(
    'event-record',
    sourceId,
    input.kind ?? '',
    input.occurredAt,
    input.scope,
    input.summary,
    input.evidenceRefs,
    mapEventRecord(input),
  );
}

/**
 * `agent-event`：`sourceId` / `occurredAt` 必须由 `context` 提供（来源无稳定身份与时间戳），
 * `scope` 由 `taskId` + `context.scope` 合成（§9.1）。
 */
export function normalizeAgentEvent(input: AgentEventLike, context: NormalizeContext): NormalizeResult {
  const sourceId = requiredContextValue(context.sourceId, 'agent-event sourceId');
  const occurredAt = requiredContextValue(context.occurredAt, 'agent-event occurredAt');
  const scope = scopeForAgentEvent(requiredScope(context.scope, 'agent-event scope'), input.taskId);
  return normalizeOutcome(
    'agent-event',
    sourceId,
    input.kind,
    occurredAt,
    scope,
    input.summary,
    input.evidenceRefs,
    mapAgentEvent(input),
  );
}

/**
 * `agent-semantic-event`：`sourceId` = `` `seq#${seq}` ``，`occurredAt` / `scope`
 * 必须由 `context` 提供（§9.1）。
 */
export function normalizeAgentSemanticEvent(
  input: AgentSemanticEventLike,
  context: NormalizeContext,
): NormalizeResult {
  const occurredAt = requiredContextValue(context.occurredAt, 'agent-semantic-event occurredAt');
  const scope = requiredScope(context.scope, 'agent-semantic-event scope');
  return normalizeOutcome(
    'agent-semantic-event',
    `seq#${input.seq}`,
    input.kind,
    occurredAt,
    scope,
    input.summary,
    input.evidenceRefs,
    mapAgentSemanticEvent(input),
  );
}

/**
 * `provider-event`：`sourceId` = 来源 `eventId`，`occurredAt` / `scope`
 * 必须由 `context` 提供（`ProviderEvent` 两者都没有，§9.1）。
 */
export function normalizeProviderEvent(
  input: ProviderEventLike,
  context: NormalizeContext,
): NormalizeResult {
  const occurredAt = requiredContextValue(context.occurredAt, 'provider-event occurredAt');
  const scope = requiredScope(context.scope, 'provider-event scope');
  return normalizeOutcome(
    'provider-event',
    input.eventId,
    input.kind,
    occurredAt,
    scope,
    input.summary,
    input.evidenceRefs,
    mapProviderEvent(input),
  );
}

/* ------------------------------------------------------------------ *
 * §9.5 摘要：SHA-256
 * ------------------------------------------------------------------ */

/**
 * 同步 sha256，走仓库既有的 `node:crypto` 约定（本包自带 `node-modules.d.ts`，与
 * `packages/core` / `runtime` / `app` / `config` / `agent-templates` 同构）。
 *
 * 确定性：不读时钟、不取随机数、不读环境变量、不读文件系统（§12）。
 * 摘要口径见 `digestOfConstructedEvent`（§9.5）。
 */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
