import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  id,
  validateProviderSettlement,
  validateProviderStartReceipt,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderEvent,
  type ProviderObserveInput,
  type ProviderRecoveryResult,
  type ProviderResumeInput,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
} from '../../../packages/contracts/src/index.js';
import {
  DshAdapterError,
  assertDshExternalSession,
  assertDshLockDescriptor,
  assertDshProfileDescriptor,
  assertDshProviderBinding,
  createDshExecutionRuntimePort,
  dshBaselineLock,
  type DshPluginLock,
  type DshProfileDescriptor,
  type DshProbeEvidence,
  type DshProviderBinding,
  type DshTransport,
  type DshTransportContext,
} from '../../../packages/adapters/dsh/src/index.js';

const digest = (): string => `sha256:${'ab'.repeat(32)}`;
const otherDigest = (): string => `sha256:${'cd'.repeat(32)}`;
const validity = (): { checkedAt: string; expiresAt: string } => {
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
};

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const operationScope = { organId: organ, taskId: task, operationId: operation };

const providerEvidence = (label: string): EvidenceRef => ({
  evidenceId: id('evidence', `ev-${label}`),
  kind: 'execution',
  source: 'dsh-test-transport',
  locator: `dsh://evidence/${label}`,
  scope: operationScope,
});

const probeEvidence: DshProbeEvidence = {
  scope: operationScope,
  evidenceRefs: [providerEvidence('probe-dependency')],
};

const externalEvidence = (label: string, session: string): EvidenceRef => ({
  evidenceId: id('evidence', `ext-${label}`),
  kind: 'external',
  source: 'dsh-test-transport',
  locator: `dsh://session/${session}`,
  scope: operationScope,
});

const plugin: DshPluginLock = {
  bundleRef: 'humanagent-dsh-bundle:approved',
  digest: digest(),
  entry: 'dist/index.js',
};

const profile: DshProfileDescriptor = {
  profileName: 'humanagent',
  homeRef: 'env:DSH_HOME',
  plugin,
  routeRef: 'explicit/dsh/route',
  patchRefs: [],
};

const providerBinding: ProviderBinding = {
  bindingId: 'binding-dsh',
  providerId: 'dsh',
  protocol: 'responses',
  endpointRef: 'local:dsh-transport',
  modelRef: 'explicit/model',
  configDigest: digest(),
  capabilityDigest: digest(),
};

const dshProviderBinding: DshProviderBinding = {
  ...providerBinding,
  routeRef: 'explicit/dsh/route',
  profileRef: 'profile:humanagent',
  lockRef: 'lock:dsh-baseline',
};

const executionIdentity = {
  runtimeId: 'runtime-a',
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
};

const startInput = (overrides: Partial<ProviderStartInput> = {}): ProviderStartInput => ({
  ...executionIdentity,
  inputRefs: ['input-a'],
  evidenceRefs: [providerEvidence('start-input')],
  ...overrides,
});

const resumeInput = (overrides: Partial<ProviderResumeInput> = {}): ProviderResumeInput => ({
  ...startInput(),
  checkpointId: id('checkpoint', 'cp-provider'),
  checkpointExecutionEpoch: 1,
  ...overrides,
});

const submitInput = (overrides: Partial<ProviderSubmitInput> = {}): ProviderSubmitInput => ({
  ...executionIdentity,
  inputRefs: ['input-b'],
  evidenceRefs: [providerEvidence('submit-input')],
  payload: { question: 'continue' },
  ...overrides,
});

const stopRequest = (overrides: Partial<ProviderStopRequest> = {}): ProviderStopRequest => ({
  ...executionIdentity,
  reason: 'operator stop',
  ownerId: 'stop-controller',
  evidenceRefs: [providerEvidence('stop-input')],
  ...overrides,
});

class StubTransport implements DshTransport {
  requiredCapabilities = ['dsh.session', 'dsh.model'];

