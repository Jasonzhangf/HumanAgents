import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createToolExecutionGateway,
} from '../../packages/app/src/index.js';
import { DeterministicInspectRoute } from '../../packages/adapters/operations/src/index.js';
import { id, type EvidenceRef, type OperationEvent, type OperationIntent, type Scope } from '../../packages/contracts/src/index.js';
import type { OperationJournalPort } from '../../packages/runtime/src/gateway/index.js';

const organ = id('organ', 'app-gateway-organ');
const task = id('task', 'app-gateway-task');
const cycle = id('cycle', 'app-gateway-cycle');
const operation = id('operation', 'app-gateway-operation');
const scope: Scope = { organId: organ, taskId: task, cycleId: cycle };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `app-gateway-${label}`),
    kind: 'operation',
    source: 'app-gateway-test',
    locator: `test://${label}`,
    scope,
  };
}

function intent(): OperationIntent {
  return {
    operationId: operation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'app-gateway-test',
    intentRevision: 'revision-1',
    kind: 'inspect',
    toolName: 'deterministic.inspect',
    inputRef: 'artifact://input/app-gateway',
    inputDigest: 'sha256:app-gateway-input',
    requestedScope: scope,
    idempotencyKey: 'app-gateway-idempotency',
    expectedOutput: {
      schemaRef: 'schema://inspect-output/v1',
      requiredEvidenceKinds: ['external', 'tool'],
    },
  };
}

const journal: OperationJournalPort = {
  async commit(_event: OperationEvent): Promise<void> {},
  async publishCommitted(_event: OperationEvent): Promise<void> {},
};

function recordingJournal(): OperationJournalPort & { readonly committed: OperationEvent[] } {
  const committed: OperationEvent[] = [];
  return {
    committed,
    async commit(event) {
      committed.push(event);
    },
    async publishCommitted(_event) {},
  };
}

test('app assembly registers the deterministic operations route in the execution gateway', async () => {
  const gateway = createToolExecutionGateway({
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('permission')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('boundary')] };
      },
    },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const submitted = await gateway.submit(intent());
  const result = await gateway.execute(operation);

  assert.equal(submitted.operation.route?.routeId, 'deterministic-inspect');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result?.outputRef, 'artifact://operations/inspect/app-gateway-operation');
});

test('app assembly rejects an adapter observation with a different operation identity', async () => {
  const foreignOperation = id('operation', 'app-gateway-foreign-operation');
  class MismatchedRoute extends DeterministicInspectRoute {
    override async execute(input: Parameters<DeterministicInspectRoute['execute']>[0]) {
      const observation = await super.execute(input);
      return { ...observation, operationId: foreignOperation };
    }
  }
  const mismatchJournal = recordingJournal();
  const gateway = createToolExecutionGateway({
    route: new MismatchedRoute(),
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('permission-mismatch')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('boundary-mismatch')] };
      },
    },
    journal: mismatchJournal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  await gateway.submit({ ...intent(), idempotencyKey: 'app-gateway-mismatch-idempotency' });
  const result = await gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'contract');
  assert.equal(result.failure?.owner, 'humanagent.operations-adapter');
  assert.equal(result.failure?.nextAction.ref, 'deterministic-inspect');
  assert.match(result.failure?.message ?? '', /different operation/);
  assert.equal(result.failure?.evidenceRefs.length, 1);
  assert.equal(result.failure?.evidenceRefs[0]?.source, 'humanagent.operations-adapter');
  assert.equal(result.result?.failure, result.failure);
  assert.equal(mismatchJournal.committed.at(-1)?.failure, result.failure);
});

test('app assembly rejects an adapter verification result with a different operation identity', async () => {
  const foreignOperation = id('operation', 'app-gateway-foreign-verification');
  class MismatchedVerifierRoute extends DeterministicInspectRoute {
    override async verify(input: Parameters<DeterministicInspectRoute['verify']>[0]) {
      const result = await super.verify(input);
      return { ...result, operationId: foreignOperation };
    }
  }
  const mismatchJournal = recordingJournal();
  const gateway = createToolExecutionGateway({
    route: new MismatchedVerifierRoute(),
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('permission-verification-mismatch')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('boundary-verification-mismatch')] };
      },
    },
    journal: mismatchJournal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  await gateway.submit({ ...intent(), idempotencyKey: 'app-gateway-verification-mismatch-idempotency' });
  const result = await gateway.execute(operation);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.failureClass, 'contract');
  assert.equal(result.failure?.owner, 'humanagent.operations-adapter');
  assert.equal(result.failure?.nextAction.ref, 'deterministic-inspect');
  assert.match(result.failure?.message ?? '', /verification result for a different operation/);
  assert.equal(result.failure?.evidenceRefs.length, 1);
  assert.equal(result.failure?.evidenceRefs[0]?.source, 'humanagent.operations-adapter');
  assert.equal(result.result?.failure, result.failure);
  assert.equal(mismatchJournal.committed.at(-1)?.failure, result.failure);
});
