import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createResponsesFileToolExecutor,
  type ProviderToolAdmissionInput,
} from '../../packages/app/src/provider-tool-execution.js';
import { UiRuntimeJournal } from '../../packages/app/src/ui-runtime/index.js';
import { createServiceExecutionAdmission } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from '../../packages/app/src/ui-runtime/task-control.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { id, type OperationId, type Scope, type TaskId } from '../../packages/contracts/src/index.js';
import type { RuntimeExecutionAllocation } from '../../packages/runtime/src/ui-runtime/coordinator.js';

const organ = id('organ', 'web-search-output-alignment-organ');
const task = id('task', 'web-search-output-alignment-task');
const cycle = id('cycle', 'web-search-output-alignment-cycle');
const principal = 'web-search-output-alignment';

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Minimal local stand-in for the `monid` search CLI. It returns one short,
 * complete page so the real `createAgentReachWebSearchProvider` /
 * `WebSearchService` path runs to a `succeeded` report without any network.
 */
const MOCK_MONID = [
  '#!/bin/sh',
  'if [ "$1" = "run" ]; then',
  "  printf '%s' '{\"runId\":\"run-align-1\"}'",
  '  exit 0',
  'fi',
  'if [ "$1" = "runs" ] && [ "$2" = "get" ]; then',
  "  printf '%s' '{\"runId\":\"run-align-1\",\"status\":\"COMPLETED\",\"output\":{\"results\":["
    + '{\"url\":\"https://example.com/a\",\"title\":\"Alpha\",\"snippet\":\"Alpha snippet\",\"site_name\":\"example.com\"},'
    + '{\"url\":\"https://example.com/b\",\"title\":\"Beta\",\"snippet\":\"Beta snippet\",\"site_name\":\"example.com\"}'
    + ']}}\'',
  '  exit 0',
  'fi',
  "printf '%s' '{}'",
  'exit 0',
  '',
].join('\n');

/**
 * Real service admission over one prepared allocation, mirroring the production
 * composition. The executor then resolves its tool control source from this
 * owner, so the returned `ToolExecResult` is the same shape the provider
 * adapter receives at runtime.
 */
async function directToolAdmission(input: {
  readonly root: string;
  readonly execution: {
    readonly runtimeId: string;
    readonly taskId: TaskId;
    readonly operationId: OperationId;
    readonly executionEpoch: number;
  };
  readonly scope: Scope;
}): Promise<ProviderToolAdmissionInput> {
  const now = () => new Date();
  const preparedJournal = new UiRuntimeJournal(join(input.root, `prepared-${input.execution.operationId.value}.jsonl`));
  const allocation: RuntimeExecutionAllocation = {
    runtimeId: input.execution.runtimeId,
    taskId: input.execution.taskId,
    operationId: input.execution.operationId,
    executionEpoch: input.execution.executionEpoch,
    assignmentId: `assignment-${input.execution.operationId.value}`,
    scope: input.scope,
    inputRefs: [`task://${input.execution.taskId.value}/input/1`],
    ownerId: principal,
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  };
  preparedJournal.append({
    kind: 'operation.prepared',
    allocation,
    input: 'web search output/digest alignment fixture',
    operationCounter: 1,
    cycleCounter: 1,
  });
  const controlJournal = new JsonlOrganJournal(join(input.root, `control-${input.execution.operationId.value}.jsonl`));
  const serviceAdmission = createServiceExecutionAdmission({
    journal: controlJournal,
    preparedJournal,
    principalOwner: principal,
    resourceBoundary: createPreparedOperationBoundary(preparedJournal),
    now,
  });
  await serviceAdmission.grants.grant({
    requestId: `fixture-task-grant:${allocation.taskId.value}`,
    taskId: allocation.taskId,
    owner: principal,
    capability: {
      actionId: TASK_EXECUTION_ACTION_ID,
      capabilities: [TASK_EXECUTION_CAPABILITY],
      scope: { organId: allocation.scope.organId, taskId: allocation.taskId },
    },
    expectedRevision: 0,
  });
  await serviceAdmission.admitExecution(allocation);
  return {
    organJournal: controlJournal,
    currentTaskGrantPort: serviceAdmission.permissions,
    principalOwner: principal,
    resourceBoundary: serviceAdmission.resourceBoundary,
    bindingFor: async (request) => {
      const prepared = preparedJournal.replay().filter((record) => record.kind === 'operation.prepared'
        && record.allocation.operationId.value === request.execution.operationId.value);
      if (prepared.length !== 1 || prepared[0]?.kind !== 'operation.prepared') {
        throw new Error('web search alignment fixture has no single retained prepared allocation');
      }
      return await serviceAdmission.bindingFor(prepared[0].allocation);
    },
    admitToolOperation: serviceAdmission.admitToolOperation,
    now,
  };
}

