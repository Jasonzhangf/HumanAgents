import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createToolExecutionGateway,
} from '../../packages/app/src/index.js';
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
