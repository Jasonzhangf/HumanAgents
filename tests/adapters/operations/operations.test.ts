import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type OperationIntent,
  type Scope,
} from '../../../packages/contracts/src/index.js';
import {
  DETERMINISTIC_INSPECT_TOOL_NAME,
  DeterministicInspectRoute,
  LegacyInternalRouteAdapter,
  OperationAdapterError,
  type LegacyInternalExecutionContext,
  type OperationExecutionRequest,
} from '../../../packages/adapters/operations/src/index.js';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const cycleId = id('cycle', 'cycle-a');
const operationId = id('operation', 'operation-a');
const requestedScope: Scope = { organId, taskId, cycleId, operationId };
const effectiveScope: Scope = { organId, taskId, cycleId, operationId };

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    operationId,
    taskId,
    cycleId,
    requestedBy: 'agent-a',
    intentRevision: 'revision-1',
    kind: 'inspect',
    toolName: DETERMINISTIC_INSPECT_TOOL_NAME,
    inputRef: 'artifact://input/one',
    inputDigest: 'sha256:input-one',
    requestedScope,
    idempotencyKey: 'idempotency-one',
    expectedOutput: {
      schemaRef: 'schema://inspect-result',
      requiredEvidenceKinds: ['external', 'tool'],
    },
    ...overrides,
  };
}

function request(overrides: Partial<OperationIntent> = {}, scope: Scope = effectiveScope): OperationExecutionRequest {
  return { intent: intent(overrides), effectiveScope: scope };
}

test('deterministic inspect returns repeatable artifact and evidence refs without external side effects', async () => {
  const route = new DeterministicInspectRoute({ now: () => '2026-09-20T00:00:00.000Z' });
  const first = await route.inspect(request());
  const second = await route.inspect(request());

  assert.deepEqual(second, first);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.operationId.value, operationId.value);
  assert.equal(first.outputRef, 'artifact://operations/inspect/operation-a');
  assert.equal(first.outputDigest, 'sha256:bd4f568eb120d3cd66f8bb44abf12ef572b67bbcfc20c931902242d35671bbcb');
  assert.deepEqual(first.evidenceRefs.map((ref) => ref.kind), ['external', 'tool']);
  assert.deepEqual(first.evidenceRefs.map((ref) => ref.scope), [effectiveScope, effectiveScope]);
  assert.deepEqual(first.verifier, {
    name: 'deterministic-inspect',
    version: 'deterministic-inspect.v1',
    decision: 'passed',
  });
});

