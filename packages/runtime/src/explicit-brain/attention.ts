import type {
  Attention,
  AttentionTriageArguments,
  DecisionTraceAdmission,
  DecisionTraceRecord,
  EvidenceRef,
  FrameworkExecutionTrace,
  PriorityPolicyDecision,
  ScopeRef,
  SemanticDecisionTrace,
  ToolDecisionTrace,
} from '../../../contracts/src/index.js';
import { validateAttentionTriage } from '../../../contracts/src/index.js';
import {
  assertManagedIssue,
  transitionManagedIssue,
  type ManagedIssue,
  type ManagedIssueState,
} from '../../../core/src/index.js';

export interface ManagedIssueRecord {
  readonly issue: ManagedIssue;
  readonly scope: ScopeRef;
  readonly attentionId: string;
  readonly rootCauseRef: string;
  readonly severity: Attention['severity'];
  readonly ownerId: string;
  readonly impact: AttentionTriageArguments['impact'];
  readonly urgency: AttentionTriageArguments['urgency'];
  readonly blocking: AttentionTriageArguments['blocking'];
  readonly userDecisionRequired: boolean;
  readonly recurrenceCount: number;
  readonly consecutiveFailureCount: number;
  readonly retryExhausted: boolean;
  readonly affectedRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly reasonRefs: readonly string[];
  readonly nextAction: string;
  readonly conditionRef?: string;
  readonly acknowledged: boolean;
}

export interface AttentionTriageReceipt {
  readonly attentionId: string;
  readonly issueId: string;
  readonly created: boolean;
  readonly publicState: Attention['state'];
  readonly priority: PriorityPolicyDecision;
  readonly trace: DecisionTraceRecord;
}

export interface AttentionActionReceipt {
  readonly attentionId: string;
  readonly issue: ManagedIssueRecord;
  readonly trace: DecisionTraceRecord;
}

export interface AttentionNotificationPort {
  notify(input: {
    readonly notificationId: string;
    readonly attentionId: string;
    readonly recipientRef: string;
    readonly messageRef: string;
  }): Promise<{
    readonly state: 'sent' | 'duplicate' | 'failed';
    readonly attentionRef?: string;
  }>;
}

export interface AttentionActionContext {
  readonly actorId: string;
  readonly runtimeBindingRef: string;
  readonly createdAt: string;
  readonly inputDigest: string;
}

export interface DecisionTraceQuery {
  readonly interactionRef?: string;
  readonly attentionRef?: string;
  readonly bugRef?: string;
  readonly taskRef?: string;
  readonly operationRef?: string;
  readonly admission?: DecisionTraceAdmission;
}

export interface DecisionTracePort {
  append(record: DecisionTraceRecord): DecisionTraceRecord;
  query(query?: DecisionTraceQuery): readonly DecisionTraceRecord[];
  recordToolDecision(input: DecisionTraceRecord): DecisionTraceRecord;
}

export class DecisionTraceJournal implements DecisionTracePort {
  private readonly records: DecisionTraceRecord[] = [];

  constructor(private readonly options: {
    readonly persist: (record: DecisionTraceRecord) => void;
    readonly load: () => readonly DecisionTraceRecord[];
  }) {}

  append(record: DecisionTraceRecord): DecisionTraceRecord {
    const copy = structuredClone(record);
    this.options.persist(copy);
    this.records.push(copy);
    return structuredClone(copy);
  }

  query(query: DecisionTraceQuery = {}): readonly DecisionTraceRecord[] {
    const records = this.records.length > 0 ? this.records : this.options.load();
    return records.filter((record) => matchesDecisionTrace(record, query)).map((record) => structuredClone(record));
  }

  recordToolDecision(input: DecisionTraceRecord): DecisionTraceRecord {
    return this.append(input);
  }
}

