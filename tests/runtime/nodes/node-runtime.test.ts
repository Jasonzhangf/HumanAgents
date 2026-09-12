import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError, id, type EvidenceRef, type ScopeRef } from '../../../packages/contracts/src/index.js';
import { NodeDispatchError, RuntimeError } from '../../../packages/runtime/src/nodes/errors.js';
import { HarnessNodeRuntime } from '../../../packages/runtime/src/nodes/node-runtime.js';
import {
  createDefaultNodeStrategyRegistry,
  NODE_STRATEGY_REFS,
  NodeStrategyRegistry,
} from '../../../packages/runtime/src/nodes/node-strategies.js';
import type { NodeAdmission, NodeStepResult } from '../../../packages/runtime/src/nodes/node-types.js';

const task = id('task', 'task-a');
const scope: ScopeRef = { organId: id('organ', 'organ-a'), taskId: task };

function evidence(label: string, evidenceScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope: evidenceScope,
  };
}

function admission(nodeId: string, policyRef: string, ownerRef = 'node-owner', nodeScope: ScopeRef = scope): NodeAdmission {
  return {
    nodeId,
    parentNodeId: null,
    nodeKind: 'execution',
    orchestrationPolicyRef: policyRef,
    inputRefs: ['input-a'],
    outputContractRef: 'output-contract-a',
    ownerRef,
    executionEpoch: 1,
    scope: nodeScope,
  };
}

function success(stepId: string, evidenceScope: ScopeRef = scope): NodeStepResult {
  return {
    stepId,
    state: 'succeeded',
    summary: `${stepId} succeeded`,
    outputRefs: [`output-${stepId}`],
    evidenceRefs: [evidence(stepId, evidenceScope)],
  };
}

test('fixed node lifecycle advances in order and rejects illegal transitions', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-serial', NODE_STRATEGY_REFS.serial));
  await assert.rejects(
    runtime.dispatch({
      nodeId: 'node-serial',
      policyRef: NODE_STRATEGY_REFS.serial,
      executionEpoch: 1,
      scope,
      ownerRef: 'node-owner',
      plan: runtime.get('node-serial').plan!,
    }),
    RuntimeError,
  );

  const order: string[] = [];
  const plan = runtime.plan({
    nodeId: 'node-serial',
    executionEpoch: 1,
    items: [
      { stepId: 'first', kind: 'execution', execute: async () => { order.push('first'); return success('first'); } },
      { stepId: 'second', kind: 'execution', execute: async () => { order.push('second'); return success('second'); } },
    ],
  });
  const dispatched = await runtime.dispatch({
    nodeId: 'node-serial',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  });
  assert.equal(dispatched.closure.state, 'succeeded');
  const observation = runtime.observe({ nodeId: 'node-serial', executionEpoch: 1, evidenceRefs: [evidence('observe')] });
  const closure = runtime.settle({ nodeId: 'node-serial', executionEpoch: 1, observation });

  assert.deepEqual(order, ['first', 'second']);
  assert.equal(closure.state, 'succeeded');
  assert.equal(runtime.get('node-serial').stage, 'settled');
  assert.equal(closure.ownerRef, 'node-owner');
  assert.equal(closure.nextAction.kind, 'continue');
  assert.throws(() => runtime.observe({ nodeId: 'node-serial', executionEpoch: 1 }), RuntimeError);
});

test('dispatch rejects concurrent redispatch while the first execution is in flight', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-race', NODE_STRATEGY_REFS.serial));
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const plan = runtime.plan({
    nodeId: 'node-race',
    executionEpoch: 1,
    items: [{
      stepId: 'only',
      kind: 'execution',
      execute: async () => {
        calls += 1;
        await gate;
        return success('only');
      },
    }],
  });
  const request = {
    nodeId: 'node-race',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  };

  const first = runtime.dispatch(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(runtime.dispatch(request), RuntimeError);
  assert.equal(calls, 1);
  assert.equal(runtime.get('node-race').stage, 'dispatched');

  release();
  const dispatched = await first;
  assert.equal(dispatched.closure.state, 'succeeded');
  assert.equal(calls, 1);
});

