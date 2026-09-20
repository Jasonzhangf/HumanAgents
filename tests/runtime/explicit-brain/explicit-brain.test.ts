import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cwd } from 'node:process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXPLICIT_BRAIN_TEMPLATE_REF,
  id,
  validateAttentionTriage,
  validateBugReport,
  validateChannelBinding,
  type BugReportArguments,
  type EvidenceRef,
  type MemoryInteractionPort,
  type MemoryOperationRequestedEvent,
  type RequirementEnvelope,
  type ToolIntent,
} from '../../../packages/contracts/src/index.js';
import {
  digestAgentTemplate,
  loadBuiltinAgentTemplate,
  validateAgentTemplate,
  validateConfiguredAgentBinding,
} from '../../../packages/agent-templates/src/index.js';
import {
  AttentionTriageOwner,
  BugActionError,
  BugActionOwner,
  bugReportBarrierDriver,
  ChannelRouter,
  ConfirmationLedger,
  DecisionTraceJournal,
  DecisionTraceStore,
  ExplicitBrainDecisionError,
  ExplicitBrainDecisionExecutor,
  ExplicitBrainAdmissionError,
  ExplicitBrainMemoryToolError,
  ExplicitBrainMemoryToolExecutor,
  ExplicitBrainRouterError,
  MemoryOperationProjection,
  MemoryOperationProjectionError,
  RequirementSubmissionOwner,
  SchedulerPatrol,
  SchedulerPatrolError,
  admitToolIntent,
  computePriority,
  createExplicitBrainToolRegistry,
  enrichMemorySaveCandidate,
  resolveBugOwner,
  stableBugSubmissionId,
  submitMemorySaveCandidate,
  type ExplicitBrainRuntimeBinding,
  type GitBugPort,
  type NotificationPort,
  type RequirementSubmitReceipt,
} from '../../../packages/runtime/src/explicit-brain/index.js';
import { reportBug, type BugIntakeLedgerPort } from '../../../packages/runtime/src/explicit-brain/index.js';
import {
  consumeEvents,
  publishEvent,
  type ConsumerCommitRequest,
  type EventBusPorts,
  type EventConsumerBinding,
  type EventConsumerReceipt,
  type EventExternalOperation,
  type EventHandlerCommit,
  type EventRetryObligation,
  type EventRecord,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';
import type {
  AppendEventRequest,
  EventConsumerRegistryPort,
  EventExternalOperationPort,
  EventJournalPort,
  EventPublisherRegistryPort,
} from '../../../packages/runtime/src/events/ports.js';
import type { RequirementInbox } from '../../../packages/runtime/src/intake/requirement-inbox.js';
import type { ExplicitBrainAdmissionError as AdmissionError } from '../../../packages/runtime/src/explicit-brain/index.js';
import { loadBuiltinPromptSegments } from '../../../packages/agent-templates/src/index.js';

const organId = id('organ', 'organ-a');
const operationId = id('operation', 'operation-a');
const capabilityDigest = 'sha256:explicit-brain-v1';

function evidence(label: string, scope: EvidenceRef['scope'] = { organId }): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'test',
    locator: `test://${label}`,
    scope,
  };
}

