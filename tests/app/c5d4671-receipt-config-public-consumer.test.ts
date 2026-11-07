import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ensureControlLayout,
  loadConfiguration,
  resolveRuntimePaths,
  type AgentRole,
} from '../../packages/config/src/index.js';
import {
  id,
  type ProviderExecutionIdentityRef,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import { APP_CHILD_CALL_TOOL, createAppChildProducer } from '../../packages/app/src/ui-runtime/child-producer.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';

function locateReceiptConfig(startUrl: string): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (;;) {
    const candidate = join(dir, 'scripts', 'c5d4671-receipt-config.toml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('c5d4671 receipt config fixture not found');
    dir = parent;
  }
}

const RECEIPT_CONFIG_PATH = locateReceiptConfig(import.meta.url);

test('c5d4671 receipt control-root config includes the executor execution roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'c5d4671-receipt-roster-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
    await ensureControlLayout(paths);
    await writeFile(join(paths.controlRoot, 'config.toml'), await readFile(RECEIPT_CONFIG_PATH, 'utf8'), 'utf8');
    const loaded = await loadConfiguration(paths);
    const executor = loaded.agentRoster.find((agent) => agent.agentId === 'executor');
    assert.ok(executor, 'receipt config must define an executor execution agent');
    assert.equal(executor!.roleId, 'execution');
    assert.equal(executor!.templateRef, 'builtin/execution@1.0.0');
    const binding = loaded.agentProviderBindings.find((entry) => entry.agentId === 'executor');
    assert.equal(binding?.roleId, 'execution');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureParent(turnId: string): ActiveTurnContext {
  return {
    admittedTurn: { turnId },
    executionIdentity: () => ({ executionEpoch: 1 }),
  } as unknown as ActiveTurnContext;
}

function fixtureParentAssignment(): never {
  return {} as never;
}

async function dispatchExecutor(roster: readonly { readonly agentId: string; readonly roleId: AgentRole }[]) {
  let admitted: { readonly agentId: string; readonly roleId: AgentRole } | undefined;
  const scope: ScopeRef = { organId: id('organ', 'roster'), taskId: id('task', 'roster'), cycleId: id('cycle', 'roster') };
  const producer = createAppChildProducer({
    manager: {
      async callChild() { throw new Error('roster fixture must not dispatch a child'); },
    } as never,
    parent: fixtureParent('roster-turn'),
    parentAssignment: fixtureParentAssignment(),
    checkpoints: {
      async pre() { throw new Error('pre-checkpoint must not run in roster fixture'); },
      async post() { throw new Error('post-checkpoint must not run in roster fixture'); },
    },
    refinedDeliveryStore: {
      async store() { throw new Error('refined store must not run in roster fixture'); },
      async read() { throw new Error('refined read must not run in roster fixture'); },
    },
    bodyAssets: {
      target: () => 'roster-body',
      async write() { throw new Error('body write must not run in roster fixture'); },
      async read() { throw new Error('body read must not run in roster fixture'); },
    },
    bindChildRun: async () => { throw new Error('bindChildRun must not run in roster fixture'); },
    prepareAgentProvider: async () => { throw new Error('prepareAgentProvider must not run in roster fixture'); },
    roster,
    admitChildOperation: async (input) => {
      admitted = input.selected;
      throw new Error('admission reached');
    },
  });
  const execution: ProviderExecutionIdentityRef = {
    runtimeId: 'roster-runtime',
    taskId: id('task', 'roster'),
    operationId: id('operation', 'roster'),
    executionEpoch: 1,
  };
  const argumentsBody: {
    purpose: string;
    agentId: string;
    kind: 'execution';
    instructions: string;
    successCriteria: string[];
    target: string;
  } = {
    kind: 'execution',
    purpose: 'compute 2+2',
    agentId: 'executor',
    instructions: 'compute 2+2 and return exactly the number 4',
    successCriteria: ['body is 4'],
    target: 'answer.txt',
  };
  try {
    await producer.execute({
      execution,
      requestId: 'roster-request',
      call: {
        toolId: APP_CHILD_CALL_TOOL.toolId,
        callId: 'roster-call',
        continuationRef: 'roster-continuation',
        arguments: argumentsBody as never,
      },
      scope,
      signal: new AbortController().signal,
    });
    return { admitted };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), admitted };
  }
}

test('child.call execution rejects an absent executor with the exact roster error', async () => {
  const { error } = await dispatchExecutor([{ agentId: 'orchestration-default', roleId: 'orchestration' as AgentRole }]);
  assert.ok(error, 'missing executor must reject');
  assert.equal(error!.message, 'selected child agentId executor is not in the configured roster');
});

test('child.call execution resolves an execution-role executor into admission', async () => {
  const { error, admitted } = await dispatchExecutor([{ agentId: 'executor', roleId: 'execution' as AgentRole }]);
  assert.equal(error!.message, 'admission reached');
  assert.deepEqual(admitted, { agentId: 'executor', roleId: 'execution' as AgentRole });
});
