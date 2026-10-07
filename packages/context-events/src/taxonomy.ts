/**
 * Context Events —— taxonomy 表与配对查表（阶段 0，冻结）。
 *
 * 设计契约：docs/architecture/context-events.md §7（taxonomy 表）+ §8.1（配对查表）+ §8.2（改写表）。
 *
 * `category` / `priority` / `narrative` / `defaultStatus` / `label` 全部由 `type` 派生，
 * 调用方不得覆盖；`CanonicalContextEvent` 不存储它们，避免第二真源。
 *
 * 共导出 12 个纯函数：6 个派生函数 + 6 个配对查表函数
 * （`closeTypeOf` / `openTypeOf` / `pairRoleOf` / `isOpenerType` / `isCloserType` / `closedStatusOf`）。
 *
 * 配对查表放在阶段 0 而不是 pairing.ts：`validation.ts`（W1，§11 第 12/13/14 项）
 * 与 `projector.ts`（W3，§10.1 nextAction）都要用它们。若放在 pairing.ts，
 * W1/W3 会编译依赖 W2，阶段 1 并发不成立。
 */

import { ContextEventError } from './errors.js';
import {
  CONTEXT_EVENT_TYPES,
  type ContextEventCategory,
  type ContextEventNarrative,
  type ContextEventPairRole,
  type ContextEventPriority,
  type ContextEventStatus,
  type ContextEventType,
} from './types.js';

interface TaxonomyRow {
  readonly category: ContextEventCategory;
  readonly priority: ContextEventPriority;
  readonly narrative: ContextEventNarrative;
  readonly defaultStatus: ContextEventStatus;
  readonly label: string;
}

/** 设计稿 §7 表，18 行全量。 */
const TAXONOMY: Readonly<Record<ContextEventType, TaxonomyRow>> = {
  'task.created': { category: 'task', priority: 2, narrative: 'progress', defaultStatus: 'completed', label: '任务已创建' },
  'task.confirmed': { category: 'task', priority: 1, narrative: 'decision', defaultStatus: 'completed', label: '任务已确认' },
  'operation.started': { category: 'task', priority: 4, narrative: 'progress', defaultStatus: 'active', label: '操作开始' },
  'operation.completed': { category: 'task', priority: 3, narrative: 'progress', defaultStatus: 'completed', label: '操作完成' },
  'operation.failed': { category: 'task', priority: 2, narrative: 'failure', defaultStatus: 'failed', label: '操作失败' },
  'error.detected': { category: 'error', priority: 1, narrative: 'failure', defaultStatus: 'active', label: '发现问题' },
  'error.resolved': { category: 'error', priority: 2, narrative: 'recovery', defaultStatus: 'resolved', label: '问题已修复' },
  'blocker.detected': { category: 'blocker', priority: 1, narrative: 'attention', defaultStatus: 'active', label: '遇到阻塞' },
  'blocker.resolved': { category: 'blocker', priority: 2, narrative: 'recovery', defaultStatus: 'resolved', label: '阻塞已解除' },
  'checkpoint.committed': { category: 'task', priority: 1, narrative: 'checkpoint', defaultStatus: 'completed', label: '检查点已提交' },
  'checkpoint.reentered': { category: 'task', priority: 2, narrative: 'checkpoint', defaultStatus: 'completed', label: '检查点已重入' },
  'context.compacted': { category: 'task', priority: 4, narrative: 'checkpoint', defaultStatus: 'completed', label: '上下文已压缩' },
  'plan.proposed': { category: 'plan', priority: 3, narrative: 'decision', defaultStatus: 'active', label: '提出方案' },
  'plan.accepted': { category: 'plan', priority: 3, narrative: 'decision', defaultStatus: 'completed', label: '方案已采纳' },
  'plan.rejected': { category: 'plan', priority: 2, narrative: 'decision', defaultStatus: 'rejected', label: '方案已否决' },
  'retry.detected': { category: 'error', priority: 3, narrative: 'attention', defaultStatus: 'active', label: '检测到重试' },
  'retry.recovered': { category: 'error', priority: 2, narrative: 'recovery', defaultStatus: 'resolved', label: '重试已恢复' },
  'retry.exhausted': { category: 'error', priority: 2, narrative: 'failure', defaultStatus: 'failed', label: '重试已耗尽' },
};

interface PairingRule {
  readonly open: ContextEventType;
  readonly close: ContextEventType;
  readonly role: ContextEventPairRole;
  /** §8.2 改写表：打开事件被该关闭事件闭合后得到的终态。 */
  readonly closedStatus: ContextEventStatus;
}

/**
 * 设计稿 §8 配对表（8 行）+ §8.2 改写表。两张表描述同一组关系，
 * 因此合并为唯一真源，`allowedStatusOf` 从它派生，不重复维护。
 *
 * `retry.exhausted` 的 role 是 `rejected`（关闭但未恢复），其 `defaultStatus` 是 `failed`：
 * role 描述「在配对中的角色」，status 描述「事件自身生命周期」，两者是不同维度。
 */
