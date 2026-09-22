import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createHandOperationRuntime,
  createResponsesFileToolExecutor,
  createToolExecutionGateway,
} from '../../packages/app/src/index.js';
import { DeterministicInspectRoute } from '../../packages/adapters/operations/src/index.js';
import { CodeSearchRoute, type CodeSearchArtifactStore } from '../../packages/adapters/operations/src/index.js';
import { id, type CodeSearchReport, type EvidenceRef, type OperationEvent, type OperationIntent, type Scope } from '../../packages/contracts/src/index.js';
import { type CodeSearchFileContent, type CodeSearchFileList, type CodeSearchFunctions } from '../../packages/runtime/src/hand/index.js';
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

test('app assembly exposes code.search as one gateway operation over multiple internal function calls', async () => {
  const searchOperation = id('operation', 'app-code-search-operation');
  const searchScope: Scope = { organId: organ, taskId: task, cycleId: cycle };
  const searchIntent: OperationIntent = {
    operationId: searchOperation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'app-gateway-test',
    intentRevision: 'revision-1',
    kind: 'inspect',
    toolName: 'code.search',
    inputRef: 'artifact://input/code-search',
    inputDigest: 'sha256:code-search-input',
    requestedScope: searchScope,
    idempotencyKey: 'app-code-search-idempotency',
    expectedOutput: { schemaRef: 'schema://code.search.report/v1', requiredEvidenceKinds: ['tool'] },
  };
  const request = {
    serviceId: 'code.search' as const,
    contractVersion: '1.0.0' as const,
    workspaceRef: 'workspace://fixture',
    path: 'src',
    query: 'needle',
    queryKind: 'literal' as const,
  };
  const reports = new Map<string, CodeSearchReport>();
  class CodeSearchStore implements CodeSearchArtifactStore {
    async readRequest() { return request; }
    async writeReport(input: Parameters<CodeSearchArtifactStore['writeReport']>[0]) {
      const outputRef = `artifact://code-search/${input.operationId.value}`;
      const outputDigest = `sha256:report-${input.operationId.value}`;
      reports.set(outputRef, input.report);
      return { outputRef, outputDigest };
    }
    async readReport(input: Parameters<CodeSearchArtifactStore['readReport']>[0]) {
      const report = reports.get(input.outputRef);
      if (!report) throw new Error('missing code search report');
      return report;
    }
  }
  class Functions implements CodeSearchFunctions {
    calls = 0;
    async findFiles(): Promise<CodeSearchFileList> { this.calls += 1; return { paths: ['src/a.ts', 'src/b.ts'], complete: true, unresolvedPaths: [] }; }
    async readFile(input: { readonly workspaceRef: string; readonly path: string }): Promise<CodeSearchFileContent> { this.calls += 1; return { path: input.path, content: input.path.endsWith('a.ts') ? 'needle' : 'other' }; }
  }
  const functions = new Functions();
  const hand = createHandOperationRuntime({
    codeSearchRoute: new CodeSearchRoute({ functions, artifacts: new CodeSearchStore(), now: () => '2026-09-20T00:00:00.000Z' }),
    permissions: { async readGrant() { return { scope: searchScope, revoked: false, evidenceRefs: [evidence('code-search-permission')] }; } },
    taskBoundaries: { async readBoundary() { return { scope: searchScope, evidenceRefs: [evidence('code-search-boundary')] }; } },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const result = await hand.execute({ intent: searchIntent });
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.route?.routeId, 'code-search');
  assert.equal(result.operation.result?.outputRef, 'artifact://code-search/app-code-search-operation');
  assert.equal(functions.calls, 3);
});

test('app assembly exposes Hand as a thin semantic-intent boundary', async () => {
  const hand = createHandOperationRuntime({
    permissions: {
      async readGrant() {
        return { scope, revoked: false, evidenceRefs: [evidence('hand-permission')] };
      },
    },
    taskBoundaries: {
      async readBoundary() {
        return { scope, evidenceRefs: [evidence('hand-boundary')] };
      },
    },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });

  const result = await hand.execute({ intent: intent() });

  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.route?.routeId, 'deterministic-inspect');
});

test('Responses file.read executes through Hand and returns actual bound-workspace content', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp-provider-file-tool-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), 'REAL_README_CONTENT\n', 'utf8');
  const executor = createResponsesFileToolExecutor({
    workspaceRoot,
    projectKey: 'fixture-project',
    artifactRoot: join(root, 'artifacts'),
  });
  try {
    const result = await executor.execute({
      execution: { runtimeId: 'runtime-file-tool', taskId: task, operationId: operation, executionEpoch: 1 },
      scope,
      call: {
        callId: 'call-readme',
        toolId: 'file.read',
        arguments: { path: './README.md' },
        continuationRef: 'response-1',
      },
      signal: new AbortController().signal,
    });

    assert.deepEqual(JSON.parse(result.output), {
      workspaceRef: 'workspace:fixture-project',
      path: 'README.md',
      content: 'REAL_README_CONTENT\n',
    });
    assert.equal(result.outputRefs[0], 'asset://provider-tool/output/provider-tool-app-gateway-operation-call-readme');
    assert.equal(result.evidenceRefs.some((ref) => ref.source === 'humanagent.operations.file-read'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Responses file.read rejects an already-aborted call before Hand admission', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp-provider-file-tool-abort-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), 'MUST_NOT_BE_READ\n', 'utf8');
  const artifactRoot = join(root, 'artifacts');
  const executor = createResponsesFileToolExecutor({ workspaceRoot, projectKey: 'fixture-project', artifactRoot });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => executor.execute({
        execution: { runtimeId: 'runtime-file-tool', taskId: task, operationId: operation, executionEpoch: 1 },
        scope,
        call: { callId: 'call-readme-aborted', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-1' },
        signal: controller.signal,
      }),
      (error) => error instanceof Error && error.name === 'AbortError',
    );
    await assert.rejects(() => access(join(artifactRoot, 'operation-journal.jsonl')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
