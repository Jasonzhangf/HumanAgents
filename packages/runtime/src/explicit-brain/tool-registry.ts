import {
  EXPLICIT_BRAIN_FORBIDDEN_TOOLS,
  EXPLICIT_BRAIN_MODEL_TOOLS,
  EXPLICIT_BRAIN_TEMPLATE_REF,
  assertExplicitBrainScope,
  validateAttentionTriage,
  validateBugProposeUpdate,
  validateBugReport,
  validateBugTransition,
  validateMemorySaveCandidateArguments,
  validateSubscriptionRequest,
  validateToolIntent,
  validateTriggerSubmit,
  type AttentionTriageArguments,
  type BugProposeUpdateArguments,
  type BugReportArguments,
  type BugTransitionArguments,
  type ExplicitBrainModelTool,
  type MemorySaveCandidateArguments,
  type RequirementSubmitArguments,
  type SubscriptionRequestArguments,
  type ToolIntent,
  type TriggerSubmitArguments,
} from '../../../contracts/src/index.js';

export class ExplicitBrainAdmissionError extends Error {
  readonly code:
    | 'unregistered-tool'
    | 'runtime-only-capability'
    | 'capability-denied'
    | 'permission-denied'
    | 'scope-mismatch'
    | 'stale-epoch'
    | 'invalid-arguments'
    | 'missing-confirmation'
    | 'invalid-runtime-binding';

  constructor(code: ExplicitBrainAdmissionError['code'], message: string) {
    super(message);
    this.name = 'ExplicitBrainAdmissionError';
    this.code = code;
  }
}

export interface ExplicitBrainCapability {
  readonly capabilityRef: string;
  readonly toolRef: ExplicitBrainModelTool;
  readonly permissionRef: string;
  readonly runtimeOnly: false;
}

export interface ExplicitBrainRuntimeBinding {
  readonly runtimeId: string;
  readonly agentInstanceId: string;
  readonly roleId: string;
  readonly templateRef: string;
  readonly interactionScopeId: string;
  readonly executionEpoch: number;
  readonly permissionRevision: string;
  readonly capabilityDigest: string;
  readonly bindingRef: string;
  readonly scopeRef: string;
  readonly permissions: readonly string[];
  readonly capabilities: readonly string[];
}

export interface ExplicitBrainAdmissionReceipt {
  readonly admitted: true;
  readonly toolRef: ExplicitBrainModelTool;
  readonly capabilityRef: ExplicitBrainModelTool;
  readonly bindingRef: string;
  readonly executionEpoch: number;
  readonly argumentsDigest: string;
}

const TOOL_PERMISSIONS: Readonly<Record<ExplicitBrainModelTool, string>> = {
  'task.query': 'task.read',
  'task.match': 'task.read',
  'runtime.status': 'runtime.read',
  'queue.inspect': 'queue.read',
  'resource.query': 'resource.read',
  'workspace.list': 'workspace.read',
  'file.read': 'workspace.read',
  'file.search': 'workspace.read',
  'agent.query': 'agent.read',
  'agent.message': 'agent.message',
  'bug.query': 'bug.read',
  'bug.inspect': 'bug.read',
  'channel.query': 'channel.read',
  'memory.search': 'memory.read',
  'memory.inspect': 'memory.read',
  'memory.compare': 'memory.read',
  'memory.save_candidate': 'memory.propose',
  'memory.operation.status': 'memory.read',
  'interaction.ask': 'task.propose',
  'interaction.propose': 'task.propose',
  'interaction.approve': 'task.propose',
  'channel.reply': 'channel.reply',
  'channel.notify': 'channel.notify',
  'requirement.submit': 'requirement.submit',
  'trigger.submit': 'trigger.submit',
  'route.submit': 'route.submit',
  'resource.request': 'resource.request',
  'subscription.request': 'subscription.request',
  'attention.list': 'attention.read',
  'attention.inspect': 'attention.read',
  'attention.triage': 'attention.triage',
  'attention.ack': 'attention.ack',
  'attention.defer': 'attention.defer',
  'attention.notify': 'attention.notify',
  'attention.resolve': 'attention.resolve',
  'bug.report': 'bug.report',
  'bug.propose-update': 'bug.propose-update',
  'bug.resolve': 'bug.resolve',
  'bug.reopen': 'bug.reopen',
};

