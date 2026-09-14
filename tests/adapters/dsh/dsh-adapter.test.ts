import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ContractError,
  id,
  validateProviderSettlement,
  validateProviderStartReceipt,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderEvent,
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
  type DshProviderBinding,
  type DshTransport,
  type DshTransportContext,
} from '../../../packages/adapters/dsh/src/index.js';

const digest = (): string => `sha256:${'ab'.repeat(32)}`;

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
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      state: 'ready' as const,
      capabilityDigest: context.binding.capabilityDigest,
      checkedAt: '2026-09-13T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      evidenceRefs: [providerEvidence('probe')],
    };
  }

  async capabilities(context: DshTransportContext) {
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      capabilities: this.requiredCapabilities,
      version: '0.1.5-rc.2',
      digest: context.binding.capabilityDigest,
      checkedAt: '2026-09-13T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
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

  async *observe() {
    const event: ProviderEvent = {
      runtimeId: 'runtime-a',
      taskId: task,
      operationId: operation,
      executionEpoch: 1,
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

function createPort(overrides: {
  profile?: DshProfileDescriptor;
  transport?: DshTransport | null;
  requiredCapabilities?: readonly string[];
} = {}): ExecutionRuntimePort {
  return createDshExecutionRuntimePort({
    lock: dshBaselineLock,
    profile: 'profile' in overrides ? overrides.profile : profile,
    transport: ('transport' in overrides ? overrides.transport : new StubTransport()) ?? null,
    requiredCapabilities: overrides.requiredCapabilities ?? ['dsh.session'],
    ownerId: 'dsh-adapter',
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
  assert.throws(() => assertDshProfileDescriptor({ ...profile, routeRef: 'implicit' }), DshAdapterError);
});

test('missing profile, bundle, transport, and capability are explicit readiness failures', async () => {
  const noProfile = createPort({ profile: undefined });
  const missingProfileProbe = await noProfile.probe(providerBinding);
  assert.equal(missingProfileProbe.state, 'dependency-missing');
  assert.equal(missingProfileProbe.ownerId, 'dsh-adapter');
  await assert.rejects(noProfile.start(startInput()), (error) => error instanceof DshAdapterError && error.code === 'dependency-missing');

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

test('DSH identity mismatch cannot be hidden by external session refs', async () => {
  const port = createPort();
  await assert.rejects(port.start(startInput({ runtimeId: 'dsh://session/sess-123' })), (error) => error instanceof ContractError);
  await assert.rejects(port.resume(resumeInput({ checkpointExecutionEpoch: 2 })), ContractError);
  await assert.rejects(port.submit(submitInput({ executionEpoch: 0 })), ContractError);
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