const IMPACT_RANK: Readonly<Record<AttentionTriageArguments['impact'], number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const URGENCY_RANK: Readonly<Record<AttentionTriageArguments['urgency'], number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  immediate: 4,
};

const BLOCKING_RANK: Readonly<Record<AttentionTriageArguments['blocking'], number>> = {
  none: 0,
  local: 1,
  task: 2,
  system: 3,
};

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function attentionRootCauseKey(scopeRef: string, rootCauseRef: string): string {
  return JSON.stringify([scopeRef, rootCauseRef]);
}

function publicState(issue: ManagedIssueRecord): Attention['state'] {
  if (issue.issue.state === 'resolved' || issue.issue.state === 'superseded') return 'resolved';
  if (issue.issue.state === 'recovering') return 'recovering';
  return 'open';
}

function severity(issue: Pick<ManagedIssueRecord, 'impact' | 'blocking' | 'retryExhausted'>): Attention['severity'] {
  if (issue.blocking === 'system' || issue.impact === 'critical' || issue.retryExhausted) return 'blocker';
  if (issue.impact === 'high' || issue.blocking === 'task' || issue.blocking === 'local') return 'attention';
  return 'info';
}

export function computePriority(input: AttentionTriageArguments): PriorityPolicyDecision {
  const reasons: string[] = [];
  let priorityClass: PriorityPolicyDecision['priorityClass'] = 'aging';
  let serviceClass: PriorityPolicyDecision['serviceClass'] = 'normal';
  let preemptsActiveExecution = false;

  if (input.kind === 'integrity') {
    priorityClass = 'safety-data-integrity';
    serviceClass = 'blocker';
    preemptsActiveExecution = true;
    reasons.push('integrity issue has highest policy class');
  } else if (input.blocking === 'system') {
    priorityClass = 'system-blocking';
    serviceClass = 'blocker';
    preemptsActiveExecution = true;
    reasons.push('system blocking');
  } else if (input.blocking === 'task') {
    priorityClass = 'task-blocking';
    serviceClass = 'normal';
    reasons.push('task blocking');
  } else if (input.userDecisionRequired) {
    priorityClass = 'user-decision-blocking';
    serviceClass = 'interactive';
    reasons.push('user decision required');
  } else if (input.urgency === 'immediate' && IMPACT_RANK[input.impact] >= IMPACT_RANK.high) {
    priorityClass = 'hard-deadline';
    serviceClass = 'interactive';
    reasons.push('immediate high-impact urgency');
  } else if (IMPACT_RANK[input.impact] >= IMPACT_RANK.high) {
    priorityClass = 'user-visible-impact';
    serviceClass = 'normal';
    reasons.push('high user-visible impact');
  } else if (input.recurrenceSignal || (input.consecutiveFailureCount ?? 0) > 1) {
    priorityClass = 'recurrence';
    reasons.push('recurrence signal');
  } else {
    reasons.push('default aging class');
  }

  if (input.retryExhausted) {
    serviceClass = 'blocker';
    reasons.push('retry exhaustion escalation');
  }
  if (input.blocking === 'none' && input.urgency === 'none') {
    reasons.push('waiting item does not consume active execution resource');
    preemptsActiveExecution = false;
  }
  if (input.kind === 'other' && IMPACT_RANK[input.impact] <= IMPACT_RANK.low) {
    serviceClass = 'background';
    reasons.push('background work retains anti-starvation class');
  }
  return { priorityClass, reasons, serviceClass, preemptsActiveExecution };
}

export class AttentionTriageOwner {
  private readonly issuesByRootCause = new Map<string, ManagedIssueRecord>();
  private readonly issuesByAttentionId = new Map<string, ManagedIssueRecord>();
  private readonly traces: DecisionTracePort;
  private sequence = 0;

  constructor(traces: DecisionTracePort = new DecisionTraceStore()) {
    this.traces = traces;
  }