export const EXPLICIT_BRAIN_CAPABILITIES: readonly ExplicitBrainCapability[] = EXPLICIT_BRAIN_MODEL_TOOLS.map((toolRef) => ({
  capabilityRef: toolRef,
  toolRef,
  permissionRef: TOOL_PERMISSIONS[toolRef],
  runtimeOnly: false,
}));

export interface ExplicitBrainToolRegistry {
  readonly templateRef: typeof EXPLICIT_BRAIN_TEMPLATE_REF;
  readonly capabilities: readonly ExplicitBrainCapability[];
  readonly capabilityDigest: string;
}

export function createExplicitBrainToolRegistry(capabilityDigest: string): ExplicitBrainToolRegistry {
  if (!capabilityDigest.trim()) throw new ExplicitBrainAdmissionError('invalid-runtime-binding', 'capability digest is required');
  return {
    templateRef: EXPLICIT_BRAIN_TEMPLATE_REF,
    capabilities: EXPLICIT_BRAIN_CAPABILITIES.map((entry) => ({ ...entry })),
    capabilityDigest,
  };
}

function isForbidden(toolRef: string): boolean {
  return (EXPLICIT_BRAIN_FORBIDDEN_TOOLS as readonly string[]).includes(toolRef);
}

function assertRuntimeBinding(binding: ExplicitBrainRuntimeBinding): void {
  assertExplicitBrainScope({
    runtimeRoleId: binding.roleId,
    runtimeTemplateRef: binding.templateRef,
    interactionScopeId: binding.interactionScopeId,
  });
  if (!Number.isSafeInteger(binding.executionEpoch) || binding.executionEpoch < 1) {
    throw new ExplicitBrainAdmissionError('invalid-runtime-binding', 'execution epoch must be positive');
  }
  if (!binding.permissionRevision.trim() || !binding.capabilityDigest.trim() || !binding.bindingRef.trim()) {
    throw new ExplicitBrainAdmissionError('invalid-runtime-binding', 'runtime binding identity is incomplete');
  }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExplicitBrainAdmissionError('invalid-arguments', `${label} is required`);
  }
  return value;
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new ExplicitBrainAdmissionError('invalid-arguments', `${label} is required`);
  }
}

function assertNoConcreteResource(args: Record<string, unknown>): void {
  for (const forbidden of ['workerId', 'runtimeId', 'providerId', 'leaseId', 'cpu', 'memory']) {
    if (forbidden in args) {
      throw new ExplicitBrainAdmissionError('invalid-arguments', `resource.request cannot specify ${forbidden}`);
    }
  }
}