test('serial node failure closure retains output and evidence from earlier succeeded steps', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-serial-fail', NODE_STRATEGY_REFS.serial));
  const plan = runtime.plan({
    nodeId: 'node-serial-fail',
    executionEpoch: 1,
    items: [
      { stepId: 'first', kind: 'execution', execute: async () => success('first') },
      {
        stepId: 'second',
        kind: 'execution',
        execute: async () => ({
          stepId: 'second',
          state: 'failed',
          summary: 'second failed',
          outputRefs: ['output-second'],
          evidenceRefs: [evidence('second-failure')],
          failureRef: 'failure-second',
        }),
      },
    ],
  });

  const result = await runtime.dispatch({
    nodeId: 'node-serial-fail',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  });

  assert.equal(result.closure.state, 'failed');
  assert.deepEqual(result.closure.outputRefs, ['output-first', 'output-second']);
  assert.deepEqual(result.closure.evidenceRefs.map((ref) => ref.locator), ['first', 'second-failure']);
});

test('failed dispatch closure scopes authoritative evidence and preserves full diagnostic evidence', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-foreign-failure-evidence', NODE_STRATEGY_REFS.serial));
  const foreignEvidence = {
    ...evidence('foreign-accumulated'),
    scope: { ...scope, taskId: id('task', 'task-foreign') },
  };
  const laterFailure = new Error('later step failed');
  const plan = runtime.plan({
    nodeId: 'node-foreign-failure-evidence',
    executionEpoch: 1,
    items: [
      {
        stepId: 'first',
        kind: 'execution',
        execute: async () => ({ ...success('first'), evidenceRefs: [foreignEvidence] }),
      },
      {
        stepId: 'later',
        kind: 'execution',
        execute: async () => { throw laterFailure; },
      },
    ],
  });

  await assert.rejects(
    runtime.dispatch({
      nodeId: 'node-foreign-failure-evidence',
      policyRef: NODE_STRATEGY_REFS.serial,
      executionEpoch: 1,
      scope,
      ownerRef: 'node-owner',
      plan,
    }),
    (error) => error instanceof NodeDispatchError
      && error.cause === laterFailure
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'foreign-accumulated',
  );
  const closure = runtime.get('node-foreign-failure-evidence').closure;
  assert.equal(closure?.state, 'failed');
  assert.deepEqual(closure?.outputRefs, ['output-first']);
  assert.deepEqual(closure?.evidenceRefs, []);
});

test('nested node failure preserves conflicting evidence and exposes an integrity failure', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-evidence-conflict', NODE_STRATEGY_REFS.serial));
  const original = evidence('shared');
  const conflicting = { ...original, locator: 'replacement', digest: 'sha256:replacement' };
  const plan = runtime.plan({
    nodeId: 'node-evidence-conflict',
    executionEpoch: 1,
    items: [
      { stepId: 'first', kind: 'execution', execute: async () => ({ ...success('first'), evidenceRefs: [original] }) },
      {
        stepId: 'nested-failure',
        kind: 'execution',
        execute: async () => {
          throw new NodeDispatchError(
            'nested failure',
            { ownerRef: 'nested-owner', failureRef: 'nested-failure' },
            { outputRefs: ['nested-output'], evidenceRefs: [conflicting], cause: new Error('nested') },
          );
        },
      },
    ],
  });

  await assert.rejects(
    runtime.dispatch({
      nodeId: 'node-evidence-conflict',
      policyRef: NODE_STRATEGY_REFS.serial,
      executionEpoch: 1,
      scope,
      ownerRef: 'node-owner',
      plan,
    }),
    (error) => error instanceof NodeDispatchError
      && error.message.includes('conflicting evidence identity')
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'shared,replacement'
      && error.failureRef?.endsWith(':evidence-integrity') === true,
  );
  const closure = runtime.get('node-evidence-conflict').closure;
  assert.deepEqual(closure?.evidenceRefs.map((ref) => ref.locator), ['shared', 'replacement']);
});

