/**
 * Semantic Observation —— I1-C 共享合同（设计稿 §17.3 / §17.4 / §17.6）。
 *
 * 唯一 owner 与依赖边界：
 * - 本模块只声明 provider-neutral 的共享信封与覆盖/配对/能力结构；canonical 事件类型
 *   （`CanonicalContextEvent`）、taxonomy、validator 与 pairing outcome 仍归
 *   `packages/context-events`。本模块**不** import 下游 canonical 类型，也不复制其 schema。
 * - 依赖方向固定：`UI -> context-events -> contracts` 与 `UI -> contracts`；本模块只依赖
 *   同包内的 `ScopeRef` / `EvidenceRef` 与既有断言函数，无反向边、无新 barrel。
 * - `TEvent` 是**必需**类型参数：没有默认值，不退化为 `any` / `unknown` / 事件 stub /
 *   可变数组。唯一 concrete specialization 在 `packages/ui/contracts/runtime.ts`。
 *
 * 校验归属：本模块只拥有信封结构、scope/ref identity、version、watermark、readonly 形状
 * 以及 coverage/pairing/capability 的结构字段。`events` 元素必须由调用方提供 typed
 * validator callback，本模块把校验委托给现有 canonical validator owner；不提供默认或
 * no-op validator、不复制 canonical schema、不吞失败、不把未验证事件标为 canonical valid。
 */

import { ContractError } from './errors.js';
import { assertEvidenceRef, assertExecutionEpoch, assertScope } from './index.js';
import type { EvidenceRef, ScopeRef } from './index.js';

/** §17.3 闭合 coverage reason 词表；不得用不透明字符串或猜测 canonical 事件替代。 */
export const COVERAGE_ISSUE_REASONS = [
  'unknown-kind',
  'waiting-is-not-terminal',
  'indistinguishable-tool-phase',
  'correlation-unavailable',
  'source-facet-missing',
  'duplicate-conflict',
  'opener-missing',
  'multi-opener',
  'closer-conflict',
] as const;
export type CoverageIssueReason = (typeof COVERAGE_ISSUE_REASONS)[number];

/**
 * typed 事件引用：保留 durable source identity（§17.2）与 scope。
 * `eventId` / `sourceId` 沿用 canonical 的普通字符串身份，不新建 branded 单位。
 */
export interface SemanticEventRef {
  readonly eventId: string;
  readonly sourceId: string;
  readonly scope: ScopeRef;
}

/** §17.3：每个 reason 保留 typed 来源引用与 scope；有 canonical 事件时附 typed event ref。 */
export interface CoverageIssue {
  readonly reason: CoverageIssueReason;
  readonly scope: ScopeRef;
  readonly sourceRef: EvidenceRef;
  readonly eventRef?: SemanticEventRef;
}

/** §17.4：request、Harness operation、tool invocation 使用不同关联种类。 */
export const PAIRED_EXECUTION_GROUP_KINDS = ['request', 'operation', 'invocation'] as const;
export type PairedExecutionGroupKind = (typeof PAIRED_EXECUTION_GROUP_KINDS)[number];

/**
 * §17.4 / §17.5：投影状态与 canonical status 分离，`unknown` / `unavailable` /
 * `cancelled` / `blocked` / `waiting` 各自保留真实语义，不合并成普通 failed；
 * `open` / `closed` 表达 §17.5 live（未收拢）与 stable（已提交）两组事实。
 */
export const PAIRED_EXECUTION_STATES = [
  'open',
  'closed',
  'unknown',
  'unavailable',
  'cancelled',
  'blocked',
  'waiting',
] as const;
export type PairedExecutionState = (typeof PAIRED_EXECUTION_STATES)[number];

/**
 * §17.4：关联键至少区分 task / operation（经 `scope`）、`executionEpoch`、request / call /
 * toolId。投影只收拢身份与状态，不成为新的配对关系或状态真源。
 */
export interface PairedExecutionGroup {
  readonly groupId: string;
  readonly kind: PairedExecutionGroupKind;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly requestId?: string;
  readonly callId?: string;
  readonly toolId?: string;
  readonly state: PairedExecutionState;
  readonly eventRefs: readonly SemanticEventRef[];
}