function validateToolArguments(toolRef: ExplicitBrainModelTool, args: Readonly<Record<string, unknown>>): void {
  if (toolRef === 'attention.ack' || toolRef === 'attention.resolve') {
    assertString(args.attentionId, `${toolRef} attentionId`);
    return;
  }
  if (toolRef === 'attention.defer') {
    assertString(args.attentionId, 'attention.defer attentionId');
    assertString(args.conditionRef, 'attention.defer conditionRef');
    return;
  }
  if (toolRef === 'attention.notify') {
    assertString(args.attentionId, 'attention.notify attentionId');
    assertString(args.recipientRef, 'attention.notify recipientRef');
    assertString(args.messageRef, 'attention.notify messageRef');
    assertString(args.notificationId, 'attention.notify notificationId');
    return;
  }
  if (toolRef === 'attention.list') {
    assertString(args.scopeRef, 'attention.list scopeRef');
    return;
  }
  if (toolRef === 'attention.inspect') {
    assertString(args.attentionId, 'attention.inspect attentionId');
    return;
  }
  if (toolRef === 'task.query' || toolRef === 'task.match') {
    assertString(args.queryRef ?? args.taskRef ?? args.scopeRef, `${toolRef} queryRef, taskRef, or scopeRef`);
    return;
  }
  if (toolRef === 'runtime.status' || toolRef === 'queue.inspect' || toolRef === 'resource.query') {
    assertString(args.scopeRef, `${toolRef} scopeRef`);
    return;
  }
  if (toolRef === 'workspace.list') {
    assertString(args.scopeRef ?? args.pathRef, 'workspace.list scopeRef or pathRef');
    return;
  }
  if (toolRef === 'file.read') {
    assertString(args.pathRef, 'file.read pathRef');
    return;
  }
  if (toolRef === 'file.search') {
    assertString(args.query, 'file.search query');
    assertString(args.scopeRef, 'file.search scopeRef');
    assertPositiveLimit(args.limit);
    return;
  }
  if (toolRef === 'agent.query') {
    assertString(args.agentRef ?? args.scopeRef, 'agent.query agentRef or scopeRef');
    return;
  }
  if (toolRef === 'agent.message') {
    assertString(args.recipientRef, 'agent.message recipientRef');
    assertString(args.messageRef, 'agent.message messageRef');
    if (!['control', 'data', 'observation'].includes(String(args.messageClass))) {
      throw new ExplicitBrainAdmissionError('invalid-arguments', 'agent.message messageClass is invalid');
    }
    return;
  }
  if (toolRef === 'bug.query') {
    assertString(args.queryRef, 'bug.query queryRef');
    return;
  }
  if (toolRef === 'bug.inspect') {
    assertString(args.bugId, 'bug.inspect bugId');
    return;
  }
  if (toolRef === 'channel.query') {
    assertString(args.channelId ?? args.scopeRef, 'channel.query channelId or scopeRef');
    return;
  }
  if (toolRef === 'memory.search') {
    assertString(args.query, 'memory.search query');
    assertPositiveLimit(args.limit);
    return;
  }
  if (toolRef === 'memory.inspect') {
    assertString(args.sourceRef, 'memory.inspect sourceRef');
    return;
  }
  if (toolRef === 'memory.compare') {
    assertString(args.leftRef, 'memory.compare leftRef');
    assertString(args.rightRef, 'memory.compare rightRef');
    return;
  }
  if (toolRef === 'memory.save_candidate') {
    validateMemorySaveCandidateArguments(args as unknown as MemorySaveCandidateArguments);
    return;
  }
  if (toolRef === 'memory.operation.status') {
    assertString(args.operationId, 'memory.operation.status operationId');
    return;
  }
  if (toolRef === 'interaction.ask') {
    assertString(args.questionRef, 'interaction.ask questionRef');
    return;
  }
  if (toolRef === 'interaction.propose') {
    assertString(args.proposalRef, 'interaction.propose proposalRef');
    return;
  }
  if (toolRef === 'interaction.approve') {
    assertString(args.proposalRef, 'interaction.approve proposalRef');
    assertString(args.confirmationRef, 'interaction.approve confirmationRef');
    return;
  }
  if (toolRef === 'channel.reply') {
    assertString(args.channelId, 'channel.reply channelId');
    assertString(args.messageRef, 'channel.reply messageRef');
    return;
  }
  if (toolRef === 'channel.notify') {
    assertString(args.channelId, 'channel.notify channelId');
    assertString(args.recipientRef, 'channel.notify recipientRef');
    assertString(args.messageRef, 'channel.notify messageRef');
    return;
  }
  if (toolRef === 'route.submit') {
    assertString(args.routeRef, 'route.submit routeRef');
    assertString(args.payloadRef, 'route.submit payloadRef');
    return;
  }
  if (toolRef === 'trigger.submit') {
    validateTriggerSubmit(args as unknown as TriggerSubmitArguments);
    return;
  }
  if (toolRef === 'subscription.request') {
    validateSubscriptionRequest(args as unknown as SubscriptionRequestArguments);
    return;
  }
  if (toolRef === 'requirement.submit') {
    const input = args as unknown as RequirementSubmitArguments;
    assertString(input.interactionId, 'requirement interactionId');
    assertString(input.draftId, 'requirement draftId');
    assertString(input.confirmationRef, 'requirement confirmationRef');
    if (!Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1) {
      throw new ExplicitBrainAdmissionError('invalid-arguments', 'requirement inputRevision must be positive');
    }
    return;
  }
  if (toolRef === 'resource.request') {
    assertNoConcreteResource(args);
    assertString(args.routeOperationId, 'resource.request routeOperationId');
    assertStringArray(args.capabilityRefs, 'resource.request capabilityRefs');
    if (!['interactive', 'normal', 'blocker', 'background'].includes(String(args.resourceClass))) {
      throw new ExplicitBrainAdmissionError('invalid-arguments', 'resource.request resourceClass is invalid');
    }
    if (!['none', 'checkpoint-boundary'].includes(String(args.preemption))) {
      throw new ExplicitBrainAdmissionError('invalid-arguments', 'resource.request preemption is invalid');
    }
    return;
  }
  if (toolRef === 'attention.triage') {
    validateAttentionTriage(args as unknown as AttentionTriageArguments);
    return;
  }
  if (toolRef === 'bug.report') {
    validateBugReport(args as unknown as BugReportArguments);
    return;
  }
  if (toolRef === 'bug.propose-update') {
    validateBugProposeUpdate(args as unknown as BugProposeUpdateArguments);
    return;
  }
  if (toolRef === 'bug.resolve' || toolRef === 'bug.reopen') {
    validateBugTransition(args as unknown as BugTransitionArguments);
    return;
  }
}