function binding(overrides: Partial<ExplicitBrainRuntimeBinding> = {}): ExplicitBrainRuntimeBinding {
  return {
    runtimeId: 'runtime-explicit-brain',
    agentInstanceId: 'agent-explicit-brain',
    roleId: 'interaction',
    templateRef: EXPLICIT_BRAIN_TEMPLATE_REF,
    interactionScopeId: 'interaction-a',
    executionEpoch: 4,
    permissionRevision: 'permission-r1',
    capabilityDigest,
    bindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a/interaction-a',
    permissions: [
      'task.read',
      'task.propose',
      'runtime.read',
      'queue.read',
      'resource.read',
      'bug.read',
      'bug.report',
      'channel.read',
      'channel.reply',
      'channel.notify',
      'memory.read',
      'memory.propose',
      'attention.read',
      'attention.triage',
      'requirement.submit',
      'trigger.submit',
      'resource.request',
      'subscription.request',
    ],
    capabilities: [
      'task.query',
      'task.match',
      'runtime.status',
      'queue.inspect',
      'resource.query',
      'bug.query',
      'bug.inspect',
      'channel.query',
      'memory.search',
      'memory.inspect',
      'memory.compare',
      'memory.save_candidate',
      'memory.operation.status',
      'interaction.ask',
      'interaction.propose',
      'interaction.approve',
      'channel.reply',
      'channel.notify',
      'requirement.submit',
      'trigger.submit',
      'route.submit',
      'resource.request',
      'subscription.request',
      'attention.list',
      'attention.inspect',
      'attention.triage',
      'attention.ack',
      'attention.defer',
      'attention.notify',
      'attention.resolve',
      'bug.report',
      'bug.propose-update',
      'bug.resolve',
      'bug.reopen',
    ],
    ...overrides,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function argumentsDigest(args: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash('sha256').update(stableStringify(args)).digest('hex')}`;
}

const digestArguments = argumentsDigest;

function intent(toolRef: string, args: Readonly<Record<string, unknown>> = {}): ToolIntent {
  return {
    toolIntentId: `intent:${toolRef}`,
    toolRef,
    arguments: args,
    argumentsDigest: argumentsDigest(args),
    reasonRefs: ['reason:test'],
    selectedBecause: 'test',
  };
}

test('1.0.0 and 1.1.0 bindings keep tool and permission surfaces isolated', () => {
  validateConfiguredAgentBinding({
    roleId: 'interaction',
    templateRef: 'builtin/interaction@1.0.0',
    driverRef: 'fake',
    skills: ['input-normalization'],
    tools: ['proposal.render'],
    permissions: ['task.propose'],
  });
  assert.throws(() => validateConfiguredAgentBinding({
    roleId: 'interaction',
    templateRef: 'builtin/interaction@1.0.0',
    driverRef: 'fake',
    skills: ['input-normalization'],
    tools: ['interaction.propose'],
    permissions: ['task.propose'],
  }));
  validateConfiguredAgentBinding({
    roleId: 'interaction',
    templateRef: EXPLICIT_BRAIN_TEMPLATE_REF,
    driverRef: 'fake',
    skills: ['channel-routing'],
    tools: ['interaction.propose'],
    permissions: ['task.propose'],
  });
});

test('1.1.0 interaction template loads versioned prompt segments without changing 1.0.0', async () => {
  const root = `${cwd()}/packages/agent-templates/templates`;
  const legacy = await loadBuiltinPromptSegments('interaction', root, '1.0.0');
  const current = await loadBuiltinPromptSegments('interaction', root, '1.1.0');
  assert.equal(legacy.segments[0]?.ref, 'interaction/identity.md');
  assert.equal(current.segments[0]?.ref, 'common/observation.md');
  const explicitBrainIdentity = current.segments.find(
    (segment) => segment.ref === 'interaction/profiles/explicit-brain/identity.md',
  );
  assert.ok(explicitBrainIdentity);
  assert.notEqual(legacy.contentDigest, current.contentDigest);
  assert.match(explicitBrainIdentity.content, /Explicit Brain/);
  const manifest = await loadBuiltinAgentTemplate(root, 'interaction', '1.1.0');
  assert.equal(manifest.digest, digestAgentTemplate(manifest));
  validateAgentTemplate(manifest, {
    capabilities: [...manifest.capabilityRefs],
    skills: [...manifest.skillRefs],
    toolCapabilities: [...manifest.toolCapabilityRefs],
  });
  for (const segment of ['identity', 'mission', 'input-output', 'failure', 'boundaries']) {
    const profile = await readFile(join(root, 'builtin', 'interaction', 'profiles', 'explicit-brain', `${segment}.md`), 'utf8');
    assert.ok(profile.trim().length > 0);
  }
});

test('tool admission requires one-to-one registry, capability, permission, epoch and arguments', () => {
  const registry = createExplicitBrainToolRegistry(capabilityDigest);
  const admitted = admitToolIntent({
    registry,
    binding: binding(),
    intent: intent('resource.request', {
      routeOperationId: 'operation:route-a',
      capabilityRefs: ['report.collect'],
      resourceClass: 'normal',
      preemption: 'none',
    }),
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  assert.equal(admitted.toolRef, 'resource.request');
  const trigger = admitToolIntent({
    registry,
    binding: binding(),
    intent: intent('trigger.submit', {
      triggerRef: 'trigger:patrol-a',
      source: 'schedule',
      policyRef: 'policy:patrol',
      policyRevision: 1,
      skillRef: 'channel-routing',
      skillDigest: 'sha256:skill',
      idempotencyKey: 'subscription-a::1::1',
      payloadRef: 'asset://patrol-a',
    }),
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  assert.equal(trigger.toolRef, 'trigger.submit');
  assert.throws(
    () => admitToolIntent({
      registry,
      binding: binding(),
      intent: intent('trigger.submit', {
        triggerRef: 'trigger:patrol-a',
        source: 'schedule',
        policyRef: 'policy:patrol',
        policyRevision: 0,
        skillRef: 'channel-routing',
        skillDigest: 'sha256:skill',
        idempotencyKey: 'subscription-a::1::1',
        payloadRef: 'asset://patrol-a',
      }),
      currentEpoch: 4,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError && error.code === 'invalid-arguments',
  );
  assert.throws(
    () => admitToolIntent({
      registry: createExplicitBrainToolRegistry('sha256:other-capabilities'),
      binding: binding(),
      intent: intent('runtime.status', { scopeRef: 'scope:organ-a' }),
      currentEpoch: 4,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError
      && error.code === 'invalid-runtime-binding',
  );
  assert.throws(
    () => admitToolIntent({
      registry,
      binding: binding(),
      intent: intent('runtime.spawn'),
      currentEpoch: 4,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError && error.code === 'runtime-only-capability',
  );
  assert.throws(
    () => admitToolIntent({
      registry,
      binding: binding({ permissions: ['resource.read'] }),
      intent: intent('resource.request', {
        routeOperationId: 'operation:route-a',
        capabilityRefs: ['x'],
        resourceClass: 'normal',
        preemption: 'none',
      }),
      currentEpoch: 4,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError && error.code === 'permission-denied',
  );
  assert.throws(
    () => admitToolIntent({
      registry,
      binding: binding(),
      intent: intent('resource.request', {
        routeOperationId: 'operation:route-a',
        capabilityRefs: ['x'],
        resourceClass: 'normal',
        preemption: 'none',
        workerId: 'worker-a',
      }),
      currentEpoch: 4,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError && error.code === 'invalid-arguments',
  );
  assert.throws(
    () => admitToolIntent({
      registry,
      binding: binding(),
      intent: intent('runtime.status', { scopeRef: 'scope:organ-a' }),
      currentEpoch: 5,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError && error.code === 'stale-epoch',
  );
  const memoryCandidate = admitToolIntent({
    registry,
    binding: binding(),
    intent: intent('memory.save_candidate', {
      submissionId: 'submission:memory-a',
      requestedKind: 'semantic',
      candidateCategory: 'project-fact',
      contentRef: 'content:memory-a',
      evidenceRefs: ['source:memory-a'],
      desiredScope: 'project',
      reason: 'explicit memory request',
    }),
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  assert.equal(memoryCandidate.toolRef, 'memory.save_candidate');
  assert.throws(
    () => admitToolIntent({
      registry,
      binding: binding(),
      intent: intent('memory.save_candidate', {
        submissionId: 'submission:memory-b',
        requestedKind: 'semantic',
        candidateCategory: 'project-fact',
        contentRef: 'content:memory-b',
        evidenceRefs: [],
        desiredScope: 'project',
        reason: 'missing evidence',
      }),
      currentEpoch: 4,
      currentPermissionRevision: 'permission-r1',
      argumentsDigest: digestArguments,
    }),
    (error: AdmissionError) => error instanceof ExplicitBrainAdmissionError && error.code === 'invalid-arguments',
  );
  for (const [toolRef, args] of [
    ['attention.ack', {}],
    ['attention.defer', { attentionId: 'attention:a' }],
    ['attention.notify', { attentionId: 'attention:a', recipientRef: 'human:a' }],
    ['attention.resolve', {}],
    ['task.query', {}],
    ['bug.inspect', {}],
    ['channel.reply', {}],
    ['interaction.approve', {}],
    ['memory.operation.status', {}],
    ['memory.save_candidate', {
      submissionId: 'submission:a',
      candidateCategory: 'project-fact',
      contentRef: 'content:a',
    }],
    ['resource.request', {
      capabilityRefs: ['x'],
      resourceClass: 'normal',
      preemption: 'none',
    }],
  ] as const) {
    assert.throws(
      () => admitToolIntent({
        registry,
        binding: binding(),
        intent: intent(toolRef, args),
        currentEpoch: 4,
        currentPermissionRevision: 'permission-r1',
        argumentsDigest: digestArguments,
      }),
      (error: unknown) => error instanceof ExplicitBrainAdmissionError
        && (error.code === 'invalid-arguments' || error.code === 'permission-denied'),
      `${toolRef} must reject incomplete arguments`,
    );
  }
});

test('framework executor records accepted and denied tool decisions without trusting the model to record', async () => {
  const traces = new DecisionTraceStore();
  const executed: string[] = [];
  const executor = new ExplicitBrainDecisionExecutor<string>({
    registry: createExplicitBrainToolRegistry(capabilityDigest),
    binding: binding(),
    traces,
    handler: {
      async execute(intent) {
        executed.push(intent.toolRef);
        return `result:${intent.toolRef}`;
      },
    },
    context: {
      scopeRef: 'scope:organ-a',
      runtimeBindingRef: 'binding-explicit-brain',
      ownerRef: 'runtime-explicit-brain',
      createdAt: '2026-09-17T00:00:00.000Z',
      inputDigest: 'sha256:interaction-input',
      argumentsRef: (toolIntent) => `arguments:${toolIntent.toolIntentId}`,
    },
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  const decision = {
    decisionId: 'decision-accepted',
    interactionId: 'interaction-a',
    kind: 'intent' as const,
    selectedAction: 'notify' as const,
    summary: 'notify through an admitted tool',
    evidenceRefs: ['source:a'],
    toolIntents: [intent('channel.notify', { channelId: 'manual', recipientRef: 'human:a', messageRef: 'message:a' })],
  };
  const [result] = await executor.execute(decision);
  assert.equal(result?.result, 'result:channel.notify');
  assert.deepEqual(executed, ['channel.notify']);
  assert.equal(traces.query({ interactionRef: 'interaction-a', admission: 'accepted' }).length, 1);
  assert.equal(result?.trace.execution?.admission, 'accepted');

  const traced = new DecisionTraceStore();
  const tracedExecutor = new ExplicitBrainDecisionExecutor<string>({
    registry: createExplicitBrainToolRegistry(capabilityDigest),
    binding: binding(),
    traces: traced,
    handler: {
      async execute() {
        return {
          value: 'result:traced',
          trace: {
            operationId,
            effectRefs: ['effect:tool'],
            resultRef: 'result:tool',
            eventRefs: ['event:tool'],
            notificationOperationRefs: ['notification:tool'],
            stateTransitionRef: 'state:tool',
            downstreamRouteRef: 'route:tool',
            finalReceiptRef: 'receipt:tool',
          },
        };
      },
    },
    context: {
      scopeRef: 'scope:organ-a',
      runtimeBindingRef: 'binding-explicit-brain',
      ownerRef: 'runtime-explicit-brain',
      createdAt: '2026-09-17T00:00:00.000Z',
      inputDigest: 'sha256:interaction-input',
      argumentsRef: (toolIntent) => `arguments:${toolIntent.toolIntentId}`,
      attentionRef: 'attention:traced',
      bugRef: 'bug:traced',
      taskRef: 'task:traced',
      operationRef: operationId.value,
    },
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  const [tracedResult] = await tracedExecutor.execute({
    ...decision,
    decisionId: 'decision-traced',
    toolIntents: [intent('channel.notify', { channelId: 'manual', recipientRef: 'human:a', messageRef: 'message:a' })],
  });
  assert.equal(tracedResult?.trace.execution?.operationId?.value, operationId.value);
  assert.deepEqual(tracedResult?.trace.execution?.effectRefs, ['effect:tool']);
  assert.equal(tracedResult?.trace.execution?.resultRef, 'result:tool');
  assert.deepEqual(tracedResult?.trace.execution?.eventRefs, ['event:tool']);
  assert.deepEqual(tracedResult?.trace.execution?.notificationOperationRefs, ['notification:tool']);
  assert.equal(tracedResult?.trace.execution?.stateTransitionRef, 'state:tool');
  assert.equal(tracedResult?.trace.execution?.downstreamRouteRef, 'route:tool');
  assert.equal(tracedResult?.trace.execution?.finalReceiptRef, 'receipt:tool');
  assert.equal(traced.query({ operationRef: operationId.value }).length, 1);
  assert.equal(traced.query({ attentionRef: 'attention:traced' }).length, 1);
  assert.equal(traced.query({ bugRef: 'bug:traced' }).length, 1);
  assert.equal(traced.query({ taskRef: 'task:traced' }).length, 1);

  const waitingTraces = new DecisionTraceStore();
  const waitingExecutor = new ExplicitBrainDecisionExecutor<string>({
    registry: createExplicitBrainToolRegistry(capabilityDigest),
    binding: binding(),
    traces: waitingTraces,
    handler: {
      async execute() {
        return {
          value: 'waiting',
          trace: {
            admission: 'waiting',
            effectRefs: ['resource:waiting'],
            settlement: {
              state: 'waiting',
              recoveryRef: 'attention:resource-waiting',
            },
          },
        };
      },
    },
    context: {
      scopeRef: 'scope:organ-a',
      runtimeBindingRef: 'binding-explicit-brain',
      ownerRef: 'runtime-explicit-brain',
      createdAt: '2026-09-17T00:00:00.000Z',
      inputDigest: 'sha256:interaction-input',
      argumentsRef: (toolIntent) => `arguments:${toolIntent.toolIntentId}`,
    },
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  const [waiting] = await waitingExecutor.execute({
    ...decision,
    decisionId: 'decision-waiting',
    selectedAction: 'wait',
    toolIntents: [intent('resource.request', {
      routeOperationId: 'operation:route-waiting',
      capabilityRefs: ['report.collect'],
      resourceClass: 'normal',
      preemption: 'none',
    })],
  });
  assert.equal(waiting?.trace.execution?.admission, 'waiting');
  assert.deepEqual(waiting?.trace.execution?.settlement, {
    state: 'waiting',
    recoveryRef: 'attention:resource-waiting',
  });
  assert.equal(waitingTraces.query({ admission: 'waiting' }).length, 1);

  await assert.rejects(
    () => executor.execute({
      ...decision,
      decisionId: 'decision-denied',
      toolIntents: [intent('runtime.spawn')],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExplicitBrainDecisionError);
      assert.equal(error.admission, 'rejected');
      assert.equal(error.trace.execution?.admission, 'rejected');
      return true;
    },
  );
  assert.equal(traces.query({ interactionRef: 'interaction-a', admission: 'rejected' }).length, 1);
});

test('decision trace journal preserves history after recreation and new appends', () => {
  const persisted: string[] = [];
  const firstOwner = new AttentionTriageOwner(new DecisionTraceJournal({
    persist: (record) => persisted.push(JSON.stringify(record)),
    load: () => persisted.map((record) => JSON.parse(record)),
  }));
  const triage = firstOwner.triage({
    sourceRef: 'source:replay',
    kind: 'operation-failure',
    impact: 'low',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['operation:replay'],
    evidenceRefs: [evidence('replay')],
    reasonRefs: ['replay'],
    proposedNextAction: 'retry',
  }, {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:replay',
  });

  const recreatedOwner = new AttentionTriageOwner(new DecisionTraceJournal({
    persist: (record) => persisted.push(JSON.stringify(record)),
    load: () => persisted.map((record) => JSON.parse(record)),
  }));
  assert.equal(recreatedOwner.queryTraces({ attentionRef: triage.attentionId }).length, 1);
  recreatedOwner.triage({
    sourceRef: 'source:replay-after-restart',
    kind: 'operation-failure',
    impact: 'medium',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['operation:replay-after-restart'],
    evidenceRefs: [evidence('replay-after-restart')],
    reasonRefs: ['replay-after-restart'],
    proposedNextAction: 'retry',
  }, {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:01.000Z',
    inputDigest: 'sha256:replay-after-restart',
  });
  const tracesAfterAppend = recreatedOwner.queryTraces();
  assert.equal(tracesAfterAppend.length, 2);
  assert.equal(tracesAfterAppend.some((trace) => trace.semantic?.interactionRef === 'source:replay-after-restart'), true);
});

test('channel routing supports manual and automatic events without fabricating confirmation', () => {
  const router = new ChannelRouter([{
    skillRef: 'error-notification',
    skillDigest: 'sha256:skill',
  }]);
  router.register({
    channelId: 'manual',
    kind: 'manual-route',
    scopeRef: 'scope:organ-a',
    skillRef: 'channel-routing',
    inputSchemaRef: 'schema://manual',
    replyMode: 'reply',
    errorPolicy: 'attention',
  });
  router.register({
    channelId: 'health',
    kind: 'health-event',
    scopeRef: 'scope:organ-a',
    skillRef: 'error-notification',
    inputSchemaRef: 'schema://health',
    replyMode: 'notify',
    errorPolicy: 'attention',
  });
  const manual = router.route({
    interactionId: 'interaction-1',
    sourceRef: 'source:manual-1',
    channelId: 'manual',
    inputRevision: 1,
    idempotencyKey: 'manual-1',
    rawInputRef: 'asset://manual-1',
    occurredAt: '2026-09-17T00:00:00.000Z',
  });
  assert.equal(manual.manual, true);
  assert.equal(manual.normalized.classification, 'business-requirement');
  assert.throws(() => router.route({
    interactionId: 'interaction-2',
    sourceRef: 'source:health-1',
    channelId: 'health',
    inputRevision: 1,
    idempotencyKey: 'health-1',
    rawInputRef: 'asset://health-1',
    occurredAt: '2026-09-17T00:00:00.000Z',
  }));
  const automatic = router.route({
    interactionId: 'interaction-2',
    sourceRef: 'source:health-1',
    channelId: 'health',
    inputRevision: 1,
    idempotencyKey: 'health-1',
    rawInputRef: 'asset://health-1',
    occurredAt: '2026-09-17T00:00:00.000Z',
    policy: {
      policyRef: 'policy://health',
      revision: 1,
      approved: true,
      sourceBindingRef: 'source-binding://health',
      skillRef: 'error-notification',
      skillDigest: 'sha256:skill',
      idempotencyKey: 'health-1',
    },
  });
  assert.equal(automatic.manual, false);
  assert.equal(automatic.normalized.classification, 'health-event');
  const automaticReplay = router.route({
    interactionId: 'interaction-2',
    sourceRef: 'source:health-1',
    channelId: 'health',
    inputRevision: 1,
    idempotencyKey: 'health-1',
    rawInputRef: 'asset://health-1',
    occurredAt: '2026-09-17T00:00:00.000Z',
    policy: {
      policyRef: 'policy://health',
      revision: 1,
      approved: true,
      sourceBindingRef: 'source-binding://health',
      skillRef: 'error-notification',
      skillDigest: 'sha256:skill',
      idempotencyKey: 'health-1',
    },
  });
  assert.deepEqual(automaticReplay.normalized, automatic.normalized);
  assert.throws(() => router.route({
    interactionId: 'interaction-2',
    sourceRef: 'source:health-conflict',
    channelId: 'health',
    inputRevision: 1,
    idempotencyKey: 'health-1',
    rawInputRef: 'asset://health-1',
    occurredAt: '2026-09-17T00:00:00.000Z',
    policy: {
      policyRef: 'policy://health',
      revision: 1,
      approved: true,
      sourceBindingRef: 'source-binding://health',
      skillRef: 'error-notification',
      skillDigest: 'sha256:skill',
      idempotencyKey: 'health-1',
    },
  }), (error: unknown) => error instanceof ExplicitBrainRouterError
    && error.code === 'duplicate-submit');
  assert.throws(() => router.route({
    interactionId: 'interaction-3',
    sourceRef: 'source:health-2',
    channelId: 'health',
    inputRevision: 1,
    idempotencyKey: 'health-2',
    rawInputRef: 'asset://health-2',
    occurredAt: '2026-09-17T00:00:00.000Z',
    policy: {
      policyRef: 'policy://health',
      revision: 1,
      approved: true,
      sourceBindingRef: 'source-binding://health',
      skillRef: 'channel-routing',
      skillDigest: 'sha256:skill',
      idempotencyKey: 'health-2',
    },
  }), /policy skill does not match/);
  assert.throws(() => router.route({
    interactionId: 'interaction-4',
    sourceRef: 'source:health-3',
    channelId: 'health',
    inputRevision: 1,
    idempotencyKey: 'health-3',
    rawInputRef: 'asset://health-3',
    occurredAt: '2026-09-17T00:00:00.000Z',
    policy: {
      policyRef: 'policy://health',
      revision: 1,
      approved: true,
      sourceBindingRef: 'source-binding://health',
      skillRef: 'error-notification',
      skillDigest: 'sha256:other',
      idempotencyKey: 'health-3',
    },
  }), /skill revision is not registered/);
});

test('scheduler patrol is pauseable, skips busy occurrences, and is idempotent per occurrence', async () => {
  const submitted: string[] = [];
  const attentions: string[] = [];
  const patrol = new SchedulerPatrol({
    subscription: {
      subscriptionId: 'subscription-a',
      goalId: 'goal-a',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    },
    trigger: {
      triggerRef: 'trigger:patrol-a',
      source: 'schedule',
      policyRef: 'policy:patrol',
      policyRevision: 1,
      skillRef: 'channel-routing',
      skillDigest: 'sha256:skill',
      scopeRef: 'scope:organ-a',
      priorityProposalRef: 'priority:background',
      payloadRef: 'asset://patrol-a',
    },
    now: () => new Date('2026-09-17T02:00:00.000Z'),
    port: {
      async submitTrigger(input) {
        submitted.push(input.idempotencyKey);
        return { triggerReceiptRef: `receipt:${input.idempotencyKey}`, accepted: true };
      },
      async createAttention(input) {
        attentions.push(input.reason);
        return { attentionRef: 'attention:patrol-failure' };
      },
    },
  });

  const skipped = await patrol.run({ dueAt: '2026-09-17T00:00:00.000Z', busy: true });
  assert.equal(skipped.occurrence.state, 'consumed');
  assert.equal(submitted.length, 0);
  assert.equal(skipped.nextCheckRef, 'next-check:subscription-a::1::1');

  const first = await patrol.run({ dueAt: '2026-09-17T01:00:00.000Z', busy: false });
  const duplicate = await patrol.run({ dueAt: '2026-09-17T01:00:00.000Z', busy: false });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(submitted, ['subscription-a::1::2']);
  assert.equal(first.triggerReceiptRef, 'receipt:subscription-a::1::2');
  assert.equal(patrol.snapshot().currentOccurrenceOrdinal, 2);

  const paused = patrol.pause();
  assert.equal(paused.state, 'suspended');
  await assert.rejects(
    () => patrol.run({ dueAt: '2026-09-17T02:00:00.000Z', busy: false }),
    (error: unknown) => error instanceof SchedulerPatrolError && error.code === 'subscription-state',
  );
  assert.equal(patrol.resume().state, 'active');

  const failing = new SchedulerPatrol({
    subscription: {
      subscriptionId: 'subscription-b',
      goalId: 'goal-a',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    },
    trigger: {
      triggerRef: 'trigger:patrol-b',
      source: 'schedule',
      policyRef: 'policy:patrol',
      policyRevision: 1,
      skillRef: 'channel-routing',
      skillDigest: 'sha256:skill',
      scopeRef: 'scope:organ-a',
      priorityProposalRef: 'priority:background',
      payloadRef: 'asset://patrol-b',
    },
    now: () => new Date('2026-09-17T02:00:00.000Z'),
    port: {
      async submitTrigger() {
        throw new Error('trigger transport failed');
      },
      async createAttention(input) {
        attentions.push(input.reason);
        return { attentionRef: 'attention:patrol-failure' };
      },
    },
  });
  const failed = await failing.run({ dueAt: '2026-09-17T00:00:00.000Z', busy: false });
  assert.equal(failed.occurrence.state, 'due');
  assert.equal(failed.attentionRef, 'attention:patrol-failure');
  assert.deepEqual(attentions, ['trigger transport failed']);
  let retryAccepted = false;
  const retrying = new SchedulerPatrol({
    subscription: {
      subscriptionId: 'subscription-c',
      goalId: 'goal-a',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    },
    trigger: {
      triggerRef: 'trigger:patrol-c',
      source: 'schedule',
      policyRef: 'policy:patrol',
      policyRevision: 1,
      skillRef: 'channel-routing',
      skillDigest: 'sha256:skill',
      scopeRef: 'scope:organ-a',
      priorityProposalRef: 'priority:background',
      payloadRef: 'asset://patrol-c',
    },
    now: () => new Date('2026-09-17T02:00:00.000Z'),
    port: {
      async submitTrigger() {
        if (!retryAccepted) {
          retryAccepted = true;
          throw new Error('trigger transport failed once');
        }
        return { triggerReceiptRef: 'receipt:patrol-c', accepted: true };
      },
      async createAttention() {
        return { attentionRef: 'attention:patrol-c-failure' };
      },
    },
  });
  const retryFailure = await retrying.run({ dueAt: '2026-09-17T00:00:00.000Z', busy: false });
  assert.equal(retryFailure.occurrence.state, 'due');
  const retrySuccess = await retrying.run({ dueAt: '2026-09-17T00:00:00.000Z', busy: false });
  assert.equal(retrySuccess.occurrence.state, 'consumed');
  assert.equal(retrySuccess.triggerReceiptRef, 'receipt:patrol-c');
});

test('explicit brain boundary validators reject invalid discriminants', () => {
  assert.throws(() => validateChannelBinding({
    channelId: 'invalid-channel',
    kind: 'unknown' as 'user',
    scopeRef: 'scope:organ-a',
    skillRef: 'channel-routing',
    inputSchemaRef: 'schema://invalid',
    replyMode: 'reply',
    errorPolicy: 'attention',
  }), /invalid channel kind/);
  assert.throws(() => validateAttentionTriage({
    sourceRef: 'source:invalid',
    kind: 'unknown' as 'other',
    impact: 'medium',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['attention:invalid'],
    evidenceRefs: [evidence('invalid')],
    reasonRefs: ['reason:invalid'],
    proposedNextAction: 'reject',
  }), /invalid attention kind/);
  assert.throws(() => validateBugReport({
    sourceFactRef: 'fact:invalid',
    submissionId: 'submission:invalid',
    observedResultRef: 'observed:invalid',
    expectedResultRef: 'expected:invalid',
    reproductionRefs: ['repro:invalid'],
    severityProposal: 'unknown' as 'low',
    impactProposal: 'invalid',
    correlationRef: 'correlation:invalid',
  }), /invalid bug severityProposal/);
});

test('requirement submission requires explicit confirmation of the current revision', async () => {
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: 'interaction-a',
    draftId: 'draft-a',
    inputRevision: 3,
    normalizedInput: 'normalized draft-a',
    intent: 'create',
    payloadRef: 'asset://draft-a',
  });
  const submitted: string[] = [];
  const inbox = {
    get expectedNextFifoSeq() { return 1; },
    markConfirmed() {},
    find() { return undefined; },
    async append(envelope: { readonly requirementId: string }) {
      submitted.push(envelope.requirementId);
      return { requirementId: envelope.requirementId, draftId: 'draft-a', fifoSeq: 1 };
    },
  } as unknown as Pick<RequirementInbox, 'expectedNextFifoSeq' | 'markConfirmed' | 'append' | 'find'>;
  const owner = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) { submitted.push(`port:${envelope.requirementId}`); return { requirementId: envelope.requirementId }; },
  });
  const args = {
    interactionId: 'interaction-a',
    draftId: 'draft-a',
    confirmationRef: 'confirm-a',
    inputRevision: 3,
  };
  await assert.rejects(() => owner.submit(args), /requires explicit confirmation/);
  ledger.confirm({
    interactionId: 'interaction-a',
    draftId: 'draft-a',
    inputRevision: 3,
    confirmationRef: 'confirm-a',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
  });
  const first = await owner.submit(args);
  assert.equal(first.status, 'submitted');
  assert.deepEqual(submitted, ['requirement:draft-a:3', 'port:requirement:draft-a:3']);
  const duplicate = await owner.submit(args);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(submitted.length, 2);
});

test('requirement submission retries the same durable envelope after a partial failure', async () => {
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: 'interaction-retry',
    draftId: 'draft-retry',
    inputRevision: 1,
    normalizedInput: 'normalized draft-retry',
    intent: 'create',
    payloadRef: 'asset://draft-retry',
  });
  ledger.confirm({
    interactionId: 'interaction-retry',
    draftId: 'draft-retry',
    inputRevision: 1,
    confirmationRef: 'confirm-retry',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
  });
  const appended: string[] = [];
  let submitAttempts = 0;
  const owner = new RequirementSubmissionOwner(ledger, {
    get expectedNextFifoSeq() { return 1; },
    markConfirmed() {},
    find() { return undefined; },
    async append(envelope) {
      appended.push(envelope.requirementId);
      return { requirementId: envelope.requirementId, draftId: envelope.draftId, fifoSeq: envelope.fifoSeq };
    },
  }, {
    async submit(envelope) {
      submitAttempts += 1;
      if (submitAttempts === 1) throw new Error('transport lost after append');
      return { requirementId: envelope.requirementId };
    },
  });
  const args = {
    interactionId: 'interaction-retry',
    draftId: 'draft-retry',
    confirmationRef: 'confirm-retry',
    inputRevision: 1,
  };
  await assert.rejects(() => owner.submit(args), /transport lost/);
  const receipt = await owner.submit(args);
  assert.equal(receipt.status, 'submitted');
  assert.deepEqual(appended, ['requirement:draft-retry:1']);
  assert.equal(submitAttempts, 2);
});

test('requirement submission retries inbox append before invoking the downstream port', async () => {
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: 'interaction-append-retry',
    draftId: 'draft-append-retry',
    inputRevision: 1,
    normalizedInput: 'normalized draft-append-retry',
    intent: 'create',
    payloadRef: 'asset://draft-append-retry',
  });
  ledger.confirm({
    interactionId: 'interaction-append-retry',
    draftId: 'draft-append-retry',
    inputRevision: 1,
    confirmationRef: 'confirm-append-retry',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
  });
  let appendAttempts = 0;
  let downstreamCalls = 0;
  const owner = new RequirementSubmissionOwner(ledger, {
    get expectedNextFifoSeq() { return 1; },
    markConfirmed() {},
    find() { return undefined; },
    async append(envelope) {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error('append unavailable');
      return { requirementId: envelope.requirementId, draftId: envelope.draftId, fifoSeq: envelope.fifoSeq };
    },
  }, {
    async submit(envelope) {
      downstreamCalls += 1;
      return { requirementId: envelope.requirementId };
    },
  });
  const args = {
    interactionId: 'interaction-append-retry',
    draftId: 'draft-append-retry',
    confirmationRef: 'confirm-append-retry',
    inputRevision: 1,
  };

  await assert.rejects(() => owner.submit(args), /append unavailable/);
  assert.equal(downstreamCalls, 0);
  assert.equal((await owner.submit(args)).status, 'submitted');
  assert.equal(appendAttempts, 2);
  assert.equal(downstreamCalls, 1);
});

test('requirement submission retry reuses the same envelope after append succeeds', async () => {
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: 'interaction-retry-after-append',
    draftId: 'draft-retry-after-append',
    inputRevision: 1,
    normalizedInput: 'normalized retry after append',
    intent: 'create',
    payloadRef: 'asset://draft-retry-after-append',
  });
  ledger.confirm({
    interactionId: 'interaction-retry-after-append',
    draftId: 'draft-retry-after-append',
    inputRevision: 1,
    confirmationRef: 'confirm-retry-after-append',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
  });
  const envelopes: string[] = [];
  let downstreamAttempts = 0;
  const owner = new RequirementSubmissionOwner(ledger, {
    get expectedNextFifoSeq() { return 1; },
    markConfirmed() {},
    find() { return undefined; },
    async append(envelope) {
      envelopes.push(JSON.stringify(envelope));
      return { requirementId: envelope.requirementId, draftId: envelope.draftId, fifoSeq: envelope.fifoSeq };
    },
  }, {
    async submit(envelope) {
      downstreamAttempts += 1;
      if (downstreamAttempts === 1) throw new Error('downstream unavailable');
      return { requirementId: envelope.requirementId };
    },
  });
  const input = {
    interactionId: 'interaction-retry-after-append',
    draftId: 'draft-retry-after-append',
    confirmationRef: 'confirm-retry-after-append',
    inputRevision: 1,
  };

  await assert.rejects(() => owner.submit(input), /downstream unavailable/);
  const receipt = await owner.submit(input);
  assert.equal(receipt.status, 'submitted');
  assert.equal(envelopes.length, 1);
  assert.equal(downstreamAttempts, 2);
});

test('requirement submission restored receipts suppress downstream redelivery', async () => {
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: 'interaction-restored-receipt',
    draftId: 'draft-restored-receipt',
    inputRevision: 1,
    normalizedInput: 'normalized restored receipt',
    intent: 'create',
    payloadRef: 'asset://draft-restored-receipt',
  });
  ledger.confirm({
    interactionId: 'interaction-restored-receipt',
    draftId: 'draft-restored-receipt',
    inputRevision: 1,
    confirmationRef: 'confirm-restored-receipt',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
  });
  const envelope: RequirementEnvelope = {
    requirementId: 'requirement:draft-restored-receipt:1',
    draftId: 'draft-restored-receipt',
    inputRevision: 1,
    intent: 'create',
    normalizedInput: 'normalized restored receipt',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    fifoSeq: 1,
    payloadRef: 'asset://draft-restored-receipt',
  };
  const inbox = {
    get expectedNextFifoSeq() { return 1; },
    markConfirmed() {},
    find() { return envelope; },
    async append() {
      throw new Error('append must not run for restored receipt');
    },
  } as unknown as Pick<RequirementInbox, 'expectedNextFifoSeq' | 'markConfirmed' | 'append' | 'find'>;
  const submitted: { readonly interactionId: string; readonly receipt: RequirementSubmitReceipt }[] = [];
  let downstreamCalls = 0;
  const first = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(input) {
      downstreamCalls += 1;
      return { requirementId: input.requirementId };
    },
  }, undefined, (receipt) => submitted.push({ interactionId: receipt.interactionId, receipt }));
  const args = {
    interactionId: 'interaction-restored-receipt',
    draftId: 'draft-restored-receipt',
    confirmationRef: 'confirm-restored-receipt',
    inputRevision: 1,
  };
  assert.equal((await first.submit(args)).status, 'submitted');
  assert.equal(downstreamCalls, 1);
  assert.equal(submitted.length, 1);

  const second = new RequirementSubmissionOwner(ledger, inbox, {
    async submit() {
      downstreamCalls += 1;
      return { requirementId: envelope.requirementId };
    },
  });
  second.restoreSubmittedReceipts([{ ...submitted[0]!.receipt, interactionId: submitted[0]!.interactionId }]);
  assert.equal((await second.submit(args)).status, 'duplicate');
  assert.equal(downstreamCalls, 1);
});

test('requirement submission serializes concurrent revisions and same-key retries', async () => {
  const ledger = new ConfirmationLedger();
  for (const suffix of ['a', 'b']) {
    ledger.registerDraft({
      interactionId: `interaction-concurrent-${suffix}`,
      draftId: `draft-concurrent-${suffix}`,
      inputRevision: 1,
      normalizedInput: `normalized draft-concurrent-${suffix}`,
      intent: 'create',
      payloadRef: `asset://draft-concurrent-${suffix}`,
    });
    ledger.confirm({
      interactionId: `interaction-concurrent-${suffix}`,
      draftId: `draft-concurrent-${suffix}`,
      inputRevision: 1,
      confirmationRef: `confirm-concurrent-${suffix}`,
      confirmedBy: 'human',
      confirmedAt: '2026-09-17T00:00:00.000Z',
    });
  }
  let nextFifoSeq = 1;
  const appended: string[] = [];
  const downstream: string[] = [];
  const owner = new RequirementSubmissionOwner(ledger, {
    get expectedNextFifoSeq() { return nextFifoSeq; },
    markConfirmed() {},
    find() { return undefined; },
    async append(envelope) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (envelope.fifoSeq !== nextFifoSeq) throw new Error(`out-of-order append: ${envelope.fifoSeq}/${nextFifoSeq}`);
      appended.push(envelope.requirementId);
      const receipt = { requirementId: envelope.requirementId, draftId: envelope.draftId, fifoSeq: envelope.fifoSeq };
      nextFifoSeq += 1;
      return receipt;
    },
  }, {
    async submit(envelope) {
      downstream.push(envelope.requirementId);
      return { requirementId: envelope.requirementId };
    },
  });
  const a = {
    interactionId: 'interaction-concurrent-a',
    draftId: 'draft-concurrent-a',
    confirmationRef: 'confirm-concurrent-a',
    inputRevision: 1,
  };
  const b = {
    interactionId: 'interaction-concurrent-b',
    draftId: 'draft-concurrent-b',
    confirmationRef: 'confirm-concurrent-b',
    inputRevision: 1,
  };

  const [first, duplicate, second] = await Promise.all([
    owner.submit(a),
    owner.submit(a),
    owner.submit(b),
  ]);
  assert.deepEqual([first.status, duplicate.status, second.status], ['submitted', 'duplicate', 'submitted']);
  assert.deepEqual(appended, ['requirement:draft-concurrent-a:1', 'requirement:draft-concurrent-b:1']);
  assert.deepEqual(downstream, appended);
});

