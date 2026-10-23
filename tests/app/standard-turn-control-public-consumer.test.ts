import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  STANDARD_TURN_END_TOOL_ID,
  validateProviderToolResult,
  type AdmittedTurnIdentity,
  type BusinessPayload,
  type EvidenceRef,
  type ProviderExecutionIdentityRef,
  type ProviderToolCall,
  type ScopeRef,
  type TurnCloseSummary,
} from '../../packages/contracts/src/index.js';
import { ContractError } from '../../packages/contracts/src/errors.js';
import {
  createStandardTurnEndExecutor,
  STANDARD_TURN_END_TOOL,
  StandardTurnEndError,
  type StandardTurnEndOwnerPort,
} from '../../packages/app/src/ui-runtime/standard-turn-control.js';
import {
  ADVERTISED_STANDARD_TURN_END_TOOL,
  createStandardTurnEndWireExecutor,
} from '../../packages/app/src/ui-runtime/standard-turn-composition.js';
import type { ProviderToolExecutionPort } from '../../packages/adapters/provider/src/agent-driver.js';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const cycleId = id('cycle', 'cycle-a');
const operationId = id('operation', 'ui-operation-1');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };

const identity: AdmittedTurnIdentity = {
  turnId: 'turn-1',
  workAssignmentRef: 'assignment-1',
  taskRef: taskId,
  scopeRef: scope,
  cycleRef: cycleId,
  inputRevision: 1,
  directiveRevision: 1,
  executionEpoch: 1,
  runtimeBindingRef: 'binding-1',
  permissionRevision: 'permission-r1',
};

const execution: ProviderExecutionIdentityRef = {
  runtimeId: 'runtime-1',
  taskId,
  operationId,
  organId,
  cycleId,
  executionEpoch: 1,
};

const deliveryEvidence: EvidenceRef = {
  evidenceId: id('evidence', 'native-file-write'),
  kind: 'tool',
  source: 'native-process',
  locator: 'file://native-process-result.txt',
  scope,
};

const summary: TurnCloseSummary = {
  goal: { text: 'goal text', evidenceRefs: [deliveryEvidence] },
  actions: { text: 'actions text', evidenceRefs: [deliveryEvidence] },
  result: { text: 'result text', evidenceRefs: [deliveryEvidence] },
  expectedNextStep: { text: 'next step text', evidenceRefs: [deliveryEvidence] },
};

const KNOWN_REF = 'native-file-write';
const UNRESOLVED_REF = 'ux-handoff.md';
const signal = new AbortController().signal;

function fakeOwner(overrides: Partial<StandardTurnEndOwnerPort> = {}): StandardTurnEndOwnerPort {
  return {
    async resolveBoundTurn() { return identity; },
    async resolveDelivery({ deliveryRefs }) {
      return deliveryRefs.map((reference) => {
        if (reference !== KNOWN_REF) {
          throw new StandardTurnEndError(
            'standard-turn-end.delivery-unresolved',
            `delivery reference ${reference} does not resolve to scoped evidence`,
          );
        }
        return deliveryEvidence;
      });
    },
    ...overrides,
  };
}

function call(arguments_: Record<string, unknown>): ProviderToolCall {
  return {
    callId: 'call-1',
    toolId: STANDARD_TURN_END_TOOL_ID,
    arguments: arguments_ as BusinessPayload,
    continuationRef: 'continuation-1',
  };
}

test('typed executor returns a failed tool result when a delivery reference is unresolved', async () => {
  let routed = 0;
  const executor = createStandardTurnEndExecutor({ owner: fakeOwner(), route: () => { routed += 1; } });
  const actualCall = call({ summary, deliveryRefs: [UNRESOLVED_REF] });
  const result = await executor.execute({
    execution, scope, call: actualCall, signal,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'standard-turn-end.delivery-unresolved');
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.accepted, false);
  assert.equal(output.turnId, 'turn-1');
  const refusedStatus = result.status;
  if (refusedStatus === undefined) throw new Error('refused standard-turn-end result must carry its real status');
  validateProviderToolResult({
    ...execution,
    toolId: actualCall.toolId,
    callId: actualCall.callId,
    ...result,
    status: refusedStatus,
  });
  assert.equal(result.evidenceRefs.length, 1);
  assert.equal(result.evidenceRefs[0].kind, 'operation');
  assert.equal(result.evidenceRefs[0].scope.operationId?.value, operationId.value);
  assert.deepEqual(result.outputRefs, []);
  assert.equal(routed, 0);
});

test('typed executor propagates owner delivery ContractError unchanged', async () => {
  const failure = new ContractError('journal write failed');
  const executor = createStandardTurnEndExecutor({
    owner: fakeOwner({ async resolveDelivery() { throw failure; } }),
    route: () => {},
  });
  await assert.rejects(
    async () => executor.execute({ execution, scope, call: call({ summary, deliveryRefs: [KNOWN_REF] }), signal }),
    (error: unknown) => error === failure,
  );
});

