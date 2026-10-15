import assert from 'node:assert/strict';
import test from 'node:test';
import { admitAgentProvider } from '../../packages/app/src/agent-provider-admission.js';
import type { AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import type { ProviderConfig } from '../../packages/config/src/index.js';
import { canStartProviderRequest } from '../../packages/app/src/provider-admission.js';
import { AppLifecycleError } from '../../packages/app/src/errors.js';
import {
  id,
  ContractError,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderEvent,
  type ProviderReadiness,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';

/**
 * Component failure basis for this focused consumer.
 *
 * Failure mode: `admitAgentProvider` starts the selected agent provider with a
 * readiness that is not the selected composition's own probe result. A shared
 * default readiness then admits a rejected provider, or a rejected default
 * readiness rejects an admitted selected one. The helper also keeps its own
 * validation instead of reusing the contracts one, so a wrong binding passes.
 *
 * Impact: a provider request starts on the wrong provider binding or with an
 * unverified readiness, so it either fails on the target or runs against a
 * configuration the caller never selected.
 *
 * Cost: one in-memory probe double and one ready counterexample. No socket,
 * live endpoint, factory assembly, protocol codec or readiness matrix is
 * built. The request-start predicate itself is owned by
 * `canStartProviderRequest`; this consumer proves the helper applies it to the
 * selected probe result instead of to a shared default readiness.
 */

const CHECKED_AT = '2026-10-13T00:00:00.000Z';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const SELECTED_PROBE_OWNER = 'humanagent.provider-adapter.http';
const SELECTED_START_REF = 'http.start';

const scope: ScopeRef = {
  organId: id('organ', 'agent-provider-admission'),
  taskId: id('task', 'agent-provider-admission-task'),
  operationId: id('operation', 'agent-provider-admission-operation'),
};

/**
 * Fixture binding narrows the contract protocol to the protocols an existing
 * `ProviderConfig` can actually carry. The HTTP fixture speaks `responses`;
 * `other-explicit` is not a real supported config protocol here.
 */
type FixtureProviderBinding = ProviderBinding & { readonly protocol: ProviderConfig['protocol'] };

const selectedBinding: FixtureProviderBinding = {
  bindingId: 'agent-selected-binding',
  providerId: 'rcc',
  protocol: 'responses',
  endpointRef: 'http://127.0.0.1:4599',
  modelRef: 'http.model',
  configDigest: 'sha256:agent-selected-config',
  capabilityDigest: 'sha256:agent-selected-capability',
};

const readinessEvidence: EvidenceRef = {
  evidenceId: id('evidence', 'agent-selected-probe'),
  kind: 'execution',
  source: 'agent-provider-admission-consumer',
  locator: `probe://${selectedBinding.bindingId}`,
  scope,
};

const httpUnknownFailure: ProviderReadiness['failure'] = {
  errorId: 'provider.probe.probe.readiness-unknown',
  code: 'probe.readiness-unknown',
  category: 'capability',
  phase: 'probe',
  message: 'direct HTTP source has no discovery probe; start an explicit request to learn the remote state',
  ownerId: SELECTED_PROBE_OWNER,
  retryable: 'manual',
  attention: 'foreground',
  evidenceRefs: [readinessEvidence],
  nextAction: { kind: 'continue', ref: SELECTED_START_REF },
};

/**
 * The real HTTP source has no discovery contract: its own probe returns the
 * typed `unknown` state with the `continue -> http.start` next action. This
 * double carries that same shape, so no readiness is fabricated here.
 */
const selectedReadiness: ProviderReadiness = {
  bindingId: selectedBinding.bindingId,
  providerId: selectedBinding.providerId,
  protocol: selectedBinding.protocol,
  state: 'unknown',
  capabilityDigest: selectedBinding.capabilityDigest,
  checkedAt: CHECKED_AT,
  expiresAt: EXPIRES_AT,
  evidenceRefs: [readinessEvidence],
  ownerId: SELECTED_PROBE_OWNER,
  nextAction: { kind: 'continue', ref: SELECTED_START_REF },
  failure: httpUnknownFailure,
};

/** Shared/default readiness that is ready and requestable from any source. */
const defaultReadyReadiness: ProviderReadiness = {
  bindingId: 'agent-default-binding',
  providerId: selectedBinding.providerId,
  protocol: selectedBinding.protocol,
  state: 'ready',
  capabilityDigest: 'sha256:agent-default-capability',
  checkedAt: CHECKED_AT,
  expiresAt: EXPIRES_AT,
  evidenceRefs: [readinessEvidence],
};

const rejectedReadiness: ProviderReadiness = {
  bindingId: selectedBinding.bindingId,
  providerId: selectedBinding.providerId,
  protocol: selectedBinding.protocol,
  state: 'not-ready',
  capabilityDigest: selectedBinding.capabilityDigest,
  checkedAt: CHECKED_AT,
  expiresAt: EXPIRES_AT,
  evidenceRefs: [readinessEvidence],
  ownerId: 'humanagent.provider-adapter.selected',
  failure: {
    errorId: 'agent-selected-probe-failure',
    code: 'provider.unavailable',
    category: 'provider',
    phase: 'probe',
    message: 'selected provider probe failed',
    ownerId: 'humanagent.provider-adapter.selected',
    retryable: 'manual',
    attention: 'foreground',
    evidenceRefs: [readinessEvidence],
    nextAction: { kind: 'recover', ref: 'humanagent.provider-adapter.selected' },
  },
  nextAction: { kind: 'recover', ref: 'humanagent.provider-adapter.selected' },
};

/**
 * Probe-record double for the helper contract. It records which binding the
 * admission actually probed and returns the one readiness it was given. Every
 * other port operation refuses, because admission must not start, resume,
 * submit, stop, settle or close a session through this path.
 */
function admissionComposition(
  binding: FixtureProviderBinding,
  readiness: ProviderReadiness,
  probed: ProviderBinding[],
): AgentProviderComposition {
  const refused = (): never => { throw new Error('admission must not reach this provider operation'); };
  const port: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async (probedBinding: ProviderBinding): Promise<ProviderReadiness> => {
      probed.push(probedBinding);
      return readiness;
    },
    capabilities: async () => refused(),
    start: async () => refused(),
    resume: async () => refused(),
    submit: async () => refused(),
    observe: async function* (): AsyncIterable<ProviderEvent> {},
    requestStop: async () => refused(),
    settle: async () => refused(),
    close: async () => refused(),
  };
  return {
    roleId: 'execution',
    provider: {
      provider: 'rcc', source: 'http', binding: binding.bindingId,
      protocol: 'responses', model: binding.modelRef,
      route: 'http.model', baseUrl: 'http://127.0.0.1:4599',
    },
    source: 'http', binding, port,
  };
}

test('agent provider admission admits the selected HTTP unknown readiness from its own probe', async () => {
  const probed: ProviderBinding[] = [];
  const selected = admissionComposition(selectedBinding, selectedReadiness, probed);

  const admitted = await admitAgentProvider(selected);

  assert.equal(admitted, selectedReadiness);
  assert.deepEqual(probed, [selectedBinding]);
  assert.equal(admitted.state, 'unknown');
  assert.equal(admitted.ownerId, SELECTED_PROBE_OWNER);
  assert.equal(admitted.nextAction?.kind, 'continue');
  assert.equal(admitted.nextAction?.ref, SELECTED_START_REF);
  assert.equal(canStartProviderRequest('http', admitted), true);
  assert.equal(canStartProviderRequest('rcc', admitted), false);
});

test('agent provider admission rejects the selected rejection while the shared default stays ready', async () => {
  const probed: ProviderBinding[] = [];
  const rejected = admissionComposition(selectedBinding, rejectedReadiness, probed);
  const defaultBinding = {
    ...selectedBinding,
    bindingId: defaultReadyReadiness.bindingId,
    capabilityDigest: defaultReadyReadiness.capabilityDigest,
  };
  const ready = admissionComposition(defaultBinding, defaultReadyReadiness, probed);

  await assert.rejects(() => admitAgentProvider(rejected), (error: unknown) => {
    assert.ok(error instanceof AppLifecycleError);
    if (!(error instanceof AppLifecycleError)) throw error;
    assert.equal(error.code, 'provider-request-rejected');
    assert.equal(error.message, 'selected provider probe failed');
    assert.equal(error.ownerId, 'humanagent.provider-adapter.selected');
    assert.equal(error.nextAction, 'humanagent.provider-adapter.selected');
    assert.equal(error.cause, rejectedReadiness.failure);
    assert.deepEqual(rejectedReadiness.failure?.evidenceRefs, [readinessEvidence]);
    return true;
  });
  assert.equal(await admitAgentProvider(ready), defaultReadyReadiness);

  // The rejected readiness was probed from its own composition and the ready
  // default readiness could not start it.
  assert.deepEqual(probed, [selectedBinding, defaultBinding]);
});

test('agent provider admission rejects a readiness that is not bound to the selected binding', async () => {
  const probed: ProviderBinding[] = [];
  const wrongBinding = admissionComposition(selectedBinding, defaultReadyReadiness, probed);

  await assert.rejects(() => admitAgentProvider(wrongBinding), (error: unknown) => {
    assert.ok(error instanceof ContractError);
    if (!(error instanceof ContractError)) throw error;
    assert.equal(error.message, 'provider binding id mismatch');
    return true;
  });
  assert.deepEqual(probed, [selectedBinding]);
});

test('agent provider admission surfaces a root probe failure without swallowing it', async () => {
  const probed: ProviderBinding[] = [];
  const original = new Error('selected composition probe is unavailable');
  const probeFailure = (): never => { throw original; };
  const selected = admissionComposition(selectedBinding, selectedReadiness, probed);
  const failing: AgentProviderComposition = {
    ...selected,
    port: {
      kind: 'humanagent.execution-runtime-port',
      probe: async () => probeFailure(),
      capabilities: async () => probeFailure(),
      start: async () => probeFailure(),
      resume: async () => probeFailure(),
      submit: async () => probeFailure(),
      observe: async function* (): AsyncIterable<ProviderEvent> {},
      requestStop: async () => probeFailure(),
      settle: async () => probeFailure(),
      close: async () => probeFailure(),
    },
  };

  await assert.rejects(() => admitAgentProvider(failing), (error: unknown) => error === original);
  assert.deepEqual(probed, []);
});