test('requirement submission rejects a downstream receipt for a different requirement', async () => {
  const ledger = new ConfirmationLedger();
  ledger.registerDraft({
    interactionId: 'interaction-mismatch',
    draftId: 'draft-mismatch',
    inputRevision: 1,
    normalizedInput: 'normalized draft-mismatch',
    intent: 'create',
    payloadRef: 'asset://draft-mismatch',
  });
  ledger.confirm({
    interactionId: 'interaction-mismatch',
    draftId: 'draft-mismatch',
    inputRevision: 1,
    confirmationRef: 'confirm-mismatch',
    confirmedBy: 'human',
    confirmedAt: '2026-09-17T00:00:00.000Z',
  });
  const owner = new RequirementSubmissionOwner(ledger, {
    get expectedNextFifoSeq() { return 1; },
    markConfirmed() {},
    find() { return undefined; },
    async append(envelope) {
      return { requirementId: envelope.requirementId, draftId: envelope.draftId, fifoSeq: envelope.fifoSeq };
    },
  }, {
    async submit() { return { requirementId: 'requirement:other' }; },
  });

  await assert.rejects(
    () => owner.submit({
      interactionId: 'interaction-mismatch',
      draftId: 'draft-mismatch',
      confirmationRef: 'confirm-mismatch',
      inputRevision: 1,
    }),
    /requirement submission receipt mismatch: requirement:other/,
  );
});