  triage(input: AttentionTriageArguments, context: {
    readonly ownerId: string;
    readonly runtimeBindingRef: string;
    readonly scopeRef: string;
    readonly scope: ScopeRef;
    readonly createdAt: string;
    readonly inputDigest: string;
  }): AttentionTriageReceipt {
    validateAttentionTriage(input);
    nonEmpty(context.ownerId, 'attention ownerId');
    const rootCauseRef = input.recurrenceSignal?.rootCauseRef ?? input.sourceRef;
    const rootCauseKey = attentionRootCauseKey(context.scopeRef, rootCauseRef);
    const previous = this.issuesByRootCause.get(rootCauseKey);
    const existing = previous?.issue.state === 'resolved' || previous?.issue.state === 'superseded'
      ? undefined
      : previous;
    this.sequence += 1;
    const issueId = existing?.issue.issueId ?? `managed-issue:${this.sequence}`;
    const attentionId = existing?.attentionId ?? `attention:${this.sequence}`;
    const recurrenceCount = existing ? existing.recurrenceCount + 1 : 1;
    const consecutiveFailureCount = input.consecutiveFailureCount
      ?? (existing ? existing.consecutiveFailureCount + 1 : 1);
    const impact = maxEnum(existing?.impact, input.impact, IMPACT_RANK);
    const urgency = maxEnum(existing?.urgency, input.urgency, URGENCY_RANK);
    const blocking = maxEnum(existing?.blocking, input.blocking, BLOCKING_RANK);
    const conditionRef = input.proposedCondition
      ?? (blocking === 'none' ? undefined : `attention-recovery:${rootCauseRef}`);
    const issueState: ManagedIssueState = conditionRef
      ? 'waiting'
      : blocking === 'none'
        ? 'recovering'
        : 'open';
    const issue: ManagedIssueRecord = {
      issue: {
        issueId,
        scope: context.scopeRef,
        scopeId: rootCauseRef,
        category: categoryFor(input.kind),
        severity: severity({
          impact,
          blocking,
          retryExhausted: input.retryExhausted === true,
        }),
        firstObservedAt: existing?.issue.firstObservedAt ?? context.createdAt,
        ownerId: context.ownerId,
        state: issueState,
        impact: `${input.impact}/${input.urgency}/${input.blocking}`,
        originalErrorRef: input.sourceRef,
        actionRefs: [input.proposedNextAction],
        conditionRef,
        escalationTarget: input.retryExhausted ? input.proposedNextAction : undefined,
        evidenceRefs: [...input.reasonRefs],
      },
      scope: context.scope,
      attentionId,
      rootCauseRef,
      severity: severity({
        impact,
        blocking,
        retryExhausted: input.retryExhausted === true,
      }),
      ownerId: context.ownerId,
      impact,
      urgency,
      blocking,
      userDecisionRequired: input.userDecisionRequired,
      recurrenceCount,
      consecutiveFailureCount,
      retryExhausted: input.retryExhausted === true,
      affectedRefs: unique([...(existing?.affectedRefs ?? []), ...input.affectedRefs]),
      evidenceRefs: uniqueEvidenceRefs([...(existing?.evidenceRefs ?? []), ...input.evidenceRefs]),
      reasonRefs: unique([...(existing?.reasonRefs ?? []), ...input.reasonRefs]),
      nextAction: input.proposedNextAction,
      conditionRef,
      acknowledged: existing?.acknowledged ?? false,
    };
    assertManagedIssue(issue.issue);
    this.issuesByRootCause.set(rootCauseKey, issue);
    this.issuesByAttentionId.set(attentionId, issue);
    const priority = computePriority({ ...input, impact, urgency, blocking, consecutiveFailureCount });
    const semantic: SemanticDecisionTrace = {
      traceId: `semantic:${this.sequence}`,
      scopeRef: context.scopeRef,
      runtimeBindingRef: context.runtimeBindingRef,
      interactionRef: input.sourceRef,
      attentionRef: attentionId,
      decisionKind: 'attention-triage',
      decisionSummary: `${input.kind}: ${priority.priorityClass}`,
      selectedAction: existing ? 'update-attention' : 'create-attention',
      evidenceRefs: [...input.reasonRefs],
      inputDigest: context.inputDigest,
      createdAt: context.createdAt,
    };
    const execution: FrameworkExecutionTrace = {
      traceId: `execution:${this.sequence}`,
      toolIntentId: `attention-triage:${this.sequence}`,
      admission: 'accepted',
      ownerRef: context.ownerId,
      effectRefs: [issueId],
      eventRefs: [],
      notificationOperationRefs: [],
      settlement: { state: 'completed', completedAt: context.createdAt },
      stateTransitionRef: `${issue.issue.state}`,
      finalReceiptRef: attentionId,
    };
    const trace = this.traces.append({ semantic, execution });
    return {
      attentionId,
      issueId,
      created: !existing,
      publicState: publicState(issue),
      priority,
      trace,
    };
  }