async function executeWebSearch(input: {
  readonly root: string;
  readonly execution: {
    readonly runtimeId: string;
    readonly taskId: TaskId;
    readonly operationId: OperationId;
    readonly executionEpoch: number;
  };
  readonly scope: Scope;
  readonly command: string;
  readonly callId: string;
  readonly query: string;
}) {
  const workspaceRoot = join(input.root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const admission = await directToolAdmission({ root: input.root, execution: input.execution, scope: input.scope });
  const built = createResponsesFileToolExecutor({
    workspaceRoot,
    projectKey: 'web-search-output-alignment',
    artifactRoot: join(input.root, 'artifacts'),
    webSearchProviderConfig: {
      provider: 'tinyfish',
      command: input.command,
      endpoint: '/search',
      pageCeiling: 0,
      pollIntervalMs: 100,
      pollTimeoutMs: 5_000,
    },
    admission,
  });
  const result = await built.executor.execute({
    execution: input.execution,
    scope: input.scope,
    requestId: `request-${input.callId}`,
    call: {
      callId: input.callId,
      toolId: 'web.search',
      arguments: { query: input.query },
      continuationRef: `response-${input.callId}`,
    },
    signal: new AbortController().signal,
  });
  return { result, toolOutputs: built.toolOutputs };
}

test('web.search returns the persisted report as output so outputDigest names the same bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-search-output-align-'));
  const stub = join(root, 'monid-stub');
  await writeFile(stub, MOCK_MONID, 'utf8');
  await chmod(stub, 0o755);
  const operationId = id('operation', 'web-search-output-alignment-succeeded');
  const scope: Scope = { organId: organ, taskId: task, cycleId: cycle, operationId };
  const execution = {
    runtimeId: 'runtime-web-search-output-alignment',
    taskId: task,
    operationId,
    executionEpoch: 1,
  };
  try {
    const { result, toolOutputs } = await executeWebSearch({
      root,
      execution,
      scope,
      command: stub,
      callId: 'call-web-search-succeeded',
      query: 'alignment',
    });
    assert.equal(result.status, 'succeeded');
    assert.ok(result.outputRef, 'web.search must publish an outputRef');
    assert.ok(result.outputDigest, 'web.search must publish an outputDigest');
    assert.ok(result.outputRefs.includes(result.outputRef!), 'outputRefs must contain outputRef');
    // The delivered output and the descriptor must name the same artifact.
    assert.equal(sha256(result.output), result.outputDigest);
    const readback = await toolOutputs.readReport({
      outputRef: result.outputRef!,
      outputDigest: result.outputDigest!,
    });
    assert.equal(JSON.stringify(readback), result.output);

    const report = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(report.status, 'succeeded');
    assert.equal(report.resultsFound, 2);
    assert.equal(report.providerPagesFetched, 1);
    assert.equal(report.resultsScope, 'provider-pages');
    assert.equal(report.searchComplete, true);
    assert.deepEqual(report.unresolvedSources, []);
    assert.equal(typeof report.summary, 'string');
    const results = report.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 2);
    assert.equal(results[0]!.url, 'https://example.com/a');
    assert.equal(results[0]!.title, 'Alpha');
    assert.equal(results[0]!.snippet, 'Alpha snippet');
    assert.equal(results[0]!.sourceName, 'example.com');
    assert.equal(results[0]!.rank, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed web.search result keeps its output aligned with the descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-search-output-align-failed-'));
  const operationId = id('operation', 'web-search-output-alignment-failed');
  const scope: Scope = { organId: organ, taskId: task, cycleId: cycle, operationId };
  const execution = {
    runtimeId: 'runtime-web-search-output-alignment-failed',
    taskId: task,
    operationId,
    executionEpoch: 1,
  };
  try {
    const { result, toolOutputs } = await executeWebSearch({
      root,
      execution,
      scope,
      // A provider start that cannot spawn yields a typed `provider-failed`
      // report, which exercises the failed branch of the executor.
      command: join(root, 'missing-monid-stub'),
      callId: 'call-web-search-failed',
      query: 'alignment',
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.outputRef, 'failed web.search must publish an outputRef');
    assert.ok(result.outputDigest, 'failed web.search must publish an outputDigest');
    assert.ok(result.outputRefs.includes(result.outputRef!), 'outputRefs must contain outputRef');
    assert.equal(result.error?.category, 'provider');
    // The failed result must keep the same output/digest alignment as success.
    assert.equal(sha256(result.output), result.outputDigest);
    const readback = await toolOutputs.readReport({
      outputRef: result.outputRef!,
      outputDigest: result.outputDigest!,
    });
    assert.equal(JSON.stringify(readback), result.output);
    const report = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(report.status, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