test('Attention reuses ManagedIssue, escalates recurrence and blocking, and traces decisions', async () => {
  const owner = new AttentionTriageOwner();
  const first = owner.triage({
    sourceRef: 'source:operation-a',
    kind: 'operation-failure',
    impact: 'medium',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['operation:a'],
    evidenceRefs: [evidence('failure-a')],
    reasonRefs: ['failure:a'],
    proposedNextAction: 'retry',
  }, {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:first',
  });
  const second = owner.triage({
    sourceRef: 'source:operation-a',
    kind: 'operation-failure',
    impact: 'high',
    urgency: 'immediate',
    blocking: 'task',
    userDecisionRequired: false,
    recurrenceSignal: { rootCauseRef: 'source:operation-a', observedAt: '2026-09-17T00:01:00.000Z' },
    affectedRefs: ['task:a'],
    evidenceRefs: [evidence('retry-exhausted')],
    reasonRefs: ['failure:a', 'retry:exhausted'],
    proposedNextAction: 'escalate',
    retryExhausted: true,
  }, {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:01:00.000Z',
    inputDigest: 'sha256:second',
  });
  assert.equal(first.attentionId, second.attentionId);
  assert.equal(second.created, false);
  assert.equal(second.priority.priorityClass, 'task-blocking');
  assert.equal(second.priority.serviceClass, 'blocker');
  assert.equal(second.publicState, 'open');
  const acknowledged = owner.acknowledge(second.attentionId, {
    actorId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    createdAt: '2026-09-17T00:02:00.000Z',
    inputDigest: 'sha256:ack',
  });
  assert.equal(acknowledged.acknowledged, true);
  const deferred = owner.defer(second.attentionId, 'condition:operator-input', {
    actorId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    createdAt: '2026-09-17T00:03:00.000Z',
    inputDigest: 'sha256:defer',
  });
  assert.equal(deferred.issue.state, 'waiting');
  assert.equal(owner.projection(second.attentionId)?.state, 'open');
  const resolved = owner.resolve(second.attentionId, {
    actorId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    createdAt: '2026-09-17T00:04:00.000Z',
    inputDigest: 'sha256:resolve',
  });
  assert.equal(resolved.issue.state, 'resolved');
  assert.equal(owner.projection(second.attentionId)?.state, 'resolved');
  const notification = await owner.notify({
    attentionId: second.attentionId,
    recipientRef: 'human:a',
    messageRef: 'message:attention-a',
    notificationId: 'notification:attention-a',
    context: {
      actorId: 'runtime-operation-owner',
      runtimeBindingRef: 'binding-explicit-brain',
      createdAt: '2026-09-17T00:05:00.000Z',
      inputDigest: 'sha256:notify',
    },
    port: {
      async notify() { return { state: 'sent' as const }; },
    },
  });
  assert.equal(notification.trace.execution?.notificationOperationRefs[0], 'notification:attention-a');
  assert.equal(owner.list().length, 1);
  assert.equal(owner.queryTraces({ attentionRef: second.attentionId }).length, 6);
});

test('Attention recurrence after resolution creates a new issue identity', () => {
  const owner = new AttentionTriageOwner();
  const context = {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:first',
  };
  const first = owner.triage({
    sourceRef: 'source:resolved-recurrence',
    kind: 'operation-failure',
    impact: 'medium',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['operation:resolved-recurrence'],
    evidenceRefs: [evidence('resolved-recurrence-first')],
    reasonRefs: ['failure:resolved-recurrence'],
    proposedNextAction: 'recover',
  }, context);
  owner.resolve(first.attentionId, {
    actorId: 'runtime-operation-owner',
    runtimeBindingRef: context.runtimeBindingRef,
    createdAt: '2026-09-17T00:01:00.000Z',
    inputDigest: 'sha256:resolve',
  });
  const recurrence = owner.triage({
    sourceRef: 'source:resolved-recurrence',
    kind: 'operation-failure',
    impact: 'high',
    urgency: 'high',
    blocking: 'task',
    userDecisionRequired: false,
    affectedRefs: ['operation:resolved-recurrence'],
    evidenceRefs: [evidence('resolved-recurrence-second')],
    reasonRefs: ['failure:resolved-recurrence'],
    proposedNextAction: 'escalate',
  }, {
    ...context,
    createdAt: '2026-09-17T00:02:00.000Z',
    inputDigest: 'sha256:second',
  });

  assert.equal(recurrence.created, true);
  assert.notEqual(recurrence.issueId, first.issueId);
  assert.notEqual(recurrence.attentionId, first.attentionId);
  assert.equal(owner.inspect(first.attentionId)?.issue.state, 'resolved');
  assert.equal(owner.list().length, 2);
});

test('Attention recurrence and resolution stay scoped to the authoritative owner', () => {
  const owner = new AttentionTriageOwner();
  const first = owner.triage({
    sourceRef: 'source:scoped-attention',
    kind: 'operation-failure',
    impact: 'medium',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['operation:scoped-attention'],
    evidenceRefs: [evidence('scoped-attention-first')],
    reasonRefs: ['failure:scoped-attention'],
    proposedNextAction: 'recover',
  }, {
    ownerId: 'owner-a',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:scoped-attention-first',
  });
  const otherScope = owner.triage({
    sourceRef: 'source:scoped-attention',
    kind: 'operation-failure',
    impact: 'medium',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['operation:scoped-attention'],
    evidenceRefs: [evidence('scoped-attention-other')],
    reasonRefs: ['failure:scoped-attention'],
    proposedNextAction: 'recover',
  }, {
    ownerId: 'owner-b',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-b',
    scope: { organId: id('organ', 'organ-b') },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:scoped-attention-other',
  });

  assert.equal(first.created, true);
  assert.equal(otherScope.created, true);
  assert.notEqual(first.attentionId, otherScope.attentionId);
  assert.equal(owner.inspect(first.attentionId)?.ownerId, 'owner-a');
  assert.equal(owner.inspect(otherScope.attentionId)?.ownerId, 'owner-b');
  assert.throws(
    () => owner.resolve(first.attentionId, {
      actorId: 'owner-b',
      runtimeBindingRef: 'binding-explicit-brain',
      createdAt: '2026-09-17T00:01:00.000Z',
      inputDigest: 'sha256:unauthorized-resolve',
    }),
    /attention resolve actor is not authorized/,
  );
  const resolved = owner.resolve(first.attentionId, {
    actorId: 'owner-a',
    runtimeBindingRef: 'binding-explicit-brain',
    createdAt: '2026-09-17T00:01:00.000Z',
    inputDigest: 'sha256:authorized-resolve',
  });
  assert.equal(resolved.issue.state, 'resolved');
  assert.equal(resolved.issue.resolvedBy, 'owner-a');
});

test('priority policy exposes explainable waiting and background behavior', () => {
  const waiting = computePriority({
    sourceRef: 'source:waiting',
    kind: 'resource-waiting',
    impact: 'low',
    urgency: 'none',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['resource:a'],
    evidenceRefs: [evidence('waiting')],
    reasonRefs: ['quota:a'],
    proposedNextAction: 'wait',
  });
  assert.equal(waiting.preemptsActiveExecution, false);
  assert.ok(waiting.reasons.some((reason) => reason.includes('does not consume')));
  const background = computePriority({
    sourceRef: 'source:memory',
    kind: 'other',
    impact: 'low',
    urgency: 'low',
    blocking: 'none',
    userDecisionRequired: false,
    affectedRefs: ['memory:a'],
    evidenceRefs: [evidence('memory')],
    reasonRefs: ['memory:a'],
    proposedNextAction: 'schedule',
  });
  assert.equal(background.serviceClass, 'background');
  assert.ok(background.reasons.some((reason) => reason.includes('anti-starvation')));
});

test('memory operation projection distinguishes accepted from applied and only wakes on boundaries', () => {
  const projection = new MemoryOperationProjection();
  const event: MemoryOperationRequestedEvent = {
    operationId,
    trigger: 'human-correction',
    boundary: 'explicit-memory-submission',
    sourceRefs: ['source:correction'],
    scopeRef: 'scope:organ-a',
    requestedOutputs: ['candidate'],
    userVisible: false,
  };
  const record = projection.acceptSubmission({ submissionId: 'submission-a', operationId, event });
  assert.equal(record.state, 'accepted');
  assert.equal(
    projection.acceptSubmission({ submissionId: 'submission-a', operationId, event }),
    record,
  );
  assert.throws(
    () => projection.acceptSubmission({
      submissionId: 'submission-a',
      operationId,
      event: { ...event, sourceRefs: ['source:different'] },
    }),
    (error: unknown) => error instanceof MemoryOperationProjectionError
      && error.code === 'duplicate-submission',
  );
  assert.equal(projection.replyState(operationId), 'accepted; analysis has not been applied');
  projection.transition({ operationId, state: 'applied', nextAction: 'none', resultRefs: ['memory:candidate'] });
  assert.equal(projection.status(operationId).state, 'applied');
  assert.equal(projection.wakeup(event).wake, true);
  assert.equal(projection.isBoundaryWakeup(event), true);
  assert.equal(projection.isBoundaryWakeup({ ...event, boundary: 'checkpoint-rewind' }), false);
});

test('all four memory boundary wakeups are explicit and ordinary turns are not boundary wakeups', () => {
  const projection = new MemoryOperationProjection();
  const boundaries: MemoryOperationRequestedEvent[] = [
    { operationId, trigger: 'attention-blocked', boundary: 'blocked-attention', sourceRefs: ['a'], scopeRef: 's', requestedOutputs: [], userVisible: false },
    { operationId: id('operation', 'operation-b'), trigger: 'rewind', boundary: 'checkpoint-rewind', sourceRefs: ['b'], scopeRef: 's', requestedOutputs: [], userVisible: false },
    { operationId: id('operation', 'operation-c'), trigger: 'task-completion', boundary: 'task-cycle-completion', sourceRefs: ['c'], scopeRef: 's', requestedOutputs: [], userVisible: false },
    { operationId: id('operation', 'operation-d'), trigger: 'explicit-memory-request', boundary: 'explicit-memory-submission', sourceRefs: ['d'], scopeRef: 's', requestedOutputs: [], userVisible: true },
  ];
  assert.deepEqual(boundaries.map((event) => projection.wakeup(event).boundary), [
    'blocked-attention',
    'checkpoint-rewind',
    'task-cycle-completion',
    'explicit-memory-submission',
  ]);
  assert.equal(projection.isBoundaryWakeup({ ...boundaries[0]!, boundary: 'checkpoint-rewind' }), false);
});

