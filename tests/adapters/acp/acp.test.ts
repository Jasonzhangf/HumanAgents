import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AcpDriverBinding,
  type AcpServerBinding,
  type AgentBinding,
  type AgentRequestEnvelope,
} from '../../../packages/contracts/src/index.js';
import {
  AcpAdapterError,
  AcpDriverAdapter,
  AcpServerAdapter,
  DeterministicAcpDriverTransport,
  DeterministicAcpRuntimeTransport,
  type AcpDelegationProof,
  type AcpPeerProof,
} from '../../../packages/adapters/acp/index.js';

const taskId = id('task', 'task-a');
const operationId = id('operation', 'operation-a');
const serverBinding: AcpServerBinding = {
  bindingRef: 'server-a',
  principalRef: 'peer-a',
  scopeRef: 'organ-a::task-a',
  allowedSessionKinds: ['interaction', 'task'],
  allowedCapabilities: ['session.open', 'session.load', 'observe', 'request', 'cancel', 'reconcile', 'settle'],
  permissionRevision: 'permission-r1',
  bindingDigest: 'sha256:server-a',
};

const proof: AcpPeerProof = {
  principalRef: serverBinding.principalRef,
  scopeRef: serverBinding.scopeRef,
  permissionRevision: serverBinding.permissionRevision,
  bindingDigest: serverBinding.bindingDigest,
};

const taskBinding: AgentBinding = {
  kind: 'task',
  taskId,
  assignmentId: 'assignment-a',
  executionEpoch: 3,
  bindingFingerprint: 'sha256:task-binding',
};

const interactionBinding: AgentBinding = {
  kind: 'interaction',
  interactionScopeId: 'interaction-a',
  bindingFingerprint: 'sha256:interaction-binding',
};

function requestEnvelope(binding: AgentBinding, requestId = 'request-a'): AgentRequestEnvelope {
  return {
    version: 1,
    control: {
      protocolVersion: 1,
      requestId,
      attemptId: `attempt-${requestId}`,
      binding,
      providerBinding: {
        bindingId: 'provider-binding-a',
        providerId: 'provider-a',
        protocol: 'responses',
        endpointRef: 'endpoint-a',
        modelRef: 'model-a',
        configDigest: 'sha256:config',
        capabilityDigest: 'sha256:capability',
        bindingDigest: 'sha256:provider-binding',
        owner: 'runtime',
      },
      contextViewRef: 'context://view-a',
      permissionRevision: 'permission-r1',
      idempotencyKey: `idempotency-${requestId}`,
      replyMode: 'stream',
    },
    data: {
      inputRefs: ['input-a'],
      outputContractRef: 'contract://output-a',
      capabilitySetRef: 'capability://set-a',
    },
  };
}

function server(
  options: {
    readonly serverBinding?: AcpServerBinding;
    readonly transportOptions?: ConstructorParameters<typeof DeterministicAcpRuntimeTransport>[1];
  } = {},
): AcpServerAdapter {
  const binding = options.serverBinding ?? serverBinding;
  return new AcpServerAdapter(binding, new DeterministicAcpRuntimeTransport(binding, options.transportOptions));
}

async function openTask(adapter: AcpServerAdapter, acpSessionId = 'acp-task-a'): Promise<void> {
  await adapter.initialize({
    proof,
    requestedCapabilities: serverBinding.allowedCapabilities,
    requestedSessionKinds: ['interaction', 'task'],
  });
  await adapter.open({ acpSessionId, proof, binding: taskBinding, requestedCapabilities: serverBinding.allowedCapabilities });
}

async function openInteraction(adapter: AcpServerAdapter, acpSessionId = 'acp-interaction-a'): Promise<void> {
  await adapter.initialize({
    proof,
    requestedCapabilities: serverBinding.allowedCapabilities,
    requestedSessionKinds: ['interaction', 'task'],
  });
  await adapter.open({ acpSessionId, proof, binding: interactionBinding, requestedCapabilities: serverBinding.allowedCapabilities });
}

