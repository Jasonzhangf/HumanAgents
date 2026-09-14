import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderRecoveryResult,
  type ProviderSettlement,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  DshAdapterError,
  createDshExecutionRuntimePort,
  dshBaselineLock,
  type DshProfileDescriptor,
  type DshTransport,
  type DshTransportContext,
} from '../../../packages/adapters/dsh/src/index.js';

interface DshReplayFixture {
  readonly profile: DshProfileDescriptor;
  readonly binding: ProviderBinding;
  readonly identity: {
    readonly runtimeId: string;
    readonly taskId: { readonly scope: 'task'; readonly value: string };
    readonly operationId: { readonly scope: 'operation'; readonly value: string };
    readonly executionEpoch: number;
  };
  readonly scope: ScopeRef;
  readonly start: ProviderStartReceipt;
  readonly resume: ProviderRecoveryResult;
  readonly submit: ProviderSubmitResult;
  readonly observe: readonly ProviderEvent[];
  readonly stop: ProviderStopReceipt;
  readonly settle: ProviderSettlement;
  readonly close: ProviderCloseResult;
  readonly wrongResumeCheckpoint: ProviderRecoveryResult;
  readonly failure: { readonly phase: 'settle'; readonly message: string };
}

function fixtureUrl(file: string): URL {
  const compiled = /\/dist\//.test(import.meta.url);
  const ups = compiled ? 4 : 3;
  return new URL(`${'../'.repeat(ups)}tests/adapters/dsh/fixtures/${file}`, import.meta.url);
}

async function readFixture(): Promise<DshReplayFixture> {
  return JSON.parse(await readFile(fixtureUrl('dsh-lifecycle.json'), 'utf8')) as DshReplayFixture;
}

function replayEvidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `ev-replay-${label}`),
    kind: 'external',
    source: 'dsh-replay-test',
    locator: `dsh://evidence/${label}`,
    scope,
  };
}

class ReplayTransport implements DshTransport {
  private readonly resumeResult: ProviderRecoveryResult;
  private readonly settleResult: () => Promise<ProviderSettlement>;

  constructor(
    private readonly fixture: DshReplayFixture,
    options: { readonly resume?: ProviderRecoveryResult; readonly settle?: () => Promise<ProviderSettlement> } = {},
  ) {
    this.resumeResult = options.resume ?? fixture.resume;
    this.settleResult = options.settle ?? (async () => fixture.settle);
  }

  async probe(context: DshTransportContext) {
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      state: 'ready' as const,
      capabilityDigest: context.binding.capabilityDigest,
      checkedAt: '2026-09-13T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      evidenceRefs: [replayEvidence('probe', this.fixture.scope)],
    };
  }

  async capabilities(context: DshTransportContext) {
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      capabilities: ['dsh.session', 'dsh.model'],
      version: '0.1.5-rc.2',
      digest: context.binding.capabilityDigest,
      checkedAt: '2026-09-13T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      evidenceRefs: [replayEvidence('capabilities', this.fixture.scope)],
    };
  }

  async start() {
    return this.fixture.start;
  }

  async resume() {
    return this.resumeResult;
  }

  async submit() {
    return this.fixture.submit;
  }

  async *observe() {
    for (const event of this.fixture.observe) yield event;
  }

  async requestStop() {
    return this.fixture.stop;
  }

  async settle() {
    return this.settleResult();
  }

  async close() {
    return this.fixture.close;
  }
}

function startInput(fixture: DshReplayFixture) {
  return {
    ...fixture.identity,
    inputRefs: ['input-a'],
    evidenceRefs: [replayEvidence('start-input', fixture.scope)],
  };
}

function resumeInput(fixture: DshReplayFixture) {
  return {
    ...fixture.identity,
    inputRefs: ['input-a'],
    evidenceRefs: [replayEvidence('resume-input', fixture.scope)],
    checkpointId: id('checkpoint', 'cp-replay'),
    checkpointExecutionEpoch: fixture.identity.executionEpoch,
  };
}