test('normal node completion rejects conflicting evidence identities', async () => {
  const shared = evidence('normal-shared');
  const conflicting = { ...shared, locator: 'normal-replacement' };
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-normal-conflict', NODE_STRATEGY_REFS.serial));
  const plan = runtime.plan({
    nodeId: 'node-normal-conflict',
    executionEpoch: 1,
    items: [
      { stepId: 'first', kind: 'execution', execute: async () => ({ ...success('first'), evidenceRefs: [shared] }) },
      { stepId: 'second', kind: 'execution', execute: async () => ({ ...success('second'), evidenceRefs: [conflicting] }) },
    ],
  });

  await assert.rejects(
    runtime.dispatch({ nodeId: 'node-normal-conflict', policyRef: NODE_STRATEGY_REFS.serial, executionEpoch: 1, scope, ownerRef: 'node-owner', plan }),
    (error) => error instanceof NodeDispatchError
      && error.failureRef === 'node-dispatch:node-normal-conflict:evidence-integrity'
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'normal-shared,normal-replacement',
  );
  assert.equal(runtime.get('node-normal-conflict').closure?.state, 'failed');
  assert.deepEqual(runtime.get('node-normal-conflict').closure?.evidenceRefs.map((ref) => ref.locator), ['normal-shared', 'normal-replacement']);
});

test('node settlement rejects evidence identity conflicts introduced by observation', async () => {
  const shared = evidence('settle-shared');
  const conflicting = { ...shared, locator: 'settle-replacement' };
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-settle-conflict', NODE_STRATEGY_REFS.serial));
  const plan = runtime.plan({
    nodeId: 'node-settle-conflict',
    executionEpoch: 1,
    items: [{ stepId: 'only', kind: 'execution', execute: async () => ({ ...success('only'), evidenceRefs: [shared] }) }],
  });
  await runtime.dispatch({ nodeId: 'node-settle-conflict', policyRef: NODE_STRATEGY_REFS.serial, executionEpoch: 1, scope, ownerRef: 'node-owner', plan });
  const observation = runtime.observe({ nodeId: 'node-settle-conflict', executionEpoch: 1, evidenceRefs: [conflicting] });

  assert.throws(
    () => runtime.settle({ nodeId: 'node-settle-conflict', executionEpoch: 1, observation }),
    (error) => error instanceof NodeDispatchError
      && error.failureRef === 'node-settle:node-settle-conflict:evidence-integrity',
  );
  assert.equal(runtime.get('node-settle-conflict').stage, 'settled');
  assert.equal(runtime.get('node-settle-conflict').closure?.state, 'failed');
  assert.deepEqual(runtime.get('node-settle-conflict').closure?.evidenceRefs.map((ref) => ref.locator), ['settle-shared', 'settle-replacement']);
});

test('node observation and settlement reject evidence outside the node scope', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-evidence-scope', NODE_STRATEGY_REFS.serial));
  const plan = runtime.plan({
    nodeId: 'node-evidence-scope',
    executionEpoch: 1,
    items: [{ stepId: 'only', kind: 'execution', execute: async () => success('only') }],
  });
  await runtime.dispatch({ nodeId: 'node-evidence-scope', policyRef: NODE_STRATEGY_REFS.serial, executionEpoch: 1, scope, ownerRef: 'node-owner', plan });

  const foreignEvidence = {
    ...evidence('foreign'),
    scope: { organId: id('organ', 'organ-foreign'), taskId: task },
  };
  assert.throws(
    () => runtime.observe({ nodeId: 'node-evidence-scope', executionEpoch: 1, evidenceRefs: [foreignEvidence] }),
    RuntimeError,
  );
  assert.equal(runtime.get('node-evidence-scope').stage, 'dispatched');

  const observation = runtime.observe({ nodeId: 'node-evidence-scope', executionEpoch: 1, evidenceRefs: [evidence('observe')] });
  assert.throws(
    () => runtime.settle({ nodeId: 'node-evidence-scope', executionEpoch: 1, observation, evidenceRefs: [foreignEvidence] }),
    RuntimeError,
  );
  assert.equal(runtime.get('node-evidence-scope').stage, 'observed');
});