const driverBinding: AcpDriverBinding = {
  bindingRef: 'driver-a',
  externalPeerRef: 'peer-a',
  taskId,
  assignmentId: taskBinding.kind === 'task' ? taskBinding.assignmentId : 'assignment-a',
  executionEpoch: taskBinding.kind === 'task' ? taskBinding.executionEpoch : 1,
  delegatedCapabilities: ['session.open', 'session.load', 'observe', 'request', 'cancel', 'reconcile', 'settle'],
  delegationProofRef: 'proof://driver-a',
  permissionRevision: 'permission-r1',
};

const delegationProof: AcpDelegationProof = {
  proofRef: driverBinding.delegationProofRef,
  bindingRef: driverBinding.bindingRef,
  externalPeerRef: driverBinding.externalPeerRef,
  delegatedCapabilities: driverBinding.delegatedCapabilities,
  permissionRevision: driverBinding.permissionRevision,
};

test('server and driver bindings are validated before admission and retain independent identities', async () => {
  assert.throws(
    () => server({ serverBinding: { ...serverBinding, principalRef: '' } }),
    (error) => error instanceof AcpAdapterError && error.code === 'binding-invalid',
  );

  const adapter = server();
  const initialized = await adapter.initialize({
    proof,
    requestedCapabilities: ['session.open', 'observe', 'request'],
    requestedSessionKinds: ['task'],
  });
  assert.equal(initialized.bindingRef, serverBinding.bindingRef);
  assert.deepEqual(initialized.capabilities, ['session.open', 'observe', 'request']);
  assert.deepEqual(initialized.sessionKinds, ['task']);

  const opened = await adapter.open({
    acpSessionId: 'acp-task-identity',
    proof,
    binding: taskBinding,
    requestedCapabilities: ['session.open', 'observe', 'request'],
  });
  assert.equal(opened.acpSessionId, 'acp-task-identity');
  assert.equal(opened.binding.kind, 'task');
  assert.equal(opened.binding.kind === 'task' ? opened.binding.taskId.value : undefined, taskId.value);
  assert.equal(opened.binding.kind === 'task' ? opened.binding.executionEpoch : undefined, 3);
  assert.equal(opened.runtimeId.startsWith('acp-runtime-'), true);
  assert.notEqual(opened.acpSessionId, opened.runtimeId);

  await assert.rejects(
    () => adapter.open({
      acpSessionId: 'acp-task-identity',
      proof,
      binding: {
        ...taskBinding,
        bindingFingerprint: 'sha256:forged-task-binding',
      } as AgentBinding,
      requestedCapabilities: ['session.open'],
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );

  const driver = new AcpDriverAdapter(driverBinding, new DeterministicAcpDriverTransport(driverBinding));
  const remote = await driver.open({ acpSessionId: 'driver-session-a', binding: taskBinding }, delegationProof);
  assert.equal(remote.externalSessionRef, 'fake-acp-session-driver-session-a');
  assert.equal(remote.externalSessionRef.includes(taskId.value), false);
});

test('capability negotiation is intersection-only and unnegotiated calls fail explicitly', async () => {
  const adapter = server({ transportOptions: { capabilities: ['observe'] } });
  await adapter.initialize({
    proof,
    requestedCapabilities: ['observe', 'request'],
    requestedSessionKinds: ['task', 'interaction'],
  });
  const initialized = await adapter.initialize({
    proof,
    requestedCapabilities: ['session.open', 'observe'],
    requestedSessionKinds: ['task'],
  });
  assert.deepEqual(initialized.capabilities, ['observe']);

  await assert.rejects(
    () => adapter.open({ acpSessionId: 'acp-no-request', proof, binding: taskBinding, requestedCapabilities: ['request'] }),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );
  await assert.rejects(
    () => adapter.initialize({
      proof,
      requestedCapabilities: ['cancel'],
      requestedSessionKinds: ['task'],
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );
});

test('capability negotiation intersects runtime session kinds and rejects unauthorized admission', async () => {
  const adapter = server({
    transportOptions: {
      capabilities: ['session.open', 'session.load', 'observe', 'request'],
      sessionKinds: ['interaction'],
    },
  });
  const initialized = await adapter.initialize({
    proof,
    requestedCapabilities: ['session.open', 'session.load', 'observe', 'request'],
    requestedSessionKinds: ['interaction', 'task'],
  });
  assert.deepEqual(initialized.sessionKinds, ['interaction']);
  await assert.rejects(
    () => adapter.open({
      acpSessionId: 'acp-task-not-negotiated',
      proof,
      binding: taskBinding,
      requestedCapabilities: ['session.open'],
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );
});

test('delegated tool proof is required and external peer claims do not grant capability', async () => {
  assert.throws(
    () => new AcpDriverAdapter({ ...driverBinding, delegationProofRef: '' }, new DeterministicAcpDriverTransport(driverBinding)),
    (error) => error instanceof AcpAdapterError && error.code === 'binding-invalid',
  );

  const wrongProofBinding: AcpDriverBinding = {
    ...driverBinding,
    delegationProofRef: 'proof://driver-b',
  };
  assert.doesNotThrow(() => new AcpDriverAdapter(wrongProofBinding, new DeterministicAcpDriverTransport(wrongProofBinding)));

  const noCapability: AcpDriverBinding = {
    ...driverBinding,
    delegatedCapabilities: ['observe'],
  };
  const noCapabilityAdapter = new AcpDriverAdapter(noCapability, new DeterministicAcpDriverTransport(noCapability));
  const observeOnlyProof: AcpDelegationProof = {
    ...delegationProof,
    delegatedCapabilities: ['observe'],
  };
  await assert.rejects(
    () => noCapabilityAdapter.capabilities({ requestedCapabilities: ['request'] }),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );
  await assert.rejects(
    () => noCapabilityAdapter.open({ acpSessionId: 'driver-observe-only-open', binding: taskBinding }, observeOnlyProof),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );
  await assert.rejects(
    () => noCapabilityAdapter.load({
      acpSessionId: 'driver-observe-only-load',
      binding: taskBinding,
      reason: 'observe-only load must be denied',
    }, observeOnlyProof),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );

  const limitedTransport = new DeterministicAcpDriverTransport(driverBinding, {
    capabilities: ['session.open', 'session.load', 'observe'],
  });
  const limitedAdapter = new AcpDriverAdapter(driverBinding, limitedTransport);
  await limitedAdapter.open({ acpSessionId: 'driver-limited', binding: taskBinding }, delegationProof);
  await assert.rejects(
    () => limitedAdapter.request({
      acpSessionId: 'driver-limited',
      envelope: requestEnvelope(taskBinding, 'driver-limited-request'),
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );

  const adapter = new AcpDriverAdapter(driverBinding, new DeterministicAcpDriverTransport(driverBinding));
  await assert.rejects(
    () => adapter.open({ acpSessionId: 'driver-no-proof', binding: taskBinding }),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );
  await assert.rejects(
    () => adapter.open({ acpSessionId: 'driver-no-proof', binding: taskBinding }, {
      ...delegationProof,
      permissionRevision: 'permission-r2',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
});

test('interaction and task sessions keep distinct cancel, load, reconcile, and settle semantics', async () => {
  const adapter = server();
  await openInteraction(adapter);
  const interactionCancel = await adapter.cancel({
    acpSessionId: 'acp-interaction-a',
    requestId: 'interaction-request',
    attemptId: 'interaction-attempt',
    reason: 'user cancelled interaction',
  });
  assert.equal(interactionCancel.sessionKind, 'interaction');
  assert.equal(interactionCancel.accepted, true);
  assert.equal(interactionCancel.stopped, false);
  assert.equal(interactionCancel.interactionClosure?.disposition, 'cancelled');
  assert.equal(interactionCancel.taskStop, undefined);

  await assert.rejects(
    () => adapter.reconcile({
      acpSessionId: 'acp-interaction-a',
      requestId: 'interaction-request',
      attemptId: 'interaction-attempt',
      operationRef: 'operation-ref',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'session-kind-mismatch',
  );
  await assert.rejects(
    () => adapter.settle({
      acpSessionId: 'acp-interaction-a',
      requestId: 'interaction-request',
      attemptId: 'interaction-attempt',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'session-kind-mismatch',
  );

  const taskAdapter = server();
  await openTask(taskAdapter);
  const taskCancel = await taskAdapter.cancel({
    acpSessionId: 'acp-task-a',
    requestId: 'task-request',
    attemptId: 'task-attempt',
    reason: 'operator stop',
    operationId,
  });
  assert.equal(taskCancel.sessionKind, 'task');
  assert.equal(taskCancel.accepted, true);
  assert.equal(taskCancel.stopped, false);
  assert.equal(taskCancel.interactionClosure, undefined);
  assert.equal(taskCancel.taskStop?.status, 'accepted');

  const settled = await taskAdapter.settle({
    acpSessionId: 'acp-task-a',
    requestId: 'task-request',
    attemptId: 'task-attempt',
  });
  assert.equal(settled.state, 'stopped');
});

test('driver task sessions can observe while interaction sessions reject task-only operations', async () => {
  const driver = new AcpDriverAdapter(driverBinding, new DeterministicAcpDriverTransport(driverBinding));
  await driver.open({ acpSessionId: 'driver-task-observe', binding: taskBinding }, delegationProof);
  const updates = [];
  for await (const update of driver.observe({ acpSessionId: 'driver-task-observe' }, delegationProof)) updates.push(update);
  assert.equal(updates.length, 1);

  const interactionDriverBinding: AcpDriverBinding = {
    ...driverBinding,
    taskId: undefined,
    assignmentId: undefined,
    delegatedCapabilities: ['session.open', 'session.load', 'observe', 'request', 'cancel', 'reconcile', 'settle'],
  };
  const interactionDriver = new AcpDriverAdapter(
    interactionDriverBinding,
    new DeterministicAcpDriverTransport(interactionDriverBinding),
  );
  await interactionDriver.open({ acpSessionId: 'driver-interaction', binding: interactionBinding }, delegationProof);
  await assert.rejects(
    () => interactionDriver.reconcile(
      {
        acpSessionId: 'driver-interaction',
        requestId: 'request-i',
        attemptId: 'attempt-i',
        operationRef: 'operation-i',
      },
      delegationProof,
    ),
    (error) => error instanceof AcpAdapterError && error.code === 'session-kind-mismatch',
  );
  await assert.rejects(
    () => interactionDriver.settle(
      {
        acpSessionId: 'driver-interaction',
        requestId: 'request-i',
        attemptId: 'attempt-i',
      },
      delegationProof,
    ),
    (error) => error instanceof AcpAdapterError && error.code === 'session-kind-mismatch',
  );
});

test('load and close preserve history and repeated close is idempotent', async () => {
  const adapter = server();
  await openTask(adapter, 'acp-history');
  await adapter.request({ acpSessionId: 'acp-history', envelope: requestEnvelope(taskBinding) });
  const updates = [];
  for await (const update of adapter.observe({ acpSessionId: 'acp-history' })) updates.push(update);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.summary, 'deterministic fake progress');

  const loaded = await adapter.load({
    acpSessionId: 'acp-history',
    proof,
    binding: taskBinding,
    expectedExecutionEpoch: taskBinding.kind === 'task' ? taskBinding.executionEpoch : undefined,
    reason: 'resume projection',
  });
  assert.equal(loaded.acpSessionId, 'acp-history');
  await assert.rejects(
    () => adapter.load({
      acpSessionId: 'acp-history',
      proof,
      binding: {
        ...taskBinding,
        taskId: id('task', 'task-b'),
      } as AgentBinding,
      expectedExecutionEpoch: taskBinding.kind === 'task' ? taskBinding.executionEpoch : undefined,
      reason: 'wrong task projection',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
  await assert.rejects(
    () => adapter.load({
      acpSessionId: 'acp-history',
      proof,
      binding: taskBinding,
      expectedExecutionEpoch: 2,
      reason: 'stale projection',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'stale-execution',
  );

  const firstClose = await adapter.close({ acpSessionId: 'acp-history', reason: 'done' });
  const secondClose = await adapter.close({ acpSessionId: 'acp-history', reason: 'done again' });
  assert.equal(firstClose.closed, true);
  assert.equal(firstClose.idempotent, false);
  assert.equal(secondClose.closed, true);
  assert.equal(secondClose.idempotent, true);

  await assert.rejects(
    () => adapter.request({ acpSessionId: 'acp-history', envelope: requestEnvelope(taskBinding, 'after-close') }),
    (error) => error instanceof AcpAdapterError && error.code === 'transport-closed',
  );

  const recovered = await adapter.load({
    acpSessionId: 'acp-history',
    proof,
    binding: taskBinding,
    expectedExecutionEpoch: taskBinding.kind === 'task' ? taskBinding.executionEpoch : undefined,
    reason: 'recover domain history after transport close',
  });
  assert.equal(recovered.runtimeId, loaded.runtimeId);
  const recoveredUpdates = [];
  for await (const update of adapter.observe({ acpSessionId: 'acp-history' })) recoveredUpdates.push(update);
  assert.equal(recoveredUpdates.length, 1);
});

test('transport close keeps domain history when the runtime refuses to close', async () => {
  const adapter = server({ transportOptions: { closeResult: false } });
  await openTask(adapter, 'acp-close-not-complete');
  await adapter.request({ acpSessionId: 'acp-close-not-complete', envelope: requestEnvelope(taskBinding) });
  const refused = await adapter.close({ acpSessionId: 'acp-close-not-complete', reason: 'runtime busy' });
  assert.equal(refused.closed, false);
  const updates = [];
  for await (const update of adapter.observe({ acpSessionId: 'acp-close-not-complete' })) updates.push(update);
  assert.equal(updates.length, 1);
});

test('stale execution epochs and permission mismatches fail before runtime dispatch', async () => {
  const adapter = server();
  await openTask(adapter, 'acp-stale');
  const stale = requestEnvelope({ ...taskBinding, executionEpoch: 2 } as AgentBinding, 'stale-request');
  await assert.rejects(
    () => adapter.request({ acpSessionId: 'acp-stale', envelope: stale }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );

  await assert.rejects(
    () => adapter.initialize({
      proof: { ...proof, permissionRevision: 'permission-r2' },
      requestedCapabilities: ['observe'],
      requestedSessionKinds: ['task'],
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );

  const unauthorized = server({
    serverBinding: {
      ...serverBinding,
      allowedCapabilities: ['session.open', 'observe'],
    },
  });
  await unauthorized.initialize({
    proof,
    requestedCapabilities: ['session.open', 'observe'],
    requestedSessionKinds: ['task'],
  });
  await unauthorized.open({
    acpSessionId: 'acp-unauthorized',
    proof,
    binding: taskBinding,
    requestedCapabilities: ['session.open', 'observe'],
  });
  await assert.rejects(
    () => unauthorized.request({ acpSessionId: 'acp-unauthorized', envelope: requestEnvelope(taskBinding, 'unauthorized') }),
    (error) => error instanceof AcpAdapterError && error.code === 'capability-unavailable',
  );

  const requestPermission = server();
  await openTask(requestPermission, 'acp-request-permission');
  await assert.rejects(
    () => requestPermission.request({
      acpSessionId: 'acp-request-permission',
      envelope: {
        ...requestEnvelope(taskBinding, 'permission-request'),
        control: {
          ...requestEnvelope(taskBinding, 'permission-request').control,
          permissionRevision: 'permission-r2',
        },
      },
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
});

test('transport errors and no-response are visible and never become success', async () => {
  const failing = server({ transportOptions: { failures: ['transport-error'] } });
  await assert.rejects(
    () => failing.initialize({
      proof,
      requestedCapabilities: ['observe'],
      requestedSessionKinds: ['task'],
    }),
    (error) => error instanceof AcpAdapterError
      && error.code === 'transport-failure'
      && error.ownerId === 'humanagent.acp-server-adapter'
      && error.evidenceRefs.length > 0
      && error.nextAction.kind === 'recover',
  );

  const noResponse = server({ transportOptions: { failures: ['no-response'] } });
  await assert.rejects(
    () => noResponse.initialize({
      proof,
      requestedCapabilities: ['observe'],
      requestedSessionKinds: ['task'],
    }),
    (error) => error instanceof AcpAdapterError
      && error.code === 'no-response'
      && error.evidenceRefs.length > 0
      && error.nextAction.kind === 'recover',
  );

  const failingDriverBinding: AcpDriverBinding = {
    ...driverBinding,
    delegatedCapabilities: ['session.open', 'session.load', 'observe', 'request', 'cancel', 'reconcile', 'settle'],
  };
  const failingProof: AcpDelegationProof = {
    ...delegationProof,
    delegatedCapabilities: failingDriverBinding.delegatedCapabilities,
  };
  const failingDriver = new AcpDriverAdapter(
    failingDriverBinding,
    new DeterministicAcpDriverTransport(failingDriverBinding, { failures: ['transport-error'] }),
  );
  await assert.rejects(
    () => failingDriver.capabilities({ requestedCapabilities: ['observe'] }, failingProof),
    (error) => error instanceof AcpAdapterError
      && error.code === 'transport-failure'
      && error.ownerId === 'humanagent.acp-driver-adapter'
      && error.evidenceRefs.length > 0
      && error.nextAction.kind === 'recover',
  );
});

test('runtime and transport receipts must match the request before they can advance lifecycle', async () => {
  const forgedServer = server({
    transportOptions: {
      dispatchReceipt: {
        requestId: 'forged-request',
      },
      reconcileReceipt: {
        operationRef: 'forged-operation',
      },
      settleReceipt: {
        requestId: 'forged-settle-request',
      },
    },
  });
  await openTask(forgedServer, 'acp-forged-receipt');
  await assert.rejects(
    () => forgedServer.request({
      acpSessionId: 'acp-forged-receipt',
      envelope: requestEnvelope(taskBinding, 'runtime-request'),
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
  await assert.rejects(
    () => forgedServer.reconcile({
      acpSessionId: 'acp-forged-receipt',
      requestId: 'runtime-request',
      attemptId: 'attempt-runtime-request',
      operationRef: 'operation-a',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
  await assert.rejects(
    () => forgedServer.settle({
      acpSessionId: 'acp-forged-receipt',
      requestId: 'runtime-request',
      attemptId: 'attempt-runtime-request',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );

  const forgedDriver = new AcpDriverAdapter(
    driverBinding,
    new DeterministicAcpDriverTransport(driverBinding, {
      dispatchReceipt: { requestId: 'forged-driver-request' },
      reconcileReceipt: { operationRef: 'forged-driver-operation' },
      settleReceipt: { requestId: 'forged-driver-settle-request' },
    }),
  );
  await forgedDriver.open({ acpSessionId: 'driver-forged-receipt', binding: taskBinding }, delegationProof);
  await assert.rejects(
    () => forgedDriver.request({
      acpSessionId: 'driver-forged-receipt',
      envelope: requestEnvelope(taskBinding, 'driver-request'),
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
  await assert.rejects(
    () => forgedDriver.reconcile({
      acpSessionId: 'driver-forged-receipt',
      requestId: 'driver-request',
      attemptId: 'attempt-driver-request',
      operationRef: 'operation-a',
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
  await assert.rejects(
    () => forgedDriver.settle({
      acpSessionId: 'driver-forged-receipt',
      requestId: 'driver-request',
      attemptId: 'attempt-driver-request',
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
});

test('driver cancel requires request identity and does not infer stopped from accepted', async () => {
  const driver = new AcpDriverAdapter(driverBinding, new DeterministicAcpDriverTransport(driverBinding));
  await driver.open({ acpSessionId: 'driver-cancel', binding: taskBinding }, delegationProof);
  const cancelled = await driver.cancel({
    acpSessionId: 'driver-cancel',
    requestId: 'request-cancel',
    attemptId: 'attempt-cancel',
    reason: 'operator stop',
    operationId,
  }, delegationProof);
  assert.equal(cancelled.accepted, true);
  assert.equal(cancelled.stopped, false);
  assert.equal(cancelled.taskStop?.status, 'accepted');

  await assert.rejects(
    () => driver.cancel({
      acpSessionId: 'driver-cancel',
      requestId: '',
      attemptId: 'attempt-cancel',
      reason: 'operator stop',
      operationId,
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'protocol-error',
  );
});

test('unknown task stop is not accepted and forged stop operation identity is rejected', async () => {
  const unknown = new AcpDriverAdapter(
    driverBinding,
    new DeterministicAcpDriverTransport(driverBinding, { taskStopStatus: 'unknown' }),
  );
  await unknown.open({ acpSessionId: 'driver-unknown-stop', binding: taskBinding }, delegationProof);
  const unknownReceipt = await unknown.cancel({
    acpSessionId: 'driver-unknown-stop',
    requestId: 'unknown-request',
    attemptId: 'unknown-attempt',
    reason: 'stop',
    operationId,
  }, delegationProof);
  assert.equal(unknownReceipt.accepted, false);
  assert.equal(unknownReceipt.stopped, false);

  const forged = new AcpDriverAdapter(
    driverBinding,
    new DeterministicAcpDriverTransport(driverBinding, { taskStopOperationRef: 'operation-forged' }),
  );
  await forged.open({ acpSessionId: 'driver-forged-stop', binding: taskBinding }, delegationProof);
  await assert.rejects(
    () => forged.cancel({
      acpSessionId: 'driver-forged-stop',
      requestId: 'forged-stop-request',
      attemptId: 'forged-stop-attempt',
      reason: 'stop',
      operationId,
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );

  const forgedServer = server({ transportOptions: { taskStopOperationRef: 'operation-forged' } });
  await openTask(forgedServer, 'acp-forged-stop');
  await assert.rejects(
    () => forgedServer.cancel({
      acpSessionId: 'acp-forged-stop',
      requestId: 'forged-stop-request',
      attemptId: 'forged-stop-attempt',
      reason: 'stop',
      operationId,
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
});

test('interaction closures must match the cancelled scope and attempt', async () => {
  const adapter = server({
    transportOptions: {
      interactionClosure: {
        interactionScopeId: 'forged-interaction-scope',
      },
    },
  });
  await openInteraction(adapter, 'acp-forged-closure');
  await assert.rejects(
    () => adapter.cancel({
      acpSessionId: 'acp-forged-closure',
      requestId: 'interaction-request',
      attemptId: 'interaction-attempt',
      reason: 'cancel',
    }),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );

  const driver = new AcpDriverAdapter(
    {
      ...driverBinding,
      taskId: undefined,
      assignmentId: undefined,
    },
    new DeterministicAcpDriverTransport(
      {
        ...driverBinding,
        taskId: undefined,
        assignmentId: undefined,
      },
      {
        interactionClosure: {
          requestId: 'forged-interaction-request',
        },
      },
    ),
  );
  await driver.open({ acpSessionId: 'driver-forged-closure', binding: interactionBinding }, delegationProof);
  await assert.rejects(
    () => driver.cancel({
      acpSessionId: 'driver-forged-closure',
      requestId: 'interaction-request',
      attemptId: 'interaction-attempt',
      reason: 'cancel',
    }, delegationProof),
    (error) => error instanceof AcpAdapterError && error.code === 'identity-mismatch',
  );
});

test('close transport failure remains visible and leaves the session retryable', async () => {
  const closeFailure = server({ transportOptions: { failuresByOperation: { close: 'closed' } } });
  await closeFailure.initialize({
    proof,
    requestedCapabilities: ['session.open', 'observe'],
    requestedSessionKinds: ['task'],
  });
  await closeFailure.open({
    acpSessionId: 'acp-close-failure',
    proof,
    binding: taskBinding,
    requestedCapabilities: ['session.open', 'observe'],
  });
  await assert.rejects(
    () => closeFailure.close({ acpSessionId: 'acp-close-failure', reason: 'shutdown' }),
    (error) => error instanceof AcpAdapterError
      && error.code === 'transport-closed'
      && error.evidenceRefs.length > 0,
  );

  const updates = [];
  for await (const update of closeFailure.observe({ acpSessionId: 'acp-close-failure' })) updates.push(update);
  assert.deepEqual(updates, []);

  const driverCloseFailure = new AcpDriverAdapter(
    driverBinding,
    new DeterministicAcpDriverTransport(driverBinding, { failuresByOperation: { close: 'closed' } }),
  );
  await driverCloseFailure.open({ acpSessionId: 'driver-close-failure', binding: taskBinding }, delegationProof);
  await assert.rejects(
    () => driverCloseFailure.close({
      acpSessionId: 'driver-close-failure',
      requestId: 'driver-close-request',
      attemptId: 'driver-close-attempt',
      reason: 'shutdown',
    }),
    (error) => error instanceof AcpAdapterError
      && error.code === 'transport-closed'
      && error.ownerId === 'humanagent.acp-driver-adapter',
  );
  const driverUpdates = [];
  for await (const update of driverCloseFailure.observe(
    { acpSessionId: 'driver-close-failure' },
    delegationProof,
  )) driverUpdates.push(update);
  assert.equal(driverUpdates.length, 1);
});