  acknowledge(attentionId: string, context: AttentionActionContext): ManagedIssueRecord {
    const issue = this.requireIssue(attentionId);
    this.assertAuthorizedActor(issue, context, 'acknowledge');
    const updated = { ...issue, acknowledged: true };
    this.store(updated);
    return this.traceAction('attention.ack', updated, {
      admission: 'accepted',
      selectedAction: 'update-attention',
      summary: 'attention acknowledged without resolving it',
    }, context).issue;
  }

  resolve(attentionId: string, context: AttentionActionContext): ManagedIssueRecord {
    const issue = this.requireIssue(attentionId);
    this.assertAuthorizedActor(issue, context, 'resolve');
    const updated = {
      ...issue,
      issue: transitionManagedIssue({
        issue: issue.issue,
        state: 'resolved',
        resolvedBy: context.actorId,
        actionRef: 'resolve-attention',
      }),
    };
    this.store(updated);
    return this.traceAction('attention.resolve', updated, {
      admission: 'accepted',
      selectedAction: 'update-attention',
      summary: 'attention resolved by its owner',
    }, context).issue;
  }

  defer(attentionId: string, conditionRef: string, context: AttentionActionContext): ManagedIssueRecord {
    const issue = this.requireIssue(attentionId);
    this.assertAuthorizedActor(issue, context, 'defer');
    if (!conditionRef.trim()) throw new Error('attention defer conditionRef is required');
    const issueValue = issue.issue.state === 'waiting'
      ? {
          ...issue.issue,
          conditionRef,
          actionRefs: [...issue.issue.actionRefs, `defer:${conditionRef}`],
        }
      : transitionManagedIssue({
          issue: issue.issue,
          state: 'waiting',
          conditionRef,
          actionRef: `defer:${conditionRef}`,
        });
    const updated = {
      ...issue,
      issue: issueValue,
      conditionRef,
    };
    this.store(updated);
    return this.traceAction('attention.defer', updated, {
      admission: 'waiting',
      selectedAction: 'wait',
      summary: `attention deferred until ${conditionRef}`,
      recoveryRef: conditionRef,
    }, context).issue;
  }

  async notify(input: {
    readonly attentionId: string;
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly notificationId: string;
    readonly port: AttentionNotificationPort;
    readonly context: AttentionActionContext;
  }): Promise<AttentionActionReceipt> {
    const issue = this.requireIssue(input.attentionId);
    this.assertAuthorizedActor(issue, input.context, 'notify');
    nonEmpty(input.recipientRef, 'attention notification recipientRef');
    nonEmpty(input.messageRef, 'attention notification messageRef');
    nonEmpty(input.notificationId, 'attention notificationId');
    const result = await input.port.notify({
      notificationId: input.notificationId,
      attentionId: issue.attentionId,
      recipientRef: input.recipientRef,
      messageRef: input.messageRef,
    });
    if (result.state === 'failed') {
      const notificationAttention = result.attentionRef
        ? this.requireIssue(result.attentionRef).attentionId
        : this.createNotificationFailureAttention(issue, input, input.context);
      return this.traceAction('attention.notify', issue, {
        admission: 'rejected',
        selectedAction: 'notify',
        summary: 'attention notification failed',
        failureRef: notificationAttention,
      }, input.context);
    }
    return this.traceAction('attention.notify', issue, {
      admission: result.state === 'duplicate' ? 'duplicate' : 'accepted',
      selectedAction: 'notify',
      summary: result.state === 'duplicate'
        ? 'attention notification already settled'
        : 'attention notification sent',
      notificationOperationRefs: [input.notificationId],
    }, input.context);
  }