  async probe(context: DshTransportContext) {
    const times = validity();
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      state: 'ready' as const,
      capabilityDigest: context.binding.capabilityDigest,
      checkedAt: times.checkedAt,
      expiresAt: times.expiresAt,
      evidenceRefs: [providerEvidence('probe')],
    };
  }

  async capabilities(context: DshTransportContext) {
    const times = validity();
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      capabilities: this.requiredCapabilities,
      version: '0.1.5-rc.2',
      digest: context.binding.capabilityDigest,
      checkedAt: times.checkedAt,
      expiresAt: times.expiresAt,
      evidenceRefs: [providerEvidence('capabilities')],
    };
  }

  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      startedAt: '2026-09-13T00:00:00Z',
      evidenceRefs: [providerEvidence('start')],
      externalExecutionRef: externalEvidence('start-session', 'sess-123'),
    };
  }

  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      checkpointId: input.checkpointId,
      recovered: true,
      staleRejected: false,
      recoveryStateRef: externalEvidence('resume-session', 'sess-123'),
      evidenceRefs: [providerEvidence('resume')],
    };
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'completed',
      outputRefs: ['output-a'],
      evidenceRefs: [providerEvidence('submit')],
      payload: { answer: 'ok' },
    };
  }

  async *observe(input: ProviderObserveInput) {
    const event: ProviderEvent = {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      eventId: 'event-a',
      kind: 'model',
      evidenceRefs: [providerEvidence('observe')],
    };
    yield event;
  }

  async requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      receivedAt: '2026-09-13T00:00:00Z',
      evidenceRefs: [providerEvidence('stop-receipt')],
    };
  }

  async settle(input: { runtimeId: string; taskId: typeof task; operationId: typeof operation; executionEpoch: number }): Promise<ProviderSettlement> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: 'stopped',
      evidenceRefs: [providerEvidence('settle')],
      resourceRelease: { state: 'released', evidenceRefs: [providerEvidence('resource')] },
      persistence: { state: 'committed', evidenceRefs: [providerEvidence('persistence')] },
    };
  }

  async close(context: DshTransportContext) {
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      state: 'closed' as const,
      evidenceRefs: [providerEvidence('close')],
    };
  }
}

class WrongStartIdentityTransport extends StubTransport {
  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    return { ...(await super.start(input)), runtimeId: 'wrong-runtime' };
  }
}

class WrongResumeCheckpointTransport extends StubTransport {
  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    return { ...(await super.resume(input)), checkpointId: id('checkpoint', 'cp-wrong') };
  }
}

class WrongObserveTransport extends StubTransport {
  async *observe(input: ProviderObserveInput) {
    const event: ProviderEvent = {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch + 1,
      eventId: 'event-wrong-epoch',
      kind: 'model',
      evidenceRefs: [providerEvidence('observe-wrong')],
    };
    yield event;
  }
}

class RejectingTransport extends StubTransport {
  async submit(): Promise<ProviderSubmitResult> {
    throw new Error('submit transport exploded');
  }

  async *observe(input: ProviderObserveInput) {
    throw new Error('observe iter exploded');
  }
}

class StructuredRejectingTransport extends StubTransport {
  async start(): Promise<ProviderStartReceipt> {
    throw { code: 'structured-provider-rejection' } as unknown;
  }
}

class MutatingStartTransport extends StubTransport {
  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    const originalRuntime = input.runtimeId;
    (input as unknown as { runtimeId: string }).runtimeId = 'mutated-runtime';
    return {
      runtimeId: originalRuntime,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      startedAt: '2026-09-13T00:00:00Z',
      evidenceRefs: [providerEvidence('start')],
      externalExecutionRef: externalEvidence('start-session', 'sess-123'),
    };
  }
}

class MutatingStreamAndSettleTransport extends StubTransport {
  async *observe(input: ProviderObserveInput) {
    const originalRuntime = input.runtimeId;
    (input as unknown as { runtimeId: string }).runtimeId = 'mutated-runtime';
    yield {
      runtimeId: originalRuntime,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      eventId: 'event-a',
      kind: 'model' as const,
      evidenceRefs: [providerEvidence('observe')],
    };
  }

  async settle(input: { runtimeId: string; taskId: typeof task; operationId: typeof operation; executionEpoch: number }): Promise<ProviderSettlement> {
    const originalRuntime = input.runtimeId;
    (input as unknown as { runtimeId: string }).runtimeId = 'mutated-runtime';
    return {
      runtimeId: originalRuntime,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: 'stopped',
      evidenceRefs: [providerEvidence('settle')],
      resourceRelease: { state: 'released', evidenceRefs: [providerEvidence('resource')] },
      persistence: { state: 'committed', evidenceRefs: [providerEvidence('persistence')] },
    };
  }
}