const PAIRING_RULES: readonly PairingRule[] = [
  { open: 'error.detected', close: 'error.resolved', role: 'resolved', closedStatus: 'resolved' },
  { open: 'blocker.detected', close: 'blocker.resolved', role: 'resolved', closedStatus: 'resolved' },
  { open: 'plan.proposed', close: 'plan.accepted', role: 'resolved', closedStatus: 'completed' },
  { open: 'plan.proposed', close: 'plan.rejected', role: 'rejected', closedStatus: 'rejected' },
  { open: 'retry.detected', close: 'retry.recovered', role: 'resolved', closedStatus: 'resolved' },
  { open: 'retry.detected', close: 'retry.exhausted', role: 'rejected', closedStatus: 'failed' },
  { open: 'operation.failed', close: 'checkpoint.committed', role: 'resolved', closedStatus: 'resolved' },
  { open: 'operation.failed', close: 'checkpoint.reentered', role: 'resolved', closedStatus: 'resolved' },
];

/**
 * 取代不是配对关系，其唯一真源是 `status` + `supersededByEventId`（设计稿 §8）。
 * `'superseded'` 对**所有** type 合法：任何事件都可被新事件取代。
 * 若不计入，§11 第 3 项会拒绝 superseded 事件、而第 15 项又要求它存在，两条判据互斥。
 */
const SUPERSEDED_STATUS: ContextEventStatus = 'superseded';

function rowOf(type: ContextEventType): TaxonomyRow {
  const row = TAXONOMY[type];
  if (row === undefined) throw new ContextEventError(`unknown context event type: ${String(type)}`);
  return row;
}

export function categoryOf(type: ContextEventType): ContextEventCategory {
  return rowOf(type).category;
}

export function priorityOf(type: ContextEventType): ContextEventPriority {
  return rowOf(type).priority;
}

export function narrativeOf(type: ContextEventType): ContextEventNarrative {
  return rowOf(type).narrative;
}

export function defaultStatusOf(type: ContextEventType): ContextEventStatus {
  return rowOf(type).defaultStatus;
}

export function labelOf(type: ContextEventType): string {
  return rowOf(type).label;
}

/**
 * `{defaultStatusOf(type)}` ∪ `{'superseded'}` ∪ §8.2 改写表中该 type 的**全部**改写目标。
 * 是设计稿 §11 第 3 项的可判定判据。
 */
export function allowedStatusOf(type: ContextEventType): readonly ContextEventStatus[] {
  const allowed: ContextEventStatus[] = [defaultStatusOf(type), SUPERSEDED_STATUS];
  for (const rule of PAIRING_RULES) {
    if (rule.open === type && !allowed.includes(rule.closedStatus)) allowed.push(rule.closedStatus);
  }
  return allowed;
}

/** 打开事件 → 允许的关闭事件；关闭事件与非配对类型 → `[]`。 */
export function closeTypeOf(type: ContextEventType): readonly ContextEventType[] {
  const closes: ContextEventType[] = [];
  for (const rule of PAIRING_RULES) {
    if (rule.open === type) closes.push(rule.close);
  }
  return closes;
}

/** 关闭事件 → 其打开事件；打开事件与非配对类型 → `undefined`。 */
export function openTypeOf(type: ContextEventType): ContextEventType | undefined {
  for (const rule of PAIRING_RULES) {
    if (rule.close === type) return rule.open;
  }
  return undefined;
}

/** 关闭事件 → 其 role；打开事件与非配对类型 → `undefined`。 */
export function pairRoleOf(type: ContextEventType): ContextEventPairRole | undefined {
  for (const rule of PAIRING_RULES) {
    if (rule.close === type) return rule.role;
  }
  return undefined;
}

/** 谓词非空：对 5 个打开类型为 true（设计稿 §11 第 12 项的判据来源）。 */
export function isOpenerType(type: ContextEventType): boolean {
  return openTypeOf(type) === undefined && closeTypeOf(type).length > 0;
}

/** 对 8 个关闭类型为 true。 */
export function isCloserType(type: ContextEventType): boolean {
  return pairRoleOf(type) !== undefined;
}

/**
 * §8.2 改写表：关闭事件 → 被它闭合的打开事件应改写的终态。
 * 每个关闭类型在 §8 配对表中恰好出现一次，因此改写目标只是关闭类型的函数。
 *
 * 这是该改写关系的**唯一真源**（与 `PAIRING_RULES` 同表）。`pairing.ts` 必须 import 本函数，
 * 不得自带第二张 closed-status 表。
 */
export function closedStatusOf(closeType: ContextEventType): ContextEventStatus | undefined {
  for (const rule of PAIRING_RULES) {
    if (rule.close === closeType) return rule.closedStatus;
  }
  return undefined;
}

// 声明期自检：表必须覆盖全部 18 个 type，且配对分区恰好 5 打开 + 8 关闭 + 5 非配对。
{
  const declared = Object.keys(TAXONOMY).length;
  if (declared !== CONTEXT_EVENT_TYPES.length) {
    throw new ContextEventError(`taxonomy must cover ${CONTEXT_EVENT_TYPES.length} types, got ${declared}`);
  }
  let openers = 0;
  let closers = 0;
  for (const type of CONTEXT_EVENT_TYPES) {
    const opener = isOpenerType(type);
    const closer = isCloserType(type);
    if (opener && closer) throw new ContextEventError(`type ${type} cannot be both opener and closer`);
    if (opener) openers += 1;
    if (closer) closers += 1;
  }
  if (openers !== 5 || closers !== 8) {
    throw new ContextEventError(`expected 5 openers and 8 closers, got ${openers} and ${closers}`);
  }
}