test('typed executor routes the accepted command when delivery references resolve', async () => {
  let routed: unknown;
  const executor = createStandardTurnEndExecutor({ owner: fakeOwner(), route: (command) => { routed = command; } });
  const result = await executor.execute({
    execution, scope, call: call({ summary, deliveryRefs: [KNOWN_REF] }), signal,
  });
  assert.equal(result.status, 'succeeded');
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.accepted, true);
  assert.equal(output.turnId, 'turn-1');
  assert.equal((routed as { identity: { turnId: string } }).identity.turnId, 'turn-1');
  assert.equal(result.evidenceRefs.length, 1);
});

test('typed executor still throws when no admitted turn is bound', async () => {
  const executor = createStandardTurnEndExecutor({
    owner: fakeOwner({ async resolveBoundTurn() { return null; } }),
    route: () => {},
  });
  await assert.rejects(
    async () => executor.execute({ execution, scope, call: call({ summary, deliveryRefs: [KNOWN_REF] }), signal }),
    (error: unknown) => error instanceof StandardTurnEndError && error.code === 'standard-turn-end.unbound',
  );
});

test('typed executor still throws when the resolved turn does not match the provider execution', async () => {
  const executor = createStandardTurnEndExecutor({ owner: fakeOwner(), route: () => {} });
  await assert.rejects(
    async () => executor.execute({
      execution: { ...execution, operationId: id('operation', 'ui-operation-9') },
      scope,
      call: call({ summary, deliveryRefs: [KNOWN_REF] }),
      signal,
    }),
    (error: unknown) => error instanceof StandardTurnEndError && error.code === 'standard-turn-end.binding',
  );
});

test('typed executor does not swallow route errors', async () => {
  const executor = createStandardTurnEndExecutor({
    owner: fakeOwner(),
    route: () => { throw new Error('request drain failed'); },
  });
  await assert.rejects(
    async () => executor.execute({ execution, scope, call: call({ summary, deliveryRefs: [KNOWN_REF] }), signal }),
    /request drain failed/,
  );
});