test('memory save candidate enriches runtime-only identity instead of accepting model supplied fields', async () => {
  const runtimeBinding = binding();
  const context = {
    requestId: 'request:memory-a',
    operationId,
    projectKey: 'project:humanagent',
    actor: {
      actorId: 'explicit-brain',
      roleId: 'interaction' as const,
      permissions: ['memory.propose'] as const,
      projectKey: 'project:humanagent',
    },
    contentDigest: 'sha256:content-a',
    observation: 'The user explicitly requested this memory candidate.',
  };
  const intentArguments = {
    submissionId: 'submission:memory-a',
    requestedKind: 'semantic' as const,
    candidateCategory: 'project-fact' as const,
    contentRef: 'content:memory-a',
    evidenceRefs: ['source:memory-a'],
    desiredScope: 'project' as const,
    reason: 'explicit memory request',
  };
  const enriched = enrichMemorySaveCandidate({
    binding: runtimeBinding,
    intentArguments,
    argumentsDigest: 'sha256:memory-save-candidate',
    context,
  });
  assert.equal(enriched.requestId, 'request:memory-a');
  assert.equal(enriched.operationId.value, operationId.value);
  assert.equal(enriched.bindingRef, 'binding-explicit-brain');
  assert.equal(enriched.projectKey, 'project:humanagent');
  assert.equal(enriched.contentDigest, 'sha256:content-a');
  assert.equal(enriched.observation, context.observation);
  assert.equal(enriched.actor.actorId, 'explicit-brain');

  const submitted: string[] = [];
  const receipt = await submitMemorySaveCandidate({
    binding: runtimeBinding,
    intentArguments,
    argumentsDigest: 'sha256:memory-save-candidate',
    context,
    port: {
      async submitCandidate(submission) {
        submitted.push(submission.submissionId);
        return {
          submissionId: submission.submissionId,
          status: 'accepted',
          operationId: submission.operationId,
          nextAction: 'wait-analysis',
        };
      },
    },
  });
  assert.equal(receipt.status, 'accepted');
  assert.deepEqual(submitted, ['submission:memory-a']);
  assert.throws(
    () => enrichMemorySaveCandidate({
      binding: runtimeBinding,
      intentArguments,
      argumentsDigest: 'sha256:memory-save-candidate',
      context: { ...context, projectKey: 'project:other' },
    }),
    /memory actor project does not match runtime project/,
  );
});

test('memory tool executor dispatches admitted capabilities through typed memory owners', async () => {
  const calls: string[] = [];
  const interaction: MemoryInteractionPort = {
    async open() {
      throw new Error('not used');
    },
    async query(input) {
      calls.push(`query:${input.namespace}`);
      return {
        handle: {
          handleId: 'memory-view:test',
          actorId: 'explicit-brain',
          projectKey: 'project:humanagent',
          namespace: input.namespace,
          readOnly: true as const,
        },
        entries: [{
          memoryId: 'memory:alpha',
          namespace: 'project' as const,
          kind: 'semantic' as const,
          state: 'approved' as const,
          summary: 'alpha',
          sourceRefs: ['source:alpha'],
          sourceDigests: ['sha256:alpha'],
          projectKey: 'project:humanagent',
          sourceScopeRef: 'scope:organ-a',
          relevanceReason: 'exact source',
        }],
        omitted: [],
      };
    },
    async resolveSource(input) {
      calls.push(`resolve:${input.sourceRef}`);
      return {
        sourceRef: input.sourceRef,
        sourceDigest: 'sha256:alpha',
      };
    },
    async inspect(input) {
      calls.push(`inspect:${input.sourceDigest}`);
      return {
        handle: {
          handleId: 'memory-view:test',
          actorId: 'explicit-brain',
          projectKey: 'project:humanagent',
          namespace: 'project' as const,
          readOnly: true as const,
        },
        sourceRef: input.sourceRef,
        sourceDigest: input.sourceDigest,
        content: 'alpha',
      };
    },
    async compare(input) {
      calls.push(`compare:${input.leftRef}:${input.rightRef}`);
      return {
        handle: {
          handleId: 'memory-view:test',
          actorId: 'explicit-brain',
          projectKey: 'project:humanagent',
          namespace: 'project' as const,
          readOnly: true as const,
        },
        leftRef: input.leftRef,
        rightRef: input.rightRef,
        relation: 'same' as const,
        evidenceRefs: [input.leftRef, input.rightRef],
      };
    },
    async review() {
      throw new Error('not used');
    },
    async promote() {
      throw new Error('not used');
    },
    async planForgetting() {
      throw new Error('not used');
    },
  };
  const executor = new ExplicitBrainMemoryToolExecutor({
    binding: binding(),
    interaction,
    submissions: {
      async submitCandidate(submission) {
        calls.push(`submit:${submission.submissionId}`);
        return {
          submissionId: submission.submissionId,
          status: 'accepted',
          operationId: submission.operationId,
          nextAction: 'wait-analysis',
        };
      },
    },
    context: {
      requestId: 'request:memory-tool',
      operationId,
      projectKey: 'project:humanagent',
      actor: {
        actorId: 'explicit-brain',
        roleId: 'interaction',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: 'project:humanagent',
      },
      contentDigest: 'sha256:content-a',
      observation: 'explicit tool invocation',
    },
  });
  const receipt = (toolIntent: ToolIntent) => ({
    admitted: true as const,
    toolRef: toolIntent.toolRef as
      | 'memory.search'
      | 'memory.inspect'
      | 'memory.compare'
      | 'memory.save_candidate',
    capabilityRef: toolIntent.toolRef as
      | 'memory.search'
      | 'memory.inspect'
      | 'memory.compare'
      | 'memory.save_candidate',
    bindingRef: 'binding-explicit-brain',
    executionEpoch: 4,
    argumentsDigest: toolIntent.argumentsDigest,
  });

  const searchIntent = intent('memory.search', { query: 'alpha', limit: 3 });
  const view = await executor.execute(searchIntent, receipt(searchIntent));
  assert.equal('entries' in view ? view.entries[0]?.summary : undefined, 'alpha');

  const inspectIntent = intent('memory.inspect', { sourceRef: 'source:alpha' });
  const detail = await executor.execute(inspectIntent, receipt(inspectIntent));
  assert.equal('content' in detail ? detail.content : undefined, 'alpha');
  assert.equal('content' in detail ? detail.sourceDigest : undefined, 'sha256:alpha');

  const compareIntent = intent('memory.compare', {
    leftRef: 'source:alpha',
    rightRef: 'source:beta',
  });
  const comparison = await executor.execute(compareIntent, receipt(compareIntent));
  assert.equal('relation' in comparison ? comparison.relation : undefined, 'same');

  const saveIntent = intent('memory.save_candidate', {
    submissionId: 'submission:memory-tool',
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef: 'content:memory-tool',
    evidenceRefs: ['source:memory-tool'],
    desiredScope: 'project',
    reason: 'explicit request',
    bindingRef: 'model-supplied-binding',
    projectKey: 'model-supplied-project',
    actor: {
      actorId: 'model-supplied-actor',
      roleId: 'system',
      permissions: ['memory.promote'],
      projectKey: 'model-supplied-project',
    },
  });
  const submission = await executor.execute(saveIntent, receipt(saveIntent));
  assert.equal('submissionId' in submission ? submission.submissionId : undefined, 'submission:memory-tool');
  assert.deepEqual(calls, [
    'query:project',
    'resolve:source:alpha',
    'inspect:sha256:alpha',
    'compare:source:alpha:source:beta',
    'submit:submission:memory-tool',
  ]);

  await assert.rejects(
    () => {
      const unsupported = intent('task.query', { queryRef: 'task:alpha' });
      return executor.execute(unsupported, receipt(unsupported));
    },
    (error: unknown) => error instanceof ExplicitBrainMemoryToolError
      && error.code === 'unsupported-tool',
  );

  const denied = new ExplicitBrainMemoryToolExecutor({
    binding: binding(),
    interaction: {
      ...interaction,
      async query() {
        throw new Error('memory backend unavailable');
      },
    },
    submissions: {
      async submitCandidate() {
        throw new Error('not used');
      },
    },
    context: {
      requestId: 'request:memory-tool-denied',
      operationId,
      projectKey: 'project:humanagent',
      actor: {
        actorId: 'explicit-brain',
        roleId: 'interaction',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: 'project:humanagent',
      },
      contentDigest: 'sha256:content-denied',
      observation: 'backend failure',
    },
  });
  await assert.rejects(
    () => denied.execute(searchIntent, receipt(searchIntent)),
    /memory backend unavailable/,
  );

  const drifted = new ExplicitBrainMemoryToolExecutor({
    binding: binding(),
    interaction: {
      ...interaction,
      async resolveSource(input) {
        return {
          sourceRef: input.sourceRef,
          sourceDigest: 'sha256:drifted',
        };
      },
      async inspect(input) {
        if (input.sourceDigest !== 'sha256:alpha') {
          throw new Error(`memory source digest drifted: ${input.sourceRef}`);
        }
        return interaction.inspect(input);
      },
    },
    submissions: {
      async submitCandidate() {
        throw new Error('not used');
      },
    },
    context: {
      requestId: 'request:memory-tool-drifted',
      operationId,
      projectKey: 'project:humanagent',
      actor: {
        actorId: 'explicit-brain',
        roleId: 'interaction',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: 'project:humanagent',
      },
      contentDigest: 'sha256:content-drifted',
      observation: 'digest drift',
    },
  });
  await assert.rejects(
    () => drifted.execute(inspectIntent, receipt(inspectIntent)),
    (error: unknown) => error instanceof Error
      && error.message === 'memory source digest drifted: source:alpha',
  );

  await assert.rejects(
    () => executor.execute(inspectIntent, { ...receipt(inspectIntent), bindingRef: 'binding-other' }),
    (error: unknown) => error instanceof ExplicitBrainMemoryToolError
      && error.code === 'invalid-admission-receipt',
  );
  await assert.rejects(
    () => executor.execute(inspectIntent, {
      ...receipt(inspectIntent),
      toolRef: 'memory.compare',
      capabilityRef: 'memory.compare',
    }),
    (error: unknown) => error instanceof ExplicitBrainMemoryToolError
      && error.code === 'invalid-admission-receipt',
  );
});

test('bug owner resolution is exactly one and duplicate source facts map to one stable submission', () => {
  assert.equal(resolveBugOwner({
    componentRef: 'runtime',
    owners: [{ componentRef: 'runtime', ownerRef: 'owner-a', active: true }],
  }).ownerRef, 'owner-a');
  assert.throws(() => resolveBugOwner({
    componentRef: 'runtime',
    owners: [
      { componentRef: 'runtime', ownerRef: 'owner-a', active: true },
      { componentRef: 'runtime', ownerRef: 'owner-b', active: true },
    ],
  }), /multiple active owners/);
  const first = stableBugSubmissionId({ contractVersion: 'bug-report@1', scopeRef: 'scope:organ-a', sourceFactRef: 'fact:a' });
  const second = stableBugSubmissionId({ contractVersion: 'bug-report@1', scopeRef: 'scope:organ-a', sourceFactRef: 'fact:a' });
  assert.equal(first, second);
});

test('bug report execution records admitted tool and execution facts through the framework executor', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:executor-bug',
    submissionId: 'model-supplied-key-is-not-authoritative',
    observedResultRef: 'observed:executor-bug',
    expectedResultRef: 'expected:executor-bug',
    reproductionRefs: ['repro:executor-bug'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'executor bug report',
    correlationRef: 'correlation:executor-bug',
  };
  const traces = new DecisionTraceStore();
  const executor = new ExplicitBrainDecisionExecutor<BugReportArguments>({
    registry: createExplicitBrainToolRegistry(capabilityDigest),
    binding: binding(),
    traces,
    handler: {
      async execute(intent, receipt) {
        assert.equal(intent.toolRef, 'bug.report');
        assert.equal(receipt.bindingRef, 'binding-explicit-brain');
        assert.equal(receipt.executionEpoch, 4);
        return {
          value: intent.arguments as unknown as BugReportArguments,
          trace: {
            effectRefs: ['bug:executor-bug'],
            resultRef: 'bug:executor-bug',
            stateTransitionRef: 'created',
            finalReceiptRef: 'receipt:executor-bug',
          },
        };
      },
    },
    context: {
      scopeRef: 'scope:organ-a',
      runtimeBindingRef: 'binding-explicit-brain',
      ownerRef: 'bug-intake-owner',
      createdAt: '2026-09-17T00:00:00.000Z',
      inputDigest: 'sha256:executor-bug-input',
      argumentsRef: (toolIntent) => `arguments:${toolIntent.toolIntentId}`,
      bugRef: 'bug:executor-bug',
    },
    currentEpoch: 4,
    currentPermissionRevision: 'permission-r1',
    argumentsDigest: digestArguments,
  });
  const [result] = await executor.execute({
    decisionId: 'decision-bug-report',
    interactionId: 'interaction-bug-report',
    kind: 'intent',
    selectedAction: 'report-bug',
    summary: 'report a durable bug source fact',
    evidenceRefs: [report.sourceFactRef],
    toolIntents: [{
      toolIntentId: 'intent:bug-report',
      toolRef: 'bug.report',
      arguments: report as unknown as Readonly<Record<string, unknown>>,
      argumentsDigest: argumentsDigest(report as unknown as Readonly<Record<string, unknown>>),
      reasonRefs: [report.sourceFactRef],
      selectedBecause: 'bug source fact was observed',
    }],
  });
  assert.equal(result?.result.sourceFactRef, report.sourceFactRef);
  assert.equal(result?.trace.tool?.bindingRef, 'binding-explicit-brain');
  assert.equal(result?.trace.tool?.capabilityDigest, capabilityDigest);
  assert.equal(result?.trace.tool?.permissionRevision, 'permission-r1');
  assert.equal(result?.trace.tool?.executionEpoch, 4);
  assert.equal(result?.trace.execution?.admission, 'accepted');
  assert.deepEqual(result?.trace.execution?.effectRefs, ['bug:executor-bug']);
  assert.equal(result?.trace.execution?.finalReceiptRef, 'receipt:executor-bug');
  assert.equal(traces.query({ bugRef: 'bug:executor-bug', admission: 'accepted' }).length, 1);
});