function assertPositiveLimit(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExplicitBrainAdmissionError('invalid-arguments', 'limit must be a positive safe integer');
  }
}

function validateToolArgumentsAtBoundary(
  toolRef: ExplicitBrainModelTool,
  args: Readonly<Record<string, unknown>>,
): void {
  try {
    validateToolArguments(toolRef, args);
  } catch (error) {
    if (error instanceof ExplicitBrainAdmissionError) throw error;
    throw new ExplicitBrainAdmissionError(
      'invalid-arguments',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function admitToolIntent(input: {
  readonly registry: ExplicitBrainToolRegistry;
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly intent: ToolIntent;
  readonly currentEpoch: number;
  readonly currentPermissionRevision: string;
  readonly argumentsDigest: (args: Readonly<Record<string, unknown>>) => string;
}): ExplicitBrainAdmissionReceipt {
  assertRuntimeBinding(input.binding);
  if (input.registry.capabilityDigest !== input.binding.capabilityDigest) {
    throw new ExplicitBrainAdmissionError(
      'invalid-runtime-binding',
      'tool registry capability digest does not match the runtime binding',
    );
  }
  if (isForbidden(input.intent.toolRef)) {
    throw new ExplicitBrainAdmissionError('runtime-only-capability', `tool is forbidden for explicit brain: ${input.intent.toolRef}`);
  }
  validateToolIntent(input.intent);
  const capability = input.registry.capabilities.find((entry) => entry.toolRef === input.intent.toolRef as ExplicitBrainModelTool);
  if (!capability) {
    throw new ExplicitBrainAdmissionError('unregistered-tool', `tool is not registered: ${input.intent.toolRef}`);
  }
  if (!input.binding.capabilities.includes(capability.capabilityRef)) {
    throw new ExplicitBrainAdmissionError('capability-denied', `runtime lacks capability: ${capability.capabilityRef}`);
  }
  if (!input.binding.permissions.includes(capability.permissionRef)) {
    throw new ExplicitBrainAdmissionError('permission-denied', `runtime lacks permission: ${capability.permissionRef}`);
  }
  if (input.currentEpoch !== input.binding.executionEpoch) {
    throw new ExplicitBrainAdmissionError('stale-epoch', 'tool intent execution epoch is stale');
  }
  if (input.currentPermissionRevision !== input.binding.permissionRevision) {
    throw new ExplicitBrainAdmissionError('permission-denied', 'tool intent permission revision is stale');
  }
  validateToolArgumentsAtBoundary(capability.toolRef, input.intent.arguments);
  const expectedDigest = input.argumentsDigest(input.intent.arguments);
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new ExplicitBrainAdmissionError('invalid-runtime-binding', 'arguments digest calculator must return a SHA-256 digest');
  }
  if (input.intent.argumentsDigest !== expectedDigest) {
    throw new ExplicitBrainAdmissionError(
      'invalid-arguments',
      `tool arguments digest mismatch: expected ${expectedDigest}`,
    );
  }
  return {
    admitted: true,
    toolRef: capability.toolRef,
    capabilityRef: capability.capabilityRef as ExplicitBrainModelTool,
    bindingRef: input.binding.bindingRef,
    executionEpoch: input.binding.executionEpoch,
    argumentsDigest: expectedDigest,
  };
}
