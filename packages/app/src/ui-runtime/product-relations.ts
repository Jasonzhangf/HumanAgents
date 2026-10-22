import {
  validateProductRelation,
  type EvidenceRef,
  type ProductBoardIndex,
  type ProductBoardItem,
  type ProductReadScope,
  type ProductRelation,
  type ProductRelationKind,
  type ProductTargetRef,
  type TaskExecutionInstanceIdentity,
  type TaskId,
  type TaskIdentitySource,
} from '../../../contracts/src/index.js';
import type { RuntimeTaskExecutionLineage } from '../../../ui/contracts/runtime.js';
import type { ProductSessionRead } from './product-session-read.js';

/**
 * R product relation projection.
 *
 * This module is a pure read projection. It accepts A1's exact board/session
 * refs plus typed identity and execution-lineage facts. It never derives an
 * edge from a title, timestamp, role, board or ID prefix, and it never treats
 * the runtime's internal actual-execution graph as a product chain.
 *
 * An absent fact produces no edge and no gap. A fact that exists without an
 * exact endpoint ref or owner evidence produces a gap and no edge.
 */
const OWNER_ID = 'humanagent.app.ui-runtime.product-relations';

export interface ProductTaskRelationFact {
  readonly taskId: TaskId;
  /** Committed identity source. Absence means no identity fact was recorded. */
  readonly identitySource?: TaskIdentitySource;
  /** Committed execution lineage. Absence means this task is not a recorded child. */
  readonly executionLineage?: RuntimeTaskExecutionLineage;
  /**
   * Exact requirement target when its owner has already recorded one. The
   * projection does not invent a requirement session ref from the raw ID.
   */
  readonly requirementRef?: ProductTargetRef;
  /**
   * Exact subscription target when its owner has already recorded one. The
   * projection does not invent a subscription session ref from the raw ID.
   */
  readonly subscriptionRef?: ProductTargetRef;
  /** Evidence refs for the committed identity/lineage facts above. */
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface ComposeProductRelationsInput {
  /** A1's board/session composition, which supplies exact task and inspection refs. */
  readonly read?: ProductSessionRead;
  readonly tasks?: readonly ProductTaskRelationFact[];
  /** Explicit typed relations already decoded by a declared owner. */
  readonly relations?: readonly ProductRelation[];
  /**
   * Optional task focus. When supplied, the read also reports fact-absent gaps
   * for that task, distinguishing "no fact exists" from "fact exists but its
   * exact ref or evidence is not recorded".
   */
  readonly focusTaskId?: TaskId;
}

export type ProductRelationGapState = 'absent' | 'unrecorded';

export interface ProductRelationGap {
  readonly code: string;
  readonly kind: ProductRelationKind;
  readonly taskId: TaskId;
  readonly state: ProductRelationGapState;
  readonly message: string;
  readonly nextAction: string;
}

export interface ProductRelationsRead {
  readonly relations: readonly ProductRelation[];
  readonly gaps: readonly ProductRelationGap[];
}

function scopeKey(scope: ProductReadScope): string {
  if (scope.kind === 'system') return 'system';
  if (scope.kind === 'project') return `project:${scope.projectKey}`;
  return `task:${scope.projectKey}:${scope.mode}:${scope.taskId.value}`;
}

function instanceKey(instance: TaskExecutionInstanceIdentity): string {
  if (instance.kind === 'native-execution') {
    return `native:${instance.execution.runtimeId}:${instance.execution.executionEpoch}`;
  }
  const incarnation = instance.incarnation;
  return [
    'incarnation',
    incarnation.runtimeId,
    incarnation.generation,
    incarnation.agentInstanceId,
    incarnation.roleId,
    incarnation.taskId.value,
    incarnation.assignmentId,
    incarnation.executionEpoch,
  ].join(':');
}

/** Stable exact-ref key used for edge dedupe and node identity. */
export function productRelationRefKey(ref: ProductTargetRef): string {
  const scope = scopeKey(ref.scope);
  if (ref.kind === 'interaction') return `interaction:${ref.taskRef.value}:${scope}`;
  if (ref.kind === 'session') {
    return [
      'session',
      ref.sessionRef.sourceKind,
      ref.sessionRef.sourceRef,
      ref.taskRef?.value ?? '',
      scope,
    ].join(':');
  }
  return `execution-instance:${ref.taskRef.value}:${instanceKey(ref.instance)}:${scope}`;
}

function relationKey(relation: ProductRelation): string {
  return [
    productRelationRefKey(relation.source),
    productRelationRefKey(relation.target),
    relation.kind,
  ].join('|');
}

function boardItems(index: ProductBoardIndex | undefined): readonly ProductBoardItem[] {
  if (index === undefined) return [];
  return index.boards.flatMap((section) => [...section.live, ...section.history, ...section.unknown]);
}

function findInteractionRef(
  index: ProductBoardIndex | undefined,
  taskId: TaskId,
): ProductTargetRef | undefined {
  return boardItems(index).find(
    (item) => item.ref.kind === 'interaction' && item.ref.taskRef.value === taskId.value,
  )?.ref;
}

function findInspectionItem(
  index: ProductBoardIndex | undefined,
  taskId: TaskId,
  occurrenceId: string,
): ProductBoardItem | undefined {
  return boardItems(index).find(
    (item) => item.ref.kind === 'session'
      && item.ref.sessionRef.sourceKind === 'inspection-occurrence'
      && item.ref.sessionRef.sourceRef === occurrenceId
      && item.ref.taskRef?.value === taskId.value,
  );
}

function mergeEvidence(
  ...groups: readonly (readonly EvidenceRef[] | undefined)[]
): EvidenceRef[] {
  const merged: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const key = `${ref.evidenceId.value}|${ref.locator}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
}

function gap(
  code: string,
  kind: ProductRelationKind,
  taskId: TaskId,
  state: ProductRelationGapState,
  message: string,
  nextAction: string,
): ProductRelationGap {
  return { code, kind, taskId, state, message, nextAction };
}

function relation(
  source: ProductTargetRef,
  target: ProductTargetRef,
  kind: ProductRelationKind,
  evidenceRefs: readonly EvidenceRef[],
): ProductRelation {
  return { source, target, kind, sourceOwner: OWNER_ID, evidenceRefs };
}

function unrecordedGap(
  code: string,
  kind: ProductRelationKind,
  taskId: TaskId,
  fact: string,
): ProductRelationGap {
  return gap(
    code,
    kind,
    taskId,
    'unrecorded',
    `${fact} exists for task ${taskId.value}, but its exact endpoint ref or owner evidence is not recorded`,
    'record the exact owner ref and evidence before showing this relation',
  );
}

/**
 * Compose evidence-backed product relations.
 *
 * Relations are deduped by exact source ref, target ref and kind. Duplicate
 * facts merge their owner evidence instead of dropping it. Missing input facts
 * stay absent; present facts with missing refs or evidence stay in `gaps`.
 */
export function composeProductRelations(input: ComposeProductRelationsInput): ProductRelationsRead {
  const relations: ProductRelation[] = [];
  const gaps: ProductRelationGap[] = [];
  const index = input.read?.boardIndex;

  for (const relation of input.relations ?? []) {
    validateProductRelation(relation);
    relations.push(relation);
  }

  for (const fact of input.tasks ?? []) {
    const taskRef = findInteractionRef(index, fact.taskId);
    if (taskRef === undefined) {
      gaps.push(unrecordedGap(
        'relation.task-ref-not-recorded',
        'unknown',
        fact.taskId,
        'a typed task fact',
      ));
      continue;
    }

    const evidenceRefs = fact.evidenceRefs ?? [];
    const focused = input.focusTaskId?.value === fact.taskId.value;

    if (fact.identitySource === undefined) {
      if (focused) {
        gaps.push(gap(
          'relation.requirement-fact-absent',
          'requirement',
          fact.taskId,
          'absent',
          `task ${fact.taskId.value} has no committed identity source`,
          'no requirement edge is shown until the identity owner records the source',
        ));
      }
    } else if (fact.requirementRef === undefined) {
      gaps.push(unrecordedGap(
        'relation.requirement-ref-not-recorded',
        'requirement',
        fact.taskId,
        'a committed identity source',
      ));
    } else if (evidenceRefs.length === 0) {
      gaps.push(unrecordedGap(
        'relation.evidence-not-recorded',
        'requirement',
        fact.taskId,
        'a committed identity source',
      ));
    } else {
      relations.push(relation(taskRef, fact.requirementRef, 'requirement', evidenceRefs));
    }

    if (fact.executionLineage === undefined) {
      if (focused) {
        gaps.push(gap(
          'relation.execution-lineage-absent',
          'child-execution',
          fact.taskId,
          'absent',
          `task ${fact.taskId.value} has no committed execution lineage`,
          'no parent, subscription or occurrence edge is shown until lineage is committed',
        ));
      }
      continue;
    }

    const parentRef = findInteractionRef(index, fact.executionLineage.parentTaskId);
    if (parentRef === undefined) {
      gaps.push(unrecordedGap(
        'relation.parent-ref-not-recorded',
        'child-execution',
        fact.taskId,
        'committed parent lineage',
      ));
    } else if (evidenceRefs.length === 0) {
      gaps.push(unrecordedGap(
        'relation.evidence-not-recorded',
        'child-execution',
        fact.taskId,
        'committed parent lineage',
      ));
    } else {
      relations.push(relation(parentRef, taskRef, 'child-execution', evidenceRefs));
    }

    if (fact.subscriptionRef === undefined) {
      gaps.push(unrecordedGap(
        'relation.subscription-ref-not-recorded',
        'subscription',
        fact.taskId,
        'committed subscription lineage',
      ));
    } else if (evidenceRefs.length === 0) {
      gaps.push(unrecordedGap(
        'relation.evidence-not-recorded',
        'subscription',
        fact.taskId,
        'committed subscription lineage',
      ));
    } else {
      relations.push(relation(taskRef, fact.subscriptionRef, 'subscription', evidenceRefs));
    }

    const occurrenceItem = findInspectionItem(index, fact.taskId, fact.executionLineage.occurrenceId);
    if (occurrenceItem === undefined) {
      gaps.push(unrecordedGap(
        'relation.occurrence-ref-not-recorded',
        'occurrence',
        fact.taskId,
        'a committed occurrence lineage',
      ));
    } else if (evidenceRefs.length === 0) {
      gaps.push(unrecordedGap(
        'relation.evidence-not-recorded',
        'occurrence',
        fact.taskId,
        'a committed occurrence lineage',
      ));
    } else {
      relations.push(relation(
        taskRef,
        occurrenceItem.ref,
        'occurrence',
        mergeEvidence(evidenceRefs, occurrenceItem.evidenceRefs),
      ));
    }
  }

  const byKey = new Map<string, ProductRelation>();
  for (const relation of relations) {
    const key = relationKey(relation);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, relation);
      continue;
    }
    byKey.set(key, {
      ...existing,
      evidenceRefs: mergeEvidence(existing.evidenceRefs, relation.evidenceRefs),
    });
  }

  const ordered = [...byKey.values()].sort((left, right) => relationKey(left).localeCompare(relationKey(right)));
  for (const relation of ordered) validateProductRelation(relation);
  return { relations: ordered, gaps };
}

/** Array-only convenience for consumers that do not need the gap report. */
export function composeProductRelationList(
  input: ComposeProductRelationsInput,
): readonly ProductRelation[] {
  return composeProductRelations(input).relations;
}