test('bug intake keeps unassigned git-bug records when owner resolution fails and idempotent notifications', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:bug-a',
    submissionId: 'model-supplied-key-is-not-authoritative',
    observedResultRef: 'observed:a',
    expectedResultRef: 'expected:a',
    reproductionRefs: ['repro:a'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'runtime failure',
    correlationRef: 'correlation:a',
  };
  const intents = new Map<string, { readonly operationRef: string; readonly submissionId: string; readonly kind: 'create' | 'assign' | 'notify-owner' | 'notify-reporter' | 'transition'; readonly idempotencyKey: string }>();
  const external = new Map<string, {
    readonly operationRef: string;
    readonly consumerKey: string;
    readonly messageId: string;
    readonly state: 'settled' | 'reconciled' | 'failed' | 'unknown';
  }>();
  const ledger: BugIntakeLedgerPort = {
    async commitOperationIntent(input) {
      const existing = intents.get(input.operationRef);
      if (existing) return existing;
      intents.set(input.operationRef, input);
      external.set(input.operationRef, { operationRef: input.operationRef, consumerKey: 'bug-intake', messageId: 'message-a', state: 'settled' });
      return input;
    },
    async readOperationIntent(ref) { return intents.get(ref) ?? null; },
    async settleOperation(input) {
      const intent = intents.get(input.operationRef);
      if (!intent) throw new Error(`missing operation intent: ${input.operationRef}`);
      const record = {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-a',
        state: input.state,
      };
      external.set(input.operationRef, record);
      return record;
    },
    async readExternalOperation(input) {
      const found = external.get(input.operationRef);
      return found && found.consumerKey === input.consumerKey && found.messageId === input.messageId ? found : null;
    },
  };
  const gitBug: GitBugPort = {
    async create(input) {
      return { bugId: 'bug-a', revision: 'rev-1', created: input.submissionId === 'bug-report@1:scope:organ-a:fact:bug-a' };
    },
    async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
    async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
  };
  const notifications: NotificationPort = {
    async notify(input) {
      return { state: input.kind === 'owner' ? 'duplicate' : 'sent' };
    },
  };
  let attentionCount = 0;
  const result = await reportBug(report, {
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:a',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [
      { componentRef: 'runtime', ownerRef: 'owner-a', active: true },
      { componentRef: 'runtime', ownerRef: 'owner-b', active: true },
    ],
    ledger,
    gitBug,
    notifications,
    async createAttention(input) {
      attentionCount += 1;
      assert.equal(input.kind, 'owner-resolution');
      assert.equal(input.bugId, 'bug-a');
      assert.equal(input.ownerRef, 'bug-routing-owner');
      return 'attention:owner-resolution';
    },
  });
  assert.equal(result.bug.state, 'created');
  assert.equal(result.bug.ownerRef, undefined);
  assert.equal(result.ownerResolutionAttention, 'attention:owner-resolution');
  assert.equal(result.reporterNotification?.state, 'sent');
  assert.equal(attentionCount, 1);
  assert.deepEqual([...intents.keys()], [
    'bug-report@1:scope:organ-a:fact:bug-a:create',
    'bug-report@1:scope:organ-a:fact:bug-a:notify-reporter',
  ]);
  assert.deepEqual([...external.values()].map((operation) => operation.state), ['settled', 'settled']);
});

test('reporter notification failure preserves git-bug state and creates an independent attention', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:notification-failure',
    submissionId: 'ignored',
    observedResultRef: 'observed:a',
    expectedResultRef: 'expected:a',
    reproductionRefs: ['repro:a'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'reporter was not notified',
    correlationRef: 'correlation:a',
  };
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const external = new Map<string, { readonly operationRef: string; readonly consumerKey: string; readonly messageId: string; readonly state: 'settled' | 'reconciled' | 'failed' | 'unknown' }>();
  const ledger: BugIntakeLedgerPort = {
    async commitOperationIntent(input) {
      const existing = intents.get(input.operationRef);
      if (existing) return existing;
      intents.set(input.operationRef, input);
      return input;
    },
    async readOperationIntent(ref) { return intents.get(ref) ?? null; },
    async settleOperation(input) {
      const record = {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-notification',
        state: input.state,
      };
      external.set(input.operationRef, record);
      return record;
    },
    async readExternalOperation(input) {
      const found = external.get(input.operationRef);
      return found && found.consumerKey === input.consumerKey && found.messageId === input.messageId ? found : null;
    },
  };
  const attentions: string[] = [];
  const result = await reportBug(report, {
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:a',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [{ componentRef: 'runtime', ownerRef: 'owner-a', active: true }],
    ledger,
    gitBug: {
      async create() { return { bugId: 'bug-notify', revision: 'rev-1', created: true }; },
      async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
      async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
    },
    notifications: {
      async notify(input) {
        return { state: input.kind === 'reporter' ? 'failed' : 'sent' };
      },
    },
    async createAttention(input) {
      attentions.push(`${input.kind}:${input.operationRef ?? 'none'}`);
      return `attention:${input.kind}`;
    },
  });
  assert.equal(result.bug.state, 'assigned');
  assert.equal(result.reporterNotification?.state, 'failed');
  assert.equal(result.notificationAttention, 'attention:notification-failure');
  assert.deepEqual(attentions, ['notification-failure:bug-report@1:scope:organ-a:fact:notification-failure:notify-reporter']);
  assert.deepEqual(result.notificationAttentionRefs, ['attention:notification-failure']);
  assert.equal(external.get('bug-report@1:scope:organ-a:fact:notification-failure:notify-reporter')?.state, 'failed');
});

test('both owner and reporter notification failures keep independent attention refs', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:dual-notification-failure',
    submissionId: 'ignored',
    observedResultRef: 'observed:a',
    expectedResultRef: 'expected:a',
    reproductionRefs: ['repro:a'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'both notifications failed',
    correlationRef: 'correlation:a',
  };
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const external = new Map<string, { readonly operationRef: string; readonly consumerKey: string; readonly messageId: string; readonly state: 'settled' | 'reconciled' | 'failed' | 'unknown' }>();
  const ledger: BugIntakeLedgerPort = {
    async commitOperationIntent(input) { intents.set(input.operationRef, input); return input; },
    async readOperationIntent(ref) { return intents.get(ref) ?? null; },
    async settleOperation(input) {
      const record = {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-dual-notification',
        state: input.state,
      };
      external.set(input.operationRef, record);
      return record;
    },
    async readExternalOperation(input) {
      const found = external.get(input.operationRef);
      return found && found.consumerKey === input.consumerKey && found.messageId === input.messageId ? found : null;
    },
  };
  const attentions: string[] = [];
  const result = await reportBug(report, {
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:a',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [{ componentRef: 'runtime', ownerRef: 'owner-a', active: true }],
    ledger,
    gitBug: {
      async create() { return { bugId: 'bug-dual-notify', revision: 'rev-1', created: true }; },
      async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
      async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
    },
    notifications: {
      async notify() { return { state: 'failed' as const }; },
    },
    async createAttention(input) {
      const ref = `attention:${input.kind}:${input.recipientRef}`;
      attentions.push(ref);
      return ref;
    },
  });
  assert.deepEqual(result.notificationAttentionRefs, [
    'attention:notification-failure:owner-a',
    'attention:notification-failure:reporter:a',
  ]);
  assert.equal(result.ownerNotification?.attentionRef, 'attention:notification-failure:owner-a');
  assert.equal(result.reporterNotification?.attentionRef, 'attention:notification-failure:reporter:a');
  assert.deepEqual(attentions, result.notificationAttentionRefs);
});

test('notification waiting remains pending instead of being settled as delivered', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:notification-waiting',
    submissionId: 'ignored',
    observedResultRef: 'observed:a',
    expectedResultRef: 'expected:a',
    reproductionRefs: ['repro:a'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'notification waiting',
    correlationRef: 'correlation:a',
  };
  const external = new Map<string, { readonly operationRef: string; readonly consumerKey: string; readonly messageId: string; readonly state: 'pending' | 'settled' | 'reconciled' | 'failed' | 'unknown' }>();
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const ledger: BugIntakeLedgerPort = {
    async commitOperationIntent(input) { intents.set(input.operationRef, input); return input; },
    async readOperationIntent(ref) { return intents.get(ref) ?? null; },
    async settleOperation(input) {
      const record = {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-waiting',
        state: input.state,
      };
      external.set(input.operationRef, record);
      return record;
    },
    async readExternalOperation(input) {
      const found = external.get(input.operationRef);
      return found && found.consumerKey === input.consumerKey && found.messageId === input.messageId ? found : null;
    },
  };
  const result = await reportBug(report, {
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:a',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [{ componentRef: 'runtime', ownerRef: 'owner-a', active: true }],
    ledger,
    gitBug: {
      async create() { return { bugId: 'bug-waiting', revision: 'rev-1', created: true }; },
      async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
      async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
    },
    notifications: {
      async notify(input) { return { state: input.kind === 'reporter' ? 'waiting' : 'sent' }; },
    },
    async createAttention() { return 'attention:notification-failure'; },
  });
  assert.equal(result.reporterNotification?.state, 'waiting');
  assert.equal(external.has('bug-report@1:scope:organ-a:fact:notification-waiting:notify-reporter'), false);
  assert.equal(result.notificationAttention, 'attention:notification-failure');
});

test('bug barrier precommit follows owner resolution instead of active owner presence', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:barrier-owner-resolution',
    submissionId: 'ignored',
    observedResultRef: 'observed:a',
    expectedResultRef: 'expected:a',
    reproductionRefs: ['repro:a'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'owner resolution is ambiguous',
    correlationRef: 'correlation:a',
  };
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const sourceFacts = new Map<string, BugReportArguments>();
  const ledger: BugIntakeLedgerPort = {
    async commitOperationIntent(input) {
      intents.set(input.operationRef, input);
      return input;
    },
    async readOperationIntent(ref) { return intents.get(ref) ?? null; },
    async commitSourceFact(input) { sourceFacts.set(input.submissionId, input.report); },
    async readSourceFact(input) { return sourceFacts.get(input.submissionId) ?? null; },
    async settleOperation(input) {
      return {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-owner-resolution',
        state: input.state,
      };
    },
    async readExternalOperation() { return null; },
  };
  const driver = bugReportBarrierDriver({
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:a',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [
      { componentRef: 'runtime', ownerRef: 'owner-a', active: true },
      { componentRef: 'runtime', ownerRef: 'owner-b', active: true },
    ],
    ledger,
    gitBug: {
      async create() { return { bugId: 'bug-owner-resolution', revision: 'rev-1', created: true }; },
      async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
      async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
    },
    notifications: {
      async notify() { return { state: 'sent' as const }; },
    },
    async createAttention() { return 'attention:owner-resolution'; },
  });
  const prepared = await driver.prepare({
    event: {
      messageId: 'message-owner-resolution',
      streamId: 'stream-bug',
      class: 'data',
      scope: { organId: organId },
      occurredAt: '2026-09-17T00:00:00.000Z',
      summary: 'bug report',
      payload: { report: report as unknown as Record<string, never> },
      evidenceRefs: [],
      publisherId: 'publisher-harness',
      sequence: 1,
      committedAt: '2026-09-17T00:00:00.000Z',
    },
    attempt: 1,
  });
  assert.ok('completionMode' in prepared);
  if (!('completionMode' in prepared) || prepared.completionMode !== 'operation-barrier') {
    throw new Error('operation barrier expected');
  }
  assert.deepEqual(prepared.externalOperationRefs, [
    'bug-report@1:scope:organ-a:fact:barrier-owner-resolution:create',
    'bug-report@1:scope:organ-a:fact:barrier-owner-resolution:notify-reporter',
  ]);
});