function submitInput(fixture: DshReplayFixture) {
  return {
    ...fixture.identity,
    inputRefs: ['input-b'],
    evidenceRefs: [replayEvidence('submit-input', fixture.scope)],
    payload: { question: 'continue' },
  };
}

function stopRequest(fixture: DshReplayFixture) {
  return {
    ...fixture.identity,
    reason: 'operator stop',
    ownerId: 'stop-controller',
    evidenceRefs: [replayEvidence('stop-input', fixture.scope)],
  };
}

function createPort(fixture: DshReplayFixture, transport: ReplayTransport) {
  return createDshExecutionRuntimePort({
    lock: dshBaselineLock,
    profile: fixture.profile,
    transport,
    requiredCapabilities: ['dsh.session', 'dsh.model'],
    ownerId: 'dsh-adapter',
    probeEvidence: {
      scope: fixture.scope,
      evidenceRefs: [replayEvidence('probe-dependency', fixture.scope)],
    },
  });
}

test('recorded DSH transport lifecycle replays through bridge and keeps stop separate from settle', async () => {
  const fixture = await readFixture();
  const port = createPort(fixture, new ReplayTransport(fixture));

  const probe = await port.probe(fixture.binding);
  assert.equal(probe.state, 'ready');

  const started = await port.start(startInput(fixture));
  assert.equal(started.externalExecutionRef?.kind, 'external');

  const resumed = await port.resume(resumeInput(fixture));
  assert.equal(resumed.recoveryStateRef.kind, 'external');
  assert.equal(resumed.checkpointId.value, 'cp-replay');

  const submitted = await port.submit(submitInput(fixture));
  assert.equal(submitted.status, 'completed');

  const observed: ProviderEvent[] = [];
  for await (const event of port.observe(fixture.identity)) observed.push(event);
  assert.equal(observed[0].eventId, 'event-recorded-1');

  const stop = await port.requestStop(stopRequest(fixture));
  assert.equal(stop.status, 'accepted');
  assert.equal('state' in stop, false);
  assert.equal('settled' in stop, false);

  const settled = await port.settle(fixture.identity);
  assert.equal(settled.state, 'stopped');
  assert.equal(settled.resourceRelease.state, 'released');
  assert.equal(settled.persistence.state, 'committed');

  const closed = await port.close(fixture.binding);
  assert.equal(closed.state, 'closed');
});

test('recorded DSH resume checkpoint mismatch is rejected with bridge owner and next action', async () => {
  const fixture = await readFixture();
  const port = createPort(fixture, new ReplayTransport(fixture, { resume: fixture.wrongResumeCheckpoint }));

  await port.start(startInput(fixture));
  await assert.rejects(
    () => port.resume(resumeInput(fixture)),
    (error) => {
      assert.ok(error instanceof DshAdapterError);
      assert.equal(error.code, 'identity-mismatch');
      assert.equal(error.phase, 'resume');
      assert.equal(error.ownerId, 'dsh-adapter');
      assert.deepEqual(error.nextAction, { kind: 'recover', ref: 'dsh-adapter' });
      return true;
    },
  );
});

test('recorded DSH transport crash failure maps to explicit bridge owner and next action', async () => {
  const fixture = await readFixture();
  const port = createPort(fixture, new ReplayTransport(fixture, {
    settle: async () => {
      throw new Error(fixture.failure.message);
    },
  }));

  await port.start(startInput(fixture));
  await assert.rejects(
    () => port.settle(fixture.identity),
    (error) => {
      assert.ok(error instanceof DshAdapterError);
      assert.equal(error.code, 'transport-failure');
      assert.equal(error.phase, 'settle');
      assert.equal(error.ownerId, 'dsh-adapter');
      assert.deepEqual(error.nextAction, { kind: 'recover', ref: 'dsh-adapter' });
      assert.equal(error.cause instanceof Error ? error.cause.message : String(error.cause), 'crash-like transport failure');
      return true;
    },
  );
});
