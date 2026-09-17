import {
  validateBugReport,
  type BugRecord,
  type BugReportArguments,
  type NotificationRecord,
  type OwnerRegistryEntry,
} from '../../../contracts/src/index.js';
import type {
  EventExternalOperation,
  EventOperationBarrierDriver,
  EventOperationBarrierIntent,
} from '../events/index.js';

export class BugIntakeError extends Error {
  readonly code: 'owner-not-unique' | 'owner-not-found' | 'source-fact-required' | 'idempotency-conflict';

  constructor(code: BugIntakeError['code'], message: string) {
    super(message);
    this.name = 'BugIntakeError';
    this.code = code;
  }
}

export interface GitBugPort {
  create(input: {
    readonly submissionId: string;
    readonly sourceFactRef: string;
    readonly report: BugReportArguments;
  }): Promise<{ readonly bugId: string; readonly revision: string; readonly created: boolean }>;
  assign(input: {
    readonly bugId: string;
    readonly ownerRef: string;
    readonly submissionId: string;
  }): Promise<{ readonly bugId: string; readonly revision: string; readonly assigned: boolean }>;
  transition(input: {
    readonly bugId: string;
    readonly state: 'resolved' | 'reopened';
    readonly submissionId: string;
  }): Promise<{ readonly bugId: string; readonly revision: string; readonly transitioned: boolean }>;
}

export interface NotificationPort {
  notify(input: {
    readonly notificationId: string;
    readonly bugId: string;
    readonly gitBugRevision: string;
    readonly transition: BugRecord['state'];
    readonly recipientRef: string;
    readonly kind: 'owner' | 'reporter';
  }): Promise<{ readonly state: NotificationRecord['state']; readonly attentionRef?: string }>;
}

export interface BugOperationIntent {
  readonly operationRef: string;
  readonly submissionId: string;
  readonly kind: 'create' | 'assign' | 'notify-owner' | 'notify-reporter' | 'transition';
  readonly idempotencyKey: string;
}