/** §17.6：能力不可用必须显式表达，不得序列化为空的 available 历史。 */
export const CAPABILITY_STATES = ['available', 'unavailable', 'unknown'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export interface CapabilityStatus {
  readonly capability: string;
  readonly state: CapabilityState;
  readonly reason?: string;
  readonly sourceRef?: EvidenceRef;
}

/**
 * §17.3：生产语义观测信封。`TEvent` 必需、无默认；`events` 只读。
 * `sourceWatermark` 与 `publicCommitWatermark` 保持两个独立 `number` 水位：缺省不等于 0，
 * 相等合法，不发明跨流不等式或 branded 单位。
 */
export interface SemanticObservationEnvelope<TEvent> {
  readonly scope: ScopeRef;
  readonly projectionVersion: string;
  readonly sourceWatermark: number;
  readonly publicCommitWatermark?: number;
  readonly events: readonly TEvent[];
  readonly coverageIssues: readonly CoverageIssue[];
  readonly pairing: readonly PairedExecutionGroup[];
  readonly capabilities: readonly CapabilityStatus[];
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError(`${label} must be a non-empty string`);
}

function assertWatermark(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a finite non-negative safe integer`);
}

/** 共享 scope 结构校验：organ 必需，task/cycle/operation 存在时按声明的 kind 逐项校验。 */
function assertSemanticScope(scope: ScopeRef, label: string): void {
  assertScope(scope.organId, 'organ');
  assertNonEmpty(scope.organId.value, `${label} organId`);
  if (scope.taskId) {
    assertScope(scope.taskId, 'task');
    assertNonEmpty(scope.taskId.value, `${label} taskId`);
  }
  if (scope.cycleId) {
    assertScope(scope.cycleId, 'cycle');
    assertNonEmpty(scope.cycleId.value, `${label} cycleId`);
  }
  if (scope.operationId) {
    assertScope(scope.operationId, 'operation');
    assertNonEmpty(scope.operationId.value, `${label} operationId`);
  }
}

function assertRefArray<T>(value: readonly T[], label: string): void {
  if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`);
}

export function validateSemanticEventRef(ref: SemanticEventRef): void {
  assertNonEmpty(ref.eventId, 'semantic event ref eventId');
  assertNonEmpty(ref.sourceId, 'semantic event ref sourceId');
  assertSemanticScope(ref.scope, 'semantic event ref scope');
}

export function validateCoverageIssue(issue: CoverageIssue): void {
  if (!COVERAGE_ISSUE_REASONS.includes(issue.reason)) {
    throw new ContractError(`unsupported coverage issue reason: ${String(issue.reason)}`);
  }
  assertSemanticScope(issue.scope, 'coverage issue scope');
  assertEvidenceRef(issue.sourceRef);
  if (issue.eventRef !== undefined) validateSemanticEventRef(issue.eventRef);
}

export function validatePairedExecutionGroup(group: PairedExecutionGroup): void {
  assertNonEmpty(group.groupId, 'paired execution group id');
  if (!PAIRED_EXECUTION_GROUP_KINDS.includes(group.kind)) {
    throw new ContractError(`unsupported paired execution group kind: ${String(group.kind)}`);
  }
  assertSemanticScope(group.scope, 'paired execution group scope');
  assertExecutionEpoch(group.executionEpoch);
  if (group.requestId !== undefined) assertNonEmpty(group.requestId, 'paired execution group requestId');
  if (group.callId !== undefined) assertNonEmpty(group.callId, 'paired execution group callId');
  if (group.toolId !== undefined) assertNonEmpty(group.toolId, 'paired execution group toolId');
  if (!PAIRED_EXECUTION_STATES.includes(group.state)) {
    throw new ContractError(`unsupported paired execution state: ${String(group.state)}`);
  }
  assertRefArray(group.eventRefs, 'paired execution group eventRefs');
  for (const ref of group.eventRefs) validateSemanticEventRef(ref);
}

export function validateCapabilityStatus(status: CapabilityStatus): void {
  assertNonEmpty(status.capability, 'capability status capability');
  if (!CAPABILITY_STATES.includes(status.state)) {
    throw new ContractError(`unsupported capability state: ${String(status.state)}`);
  }
  if (status.reason !== undefined) assertNonEmpty(status.reason, 'capability status reason');
  if (status.sourceRef !== undefined) assertEvidenceRef(status.sourceRef);
}

/**
 * 信封校验的唯一入口。`validateEvent` 是**必需** typed callback：本函数只校验共享结构，
 * 然后把每个 `events` 元素委托给调用方提供的 canonical validator owner。callback 抛出的
 * 错误原样向上传播，不 catch、不降级为成功。本函数不 clone、不 mutate 任何输入数组/事件。
 */
export function validateSemanticObservationEnvelope<TEvent>(
  input: SemanticObservationEnvelope<TEvent>,
  validateEvent: (event: TEvent) => void,
): void {
  assertSemanticScope(input.scope, 'semantic observation scope');
  assertNonEmpty(input.projectionVersion, 'semantic observation projectionVersion');
  assertWatermark(input.sourceWatermark, 'sourceWatermark');
  if (input.publicCommitWatermark !== undefined) assertWatermark(input.publicCommitWatermark, 'publicCommitWatermark');
  assertRefArray(input.events, 'semantic observation events');
  for (const event of input.events) validateEvent(event);
  assertRefArray(input.coverageIssues, 'semantic observation coverageIssues');
  for (const issue of input.coverageIssues) validateCoverageIssue(issue);
  assertRefArray(input.pairing, 'semantic observation pairing');
  for (const group of input.pairing) validatePairedExecutionGroup(group);
  assertRefArray(input.capabilities, 'semantic observation capabilities');
  for (const capability of input.capabilities) validateCapabilityStatus(capability);
}