test('node dispatch rejects closure evidence outside the node task scope', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  const nodeScope: ScopeRef = {
    ...scope,
    cycleId: id('cycle', 'cycle-a'),
    operationId: id('operation', 'operation-a'),
  };
  runtime.admit(admission('node-closure-evidence-scope', NODE_STRATEGY_REFS.serial, 'node-owner', nodeScope));
  const validEvidence = evidence('valid-closure', nodeScope);
  const foreignEvidence = evidence('foreign-closure', {
    ...nodeScope,
    cycleId: id('cycle', 'cycle-foreign'),
    operationId: id('operation', 'operation-foreign'),
  });
  const plan = runtime.plan({
    nodeId: 'node-closure-evidence-scope',
    executionEpoch: 1,
    items: [{
      stepId: 'only',
      kind: 'execution',
      execute: async () => ({
        ...success('only'),
        outputRefs: ['output-valid-closure', 'output-foreign-closure'],
        evidenceRefs: [validEvidence, foreignEvidence],
      }),
    }],
  });

  await assert.rejects(
    runtime.dispatch({ nodeId: 'node-closure-evidence-scope', policyRef: NODE_STRATEGY_REFS.serial, executionEpoch: 1, scope: nodeScope, ownerRef: 'node-owner', plan }),
    (error) => error instanceof NodeDispatchError
      && error.failureRef === 'node-dispatch:node-closure-evidence-scope:evidence-scope'
      && error.outputRefs.join(',') === 'output-valid-closure,output-foreign-closure'
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'valid-closure,foreign-closure',
  );
  const closure = runtime.get('node-closure-evidence-scope').closure;
  assert.equal(closure?.state, 'failed');
  assert.deepEqual(closure?.outputRefs, ['output-valid-closure', 'output-foreign-closure']);
  assert.deepEqual(closure?.evidenceRefs, [validEvidence]);
  assert.deepEqual(closure?.diagnosticEvidenceRefs, [validEvidence, foreignEvidence]);
});

test('serial closure validation failure retains completed output and evidence', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-serial-invalid-closure', NODE_STRATEGY_REFS.serial));
  const plan = runtime.plan({
    nodeId: 'node-serial-invalid-closure',
    executionEpoch: 1,
    items: [
      { stepId: 'first', kind: 'execution', execute: async () => success('first') },
      {
        stepId: 'invalid-wait',
        kind: 'execution',
        execute: async () => ({
          stepId: 'invalid-wait',
          state: 'waiting' as const,
          summary: 'waiting result is missing its condition',
          outputRefs: ['output-invalid-wait'],
          evidenceRefs: [evidence('invalid-wait')],
        }),
      },
    ],
  });

  await assert.rejects(
    runtime.dispatch({
      nodeId: 'node-serial-invalid-closure',
      policyRef: NODE_STRATEGY_REFS.serial,
      executionEpoch: 1,
      scope,
      ownerRef: 'node-owner',
      plan,
    }),
    (error) => error instanceof NodeDispatchError
      && error.outputRefs.join(',') === 'output-first,output-invalid-wait'
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'first,invalid-wait',
  );
  const closure = runtime.get('node-serial-invalid-closure').closure;
  assert.equal(closure?.state, 'failed');
  assert.deepEqual(closure?.outputRefs, ['output-first', 'output-invalid-wait']);
  assert.deepEqual(closure?.evidenceRefs.map((ref) => ref.locator), ['first', 'invalid-wait']);
});

test('dispatch failure after execution starts preserves failed closure and blocks unsafe retry', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-retry', NODE_STRATEGY_REFS.serial));
  let attempts = 0;
  const plan = runtime.plan({
    nodeId: 'node-retry',
    executionEpoch: 1,
    items: [{
      stepId: 'only',
      kind: 'execution',
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient dispatch failure');
        return success('only');
      },
    }],
  });
  const request = {
    nodeId: 'node-retry',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  };

  await assert.rejects(runtime.dispatch(request), /transient dispatch failure/);
  assert.equal(runtime.get('node-retry').stage, 'dispatched');
  assert.equal(runtime.get('node-retry').closure?.state, 'failed');

  await assert.rejects(runtime.dispatch(request), RuntimeError);
  assert.equal(attempts, 1);
});

test('post-dispatch closure validation failure preserves failed closure and blocks unsafe retry', async () => {
  const registry = new NodeStrategyRegistry();
  let attempts = 0;
  registry.register({
    policyRef: 'valid-after-validation',
    dispatch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          closure: {
            nodeId: 'node-invalid-closure',
            state: 'failed',
            ownerRef: 'node-owner',
            nextAction: { kind: 'recover', ref: 'missing-failure-ref' },
            outputRefs: [],
            evidenceRefs: [],
          },
        };
      }
      return {
        closure: {
          nodeId: 'node-invalid-closure',
          state: 'succeeded',
          ownerRef: 'node-owner',
          nextAction: { kind: 'continue', ref: 'checkpoint' },
          outputRefs: ['output-only'],
          evidenceRefs: [evidence('only')],
        },
      };
    },
  });
  const runtime = new HarnessNodeRuntime(registry);
  runtime.admit(admission('node-invalid-closure', 'valid-after-validation'));
  const plan = runtime.plan({ nodeId: 'node-invalid-closure', executionEpoch: 1 });
  const request = {
    nodeId: 'node-invalid-closure',
    policyRef: 'valid-after-validation',
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  };

  await assert.rejects(runtime.dispatch(request), RuntimeError);
  assert.equal(runtime.get('node-invalid-closure').stage, 'dispatched');
  assert.equal(runtime.get('node-invalid-closure').closure?.state, 'failed');

  await assert.rejects(runtime.dispatch(request), RuntimeError);
  assert.equal(attempts, 1);
});

