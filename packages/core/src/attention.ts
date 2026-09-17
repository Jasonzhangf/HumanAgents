import { CoreError } from './errors.js';

export type ManagedIssueCategory =
  | 'config'
  | 'dependency'
  | 'permission'
  | 'operation'
  | 'integrity'
  | 'health'
  | 'control'
  | 'projection';

export type ManagedIssueSeverity = 'info' | 'attention' | 'blocker';
export type ManagedIssueState = 'open' | 'recovering' | 'waiting' | 'blocked' | 'resolved' | 'superseded';

export interface ManagedIssue {
  readonly issueId: string;
  readonly scope: string;
  readonly scopeId: string;
  readonly category: ManagedIssueCategory;
  readonly severity: ManagedIssueSeverity;
  readonly firstObservedAt: string;
  readonly ownerId: string;
  readonly state: ManagedIssueState;
  readonly impact: string;
  readonly originalErrorRef?: string;
  readonly actionRefs: readonly string[];
  readonly conditionRef?: string;
  readonly escalationTarget?: string;
  readonly evidenceRefs: readonly string[];
  readonly resolvedBy?: string;
}

const ISSUE_TRANSITIONS: Readonly<Record<ManagedIssueState, readonly ManagedIssueState[]>> = {
  open: ['recovering', 'waiting', 'blocked', 'resolved', 'superseded'],
  recovering: ['open', 'waiting', 'blocked', 'resolved', 'superseded'],
  waiting: ['open', 'recovering', 'blocked', 'resolved', 'superseded'],
  blocked: ['open', 'recovering', 'waiting', 'resolved', 'superseded'],
  resolved: [],
  superseded: [],
};

export function canTransitionManagedIssue(from: ManagedIssueState, to: ManagedIssueState): boolean {
  return ISSUE_TRANSITIONS[from].includes(to);
}

export function assertManagedIssue(issue: ManagedIssue): void {
  for (const [value, label] of [
    [issue.issueId, 'issueId'],
    [issue.scope, 'scope'],
    [issue.scopeId, 'scopeId'],
    [issue.ownerId, 'ownerId'],
    [issue.impact, 'impact'],
  ] as const) {
    if (!value.trim()) throw new CoreError(`managed issue ${label} is required`);
  }
  if (!Number.isFinite(Date.parse(issue.firstObservedAt))) throw new CoreError('managed issue firstObservedAt is invalid');
  if (issue.evidenceRefs.length === 0) throw new CoreError('managed issue evidenceRefs cannot be empty');
  if (issue.actionRefs.length === 0) throw new CoreError('managed issue actionRefs cannot be empty');
  if ((issue.state === 'waiting' || issue.state === 'blocked') && !issue.conditionRef) {
    throw new CoreError(`${issue.state} managed issue requires a conditionRef`);
  }
  if (issue.state === 'resolved' && !issue.resolvedBy?.trim()) {
    throw new CoreError('resolved managed issue requires resolvedBy');
  }
}

export function transitionManagedIssue(input: {
  readonly issue: ManagedIssue;
  readonly state: ManagedIssueState;
  readonly ownerId?: string;
  readonly conditionRef?: string;
  readonly escalationTarget?: string;
  readonly actionRef?: string;
  readonly evidenceRef?: string;
  readonly resolvedBy?: string;
}): ManagedIssue {
  assertManagedIssue(input.issue);
  if (!canTransitionManagedIssue(input.issue.state, input.state)) {
    throw new CoreError(`illegal managed issue transition: ${input.issue.state} -> ${input.state}`);
  }
  const next: ManagedIssue = {
    ...input.issue,
    state: input.state,
    ownerId: input.ownerId ?? input.issue.ownerId,
    conditionRef: input.conditionRef ?? input.issue.conditionRef,
    escalationTarget: input.escalationTarget ?? input.issue.escalationTarget,
    actionRefs: input.actionRef ? [...input.issue.actionRefs, input.actionRef] : input.issue.actionRefs,
    evidenceRefs: input.evidenceRef ? [...input.issue.evidenceRefs, input.evidenceRef] : input.issue.evidenceRefs,
    resolvedBy: input.resolvedBy ?? input.issue.resolvedBy,
  };
  assertManagedIssue(next);
  return next;
}