test('wire executor returns a failed tool result when a summary reference is unresolved', async () => {
  const wire = createStandardTurnEndWireExecutor(fakeOwner(), {
    async execute() { throw new Error('control must not run for a refused end'); },
  });
  const result = await wire.execute({
    execution,
    scope,
    call: call({
      summary: {
        goal: { text: 'goal text', evidenceRefs: [UNRESOLVED_REF] },
        actions: { text: 'actions text', evidenceRefs: [KNOWN_REF] },
        result: { text: 'result text', evidenceRefs: [KNOWN_REF] },
        expectedNextStep: { text: 'next step text', evidenceRefs: [KNOWN_REF] },
      },
      deliveryRefs: [KNOWN_REF],
    }),
    signal,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'standard-turn-end.delivery-unresolved');
  assert.equal((JSON.parse(result.output) as Record<string, unknown>).turnId, 'turn-1');
});

test('wire executor propagates owner delivery ContractError unchanged', async () => {
  const failure = new ContractError('journal write failed');
  const wire = createStandardTurnEndWireExecutor(
    fakeOwner({ async resolveDelivery() { throw failure; } }),
    { async execute() { throw new Error('control must not run for an owner failure'); } },
  );
  await assert.rejects(
    async () => wire.execute({
      execution,
      scope,
      call: call({
        summary: {
          goal: { text: 'goal text', evidenceRefs: [KNOWN_REF] },
          actions: { text: 'actions text', evidenceRefs: [KNOWN_REF] },
          result: { text: 'result text', evidenceRefs: [KNOWN_REF] },
          expectedNextStep: { text: 'next step text', evidenceRefs: [KNOWN_REF] },
        },
        deliveryRefs: [KNOWN_REF],
      }),
      signal,
    }),
    (error: unknown) => error === failure,
  );
});

test('wire executor routes through control when summary and delivery references resolve', async () => {
  let forwarded: ProviderToolCall | undefined;
  const control: ProviderToolExecutionPort = {
    async execute(request) {
      forwarded = request.call;
      return { output: 'ok', outputRefs: [], evidenceRefs: [], status: 'succeeded', executorRoute: STANDARD_TURN_END_TOOL_ID };
    },
  };
  const wire = createStandardTurnEndWireExecutor(fakeOwner(), control);
  const result = await wire.execute({
    execution,
    scope,
    call: call({
      summary: {
        goal: { text: 'goal text', evidenceRefs: [KNOWN_REF] },
        actions: { text: 'actions text', evidenceRefs: [KNOWN_REF] },
        result: { text: 'result text', evidenceRefs: [KNOWN_REF] },
        expectedNextStep: { text: 'next step text', evidenceRefs: [KNOWN_REF] },
      },
      deliveryRefs: [KNOWN_REF],
    }),
    signal,
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(forwarded);
  const forwardedSummary = (forwarded!.arguments as unknown as { summary: TurnCloseSummary }).summary;
  assert.equal(forwardedSummary.goal.evidenceRefs[0].evidenceId.value, 'native-file-write');
});

test('wire executor preserves an explicit inspection outcome in the accepted summary', async () => {
  let acceptedSummary: TurnCloseSummary | undefined;
  const owner = fakeOwner();
  const control = createStandardTurnEndExecutor({
    owner,
    route: (command) => { acceptedSummary = command.summary; },
  });
  const wire = createStandardTurnEndWireExecutor(owner, control);
  const result = await wire.execute({
    execution,
    scope,
    call: call({
      summary: {
        goal: { text: 'goal text', evidenceRefs: [KNOWN_REF] },
        actions: { text: 'actions text', evidenceRefs: [KNOWN_REF] },
        result: { text: 'result text', evidenceRefs: [KNOWN_REF] },
        expectedNextStep: { text: 'next step text', evidenceRefs: [KNOWN_REF] },
        inspectionOutcome: { status: 'completed', judgment: 'scope observed' },
      },
      deliveryRefs: [KNOWN_REF],
    }),
    signal,
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(acceptedSummary?.inspectionOutcome, { status: 'completed', judgment: 'scope observed' });
});

test('wire executor rejects malformed inspection outcomes through the shared control validator', async () => {
  const owner = fakeOwner();
  let routed = 0;
  const wire = createStandardTurnEndWireExecutor(owner, createStandardTurnEndExecutor({
    owner,
    route: () => { routed += 1; },
  }));
  for (const inspectionOutcome of [{ status: 'completed' }, { status: 'unknown' }]) {
    const result = await wire.execute({
      execution,
      scope,
      call: call({
        summary: {
          goal: { text: 'goal text', evidenceRefs: [KNOWN_REF] },
          actions: { text: 'actions text', evidenceRefs: [KNOWN_REF] },
          result: { text: 'result text', evidenceRefs: [KNOWN_REF] },
          expectedNextStep: { text: 'next step text', evidenceRefs: [KNOWN_REF] },
          inspectionOutcome,
        },
        deliveryRefs: [KNOWN_REF],
      }),
      signal,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'standard-turn-end.arguments');
  }
  assert.equal(routed, 0);
});

test('top-level delivery refs are resolved as delivery material, summary citations are not', async () => {
  const resolutionKinds: Array<boolean | undefined> = [];
  const owner = fakeOwner({
    async resolveDelivery({ deliveryRefs, requireDeliveryMaterial }) {
      resolutionKinds.push(requireDeliveryMaterial);
      return deliveryRefs.map((reference) => {
        if (reference !== KNOWN_REF) {
          throw new StandardTurnEndError('standard-turn-end.delivery-unresolved', `unresolved ${reference}`);
        }
        return deliveryEvidence;
      });
    },
  });
  let routed = 0;
  const wire = createStandardTurnEndWireExecutor(owner, createStandardTurnEndExecutor({
    owner,
    route: () => { routed += 1; },
  }));
  const result = await wire.execute({
    execution,
    scope,
    call: call({
      summary: {
        goal: { text: 'goal text', evidenceRefs: [KNOWN_REF] },
        actions: { text: 'actions text', evidenceRefs: [KNOWN_REF] },
        result: { text: 'result text', evidenceRefs: [KNOWN_REF] },
        expectedNextStep: { text: 'next step text', evidenceRefs: [KNOWN_REF] },
      },
      deliveryRefs: [KNOWN_REF],
    }),
    signal,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(routed, 1);
  assert.equal(resolutionKinds.length, 5);
  assert.deepEqual(resolutionKinds.slice(0, 4), [undefined, undefined, undefined, undefined]);
  assert.equal(resolutionKinds[4], true);
});

test('the advertised tools describe delivery refs as committed file writes or inspection results only', () => {
  const schema: { properties?: Record<string, unknown> } = STANDARD_TURN_END_TOOL.inputSchema;
  const advertisedSchema: { properties?: Record<string, unknown> } = ADVERTISED_STANDARD_TURN_END_TOOL.inputSchema;
  for (const candidate of [schema, advertisedSchema]) {
    const deliveryRefs = candidate.properties?.deliveryRefs as { description: string } | undefined;
    if (deliveryRefs === undefined) throw new Error('the tool schema must declare deliveryRefs');
    assert.match(deliveryRefs.description, /never cite goal/i);
    const deliveryText = candidate.properties?.deliveryText as { description: string } | undefined;
    if (deliveryText === undefined) throw new Error('the tool schema must declare deliveryText');
    assert.match(deliveryText.description, /deliveryRefs empty/i);
  }
});

test('delivery material is limited to committed file writes and inspection results', async () => {
  const { carriesDeliveryMaterial } = await import('../../packages/app/src/provider-tool-execution.js');
  assert.equal(carriesDeliveryMaterial('file.write'), true);
  assert.equal(carriesDeliveryMaterial('file.read'), true);
  assert.equal(carriesDeliveryMaterial('get_goal'), true);
  for (const toolId of ['file.edit', 'bash', 'todo_write', 'create_goal', 'update_goal']) {
    assert.equal(carriesDeliveryMaterial(toolId), false, `${toolId} must never carry delivery material`);
  }
});