test('strategy registry rejects duplicates and unknown policy references', async () => {
  const registry = createDefaultNodeStrategyRegistry();
  assert.throws(() => registry.register({ policyRef: NODE_STRATEGY_REFS.serial, dispatch: async () => { throw new Error('unreachable'); } }), RuntimeError);
  const runtime = new HarnessNodeRuntime(registry);
  assert.throws(() => runtime.admit(admission('node-unknown', 'not-registered')), RuntimeError);
  assert.deepEqual([...registry.refs()].sort(), [
    NODE_STRATEGY_REFS.parallelJoin,
    NODE_STRATEGY_REFS.reviewRemediation,
    NODE_STRATEGY_REFS.serial,
    NODE_STRATEGY_REFS.waitForCondition,
  ]);
});

test('wait-for-condition and review-remediation return explicit ownership and next actions', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-wait', NODE_STRATEGY_REFS.waitForCondition));
  const waitPlan = runtime.plan({ nodeId: 'node-wait', executionEpoch: 1, conditionRef: 'dependency-ready' });
  const waiting = await runtime.dispatch({
    nodeId: 'node-wait',
    policyRef: NODE_STRATEGY_REFS.waitForCondition,
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan: waitPlan,
  });
  assert.equal(waiting.closure.state, 'waiting');
  assert.equal(waiting.closure.ownerRef, 'node-owner');
  assert.deepEqual(waiting.closure.nextAction, { kind: 'wait', ref: 'dependency-ready' });

  runtime.admit(admission('node-review', NODE_STRATEGY_REFS.reviewRemediation, 'review-owner'));
  const reviewPlan = runtime.plan({
    nodeId: 'node-review',
    executionEpoch: 1,
    remediationRef: 'remediation-a',
    items: [{
      stepId: 'review',
      kind: 'review',
      execute: async () => ({
        stepId: 'review',
        state: 'blocked',
        summary: 'finding requires remediation',
        outputRefs: [],
        evidenceRefs: [evidence('review-finding')],
      }),
    }],
  });
  const review = await runtime.dispatch({
    nodeId: 'node-review',
    policyRef: NODE_STRATEGY_REFS.reviewRemediation,
    executionEpoch: 1,
    scope,
    ownerRef: 'review-owner',
    plan: reviewPlan,
  });
  assert.equal(review.closure.state, 'blocked');
  assert.equal(review.closure.ownerRef, 'review-owner');
  assert.deepEqual(review.closure.nextAction, { kind: 'recover', ref: 'remediation-a' });
  assert.equal(review.closure.conditionRef, 'remediation-a');
});

test('parallel-join reports blocking step without converting it to success', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-parallel', NODE_STRATEGY_REFS.parallelJoin, 'parallel-owner'));
  const plan = runtime.plan({
    nodeId: 'node-parallel',
    executionEpoch: 1,
    items: [
      { stepId: 'left', kind: 'execution', execute: async () => success('left') },
      {
        stepId: 'right',
        kind: 'execution',
        execute: async () => ({
          stepId: 'right',
          state: 'failed',
          summary: 'external operation failed',
          outputRefs: [],
          evidenceRefs: [evidence('right-failure')],
          failureRef: 'failure-right',
        }),
      },
    ],
  });
  const result = await runtime.dispatch({
    nodeId: 'node-parallel',
    policyRef: NODE_STRATEGY_REFS.parallelJoin,
    executionEpoch: 1,
    scope,
    ownerRef: 'parallel-owner',
    plan,
  });
  assert.equal(result.closure.state, 'failed');
  assert.equal(result.closure.ownerRef, 'parallel-owner');
  assert.equal(result.closure.failureRef, 'failure-right');
  assert.deepEqual(result.closure.nextAction, { kind: 'recover', ref: 'failure-right' });
  assert.deepEqual(result.closure.outputRefs, ['output-left']);
  assert.deepEqual(result.closure.evidenceRefs.map((ref) => ref.locator), ['left', 'right-failure']);
});