test('inspect verification failure is visible as a structured failed result', async () => {
  const route = new DeterministicInspectRoute({ now: () => '2026-09-20T00:00:00.000Z' });
  const result = await route.verify({
    intent: intent(),
    effectiveScope,
    observation: { operationId, evidenceRefs: [] },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.phase, 'verification');
  assert.equal(result.failure?.failureClass, 'verifier');
  assert.equal(result.failure?.operationId.value, operationId.value);
  assert.equal(result.failure?.nextAction.kind, 'recover');
  assert.equal(result.failure?.evidenceRefs.length, 1);
  assert.deepEqual(result.evidenceRefs, result.failure?.evidenceRefs);
  assert.equal(result.outputRef, undefined);
  assert.equal(result.outputDigest, undefined);
  assert.deepEqual(result.failure?.evidenceRefs[0]?.scope, effectiveScope);
});

test('inspect verification rejects observation from a different operation', async () => {
  const route = new DeterministicInspectRoute({ now: () => '2026-09-20T00:00:00.000Z' });
  const otherOperationId = id('operation', 'operation-b');
  const result = await route.verify({
    intent: intent(),
    effectiveScope,
    observation: {
      operationId: otherOperationId,
      outputRef: 'artifact://operations/inspect/operation-b',
      outputDigest: 'sha256:other-operation',
      evidenceRefs: [{
        evidenceId: id('evidence', 'other-operation-evidence'),
        kind: 'tool',
        source: 'test',
        locator: 'test://other-operation',
        scope: effectiveScope,
      }],
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.failure?.message ?? '', /operation id/);
  assert.equal(result.outputRef, undefined);
  assert.equal(result.outputDigest, undefined);
  assert.equal(result.evidenceRefs.length, 1);
  assert.equal(result.evidenceRefs[0]?.locator, 'operations://failure/operation-a/operation-id-mismatch');
  assert.deepEqual(result.evidenceRefs[0]?.scope, effectiveScope);
});

test('inspect verification rejects evidence outside the effective operation scope', async () => {
  const route = new DeterministicInspectRoute({ now: () => '2026-09-20T00:00:00.000Z' });
  const foreignScope: Scope = { organId, taskId: id('task', 'task-b'), cycleId, operationId };
  const result = await route.verify({
    intent: intent(),
    effectiveScope,
    observation: {
      operationId,
      outputRef: 'artifact://operations/inspect/operation-a',
      outputDigest: 'sha256:operation-a',
      evidenceRefs: [
        {
          evidenceId: id('evidence', 'current-operation-evidence'),
          kind: 'external',
          source: 'test',
          locator: 'test://current-operation',
          scope: effectiveScope,
        },
        {
          evidenceId: id('evidence', 'foreign-operation-evidence'),
          kind: 'tool',
          source: 'test',
          locator: 'test://foreign-operation',
          scope: foreignScope,
        },
      ],
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.failure?.message ?? '', /evidence scope/);
  assert.equal(result.outputRef, undefined);
  assert.equal(result.outputDigest, undefined);
  assert.equal(result.evidenceRefs.length, 1);
  assert.equal(result.evidenceRefs[0]?.locator, 'operations://failure/operation-a/evidence-scope-mismatch');
  assert.deepEqual(result.evidenceRefs[0]?.scope, effectiveScope);
});

test('inspect verification rejects a forged deterministic output', async () => {
  const route = new DeterministicInspectRoute({ now: () => '2026-09-20T00:00:00.000Z' });
  const expected = await route.execute(request());
  const result = await route.verify({
    intent: intent(),
    effectiveScope,
    observation: {
      ...expected,
      outputRef: 'artifact://operations/inspect/forged',
      outputDigest: 'sha256:forged',
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'verifier');
  assert.match(result.failure?.message ?? '', /deterministic route result/);
});

test('inspect scope expansion fails explicitly before any result is claimed', async () => {
  const route = new DeterministicInspectRoute({ now: () => '2026-09-20T00:00:00.000Z' });
  const narrowedRequest: Scope = { organId: id('organ', 'organ-b'), taskId, cycleId, operationId };

  await assert.rejects(
    () => route.inspect(request({ requestedScope: narrowedRequest }, requestedScope)),
    (error) => {
      assert.ok(error instanceof OperationAdapterError);
      assert.equal(error.failure.phase, 'admission');
      assert.equal(error.failure.failureClass, 'permission');
      assert.equal(error.failure.operationId.value, operationId.value);
      return true;
    },
  );
});

test('legacy adapter preserves entry identity, scope, and exact thrown errors without fallback execution', async () => {
  const thrown = new Error('legacy tool failed');
  const contexts: LegacyInternalExecutionContext[] = [];
  let calls = 0;
  const adapter = new LegacyInternalRouteAdapter({
    entryId: 'internal.tool.one',
    async execute(context) {
      calls += 1;
      contexts.push(context);
      throw thrown;
    },
  });

  await assert.rejects(
    () => adapter.execute(request({ toolName: 'legacy.internal.one' })),
    (error) => error === thrown,
  );
  assert.equal(calls, 1);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].entryId, 'internal.tool.one');
  assert.equal(contexts[0].operationId.value, operationId.value);
  assert.deepEqual(contexts[0].scope, effectiveScope);
  assert.equal(contexts[0].inputRef, 'artifact://input/one');
});

test('legacy adapter wraps successful output under the old entry identity', async () => {
  const adapter = new LegacyInternalRouteAdapter({
    entryId: 'internal.tool.two',
    async execute(context) {
      return {
        outputRef: `artifact://legacy/${context.entryId}/custom`,
        outputDigest: 'sha256:legacy-output',
        evidenceRefs: [{
          evidenceId: id('evidence', 'legacy-success'),
          kind: 'tool',
          source: 'legacy-test',
          locator: 'legacy://success',
          scope: effectiveScope,
        }],
      };
    },
  });

  const observation = await adapter.execute(request({ toolName: 'legacy.internal.two' }));

  assert.equal(observation.operationId.value, operationId.value);
  assert.equal(observation.outputRef, 'artifact://legacy/internal.tool.two/custom');
  assert.equal(observation.outputDigest, 'sha256:legacy-output');
  assert.equal(observation.evidenceRefs.length, 1);
  assert.equal(observation.evidenceRefs[0].source, 'legacy-test');
  assert.deepEqual(observation.evidenceRefs[0].scope, effectiveScope);
});

test('legacy adapter rejects incomplete output instead of inventing an artifact', async () => {
  const adapter = new LegacyInternalRouteAdapter({
    entryId: 'internal.tool.incomplete',
    async execute() { return undefined; },
  });

  await assert.rejects(
    () => adapter.execute(request()),
    (error) => error instanceof OperationAdapterError
      && error.failure.failureClass === 'contract'
      && /complete output/.test(error.failure.message),
  );
});

test('legacy adapter rejects evidence outside the effective scope', async () => {
  const adapter = new LegacyInternalRouteAdapter({
    entryId: 'internal.tool.foreign',
    async execute() {
      return {
        outputRef: 'artifact://legacy/foreign/output',
        outputDigest: 'sha256:foreign',
        evidenceRefs: [{
          evidenceId: id('evidence', 'foreign-evidence'),
          kind: 'tool',
          source: 'legacy-test',
          locator: 'legacy://foreign',
          scope: { ...effectiveScope, taskId: id('task', 'task-b') },
        }],
      };
    },
  });

  await assert.rejects(
    () => adapter.execute(request()),
    (error) => error instanceof OperationAdapterError
      && /scope/.test(error.failure.message),
  );
});

test('legacy adapter rejects evidence with a broader scope than the operation', async () => {
  const adapter = new LegacyInternalRouteAdapter({
    entryId: 'internal.tool.broad',
    async execute() {
      return {
        outputRef: 'artifact://legacy/broad/output',
        outputDigest: 'sha256:broad',
        evidenceRefs: [{
          evidenceId: id('evidence', 'broad-evidence'),
          kind: 'tool',
          source: 'legacy-test',
          locator: 'legacy://broad',
          scope: { organId },
        }],
      };
    },
  });

  await assert.rejects(
    () => adapter.execute(request()),
    (error) => error instanceof OperationAdapterError
      && /scope/.test(error.failure.message),
  );
});