class TypedErrorTransport extends StubTransport {
  async start(): Promise<ProviderStartReceipt> {
    throw new DshAdapterError('capability-unavailable', 'typed transport failure', 'dsh-adapter');
  }
}

class WrongReadinessBindingTransport extends StubTransport {
  async probe(context: DshTransportContext) {
    return { ...(await super.probe(context)), providerId: 'wrong-provider' };
  }
}

class ExpiredReadinessTransport extends StubTransport {
  async probe(context: DshTransportContext) {
    return { ...(await super.probe(context)), expiresAt: new Date(Date.now() - 1_000).toISOString() };
  }
}

class WrongCapabilitiesBindingTransport extends StubTransport {
  async capabilities(context: DshTransportContext) {
    return { ...(await super.capabilities(context)), providerId: 'wrong-provider' };
  }
}

class WrongCapabilitiesDigestTransport extends StubTransport {
  async capabilities(context: DshTransportContext) {
    return { ...(await super.capabilities(context)), digest: otherDigest() };
  }
}

class ExpiredCapabilitiesTransport extends StubTransport {
  async capabilities(context: DshTransportContext) {
    return { ...(await super.capabilities(context)), expiresAt: new Date(Date.now() - 1_000).toISOString() };
  }
}

class ReadinessExpiresAfterCapabilitiesTransport extends StubTransport {
  async probe(context: DshTransportContext) {
    return { ...(await super.probe(context)), expiresAt: new Date(Date.now() + 30).toISOString() };
  }

  async capabilities(context: DshTransportContext) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return super.capabilities(context);
  }
}

class WrongCloseBindingTransport extends StubTransport {
  async close(context: DshTransportContext) {
    return { ...(await super.close(context)), bindingId: 'wrong-binding' };
  }
}

class WaitingSettleTransport extends StubTransport {
  async settle(input: { runtimeId: string; taskId: typeof task; operationId: typeof operation; executionEpoch: number }): Promise<ProviderSettlement> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: 'waiting',
      evidenceRefs: [providerEvidence('settle-waiting')],
      resourceRelease: { state: 'pending', evidenceRefs: [providerEvidence('resource-waiting')] },
      persistence: { state: 'pending', evidenceRefs: [providerEvidence('persistence-waiting')] },
      ownerId: 'dsh-adapter',
      nextAction: { kind: 'continue', ref: 'dsh.observe' },
    };
  }
}

class NotRecoveredTransport extends StubTransport {
  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      checkpointId: input.checkpointId,
      recovered: false,
      staleRejected: false,
      recoveryStateRef: externalEvidence('resume-session', 'sess-123'),
      evidenceRefs: [providerEvidence('resume')],
      error: {
        errorId: 'dsh.resume.unsupported',
        code: 'resume.unsupported',
        category: 'capability',
        phase: 'resume',
        message: 'DSH resume did not recover this provider execution',
        ownerId: 'dsh-adapter',
        retryable: 'manual',
        attention: 'foreground',
        evidenceRefs: [providerEvidence('resume-error')],
        nextAction: { kind: 'recover', ref: 'dsh-adapter' },
      },
      ownerId: 'dsh-adapter',
      nextAction: { kind: 'recover', ref: 'dsh-adapter' },
    };
  }
}

function createPort(overrides: {
  profile?: DshProfileDescriptor;
  transport?: DshTransport | null;
  requiredCapabilities?: readonly string[];
  probeEvidence?: DshProbeEvidence | null;
} = {}): ExecutionRuntimePort {
  return createDshExecutionRuntimePort({
    lock: dshBaselineLock,
    profile: 'profile' in overrides ? overrides.profile : profile,
    transport: ('transport' in overrides ? overrides.transport : new StubTransport()) ?? null,
    requiredCapabilities: overrides.requiredCapabilities ?? ['dsh.session'],
    ownerId: 'dsh-adapter',
    probeEvidence: 'probeEvidence' in overrides ? overrides.probeEvidence ?? undefined : probeEvidence,
  });
}