  inspect(attentionId: string): ManagedIssueRecord | undefined {
    return this.issuesByAttentionId.get(attentionId);
  }

  list(): readonly ManagedIssueRecord[] {
    return [...this.issuesByAttentionId.values()];
  }

  queryTraces(query: DecisionTraceQuery = {}): readonly DecisionTraceRecord[] {
    return this.traces.query(query);
  }

  projection(attentionId: string): Attention | undefined {
    const issue = this.inspect(attentionId);
    if (!issue) return undefined;
    return {
      attentionId: issue.attentionId,
      scope: issue.scope,
      severity: issue.severity,
      state: publicState(issue),
      message: issue.nextAction,
      evidenceRefs: [...issue.evidenceRefs],
      ownerId: issue.ownerId,
      nextAction: { kind: issue.issue.state === 'waiting' ? 'wait' : issue.issue.state === 'blocked' ? 'recover' : 'continue', ref: issue.conditionRef },
    };
  }

  private requireIssue(attentionId: string): ManagedIssueRecord {
    const issue = this.issuesByAttentionId.get(attentionId);
    if (!issue) throw new Error(`attention not found: ${attentionId}`);
    return issue;
  }

  private assertAuthorizedActor(
    issue: ManagedIssueRecord,
    context: AttentionActionContext,
    action: 'acknowledge' | 'resolve' | 'defer' | 'notify',
  ): void {
    nonEmpty(context.actorId, 'attention action actorId');
    if (context.actorId !== issue.ownerId) {
      throw new Error(`attention ${action} actor is not authorized for issue owner: ${issue.ownerId}`);
    }
  }

  private store(issue: ManagedIssueRecord): void {
    this.issuesByRootCause.set(attentionRootCauseKey(issue.issue.scope, issue.rootCauseRef), issue);
    this.issuesByAttentionId.set(issue.attentionId, issue);
  }

  private traceAction(
    toolRef: string,
    issue: ManagedIssueRecord,
    input: {
      readonly admission: DecisionTraceAdmission;
      readonly selectedAction: SemanticDecisionTrace['selectedAction'];
      readonly summary: string;
      readonly failureRef?: string;
      readonly recoveryRef?: string;
      readonly notificationOperationRefs?: readonly string[];
    },
    context: AttentionActionContext,
  ): AttentionActionReceipt {
    this.sequence += 1;
    const semantic: SemanticDecisionTrace = {
      traceId: `semantic:${toolRef}:${this.sequence}`,
      scopeRef: issue.issue.scope,
      runtimeBindingRef: context.runtimeBindingRef,
      attentionRef: issue.attentionId,
      decisionKind: 'attention-triage',
      decisionSummary: input.summary,
      selectedAction: input.selectedAction,
      evidenceRefs: [...issue.reasonRefs],
      inputDigest: context.inputDigest,
      createdAt: context.createdAt,
    };
    const execution: FrameworkExecutionTrace = {
      traceId: `execution:${toolRef}:${this.sequence}`,
      toolIntentId: `${toolRef}:${this.sequence}`,
      admission: input.admission,
      ownerRef: issue.ownerId,
      effectRefs: [issue.issue.issueId],
      eventRefs: [],
      notificationOperationRefs: [...(input.notificationOperationRefs ?? [])],
      failureRef: input.failureRef,
      settlement: input.recoveryRef
        ? { state: 'waiting', recoveryRef: input.recoveryRef }
        : input.failureRef
          ? { state: 'failed', completedAt: context.createdAt }
          : { state: 'completed', completedAt: context.createdAt },
      stateTransitionRef: issue.issue.state,
      finalReceiptRef: issue.attentionId,
    };
    return {
      attentionId: issue.attentionId,
      issue,
      trace: this.traces.append({ semantic, execution }),
    };
  }

