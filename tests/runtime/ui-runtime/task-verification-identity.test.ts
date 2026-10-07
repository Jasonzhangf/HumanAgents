import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  id,
  type EvidenceRef,
  type Scope,
  type TaskCheckEvidence,
  type TaskCheckPolicy,
  type TaskExecutionEvidence,
  type TaskVerificationBinding,
  type TaskVerificationPolicy,
} from '../../../packages/contracts/src/index.js';
import type {
  TaskVerificationExecutionPort,
  TaskVerificationPort,
} from '../../../packages/runtime/src/gateway/ports.js';
import {
  TaskVerificationBridge,
  TaskVerificationError,
  TaskVerificationIdentityConflictError,
} from '../../../packages/runtime/src/ui-runtime/task-verification.js';
import { verificationPolicyDigest } from '../../../packages/runtime/src/ui-runtime/verification-policy-compiler.js';

const scope: Scope = {
  organId: id('organ', 'organ-verification-identity'),
  taskId: id('task', 'task-verification-identity'),
};
const taskId = scope.taskId!;
const operationId = id('operation', 'operation-verification-identity');
const inputDigest = `sha256:${'1'.repeat(64)}`;
const SHA_X = sha('evaluator-x');
const SHA_Y = sha('evaluator-y');
const evidenceRefs: readonly EvidenceRef[] = [
  {
    evidenceId: id('evidence', 'verification-input-evidence'),
    kind: 'operation',
    source: 'verification-identity-test',
    locator: 'verification/input-evidence',
    scope,
  },
];

function sha(label: string): string {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function policy(evaluatorDigest: string): TaskVerificationPolicy {
  const unsigned = {
    policyId: 'policy-verification-identity',
    policyRevision: 1,
    requirementId: 'requirement-verification-identity',
    directiveRevision: 1,
    profileRef: 'verification-profile://default/v1',
    checks: [
      {
        checkId: 'native-default-task-output',
        kind: 'native' as const,
        required: true,
        evaluator: 'default-task-output-v1' as const,
        evaluatorDigest,
        timeoutMs: 10_000,
        permissionRefs: ['permission://task-output/read'],
      },
    ],
  };
  return {
    ...unsigned,
    compiledRef: 'verification-policy:policy-verification-identity:1',
    compiledDigest: verificationPolicyDigest({
      ...unsigned,
      compiledRef: '',
      compiledDigest: '',
    }),
  };
}

function binding(forPolicy: TaskVerificationPolicy, attempt = 1): TaskVerificationBinding {
  return {
    bindingRef: `binding-verification:${forPolicy.compiledDigest}`,
    bindingDigest: sha(`binding:${forPolicy.compiledDigest}:${attempt}`),
    policyRef: forPolicy.compiledRef,
    policyDigest: forPolicy.compiledDigest,
    taskId,
    operationId,
    executionEpoch: 1,
    attempt,
    executionEvidenceRef: `task-execution:${operationId.value}`,
    executionEvidenceDigest: inputDigest,
    artifacts: [
      {
        role: 'primary',
        artifactRef: 'artifact://verification-input',
        artifactDigest: inputDigest,
      },
    ],
    boundAt: '2026-10-05T00:00:00.000Z',
  };
}

function executionEvidence(): TaskExecutionEvidence {
  return {
    taskId,
    operationId,
    executionEpoch: 1,
    inputArtifactDigest: inputDigest,
    stdout: '',
    exitCode: 0,
    evidenceRefs,
  };
}

function checkEvidence(
  input: Parameters<TaskVerificationExecutionPort['execute']>[0],
  status: 'succeeded' | 'failed',
): TaskCheckEvidence {
  const check = input.check as Extract<TaskCheckPolicy, { kind: 'native' }>;
  return {
    checkId: check.checkId,
    kind: check.kind,
    status,
    decisionRef: `verification-decision:${check.checkId}`,
    decisionDigest: sha(`decision:${check.evaluatorDigest}:${status}`),
    artifactDigests: input.binding.artifacts.map((artifact) => artifact.artifactDigest),
    evidenceRefs: [
      {
        evidenceId: id('evidence', `verification-result-${status}`),
        kind: 'operation',
        source: 'verification-identity-test',
        locator: `verification/result/${status}`,
        scope,
      },
    ],
  };
}

class RecordingExecutionPort implements TaskVerificationExecutionPort {
  readonly requests: Parameters<TaskVerificationExecutionPort['execute']>[0][] = [];

  async execute(input: Parameters<TaskVerificationExecutionPort['execute']>[0]): Promise<TaskCheckEvidence> {
    this.requests.push(input);
    const check = input.check as Extract<TaskCheckPolicy, { kind: 'native' }>;
    return checkEvidence(input, check.evaluatorDigest === SHA_Y ? 'failed' : 'succeeded');
  }
}

function bridge(execution: TaskVerificationExecutionPort): TaskVerificationPort {
  return new TaskVerificationBridge({
    execution,
    evidenceScope: { organId: id('organ', 'organ-verification-identity') },
    now: () => '2026-10-05T00:00:00.000Z',
  });
}

test('task verification rejects a changed checker under an old immutable identity', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const first = policy(SHA_X);
  const second = policy(SHA_Y);

  const firstResult = await verifier.verify({
    policy: first,
    binding: binding(first),
    executionEvidence: executionEvidence(),
  });
  assert.equal(firstResult.status, 'success');
  assert.notEqual(first.compiledDigest, second.compiledDigest);
  await assert.rejects(
    verifier.verify({
      policy: second,
      binding: binding(second),
      executionEvidence: executionEvidence(),
    }),
    (error: unknown) => error instanceof TaskVerificationIdentityConflictError
      && error instanceof TaskVerificationError
      && error.code === 'identity-conflict'
      && /immutable verification identity/i.test(error.message),
  );
  assert.equal(execution.requests.length, 1);
  assert.equal(execution.requests[0]?.policy.compiledDigest, first.compiledDigest);
});