test('DSH lock, profile, plugin, and binding descriptors validate', () => {
  assert.doesNotThrow(() => assertDshLockDescriptor(dshBaselineLock));
  assert.doesNotThrow(() => assertDshProfileDescriptor(profile));
  assert.doesNotThrow(() => assertDshProviderBinding(dshProviderBinding));
  assert.throws(() => assertDshLockDescriptor({ ...dshBaselineLock, commit: 'bad' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, profileName: 'default' }), DshAdapterError);
  assert.throws(() => assertDshProviderBinding({ ...dshProviderBinding, routeRef: 'default' }), DshAdapterError);
});

test('DSH default and implicit route/provider/profile values are rejected', () => {
  assert.throws(() => assertDshProviderBinding({ ...dshProviderBinding, providerId: 'implicit' }), DshAdapterError);
  assert.throws(() => assertDshProviderBinding({ ...dshProviderBinding, routeRef: 'implicit' }), DshAdapterError);
  assert.doesNotThrow(() => assertDshProviderBinding({ ...dshProviderBinding, protocol: 'other-explicit' }));
  assert.throws(() => assertDshProviderBinding({ ...dshProviderBinding, protocol: 'openai' } as unknown as DshProviderBinding), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'default' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'implicit' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'unknown' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: '~/.dsh' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: '/tmp/humanagent-dsh' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: './.dsh' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'env:HOME' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'env:PWD' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'ref:default' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, homeRef: 'config:implicit' }), DshAdapterError);
  assert.throws(() => assertDshProfileDescriptor({ ...profile, routeRef: 'implicit' }), DshAdapterError);
  assert.doesNotThrow(() => assertDshProfileDescriptor({ ...profile, homeRef: 'env:DSH_HOME' }));
  assert.doesNotThrow(() => assertDshProfileDescriptor({ ...profile, homeRef: 'ref:humanagent.dsh.home' }));
});