  private createNotificationFailureAttention(
    issue: ManagedIssueRecord,
    input: {
      readonly recipientRef: string;
      readonly messageRef: string;
      readonly notificationId: string;
    },
    context: AttentionActionContext,
  ): string {
    return this.triage({
      sourceRef: input.notificationId,
      kind: 'notification-failure',
      impact: issue.impact,
      urgency: issue.urgency,
      blocking: issue.blocking,
      userDecisionRequired: issue.userDecisionRequired,
      affectedRefs: [input.recipientRef, input.notificationId],
      evidenceRefs: issue.evidenceRefs,
      reasonRefs: [input.messageRef, input.notificationId],
      proposedNextAction: 'retry-notification',
    }, {
      ownerId: issue.ownerId,
      runtimeBindingRef: context.runtimeBindingRef,
      scopeRef: issue.issue.scope,
      scope: issue.scope,
      createdAt: context.createdAt,
      inputDigest: `attention-notification-failure:${input.notificationId}`,
    }).attentionId;
  }
}

function categoryFor(kind: AttentionTriageArguments['kind']): ManagedIssue['category'] {
  switch (kind) {
    case 'owner-resolution':
      return 'config';
    case 'notification-failure':
      return 'dependency';
    case 'resource-waiting':
      return 'operation';
    case 'health':
      return 'health';
    case 'integrity':
      return 'integrity';
    case 'operation-failure':
      return 'operation';
    case 'other':
      return 'projection';
  }
}

function maxEnum<T extends string>(
  left: T | undefined,
  right: T,
  ranks: Readonly<Record<T, number>>,
): T {
  return left !== undefined && ranks[left] >= ranks[right] ? left : right;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueEvidenceRefs(values: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = [
      value.evidenceId.value,
      value.kind,
      value.source,
      value.locator,
      value.digest ?? '',
      value.scope.organId.value,
      value.scope.taskId?.value ?? '',
      value.scope.cycleId?.value ?? '',
      value.scope.operationId?.value ?? '',
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class DecisionTraceStore implements DecisionTracePort {
  private readonly records: DecisionTraceRecord[] = [];

  append(record: DecisionTraceRecord): DecisionTraceRecord {
    const copy = structuredClone(record);
    this.records.push(copy);
    return copy;
  }

  query(query: DecisionTraceQuery = {}): readonly DecisionTraceRecord[] {
    return this.records.filter((record) => matchesDecisionTrace(record, query)).map((record) => structuredClone(record));
  }

  recordToolDecision(input: DecisionTraceRecord): DecisionTraceRecord {
    return this.append(input);
  }
}

function matchesDecisionTrace(record: DecisionTraceRecord, query: DecisionTraceQuery): boolean {
  const semantic = record.semantic;
  const execution = record.execution;
  return (!query.interactionRef || semantic.interactionRef === query.interactionRef)
    && (!query.attentionRef || semantic.attentionRef === query.attentionRef)
    && (!query.bugRef || semantic.bugRef === query.bugRef)
    && (!query.taskRef || semantic.taskRef === query.taskRef)
    && (!query.operationRef || semantic.operationRef === query.operationRef || execution?.operationId?.value === query.operationRef)
    && (!query.admission || execution?.admission === query.admission);
}