test('parallel join closure validation failure retains completed output and evidence', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-parallel-invalid-closure', NODE_STRATEGY_REFS.parallelJoin, 'parallel-owner'));
  const plan = runtime.plan({
    nodeId: 'node-parallel-invalid-closure',
    executionEpoch: 1,
    items: [
      { stepId: 'left', kind: 'execution', execute: async () => success('left') },
      {
        stepId: 'invalid-wait',
        kind: 'execution',
        execute: async () => ({
          stepId: 'invalid-wait',
          state: 'waiting' as const,
          summary: 'waiting result is missing its condition',
          outputRefs: ['output-invalid-wait'],
          evidenceRefs: [evidence('parallel-invalid-wait')],
        }),
      },
    ],
  });

  await assert.rejects(
    runtime.dispatch({
      nodeId: 'node-parallel-invalid-closure',
      policyRef: NODE_STRATEGY_REFS.parallelJoin,
      executionEpoch: 1,
      scope,
      ownerRef: 'parallel-owner',
      plan,
    }),
    (error) => error instanceof NodeDispatchError
      && error.outputRefs.join(',') === 'output-left,output-invalid-wait'
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'left,parallel-invalid-wait',
  );
  const closure = runtime.get('node-parallel-invalid-closure').closure;
  assert.equal(closure?.state, 'failed');
  assert.deepEqual(closure?.outputRefs, ['output-left', 'output-invalid-wait']);
  assert.deepEqual(closure?.evidenceRefs.map((ref) => ref.locator), ['left', 'parallel-invalid-wait']);
});

test('parallel join exposes rejection only after every item settles so retry waits for in-flight work', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-parallel-wait', NODE_STRATEGY_REFS.parallelJoin, 'parallel-owner'));
  let attempts = 0;
  let releaseSecond: () => void = () => {};
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const order: string[] = [];
  const plan = runtime.plan({
    nodeId: 'node-parallel-wait',
    executionEpoch: 1,
    items: [
      {
        stepId: 'reject-first',
        kind: 'execution',
        execute: async () => {
          attempts += 1;
          order.push('reject-first');
          throw new Error('original parallel failure');
        },
      },
      {
        stepId: 'settle-second',
        kind: 'execution',
        execute: async () => {
          attempts += 1;
          order.push('settle-second');
          await secondGate;
          order.push('settle-second-done');
          return success('settle-second');
        },
      },
    ],
  });
  const request = {
    nodeId: 'node-parallel-wait',
    policyRef: NODE_STRATEGY_REFS.parallelJoin,
    executionEpoch: 1,
    scope,
    ownerRef: 'parallel-owner',
    plan,
  };

  const first = runtime.dispatch(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['reject-first', 'settle-second']);
  assert.equal(runtime.get('node-parallel-wait').stage, 'dispatched');

  await assert.rejects(runtime.dispatch(request), RuntimeError);
  assert.equal(runtime.get('node-parallel-wait').stage, 'dispatched');
  assert.equal(attempts, 2);

  releaseSecond();
  await assert.rejects(first, /original parallel failure/);
  assert.deepEqual(order, ['reject-first', 'settle-second', 'settle-second-done']);
  assert.equal(runtime.get('node-parallel-wait').stage, 'dispatched');
  assert.equal(runtime.get('node-parallel-wait').closure?.state, 'failed');
});

test('parallel join preserves an undefined rejection after every item settles', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-parallel-undefined', NODE_STRATEGY_REFS.parallelJoin, 'parallel-owner'));
  let releaseSecond: () => void = () => {};
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let secondSettled = false;
  const plan = runtime.plan({
    nodeId: 'node-parallel-undefined',
    executionEpoch: 1,
    items: [
      {
        stepId: 'reject-undefined',
        kind: 'execution',
        execute: () => { throw undefined; },
      },
      {
        stepId: 'settle-after-undefined',
        kind: 'execution',
        execute: async () => {
          await secondGate;
          secondSettled = true;
          return success('settle-after-undefined');
        },
      },
    ],
  });
  const request = {
    nodeId: 'node-parallel-undefined',
    policyRef: NODE_STRATEGY_REFS.parallelJoin,
    executionEpoch: 1,
    scope,
    ownerRef: 'parallel-owner',
    plan,
  };

  const first = runtime.dispatch(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(runtime.dispatch(request), RuntimeError);
  assert.equal(secondSettled, false);
  releaseSecond();
  await assert.rejects(first, (failure) => failure instanceof RuntimeError && (failure as { cause: unknown }).cause === undefined);
  assert.equal(secondSettled, true);
  assert.equal(runtime.get('node-parallel-undefined').stage, 'dispatched');
  assert.equal(runtime.get('node-parallel-undefined').closure?.state, 'failed');
});