test('task verification rejects a changed immutable identity and keeps the old evidence unrelabeled', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const first = policy(SHA_X);
  const second = policy(SHA_Y);

  const firstResult = await verifier.verify({
    policy: first,
    binding: binding(first),
    executionEvidence: executionEvidence(),
  });
  assert.equal(firstResult.status, 'success');

  await assert.rejects(
    verifier.verify({
      policy: second,
      binding: binding(second),
      executionEvidence: executionEvidence(),
    }),
    (error: unknown) => error instanceof TaskVerificationIdentityConflictError
      && error instanceof TaskVerificationError
      && error.code === 'identity-conflict'
      && /immutable verification identity/i.test(error.message),
  );
  assert.equal(execution.requests.length, 1);
  assert.equal(execution.requests[0]?.policy.compiledDigest, first.compiledDigest);
});

test('task verification keeps single-flight execution for the same immutable identity', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const identity = policy(SHA_X);
  const identityBinding = binding(identity);

  const results = await Promise.all([
    verifier.verify({ policy: identity, binding: identityBinding, executionEvidence: executionEvidence() }),
    verifier.verify({ policy: identity, binding: identityBinding, executionEvidence: executionEvidence() }),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['success', 'success']);
  assert.deepEqual(results.map((result) => result.policyDigest), [identity.compiledDigest, identity.compiledDigest]);
  assert.equal(execution.requests.length, 1);
});

test('task verification executes a changed policy under an explicit new attempt', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const first = policy(SHA_X);
  const second = policy(SHA_Y);

  const firstResult = await verifier.verify({
    policy: first,
    binding: binding(first),
    executionEvidence: executionEvidence(),
  });
  const secondResult = await verifier.verify({
    policy: second,
    binding: binding(second, 2),
    executionEvidence: executionEvidence(),
  });

  assert.equal(firstResult.status, 'success');
  assert.equal(secondResult.status, 'rejected');
  assert.equal(secondResult.attempt, 2);
  assert.equal(secondResult.policyDigest, second.compiledDigest);
  assert.equal(execution.requests.length, 2);
  assert.deepEqual(execution.requests.map((request) => request.policy.compiledDigest), [
    first.compiledDigest,
    second.compiledDigest,
  ]);
});