test('bug barrier recovery reconciles persisted source facts and intents before receipt and cursor', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:barrier-recovery',
    submissionId: 'ignored',
    observedResultRef: 'observed:barrier-recovery',
    expectedResultRef: 'expected:barrier-recovery',
    reproductionRefs: ['repro:barrier-recovery'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'interrupted bug intake',
    correlationRef: 'correlation:barrier-recovery',
  };
  const submissionId = stableBugSubmissionId({
    contractVersion: 'bug-report@1',
    scopeRef: 'scope:organ-a',
    sourceFactRef: report.sourceFactRef,
  });
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const external = new Map<string, { readonly operationRef: string; readonly consumerKey: string; readonly messageId: string; readonly state: 'pending' | 'settled' | 'reconciled' | 'failed' | 'unknown' }>();
  const sourceFacts = new Map<string, BugReportArguments>();
  const order: string[] = [];
  let failExecute = true;
  let bugCreates = 0;
  let ownerNotifications = 0;
  let reporterNotifications = 0;
  const ledger: BugIntakeLedgerPort = {
    async commitSourceFact(input) {
      order.push('source-fact');
      sourceFacts.set(input.submissionId, input.report);
    },
    async readSourceFact(input) {
      order.push('read-source-fact');
      return sourceFacts.get(input.submissionId) ?? null;
    },
    async commitOperationIntent(input) {
      order.push(`intent:${input.kind}`);
      intents.set(input.operationRef, input);
      if (!external.has(input.operationRef)) {
        external.set(input.operationRef, {
          operationRef: input.operationRef,
          consumerKey: 'bug-intake',
          messageId: 'message-barrier-recovery',
          state: 'pending',
        });
      }
      return input;
    },
    async readOperationIntent(ref) {
      order.push(`read-intent:${intents.get(ref)?.kind ?? 'missing'}`);
      return intents.get(ref) ?? null;
    },
    async settleOperation(input) {
      order.push(`settle:${input.state}`);
      const record = {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-barrier-recovery',
        state: input.state,
      };
      external.set(input.operationRef, record);
      return record;
    },
    async readExternalOperation(input) {
      const found = external.get(input.operationRef);
      return found && found.consumerKey === input.consumerKey && found.messageId === input.messageId ? found : null;
    },
  };
  const driver = bugReportBarrierDriver({
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:barrier-recovery',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [{ componentRef: 'runtime', ownerRef: 'owner-a', active: true }],
    ledger,
    recovery: {
      async reconcile(input) {
        order.push(`reconcile:${input.kind}`);
        const state = input.kind === 'notify-reporter' ? 'reconciled' : 'settled';
        const record = {
          operationRef: input.operationRef,
          consumerKey: 'bug-intake',
          messageId: 'message-barrier-recovery',
          state,
        } as const;
        external.set(input.operationRef, record);
        return record;
      },
    },
    gitBug: {
      async create() {
        bugCreates += 1;
        if (failExecute) throw new Error('interrupted after source fact and intents');
        return { bugId: 'bug-barrier-recovery', revision: 'rev-1', created: true };
      },
      async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
      async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
    },
    notifications: {
      async notify(input) {
        if (input.kind === 'owner') ownerNotifications += 1;
        else reporterNotifications += 1;
        return { state: 'sent' as const };
      },
    },
    async createAttention() { return 'attention:bug-barrier-recovery'; },
  });
  const delivery = {
    event: {
      messageId: 'message-barrier-recovery',
      streamId: 'stream-bug',
      class: 'data' as const,
      scope: { organId: organId },
      occurredAt: '2026-09-17T00:00:00.000Z',
      summary: 'bug report',
      payload: { report: report as unknown as Record<string, never> },
      evidenceRefs: [],
      publisherId: 'publisher-harness',
      sequence: 1,
      committedAt: '2026-09-17T00:00:00.000Z',
    },
    attempt: 1,
  };
  const prepared = await driver.prepare(delivery);
  assert.ok('completionMode' in prepared);
  if (!('completionMode' in prepared) || prepared.completionMode !== 'operation-barrier') {
    throw new Error('operation barrier expected');
  }
  assert.deepEqual([...intents.keys()], [
    `${submissionId}:create`,
    `${submissionId}:assign`,
    `${submissionId}:notify-owner`,
    `${submissionId}:notify-reporter`,
  ]);
  assert.equal(external.get(`${submissionId}:create`)?.state, 'pending');
  assert.equal(bugCreates, 0);
  assert.equal(ownerNotifications, 0);
  assert.equal(reporterNotifications, 0);

  await assert.rejects(
    () => driver.execute(delivery, {
      ...prepared,
      completionMode: 'operation-barrier',
    }),
    /interrupted after source fact and intents/,
  );
  assert.equal(bugCreates, 1);
  assert.equal(order.filter((entry) => entry === 'source-fact').length, 1);

  failExecute = false;
  await driver.recover?.(delivery, {
    ...prepared,
    completionMode: 'operation-barrier',
  });
  assert.deepEqual([...external.keys()].map((ref) => external.get(ref)?.state), [
    'settled',
    'settled',
    'settled',
    'reconciled',
  ]);
  assert.equal(bugCreates, 1);
  assert.equal(ownerNotifications, 0);
  assert.equal(reporterNotifications, 0);
  assert.ok(order.indexOf('source-fact') < order.indexOf('reconcile:create'));
  assert.ok(order.indexOf('read-source-fact') < order.indexOf('reconcile:create'));
  assert.ok(order.indexOf('read-intent:create') < order.indexOf('reconcile:create'));
  assert.equal(order.at(-1), 'reconcile:notify-reporter');
});

test('bug barrier driver isolates prepared state across interleaved deliveries', async () => {
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const sourceFacts = new Map<string, BugReportArguments>();
  const createdSources: string[] = [];
  const ledger: BugIntakeLedgerPort = {
    async commitOperationIntent(input) {
      intents.set(input.operationRef, input);
      return input;
    },
    async readOperationIntent(ref) { return intents.get(ref) ?? null; },
    async commitSourceFact(input) { sourceFacts.set(input.submissionId, input.report); },
    async readSourceFact(input) { return sourceFacts.get(input.submissionId) ?? null; },
    async settleOperation(input) {
      return {
        operationRef: input.operationRef,
        consumerKey: 'bug-intake',
        messageId: 'message-interleaved',
        state: input.state,
      };
    },
    async readExternalOperation() { return null; },
  };
  const driver = bugReportBarrierDriver({
    consumerKey: 'bug-intake',
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:a',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [],
    ledger,
    gitBug: {
      async create(input) {
        createdSources.push(input.sourceFactRef);
        return { bugId: `bug:${input.sourceFactRef}`, revision: 'rev-1', created: true };
      },
      async assign(input) { return { bugId: input.bugId, revision: 'rev-2', assigned: true }; },
      async transition(input) { return { bugId: input.bugId, revision: 'rev-3', transitioned: true }; },
    },
    notifications: {
      async notify() { return { state: 'sent' as const }; },
    },
    async createAttention() { return 'attention:interleaved'; },
  });
  const delivery = (messageId: string, sourceFactRef: string) => ({
    event: {
      messageId,
      streamId: 'stream-bug',
      class: 'data' as const,
      scope: { organId: organId },
      occurredAt: '2026-09-17T00:00:00.000Z',
      summary: 'bug report',
      payload: {
        report: {
          sourceFactRef,
          submissionId: 'ignored',
          observedResultRef: `observed:${sourceFactRef}`,
          expectedResultRef: `expected:${sourceFactRef}`,
          reproductionRefs: [`repro:${sourceFactRef}`],
          severityProposal: 'high' as const,
          impactProposal: 'interleaved delivery',
          correlationRef: `correlation:${sourceFactRef}`,
        } as unknown as Record<string, never>,
      },
      evidenceRefs: [],
      publisherId: 'publisher-harness',
      sequence: 1,
      committedAt: '2026-09-17T00:00:00.000Z',
    },
    attempt: 1,
  });
  const firstDelivery = delivery('message-interleaved-a', 'fact:a');
  const secondDelivery = delivery('message-interleaved-b', 'fact:b');
  const first = await driver.prepare(firstDelivery);
  const second = await driver.prepare(secondDelivery);
  if (!('completionMode' in first) || !('completionMode' in second)) throw new Error('operation barrier expected');
  const firstBarrier = first as Extract<EventHandlerCommit, { completionMode: 'operation-barrier' }>;
  const secondBarrier = second as Extract<EventHandlerCommit, { completionMode: 'operation-barrier' }>;

  await driver.execute(firstDelivery, firstBarrier);
  await driver.execute(secondDelivery, secondBarrier);

  assert.deepEqual(createdSources, ['fact:a', 'fact:b']);
});