test('missing profile, bundle, transport, and capability are explicit readiness failures', async () => {
  const noProfile = createPort({ profile: undefined });
  const missingProfileProbe = await noProfile.probe(providerBinding);
  assert.equal(missingProfileProbe.state, 'dependency-missing');
  assert.equal(missingProfileProbe.ownerId, 'dsh-adapter');
  assert.ok(missingProfileProbe.checkedAt !== '2026-09-13T00:00:00Z');
  assert.ok(missingProfileProbe.expiresAt !== '2099-01-01T00:00:00Z');
  assert.ok(Date.parse(missingProfileProbe.expiresAt) > Date.parse(missingProfileProbe.checkedAt));
  assert.equal(missingProfileProbe.evidenceRefs[0].evidenceId.value, 'ev-probe-dependency');
  assert.equal(missingProfileProbe.failure?.evidenceRefs[0].evidenceId.value, 'ev-probe-dependency');
  await assert.rejects(noProfile.start(startInput()), (error) => error instanceof DshAdapterError && error.code === 'dependency-missing');

  const noEvidencePort = createPort({ profile: undefined, probeEvidence: null });
  await assert.rejects(
    noEvidencePort.probe(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'dependency-missing' && error.phase === 'probe' && error.ownerId === 'dsh-adapter' && error.nextAction.kind === 'recover' && error.nextAction.ref === 'dsh-adapter',
  );

  const noBundle = createPort({ profile: { ...profile, plugin: undefined } });
  const noBundleProbe = await noBundle.probe(providerBinding);
  assert.equal(noBundleProbe.state, 'capability-unavailable');
  assert.equal(noBundleProbe.ownerId, 'dsh-adapter');
  await assert.rejects(noBundle.start(startInput()), (error) => error instanceof DshAdapterError && error.code === 'capability-unavailable');

  const noTransport = createPort({ transport: null });
  const noTransportProbe = await noTransport.probe(providerBinding);
  assert.equal(noTransportProbe.state, 'dependency-missing');
  await assert.rejects(noTransport.start(startInput()), (error) => error instanceof DshAdapterError && error.code === 'dependency-missing');

  const missingCapabilityTransport = new StubTransport();
  missingCapabilityTransport.requiredCapabilities = ['dsh.session', 'dsh.other'];
  const missingCapability = createPort({ transport: missingCapabilityTransport, requiredCapabilities: ['dsh.session', 'dsh.model'] });
  const missingCapabilityProbe = await missingCapability.probe(providerBinding);
  assert.equal(missingCapabilityProbe.state, 'capability-unavailable');
  await assert.rejects(missingCapability.capabilities(providerBinding), (error) => error instanceof DshAdapterError && error.code === 'capability-unavailable');
});

test('DSH execution lifecycle keeps session evidence external and stop separate from settle', async () => {
  const port = createPort();
  const probe = await port.probe(providerBinding);
  assert.equal(probe.state, 'ready');

  const started = await port.start(startInput());
  validateProviderStartReceipt(started);
  assert.equal(started.externalExecutionRef?.kind, 'external');
  assertDshExternalSession({ evidenceRef: started.externalExecutionRef! }, started.runtimeId);

  const resumed = await port.resume(resumeInput());
  assert.equal(resumed.recoveryStateRef.kind, 'external');
  assertDshExternalSession({ evidenceRef: resumed.recoveryStateRef }, resumed.runtimeId);

  const submitted = await port.submit(submitInput());
  assert.equal(submitted.status, 'completed');
  assert.equal(submitted.outputRefs[0], 'output-a');

  const observed: ProviderEvent[] = [];
  for await (const event of port.observe(executionIdentity)) observed.push(event);
  assert.equal(observed.length, 1);

  const stop = await port.requestStop(stopRequest());
  assert.equal(stop.status, 'accepted');
  assert.equal((stop as unknown as Record<string, unknown>).state, undefined);
  assert.equal((stop as unknown as Record<string, unknown>).settled, undefined);

  const settled = await port.settle(executionIdentity);
  validateProviderSettlement(settled);
  assert.equal(settled.state, 'stopped');
  assert.equal(settled.resourceRelease.state, 'released');
  assert.equal(settled.persistence.state, 'committed');

  const closed = await port.close(providerBinding);
  assert.equal(closed.state, 'closed');
});

test('DSH bridge fences transport result identity, resume checkpoint, and observed epochs', async () => {
  await assert.rejects(
    createPort({ transport: new WrongStartIdentityTransport() }).start(startInput()),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'start',
  );
  await assert.rejects(
    createPort({ transport: new WrongResumeCheckpointTransport() }).resume(resumeInput()),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'resume',
  );
  const wrongObservePort = createPort({ transport: new WrongObserveTransport() });
  await wrongObservePort.start(startInput());
  await assert.rejects(
    (async () => {
      for await (const _ of wrongObservePort.observe(executionIdentity)) {
        // noop
      }
    })(),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'observe',
  );
});

test('DSH transport rejection maps to typed errors and existing typed errors are preserved', async () => {
  const rejecting = createPort({ transport: new RejectingTransport() });
  await rejecting.start(startInput());
  await assert.rejects(
    rejecting.submit(submitInput()),
    (error) => error instanceof DshAdapterError && error.code === 'transport-failure' && error.phase === 'submit' && error.cause instanceof Error && error.cause.message === 'submit transport exploded',
  );
  await assert.rejects(
    (async () => {
      for await (const _ of rejecting.observe(executionIdentity)) {
        // noop
      }
    })(),
    (error) => error instanceof DshAdapterError && error.code === 'transport-failure' && error.phase === 'observe' && /observe iter exploded/.test(String(error.cause instanceof Error ? error.cause.message : error.cause)),
  );
  await assert.rejects(
    createPort({ transport: new TypedErrorTransport() }).start(startInput()),
    (error) => error instanceof DshAdapterError && error.code === 'capability-unavailable' && error.message === 'typed transport failure',
  );
  await assert.rejects(
    createPort({ transport: new StructuredRejectingTransport() }).start(startInput()),
    (error) => error instanceof DshAdapterError && error.code === 'transport-failure' && error.phase === 'start' && error.cause && typeof error.cause === 'object' && (error.cause as { code?: string }).code === 'structured-provider-rejection',
  );
});

test('DSH settlement validates provider evidence and removes the active fence without local stop state', async () => {
  await assert.rejects(
    createPort().settle(executionIdentity),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'settle',
  );
  const port = createPort();
  await port.start(startInput());
  const settled = await port.settle(executionIdentity);
  validateProviderSettlement(settled);
  assert.equal(settled.state, 'stopped');
  await assert.rejects(
    port.settle(executionIdentity),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'settle',
  );
  await assert.rejects(
    port.submit(submitInput()),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'submit',
  );
});

test('DSH bridge keeps the active fence until settlement is final', async () => {
  const port = createPort({ transport: new WaitingSettleTransport() });
  await port.start(startInput());
  const settled = await port.settle(executionIdentity);
  assert.equal(settled.state, 'waiting');

  const submitted = await port.submit(submitInput());
  assert.equal(submitted.status, 'completed');
  const settledAgain = await port.settle(executionIdentity);
  assert.equal(settledAgain.state, 'waiting');
});

test('DSH resume only registers active instances for recovered executions', async () => {
  const port = createPort({ transport: new NotRecoveredTransport() });
  const resume = await port.resume(resumeInput());
  assert.equal(resume.recovered, false);
  await assert.rejects(
    port.submit(submitInput()),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'submit',
  );
  await assert.rejects(
    port.settle(executionIdentity),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'settle',
  );
});

test('DSH identity comparisons use immutable snapshots even when transport mutates its input', async () => {
  const port = createPort({ transport: new MutatingStartTransport() });
  const original = startInput();
  await port.start(original);
  assert.equal(original.runtimeId, 'runtime-a');
});

test('DSH stream and settlement comparisons use immutable snapshots', async () => {
  const port = createPort({ transport: new MutatingStreamAndSettleTransport() });
  await port.start(startInput());
  const observed: ProviderEvent[] = [];
  for await (const event of port.observe(executionIdentity)) observed.push(event);
  assert.equal(observed[0].runtimeId, 'runtime-a');
  await port.settle(executionIdentity);
});

test('DSH readiness, capabilities, and close reject wrong binding, digest, or expiry', async () => {
  await assert.rejects(
    createPort({ transport: new WrongReadinessBindingTransport() }).probe(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'probe',
  );
  await assert.rejects(
    createPort({ transport: new ExpiredReadinessTransport() }).probe(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'configuration-invalid' && error.phase === 'probe',
  );
  await assert.rejects(
    createPort({ transport: new WrongCapabilitiesBindingTransport() }).capabilities(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'probe',
  );
  await assert.rejects(
    createPort({ transport: new WrongCapabilitiesDigestTransport() }).capabilities(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'probe',
  );
  await assert.rejects(
    createPort({ transport: new ExpiredCapabilitiesTransport() }).capabilities(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'configuration-invalid' && error.phase === 'probe',
  );
  await assert.rejects(
    createPort({ transport: new ReadinessExpiresAfterCapabilitiesTransport() }).probe(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'configuration-invalid' && error.phase === 'probe',
  );
  await assert.rejects(
    createPort({ transport: new WrongCloseBindingTransport() }).close(providerBinding),
    (error) => error instanceof DshAdapterError && error.code === 'identity-mismatch' && error.phase === 'close',
  );
});

test('DSH identity mismatch cannot be hidden by external session refs', async () => {
  const port = createPort();
  await assert.rejects(port.start(startInput({ runtimeId: 'dsh://session/sess-123' })), DshAdapterError);
  await assert.rejects(port.resume(resumeInput({ checkpointExecutionEpoch: 2 })), (error) => error instanceof DshAdapterError && error.phase === 'resume');
  await assert.rejects(port.submit(submitInput({ executionEpoch: 0 })), (error) => error instanceof DshAdapterError && error.phase === 'submit');
});

test('DSH adapter source has no forbidden provider imports or secret material', async () => {
  const files = [
    '../../../../packages/adapters/dsh/src/index.ts',
    '../../../../packages/adapters/dsh/src/bridge.ts',
    '../../../../packages/adapters/dsh/src/types.ts',
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
  assert.equal(/from ['"]dsh['"]/.test(source), false, 'adapter must not import the DSH package directly');
  assert.equal(/require\(['"]dsh['"]\)/.test(source), false, 'adapter must not require the DSH package directly');
  assert.equal(/sk-[A-Za-z0-9]/.test(source), false, 'adapter must not contain secret-looking material');
  assert.equal(/api[_-]?key/i.test(source), false, 'adapter must not contain API key literals');
  assert.equal(/Bearer\s+/.test(source), false, 'adapter must not contain bearer token literals');
  assert.equal(/~\/\.rcc|\/Volumes\/extension\/\.rcc/.test(source), false, 'adapter must not reference RCC secret paths');
});