test('review remediation closure validation failure retains completed output and evidence', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-review-invalid-closure', NODE_STRATEGY_REFS.reviewRemediation, 'review-owner'));
  const plan = runtime.plan({
    nodeId: 'node-review-invalid-closure',
    executionEpoch: 1,
    items: [
      { stepId: 'review-first', kind: 'review', execute: async () => success('review-first') },
      {
        stepId: 'review-invalid-wait',
        kind: 'review',
        execute: async () => ({
          stepId: 'review-invalid-wait',
          state: 'waiting' as const,
          summary: 'waiting review result is missing its condition',
          outputRefs: ['output-review-invalid-wait'],
          evidenceRefs: [evidence('review-invalid-wait')],
        }),
      },
    ],
  });

  await assert.rejects(
    runtime.dispatch({
      nodeId: 'node-review-invalid-closure',
      policyRef: NODE_STRATEGY_REFS.reviewRemediation,
      executionEpoch: 1,
      scope,
      ownerRef: 'review-owner',
      plan,
    }),
    (error) => error instanceof NodeDispatchError
      && error.outputRefs.join(',') === 'output-review-first,output-review-invalid-wait'
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'review-first,review-invalid-wait',
  );
  const closure = runtime.get('node-review-invalid-closure').closure;
  assert.equal(closure?.state, 'failed');
  assert.deepEqual(closure?.outputRefs, ['output-review-first', 'output-review-invalid-wait']);
  assert.deepEqual(closure?.evidenceRefs.map((ref) => ref.locator), ['review-first', 'review-invalid-wait']);
});

test('dispatch rejects scope mismatch before strategy execution or lifecycle advance', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-scope', NODE_STRATEGY_REFS.serial));
  let calls = 0;
  const plan = runtime.plan({
    nodeId: 'node-scope',
    executionEpoch: 1,
    items: [{
      stepId: 'scope',
      kind: 'execution',
      execute: async () => {
        calls += 1;
        return success('scope');
      },
    }],
  });
  const otherScope: ScopeRef = { ...scope, taskId: id('task', 'task-b') };

  await assert.rejects(runtime.dispatch({
    nodeId: 'node-scope',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope: otherScope,
    ownerRef: 'node-owner',
    plan,
  }), ContractError);
  await assert.rejects(runtime.dispatch({
    nodeId: 'node-scope',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan: { ...plan, scope: otherScope },
  }), ContractError);

  assert.equal(calls, 0);
  assert.equal(runtime.get('node-scope').stage, 'planned');
});

test('dispatch rejects owner mismatch before strategy execution or lifecycle advance', async () => {
  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('node-owner', NODE_STRATEGY_REFS.serial));
  let calls = 0;
  const plan = runtime.plan({
    nodeId: 'node-owner',
    executionEpoch: 1,
    items: [{
      stepId: 'owner',
      kind: 'execution',
      execute: async () => {
        calls += 1;
        return success('owner');
      },
    }],
  });

  await assert.rejects(runtime.dispatch({
    nodeId: 'node-owner',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope,
    ownerRef: 'other-owner',
    plan,
  }), RuntimeError);

  assert.equal(calls, 0);
  assert.equal(runtime.get('node-owner').stage, 'planned');
});