test('EventBus bug barrier commits receipt and cursor only after recovery reconciles external operations', async () => {
  const report: BugReportArguments = {
    sourceFactRef: 'fact:eventbus-barrier',
    submissionId: 'ignored',
    observedResultRef: 'observed:eventbus-barrier',
    expectedResultRef: 'expected:eventbus-barrier',
    reproductionRefs: ['repro:eventbus-barrier'],
    componentHint: 'runtime',
    severityProposal: 'high',
    impactProposal: 'eventbus barrier recovery',
    correlationRef: 'correlation:eventbus-barrier',
  };
  const consumerKey = 'bug-intake|scope:organ-a|bug-report@1';
  const messageId = 'message-eventbus-barrier';
  const streamId = 'stream-bug';
  const occurredAt = '2026-09-17T00:00:00.000Z';
  const publisher: TrustedEventPublisher = {
    publisherId: 'publisher-harness',
    kind: 'harness',
    ownerId: 'harness-owner',
    scope: { organId },
    allowedClasses: ['data'],
    capabilities: [],
  };
  const consumer: EventConsumerBinding = {
    consumerKey,
    consumerOwner: 'bug-intake-owner',
    scopeRef: 'scope:organ-a',
    contractVersion: 'bug-report@1',
    scope: { organId },
    streamIds: [streamId],
    allowedClasses: ['data'],
    retryLimit: 2,
    currentEpoch: 4,
  };
  const sourceFacts = new Map<string, BugReportArguments>();
  const intents = new Map<string, Parameters<BugIntakeLedgerPort['commitOperationIntent']>[0]>();
  const external = new Map<string, EventExternalOperation>();
  const order: string[] = [];
  let createCalls = 0;
  let assignCalls = 0;
  let ownerNotifications = 0;
  let reporterNotifications = 0;
  let failCreate = true;
  const ledger: BugIntakeLedgerPort = {
    async commitSourceFact(input) {
      order.push('source-fact');
      sourceFacts.set(input.submissionId, input.report);
    },
    async readSourceFact(input) {
      order.push('read-source-fact');
      return sourceFacts.get(input.submissionId) ?? null;
    },
    async commitOperationIntent(input) {
      order.push(`intent:${input.kind}`);
      intents.set(input.operationRef, input);
      if (!external.has(input.operationRef)) {
        external.set(input.operationRef, {
          operationRef: input.operationRef,
          consumerKey,
          messageId,
          state: 'pending',
        });
      }
      return input;
    },
    async readOperationIntent(ref) {
      order.push(`read-intent:${intents.get(ref)?.kind ?? 'missing'}`);
      return intents.get(ref) ?? null;
    },
    async settleOperation(input) {
      order.push(`settle:${input.state}`);
      const record: EventExternalOperation = {
        operationRef: input.operationRef,
        consumerKey,
        messageId,
        state: input.state,
      };
      external.set(input.operationRef, record);
      return record;
    },
    async readExternalOperation(input) {
      const record = external.get(input.operationRef);
      return record?.consumerKey === input.consumerKey && record.messageId === input.messageId
        ? record
        : null;
    },
  };
  const driver = bugReportBarrierDriver({
    consumerKey,
    scopeRef: 'scope:organ-a',
    reporterRef: 'reporter:eventbus-barrier',
    bugRoutingOwnerRef: 'bug-routing-owner',
    ownerRegistry: [{ componentRef: 'runtime', ownerRef: 'owner-a', active: true }],
    ledger,
    recovery: {
      async reconcile(input) {
        order.push(`reconcile:${input.kind}`);
        const record: EventExternalOperation = {
          operationRef: input.operationRef,
          consumerKey,
          messageId,
          state: input.kind === 'notify-reporter' ? 'reconciled' : 'settled',
        };
        external.set(input.operationRef, record);
        return record;
      },
    },
    gitBug: {
      async create() {
        createCalls += 1;
        if (failCreate) throw new Error('eventbus interrupted after barrier intent');
        return { bugId: 'bug-eventbus-barrier', revision: 'rev-1', created: true };
      },
      async assign(input) {
        assignCalls += 1;
        return { bugId: input.bugId, revision: 'rev-2', assigned: true };
      },
      async transition(input) {
        return { bugId: input.bugId, revision: 'rev-3', transitioned: true };
      },
    },
    notifications: {
      async notify(input) {
        if (input.kind === 'owner') ownerNotifications += 1;
        else reporterNotifications += 1;
        return { state: 'sent' as const };
      },
    },
    async createAttention() { return 'attention:eventbus-barrier'; },
  });
  class Journal implements EventJournalPort, EventExternalOperationPort {
    events: EventRecord[] = [];
    receipts = new Map<string, EventConsumerReceipt>();
    cursors = new Map<string, NonNullable<Awaited<ReturnType<EventJournalPort['readCursor']>>>>();
    retries = new Map<string, EventRetryObligation>();
    dlq = new Map<string, NonNullable<Awaited<ReturnType<EventJournalPort['readDlq']>>>>();
    barrierIntents = new Map<string, NonNullable<Awaited<ReturnType<EventBusPorts['barrierIntents']['readBarrierIntent']>>>>();

    async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
      const record: EventRecord = {
        ...input.event,
        publisherId: input.publisherId,
        sequence: this.events.filter((candidate) => candidate.streamId === input.event.streamId).length + 1,
        committedAt: occurredAt,
      };
      this.events.push(record);
      return record;
    }
    async readEvents(input: { readonly streamId: string; readonly afterSequence: number; readonly limit: number }) {
      return this.events
        .filter((candidate) => candidate.streamId === input.streamId && candidate.sequence > input.afterSequence)
        .slice(0, input.limit);
    }
    async readEvent(input: { readonly streamId: string; readonly messageId: string }) {
      return this.events.find((candidate) => candidate.streamId === input.streamId && candidate.messageId === input.messageId) ?? null;
    }
    async readCursor(input: { readonly streamId: string; readonly consumerKey: string }) {
      return this.cursors.get(`${input.streamId}:${input.consumerKey}`) ?? null;
    }
    async commitConsumerCommit(input: ConsumerCommitRequest) {
      order.push('commit-receipt-cursor');
      const key = `${input.receipt.consumerKey}:${input.receipt.messageId}`;
      const existing = this.receipts.get(key);
      if (existing) return { receipt: existing, cursor: this.cursors.get(`${input.cursor.streamId}:${input.cursor.consumerKey}`) ?? input.cursor };
      this.receipts.set(key, input.receipt);
      this.cursors.set(`${input.cursor.streamId}:${input.cursor.consumerKey}`, input.cursor);
      return { receipt: input.receipt, cursor: input.cursor };
    }
    async readReceipt(input: { readonly consumerKey: string; readonly messageId: string }) {
      return this.receipts.get(`${input.consumerKey}:${input.messageId}`) ?? null;
    }
    async commitRetryObligation(obligation: EventRetryObligation) {
      this.retries.set(obligation.retryKey, obligation);
      return obligation;
    }
    async readRetryObligation() { return null; }
    async listPendingRetryObligations() { return []; }
    async commitDlq(record: NonNullable<Awaited<ReturnType<EventJournalPort['readDlq']>>>) {
      this.dlq.set(record.retryKey, record);
      return record;
    }
    async readDlq() { return null; }
    async readExternalOperation(input: {
      readonly operationRef: string;
      readonly consumerKey: string;
      readonly messageId: string;
    }) {
      const record = external.get(input.operationRef);
      return record?.consumerKey === input.consumerKey && record.messageId === input.messageId ? record : null;
    }
    async commitBarrierIntent(input: NonNullable<Awaited<ReturnType<EventBusPorts['barrierIntents']['commitBarrierIntent']>>>) {
      order.push('barrier-intent');
      const key = `${input.streamId}:${input.consumerKey}:${input.messageId}`;
      const existing = this.barrierIntents.get(key);
      if (existing) return existing;
      this.barrierIntents.set(key, input);
      return input;
    }
    async readBarrierIntent(input: { readonly consumerKey: string; readonly messageId: string; readonly streamId: string }) {
      return this.barrierIntents.get(`${input.streamId}:${input.consumerKey}:${input.messageId}`) ?? null;
    }
  }
  class Registry implements EventPublisherRegistryPort, EventConsumerRegistryPort {
    async resolvePublisher(publisherId: string) { return publisherId === publisher.publisherId ? publisher : null; }
    async resolveConsumer(consumerKeyValue: string) { return consumerKeyValue === consumer.consumerKey ? consumer : null; }
  }
  const journal = new Journal();
  const registry = new Registry();
  const bus: EventBusPorts = {
    journal,
    publishers: registry,
    consumers: registry,
    externalOperations: journal,
    barrierIntents: journal,
  };
  await publishEvent(bus, {
    publisherId: publisher.publisherId,
    event: {
      messageId,
      streamId,
      class: 'data',
      scope: { organId },
      occurredAt,
      summary: 'bug report',
      payload: { report: report as unknown as Record<string, never> },
      evidenceRefs: [],
      executionEpoch: 4,
    },
  });

  await assert.rejects(
    () => consumeEvents(
      bus,
      { consumerKey, limit: 10, now: occurredAt },
      async () => { throw new Error('bug barrier driver owns delivery'); },
      driver,
    ),
    /eventbus interrupted after barrier intent/,
  );
  assert.equal(journal.barrierIntents.size, 1);
  assert.equal(journal.receipts.size, 0);
  assert.equal(journal.cursors.size, 0);
  assert.equal(sourceFacts.size, 1);
  assert.equal(intents.size, 4);
  assert.equal(createCalls, 1);
  assert.equal(assignCalls, 0);
  assert.equal(ownerNotifications, 0);
  assert.equal(reporterNotifications, 0);
  assert.ok(order.indexOf('source-fact') < order.indexOf('barrier-intent'));

  failCreate = false;
  const recovered = await consumeEvents(
    bus,
    { consumerKey, limit: 10, now: occurredAt },
    async () => { throw new Error('bug barrier recovery must not invoke legacy handler'); },
    driver,
  );
  assert.equal(recovered.committed.length, 1);
  assert.equal(recovered.committed[0]?.disposition, 'applied');
  assert.deepEqual(recovered.committed[0]?.effectRefs, [
    `submission:${stableBugSubmissionId({ contractVersion: 'bug-report@1', scopeRef: 'scope:organ-a', sourceFactRef: report.sourceFactRef })}`,
    ...intents.keys(),
  ]);
  assert.equal(recovered.cursors.length, 1);
  assert.equal(journal.receipts.size, 1);
  assert.equal(journal.cursors.size, 1);
  assert.equal(createCalls, 1);
  assert.equal(assignCalls, 0);
  assert.equal(ownerNotifications, 0);
  assert.equal(reporterNotifications, 0);
  assert.deepEqual([...external.values()].map((record) => record.state), [
    'settled',
    'settled',
    'settled',
    'reconciled',
  ]);
  assert.ok(order.indexOf('read-source-fact') < order.indexOf('commit-receipt-cursor'));
  assert.ok(order.indexOf('reconcile:notify-reporter') < order.indexOf('commit-receipt-cursor'));
  assert.equal(order.at(-1), 'commit-receipt-cursor');
});

test('Attention actions use real timestamps and notification failure creates a linked Attention', async () => {
  const owner = new AttentionTriageOwner();
  const triage = owner.triage({
    sourceRef: 'source:notify-failure',
    kind: 'operation-failure',
    impact: 'high',
    urgency: 'high',
    blocking: 'task',
    userDecisionRequired: false,
    affectedRefs: ['operation:notify-failure'],
    evidenceRefs: [evidence('notify-failure')],
    reasonRefs: ['failure:notify-failure'],
    proposedNextAction: 'notify',
  }, {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:notify-failure',
  });
  const failed = await owner.notify({
    attentionId: triage.attentionId,
    recipientRef: 'human:a',
    messageRef: 'message:notify-failure',
    notificationId: 'notification:notify-failure',
    context: {
      actorId: 'runtime-operation-owner',
      runtimeBindingRef: 'binding-explicit-brain',
      createdAt: '2026-09-17T00:06:00.000Z',
      inputDigest: 'sha256:notify-failure',
    },
    port: {
      async notify() { return { state: 'failed' as const }; },
    },
  });
  assert.equal(failed.trace.semantic.createdAt, '2026-09-17T00:06:00.000Z');
  assert.equal(failed.trace.execution?.settlement.state, 'failed');
  assert.equal(failed.trace.execution?.failureRef, 'attention:2');
  const notificationAttention = owner.inspect('attention:2');
  assert.ok(notificationAttention);
  assert.equal(notificationAttention.issue.originalErrorRef, 'notification:notify-failure');
  assert.equal(notificationAttention.issue.ownerId, 'runtime-operation-owner');
  assert.deepEqual(owner.projection('attention:2')?.evidenceRefs, [evidence('notify-failure')]);
});

test('Attention projection keeps authoritative scope when owner is not the organ', () => {
  const owner = new AttentionTriageOwner();
  const failureEvidence = evidence('scope');
  const triage = owner.triage({
    sourceRef: 'source:scope',
    kind: 'operation-failure',
    impact: 'medium',
    urgency: 'low',
    blocking: 'local',
    userDecisionRequired: false,
    affectedRefs: ['operation:scope'],
    evidenceRefs: [failureEvidence],
    reasonRefs: ['failure:scope'],
    proposedNextAction: 'recover',
  }, {
    ownerId: 'operator-a',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:scope',
  });

  assert.deepEqual(owner.projection(triage.attentionId)?.scope, { organId });
  assert.deepEqual(owner.projection(triage.attentionId)?.evidenceRefs, [failureEvidence]);
  assert.equal(owner.inspect(triage.attentionId)?.ownerId, 'operator-a');
});

test('Attention keeps derived recovery condition for non-none blocking', () => {
  const owner = new AttentionTriageOwner();
  const triage = owner.triage({
    sourceRef: 'source:waiting',
    kind: 'resource-waiting',
    impact: 'high',
    urgency: 'medium',
    blocking: 'task',
    userDecisionRequired: false,
    affectedRefs: ['task:waiting'],
    evidenceRefs: [evidence('resource-waiting')],
    reasonRefs: ['resource:unavailable'],
    proposedNextAction: 'wait',
  }, {
    ownerId: 'runtime-operation-owner',
    runtimeBindingRef: 'binding-explicit-brain',
    scopeRef: 'scope:organ-a',
    scope: { organId },
    createdAt: '2026-09-17T00:00:00.000Z',
    inputDigest: 'sha256:waiting',
  });

  const issue = owner.inspect(triage.attentionId);
  assert.equal(issue?.issue.state, 'waiting');
  assert.equal(issue?.conditionRef, 'attention-recovery:source:waiting');
  assert.deepEqual(owner.projection(triage.attentionId)?.nextAction, {
    kind: 'wait',
    ref: 'attention-recovery:source:waiting',
  });
});

test('bug actions require current revision and resolution plus validation evidence', async () => {
  const revisions = new Map<string, string>([['bug-a', 'rev-1']]);
  const owner = new BugActionOwner({
    async read(input) {
      const revision = revisions.get(input.bugId);
      return revision ? {
        bugId: input.bugId,
        submissionId: 'submission-a',
        state: 'assigned',
        ownerRef: 'owner-a',
        sourceFactRef: 'fact:a',
        gitBugRevision: revision,
      } : null;
    },
    async proposeUpdate(input) {
      return { bugId: input.bugId, revision: 'rev-proposal', proposedState: input.proposedState, accepted: true };
    },
    async transition(input) {
      revisions.set(input.bugId, 'rev-2');
      return { bugId: input.bugId, revision: 'rev-2', state: input.state, transitioned: true };
    },
  });
  await assert.rejects(
    () => owner.resolve({
      bugId: 'bug-a',
      expectedRevision: 'rev-1',
      resolutionEvidenceRefs: [],
      validationEvidenceRefs: ['validation:a'],
      reason: 'fixed',
    }),
    /resolutionEvidenceRefs cannot be empty/,
  );
  const resolved = await owner.resolve({
    bugId: 'bug-a',
    expectedRevision: 'rev-1',
    resolutionEvidenceRefs: ['resolution:a'],
    validationEvidenceRefs: ['validation:a'],
    reason: 'fixed',
  });
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.gitBugRevision, 'rev-2');
  await assert.rejects(
    () => owner.reopen({
      bugId: 'bug-a',
      expectedRevision: 'rev-1',
      resolutionEvidenceRefs: ['resolution:a'],
      validationEvidenceRefs: ['validation:a'],
      reason: 'regressed',
    }),
    (error: unknown) => error instanceof BugActionError && error.code === 'revision-conflict',
  );
});

test('Decision Trace stores denied and unknown execution outcomes for later query', () => {
  const traces = new DecisionTraceStore();
  const semantic = {
    traceId: 'semantic-denied',
    scopeRef: 'scope:organ-a',
    runtimeBindingRef: 'binding-explicit-brain',
    interactionRef: 'interaction-a',
    decisionKind: 'intent' as const,
    decisionSummary: 'permission denied',
    selectedAction: 'reject' as const,
    evidenceRefs: ['policy:a'],
    inputDigest: 'sha256:input',
    createdAt: '2026-09-17T00:00:00.000Z',
  };
  traces.recordToolDecision({
    semantic,
    tool: {
      traceId: 'tool-denied',
      parentDecisionTraceId: semantic.traceId,
      toolIntentId: 'intent-denied',
      toolRef: 'bug.resolve',
      argumentsRef: 'args:denied',
      argumentsDigest: 'sha256:args',
      reasonRefs: ['policy:a'],
      selectedBecause: 'attempted resolution',
      bindingRef: 'binding-explicit-brain',
      capabilityDigest,
      permissionRevision: 'permission-r1',
      executionEpoch: 4,
      createdAt: '2026-09-17T00:00:00.000Z',
    },
    execution: {
      traceId: 'execution-denied',
      toolIntentId: 'intent-denied',
      admission: 'permission-denied',
      ownerRef: 'admission-owner',
      effectRefs: [],
      eventRefs: [],
      notificationOperationRefs: [],
      failureRef: 'permission-denied',
      settlement: { state: 'failed', completedAt: '2026-09-17T00:00:00.000Z' },
    },
  });
  assert.equal(traces.query({ interactionRef: 'interaction-a', admission: 'permission-denied' }).length, 1);
});