export interface BugIntakeLedgerPort {
  commitOperationIntent(intent: BugOperationIntent): Promise<BugOperationIntent>;
  readOperationIntent(operationRef: string): Promise<BugOperationIntent | null>;
  commitSourceFact?(input: {
    readonly submissionId: string;
    readonly consumerKey: string;
    readonly messageId: string;
    readonly sourceFactRef: string;
    readonly report: BugReportArguments;
  }): Promise<void>;
  readSourceFact?(input: {
    readonly submissionId: string;
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<BugReportArguments | null>;
  settleOperation(input: {
    readonly operationRef: string;
    readonly state: 'settled' | 'reconciled' | 'failed' | 'unknown';
  }): Promise<EventExternalOperation>;
  readExternalOperation(input: {
    readonly operationRef: string;
    readonly consumerKey: string;
    readonly messageId: string;
  }): Promise<EventExternalOperation | null>;
}

export interface BugIntakeRecoveryPort {
  reconcile(input: {
    readonly operationRef: string;
    readonly kind: BugOperationIntent['kind'];
    readonly submissionId: string;
    readonly report: BugReportArguments;
    readonly bugId?: string;
    readonly ownerRef?: string;
  }): Promise<EventExternalOperation>;
}

export function stableBugSubmissionId(input: {
  readonly contractVersion: 'bug-report@1';
  readonly scopeRef: string;
  readonly sourceFactRef: string;
}): string {
  if (!input.sourceFactRef.trim()) throw new BugIntakeError('source-fact-required', 'bug source fact is required');
  return `${input.contractVersion}:${input.scopeRef}:${input.sourceFactRef}`;
}

export function resolveBugOwner(input: {
  readonly componentRef: string;
  readonly owners: readonly OwnerRegistryEntry[];
}): OwnerRegistryEntry {
  const active = input.owners.filter((owner) => owner.componentRef === input.componentRef && owner.active);
  if (active.length === 0) throw new BugIntakeError('owner-not-found', `no active owner for component: ${input.componentRef}`);
  if (active.length > 1) throw new BugIntakeError('owner-not-unique', `multiple active owners for component: ${input.componentRef}`);
  return active[0]!;
}

export interface BugIntakeResult {
  readonly submissionId: string;
  readonly bug: BugRecord;
  readonly ownerResolutionAttention?: string;
  /** @deprecated Use notificationAttentionRefs; retained for one-version compatibility. */
  readonly notificationAttention?: string;
  readonly ownerNotification?: NotificationRecord;
  readonly reporterNotification?: NotificationRecord;
  readonly notificationAttentionRefs: readonly string[];
  readonly operationIntents: readonly BugOperationIntent[];
}

export interface BugIntakeHandlerOptions {
  readonly consumerKey: string;
  readonly scopeRef: string;
  readonly reporterRef: string;
  readonly bugRoutingOwnerRef: string;
  readonly ownerRegistry: readonly OwnerRegistryEntry[];
  readonly ledger: BugIntakeLedgerPort;
  readonly recovery?: BugIntakeRecoveryPort;
  readonly gitBug: GitBugPort;
  readonly notifications: NotificationPort;
  readonly createAttention: (input: {
    readonly kind: 'owner-resolution' | 'notification-failure';
    readonly bugId: string;
    readonly componentRef?: string;
    readonly operationRef?: string;
    readonly ownerRef?: string;
    readonly recipientRef?: string;
    readonly reason: string;
  }) => Promise<string>;
}

function operationRef(submissionId: string, kind: BugOperationIntent['kind']): string {
  return `${submissionId}:${kind}`;
}

async function persistIntent(
  ledger: BugIntakeLedgerPort,
  intent: BugOperationIntent,
): Promise<BugOperationIntent> {
  return ledger.commitOperationIntent(intent);
}

function operationIntent(
  submissionId: string,
  kind: BugOperationIntent['kind'],
): BugOperationIntent {
  return {
    operationRef: operationRef(submissionId, kind),
    submissionId,
    kind,
    idempotencyKey: operationRef(submissionId, kind),
  };
}

function notificationOperationState(
  state: NotificationRecord['state'],
): 'settled' | 'reconciled' | 'failed' | undefined {
  if (state === 'sent') return 'settled';
  if (state === 'duplicate') return 'reconciled';
  if (state === 'failed') return 'failed';
  return undefined;
}

async function executeBugIntake(
  report: BugReportArguments,
  options: BugIntakeHandlerOptions,
): Promise<BugIntakeResult> {
  validateBugReport(report);
  const submissionId = stableBugSubmissionId({
    contractVersion: 'bug-report@1',
    scopeRef: options.scopeRef,
    sourceFactRef: report.sourceFactRef,
  });
  const createIntent = await persistIntent(options.ledger, operationIntent(submissionId, 'create'));
  const created = await options.gitBug.create({
    submissionId,
    sourceFactRef: report.sourceFactRef,
    report,
  });
  await options.ledger.settleOperation({
    operationRef: createIntent.operationRef,
    state: created.created ? 'settled' : 'reconciled',
  });

  let ownerRef: string | undefined;
  let ownerResolutionAttention: string | undefined;
  const notificationAttentionRefs: string[] = [];
  const operationIntents: BugOperationIntent[] = [createIntent];
  const componentRef = report.componentHint;
  if (componentRef) {
    try {
      ownerRef = resolveBugOwner({ componentRef, owners: options.ownerRegistry }).ownerRef;
    } catch (error) {
      if (!(error instanceof BugIntakeError) || (error.code !== 'owner-not-found' && error.code !== 'owner-not-unique')) throw error;
      ownerResolutionAttention = await options.createAttention({
        kind: 'owner-resolution',
        bugId: created.bugId,
        componentRef,
        ownerRef: options.bugRoutingOwnerRef,
        reason: error.message,
      });
    }
  } else {
    ownerResolutionAttention = await options.createAttention({
      kind: 'owner-resolution',
      bugId: created.bugId,
      ownerRef: options.bugRoutingOwnerRef,
      reason: 'bug report has no component hint',
    });
  }

  let ownerNotification: NotificationRecord | undefined;
  if (ownerRef) {
    const assignIntent = await persistIntent(options.ledger, operationIntent(submissionId, 'assign'));
    operationIntents.push(assignIntent);
    const assigned = await options.gitBug.assign({
      bugId: created.bugId,
      ownerRef,
      submissionId,
    });
    await options.ledger.settleOperation({
      operationRef: assignIntent.operationRef,
      state: assigned.assigned ? 'settled' : 'reconciled',
    });
    const notifyIntent = await persistIntent(options.ledger, operationIntent(submissionId, 'notify-owner'));
    operationIntents.push(notifyIntent);
    const ownerResult = await options.notifications.notify({
      notificationId: notifyIntent.operationRef,
      bugId: created.bugId,
      gitBugRevision: assigned.revision,
      transition: 'assigned',
      recipientRef: ownerRef,
      kind: 'owner',
    });
    const ownerOperationState = notificationOperationState(ownerResult.state);
    if (ownerOperationState) {
      await options.ledger.settleOperation({
        operationRef: notifyIntent.operationRef,
        state: ownerOperationState,
      });
    }
    if (ownerResult.state !== 'sent' && ownerResult.state !== 'duplicate') {
      const createdAttentionRef = await options.createAttention({
        kind: 'notification-failure',
        bugId: created.bugId,
        operationRef: notifyIntent.operationRef,
        recipientRef: ownerRef,
        reason: `owner notification ${ownerResult.state} after git-bug assignment`,
      });
      notificationAttentionRefs.push(ownerResult.attentionRef ?? createdAttentionRef);
    }
    ownerNotification = {
      notificationId: notifyIntent.operationRef,
      bugId: created.bugId,
      gitBugRevision: assigned.revision,
      transition: 'assigned',
      recipientRef: ownerRef,
      kind: 'owner',
      state: ownerResult.state,
      attentionRef: ownerResult.attentionRef ?? notificationAttentionRefs.at(-1),
    };
  }

  const reporterIntent = await persistIntent(options.ledger, operationIntent(submissionId, 'notify-reporter'));
  operationIntents.push(reporterIntent);
  const reporterResult = await options.notifications.notify({
    notificationId: reporterIntent.operationRef,
    bugId: created.bugId,
    gitBugRevision: created.revision,
    transition: 'created',
    recipientRef: options.reporterRef,
    kind: 'reporter',
  });
  const reporterOperationState = notificationOperationState(reporterResult.state);
  if (reporterOperationState) {
    await options.ledger.settleOperation({
      operationRef: reporterIntent.operationRef,
      state: reporterOperationState,
    });
  }
  if (reporterResult.state !== 'sent' && reporterResult.state !== 'duplicate') {
    const createdAttentionRef = await options.createAttention({
      kind: 'notification-failure',
      bugId: created.bugId,
      operationRef: reporterIntent.operationRef,
      recipientRef: options.reporterRef,
      reason: `reporter notification ${reporterResult.state} after git-bug state change`,
    });
    notificationAttentionRefs.push(reporterResult.attentionRef ?? createdAttentionRef);
  }
  const reporterNotification: NotificationRecord = {
    notificationId: reporterIntent.operationRef,
    bugId: created.bugId,
    gitBugRevision: created.revision,
    transition: 'created',
    recipientRef: options.reporterRef,
    kind: 'reporter',
    state: reporterResult.state,
    attentionRef: reporterResult.attentionRef ?? notificationAttentionRefs.at(-1),
  };

  return {
    submissionId,
    bug: {
      bugId: created.bugId,
      submissionId,
      state: ownerRef ? 'assigned' : 'created',
      ownerRef,
      sourceFactRef: report.sourceFactRef,
      gitBugRevision: created.revision,
    },
    ownerResolutionAttention,
    notificationAttention: notificationAttentionRefs[0],
    ownerNotification,
    reporterNotification,
    notificationAttentionRefs,
    operationIntents,
  };
}

export async function reportBug(
  report: BugReportArguments,
  options: BugIntakeHandlerOptions,
): Promise<BugIntakeResult> {
  return executeBugIntake(report, options);
}

export function bugReportBarrierDriver(
  options: BugIntakeHandlerOptions,
): EventOperationBarrierDriver {
  const prepared = new Map<string, {
    readonly report: BugReportArguments;
    readonly submissionId: string;
  }>();

  const deliveryKey = (consumerKey: string, messageId: string): string => `${consumerKey}:${messageId}`;

  return {
    async prepare({ event }) {
      const payload = event.payload as { readonly report?: BugReportArguments } | undefined;
      if (!payload?.report) {
        return {
          consumerKey: options.consumerKey,
          messageId: event.messageId,
          disposition: 'rejected',
          completionMode: 'journal-atomic',
          internalEffectFacts: [],
          externalOperationRefs: [],
          failureRef: 'bug-report-payload-missing',
        };
      }
      const report = payload.report;
      validateBugReport(report);
      const submissionId = stableBugSubmissionId({
        contractVersion: 'bug-report@1',
        scopeRef: options.scopeRef,
        sourceFactRef: report.sourceFactRef,
      });
      if (!options.ledger.commitSourceFact) {
        throw new BugIntakeError('source-fact-required', 'bug intake ledger must persist the source fact before external effects');
      }
      await options.ledger.commitSourceFact({
        submissionId,
        consumerKey: options.consumerKey,
        messageId: event.messageId,
        sourceFactRef: report.sourceFactRef,
        report,
      });
      let assignable = false;
      if (report.componentHint) {
        try {
          resolveBugOwner({ componentRef: report.componentHint, owners: options.ownerRegistry });
          assignable = true;
        } catch (error) {
          if (!(error instanceof BugIntakeError)
            || (error.code !== 'owner-not-found' && error.code !== 'owner-not-unique')) {
            throw error;
          }
        }
      }
      const intents = [
        operationIntent(submissionId, 'create'),
        ...(assignable
          ? [operationIntent(submissionId, 'assign'), operationIntent(submissionId, 'notify-owner')]
          : []),
        operationIntent(submissionId, 'notify-reporter'),
      ];
      for (const intent of intents) await persistIntent(options.ledger, intent);
      prepared.set(deliveryKey(options.consumerKey, event.messageId), { report, submissionId });
      return {
        consumerKey: options.consumerKey,
        messageId: event.messageId,
        disposition: 'applied',
        completionMode: 'operation-barrier',
        internalEffectFacts: [`submission:${submissionId}`],
        externalOperationRefs: intents.map((intent) => intent.operationRef),
      };
    },

    async execute(delivery, intent) {
      const key = deliveryKey(options.consumerKey, delivery.event.messageId);
      const state = prepared.get(key);
      if (!state || state.submissionId !== intent.internalEffectFacts[0]?.slice('submission:'.length)) {
        throw new BugIntakeError('idempotency-conflict', 'prepared bug intake state is missing or mismatched');
      }
      await executeBugIntake(state.report, options);
      prepared.delete(key);
    },

    async recover(_delivery, intent) {
      const submissionId = intent.internalEffectFacts[0]?.slice('submission:'.length);
      if (!submissionId) throw new BugIntakeError('idempotency-conflict', 'barrier intent is missing the submission id');
      if (!options.recovery) {
        throw new BugIntakeError('idempotency-conflict', 'bug intake recovery port is required to reconcile an interrupted barrier');
      }
      const report = await options.ledger.readSourceFact?.({
        submissionId,
        consumerKey: options.consumerKey,
        messageId: _delivery.event.messageId,
      });
      if (!report) throw new BugIntakeError('idempotency-conflict', 'durable bug source fact is missing');
      for (const ref of intent.externalOperationRefs) {
        const persisted = await options.ledger.readOperationIntent(ref);
        if (!persisted) throw new BugIntakeError('idempotency-conflict', `persisted operation intent is missing: ${ref}`);
        await options.recovery.reconcile({
          operationRef: persisted.operationRef,
          kind: persisted.kind,
          submissionId,
          report,
        });
      }
    },
  };
}