test('strategy result validation rejects a result for another node', async () => {
  const registry = new NodeStrategyRegistry();
  registry.register({
    policyRef: 'bad-result',
    dispatch: async () => ({
      closure: {
        nodeId: 'other-node',
        state: 'succeeded',
        ownerRef: 'node-owner',
        nextAction: { kind: 'continue', ref: 'checkpoint' },
        outputRefs: ['output-other-node'],
        evidenceRefs: [evidence('other-node')],
      },
    }),
  });
  const runtime = new HarnessNodeRuntime(registry);
  runtime.admit(admission('node-bad', 'bad-result'));
  const plan = runtime.plan({ nodeId: 'node-bad', executionEpoch: 1 });
  await assert.rejects(runtime.dispatch({
    nodeId: 'node-bad',
    policyRef: 'bad-result',
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  }), RuntimeError);
  assert.equal(runtime.get('node-bad').stage, 'dispatched');
  assert.equal(runtime.get('node-bad').closure?.state, 'failed');
  assert.deepEqual(runtime.get('node-bad').closure?.outputRefs, ['output-other-node']);
  assert.deepEqual(runtime.get('node-bad').closure?.evidenceRefs.map((ref) => ref.locator), ['other-node']);
});

test('strategy result validation rejects a closure for another owner before storing it', async () => {
  const registry = new NodeStrategyRegistry();
  registry.register({
    policyRef: 'bad-owner',
    dispatch: async () => ({
      closure: {
        nodeId: 'node-bad-owner',
        state: 'succeeded',
        ownerRef: 'other-owner',
        nextAction: { kind: 'continue', ref: 'checkpoint' },
        outputRefs: ['output-bad-owner'],
        evidenceRefs: [evidence('bad-owner')],
      },
    }),
  });
  const runtime = new HarnessNodeRuntime(registry);
  runtime.admit(admission('node-bad-owner', 'bad-owner'));
  const plan = runtime.plan({ nodeId: 'node-bad-owner', executionEpoch: 1 });

  await assert.rejects(runtime.dispatch({
    nodeId: 'node-bad-owner',
    policyRef: 'bad-owner',
    executionEpoch: 1,
    scope,
    ownerRef: 'node-owner',
    plan,
  }), RuntimeError);
  assert.equal(runtime.get('node-bad-owner').stage, 'dispatched');
  assert.equal(runtime.get('node-bad-owner').closure?.state, 'failed');
  assert.deepEqual(runtime.get('node-bad-owner').closure?.outputRefs, ['output-bad-owner']);
  assert.deepEqual(runtime.get('node-bad-owner').closure?.evidenceRefs.map((ref) => ref.locator), ['bad-owner']);
});

test('nested dispatch failure retains child output and evidence in the parent closure', async () => {
  const child = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  child.admit(admission('child-node', NODE_STRATEGY_REFS.serial, 'child-owner'));
  const childPlan = child.plan({
    nodeId: 'child-node',
    executionEpoch: 1,
    items: [
      { stepId: 'child-first', kind: 'execution', execute: async () => success('child-first') },
      {
        stepId: 'child-invalid-wait',
        kind: 'execution',
        execute: async () => ({
          stepId: 'child-invalid-wait',
          state: 'waiting' as const,
          summary: 'child waiting result is missing its condition',
          outputRefs: ['output-child-invalid-wait'],
          evidenceRefs: [evidence('child-invalid-wait')],
        }),
      },
    ],
  });

  const runtime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  runtime.admit(admission('parent-node', NODE_STRATEGY_REFS.serial, 'parent-owner'));
  const plan = runtime.plan({
    nodeId: 'parent-node',
    executionEpoch: 1,
    items: [{
      stepId: 'child-dispatch',
      kind: 'execution',
      execute: async () => {
        await child.dispatch({
          nodeId: 'child-node',
          policyRef: NODE_STRATEGY_REFS.serial,
          executionEpoch: 1,
          scope,
          ownerRef: 'child-owner',
          plan: childPlan,
        });
        throw new Error('child dispatch unexpectedly succeeded');
      },
    }],
  });

  await assert.rejects(
    runtime.dispatch({
      nodeId: 'parent-node',
      policyRef: NODE_STRATEGY_REFS.serial,
      executionEpoch: 1,
      scope,
      ownerRef: 'parent-owner',
      plan,
    }),
    (error) => error instanceof NodeDispatchError
      && error.outputRefs.join(',') === 'output-child-first,output-child-invalid-wait'
      && error.evidenceRefs.map((ref) => ref.locator).join(',') === 'child-first,child-invalid-wait',
  );
  const closure = runtime.get('parent-node').closure;
  assert.equal(closure?.state, 'failed');
  assert.deepEqual(closure?.outputRefs, ['output-child-first', 'output-child-invalid-wait']);
  assert.deepEqual(closure?.evidenceRefs.map((ref) => ref.locator), ['child-first', 'child-invalid-wait']);
});
