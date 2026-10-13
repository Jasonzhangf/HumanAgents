import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  completionCommitIdentity,
  fileWriteEffectId,
  id,
  type CompletionReadback,
  type EffectExecutionBinding,
  type FileWriteCompletionFact,
  type FileWriteCompletionResult,
  type FileWriteEffect,
  type FileWriteEffectIntent,
} from '../../packages/contracts/src/index.js';
import { JournalCommitConflictError, JournalIntegrityError } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import {
  OperationCompletionOwner,
  type OperationCompletionCommitPort,
} from '../../packages/runtime/src/gateway/operation-completion.js';
import { createResponsesFileToolExecutor } from '../../packages/app/src/provider-tool-execution.js';

const organId = id('organ', 'f2-w2-organ');
const taskId = id('task', 'f2-w2-task');
const cycleId = id('cycle', 'f2-w2-cycle');
const parentOperationId = id('operation', 'provider-execution-parent');
const toolOperationId = id('operation', 'provider-tool-provider-execution-parent-call-file-write');
const requestId = 'request-f2-w2-file-write';
const callId = 'call-file-write';
const projectKey = 'f2-w2-project';

/**
 * The project requires every durable artifact to live under `~/.humanagent`.
 * `HUMANAGENT_TEST_ROOT` only exists so a sandboxed worker can still exercise
 * the same consumer locally; the formal default is the `~/.humanagent` root.
 */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-f-operation-receipt-r1-20261012');

interface Fixture {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly journalPath: string;
}

async function withFixture(name: string, fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, `${name}-`));
  const workspaceRoot = await mkdtemp(join(tmpdir(), `humanagent-${name}-workspace-`));
  try {
    await fn({ root, workspaceRoot, artifactRoot: join(root, 'evidence'), journalPath: join(root, 'evidence', 'task-cycle.jsonl') });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function sha256Digest(value: string): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

function binding(overrides: { readonly callId?: string; readonly toolOperationId?: string } = {}): EffectExecutionBinding {
  const toolOperation = overrides.toolOperationId === undefined
    ? toolOperationId
    : id('operation', overrides.toolOperationId);
  return {
    execution: {
      runtimeId: 'runtime-f2-w2',
      taskId,
      operationId: parentOperationId,
      organId,
      cycleId,
      executionEpoch: 7,
    },
    scope: {
      organId,
      taskId,
      cycleId,
      operationId: toolOperation,
    },
    toolOperationId: toolOperation,
    requestId,
    callId: overrides.callId ?? callId,
    continuationRef: 'continuation-f2-w2',
  };
}

async function effectFor(value: EffectExecutionBinding, workspaceRef: string, content: string): Promise<FileWriteEffect> {
  return {
    kind: 'file.write',
    effectId: await fileWriteEffectId(value),
    workspaceRef,
    relativePath: 'nested/f2-w2.txt',
    inputDigest: await sha256Digest(JSON.stringify({ file_path: 'nested/f2-w2.txt', content })),
    expectedContentDigest: await sha256Digest(content),
  };
}

function completionFact(bindingValue: EffectExecutionBinding, effect: FileWriteEffect, result: FileWriteCompletionResult): FileWriteCompletionFact {
  return {
    kind: 'operation-completion',
    version: 1,
    binding: bindingValue,
    effect,
    confirmation: {
      ownerId: 'humanagent.app.provider-tool-execution.file-write',
      method: 'file-readback-digest',
      observedContentDigest: effect.expectedContentDigest,
    },
    result,
  };
}

function fileWriteRequest(content: string, requestCallId: string = callId) {
  return {
    execution: {
      runtimeId: 'runtime-f2-w2',
      taskId,
      operationId: parentOperationId,
      organId,
      cycleId,
      executionEpoch: 7,
    },
    scope: { organId, taskId, cycleId },
    requestId,
    call: {
      callId: requestCallId,
      toolId: 'file.write',
      arguments: { file_path: 'nested/f2-w2.txt', content },
      continuationRef: 'continuation-f2-w2',
    },
    signal: new AbortController().signal,
  };
}

test('F2 W2 T1 keeps effect intent unknown/reconcile and forbids replay after completion failure', async () => {
  await withFixture('t1', async ({ workspaceRoot, artifactRoot, journalPath }) => {
    const content = 'side effect then failed commit';
    const realCompletion = new JsonlOperationCompletionJournal(journalPath);
    const failingCompletion: OperationCompletionCommitPort = {
      commitIntent: (input: FileWriteEffectIntent) => realCompletion.commitIntent(input),
      async commitCompletion() {
        throw new Error('injected completion commit failure');
      },
    };
    const built = createResponsesFileToolExecutor({
      workspaceRoot,
      projectKey,
      artifactRoot,
      operationCompletionPortFor: () => failingCompletion,
    });
    let executions = 0;
    const executor = {
      async execute(request: Parameters<typeof built.executor.execute>[0]) {
        executions += 1;
        return await built.executor.execute(request);
      },
    };

    await assert.rejects(
      () => executor.execute(fileWriteRequest(content)),
      /injected completion commit failure/,
    );
    assert.equal(executions, 1);
    const written = await readFile(join(workspaceRoot, 'nested/f2-w2.txt'), 'utf8').catch(() => null);
    assert.equal(written, content, 'the real file side effect must have happened before commit failure');

    const coldReader = new JsonlOperationCompletionJournal(journalPath);
    const value = binding();
    const effectId = await fileWriteEffectId(value);
    const read = await coldReader.readExact({
      commitIdentity: await completionCommitIdentity(value, effectId),
      binding: value,
      effectId,
    });

    const expectedIntent: FileWriteEffectIntent = {
      kind: 'operation-effect-intent',
      version: 1,
      binding: value,
      effect: await effectFor(value, `workspace:${projectKey}`, content),
    };
    assert.deepEqual(read, {
      state: 'unknown',
      intent: expectedIntent,
      nextAction: 'reconcile',
      replayAllowed: false,
    });
    assert.equal(executions, 1, 'an exact read must never re-invoke the file executor');
    assert.equal(await readFile(join(workspaceRoot, 'nested/f2-w2.txt'), 'utf8'), content);
  });
});

test('F2 W2 T2 reads the same completion receipt after destroying the writer object/process state', async () => {
  await withFixture('t2', async ({ workspaceRoot, artifactRoot, journalPath }) => {
    const content = 'confirmed file write';
    const writer = createResponsesFileToolExecutor({
      workspaceRoot,
      projectKey,
      artifactRoot,
      operationCompletionPortFor: () => new JsonlOperationCompletionJournal(journalPath),
    });
    const returned = await writer.executor.execute(fileWriteRequest(content));

    // Drop the writer and output store before the cold reader is created.
    delete (writer as { toolOutputs?: unknown }).toolOutputs;
    const reader = new JsonlOperationCompletionJournal(journalPath);
    const value = binding();
    const effectId = await fileWriteEffectId(value);
    const commitIdentity = await completionCommitIdentity(value, effectId);
    const receiptRead = await reader.readExact({ commitIdentity, binding: value, effectId });

    assert.equal(receiptRead.state, 'confirmed');
    if (receiptRead.state !== 'confirmed') throw new Error('confirmed completion read is required');
    assert.equal(receiptRead.receipt.commitIdentity, commitIdentity);
    assert.equal(receiptRead.receipt.fact.binding.toolOperationId.value, toolOperationId.value);
    assert.ok(receiptRead.receipt.fact.binding.toolOperationId.value !== parentOperationId.value, 'tool operation must differ from parent execution operation');
    assert.equal(receiptRead.receipt.fact.binding.execution.operationId.value, parentOperationId.value);
    assert.equal(receiptRead.receipt.fact.binding.execution.executionEpoch, 7);
    assert.equal(receiptRead.receipt.fact.binding.requestId, requestId);
    assert.equal(receiptRead.receipt.fact.binding.callId, callId);
    assert.equal(receiptRead.receipt.fact.effect.relativePath, 'nested/f2-w2.txt');
    assert.equal(receiptRead.receipt.fact.confirmation.method, 'file-readback-digest');
    assert.equal(receiptRead.receipt.fact.result.operationId.value, toolOperationId.value);
    assert.equal(receiptRead.receipt.fact.result.outputRef, returned.outputRef);
    assert.equal(receiptRead.receipt.fact.result.outputDigest, returned.outputDigest);
    assert.equal(await readFile(join(workspaceRoot, 'nested/f2-w2.txt'), 'utf8'), content);

    // A freshly composed output reader must return the exact original output bytes.
    const rebuilt = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot });
    const report = await rebuilt.toolOutputs.readReport({ outputRef: returned.outputRef!, outputDigest: returned.outputDigest! });
    assert.equal(JSON.stringify(report), returned.output, 'cold output read must equal the exact bytes the executor returned');

    // A later completion in the same journal must not replace the earlier exact receipt.
    const laterValue = binding({ callId: 'call-file-write-later', toolOperationId: 'provider-tool-provider-execution-parent-call-file-write-later' });
    const laterEffect = await effectFor(laterValue, `workspace:${projectKey}`, 'later write');
    await reader.commitIntent({ kind: 'operation-effect-intent', version: 1, binding: laterValue, effect: laterEffect });
    await reader.commitCompletion(completionFact(laterValue, laterEffect, {
      operationId: laterValue.toolOperationId,
      status: 'succeeded',
      outputRef: 'asset://provider-tool/output/later',
      outputDigest: await sha256Digest('later'),
      evidenceRefs: [],
      verifier: { name: 'file-write-readback-digest', version: '1', decision: 'later' },
      completedAt: new Date().toISOString(),
    }));
    const reread = await reader.readExact({ commitIdentity, binding: value, effectId });
    assert.equal(reread.state, 'confirmed');
    if (reread.state !== 'confirmed') throw new Error('confirmed completion read is required');
    assert.equal(reread.receipt.fact.binding.callId, callId, 'exact read must not fall back to the latest completion');
    assert.equal(reread.receipt.fact.result.outputRef, returned.outputRef);

    await assert.rejects(
      () => reader.readExact({
        commitIdentity,
        binding: { ...value, toolOperationId: parentOperationId },
        effectId,
      }),
      /does not match the requested binding/,
    );
  });
});

test('F2 W2 keeps the first completion and rejects a conflicting fact for the same identity', async () => {
  await withFixture('conflict', async ({ workspaceRoot, artifactRoot, journalPath }) => {
    const content = 'commit integrity';
    const writer = createResponsesFileToolExecutor({
      workspaceRoot,
      projectKey,
      artifactRoot,
      operationCompletionPortFor: () => new JsonlOperationCompletionJournal(journalPath),
    });
    await writer.executor.execute(fileWriteRequest(content));

    const reader = new JsonlOperationCompletionJournal(journalPath);
    const value = binding();
    const effectId = await fileWriteEffectId(value);
    const commitIdentity = await completionCommitIdentity(value, effectId);
    const first = await reader.readExact({ commitIdentity, binding: value, effectId });
    assert.equal(first.state, 'confirmed');
    if (first.state !== 'confirmed') throw new Error('confirmed completion read is required');

    const writeEffect = await effectFor(value, `workspace:${projectKey}`, content);
    const identical = await reader.commitCompletion(completionFact(value, writeEffect, first.receipt.fact.result));
    assert.equal(identical.journalSeq, first.receipt.journalSeq, 'an identical re-commit must keep the first record');
    assert.equal(identical.commitFactDigest, first.receipt.commitFactDigest);

    const conflictingResult: FileWriteCompletionResult = {
      ...first.receipt.fact.result,
      completedAt: new Date(Date.parse(first.receipt.fact.result.completedAt) + 1000).toISOString(),
    };
    await assert.rejects(
      () => reader.commitCompletion(completionFact(value, writeEffect, conflictingResult)),
      (error: unknown) => error instanceof JournalCommitConflictError,
    );
    const after = await reader.readExact({ commitIdentity, binding: value, effectId });
    assert.equal(after.state, 'confirmed');
    if (after.state !== 'confirmed') throw new Error('confirmed completion read is required');
    assert.equal(after.receipt.commitFactDigest, first.receipt.commitFactDigest, 'a rejected conflict must leave the original receipt intact');
    assert.equal(after.receipt.fact.result.completedAt, first.receipt.fact.result.completedAt);
  });
});

test('F2 W2 surfaces journal corruption instead of a confirmed receipt', async () => {
  await withFixture('corrupt', async ({ workspaceRoot, artifactRoot, journalPath }) => {
    const writer = createResponsesFileToolExecutor({
      workspaceRoot,
      projectKey,
      artifactRoot,
      operationCompletionPortFor: () => new JsonlOperationCompletionJournal(journalPath),
    });
    await writer.executor.execute(fileWriteRequest('corruption probe'));

    const value = binding();
    const effectId = await fileWriteEffectId(value);
    const commitIdentity = await completionCommitIdentity(value, effectId);
    await appendFile(journalPath, 'not-json\n', 'utf8');

    const reader = new JsonlOperationCompletionJournal(journalPath);
    await assert.rejects(
      () => reader.readExact({ commitIdentity, binding: value, effectId }),
      (error: unknown) => error instanceof JournalIntegrityError,
    );
  });
});

const COLD_READ_SCRIPT = `
const { pathToFileURL } = await import('node:url');
const [journalPath, artifactRoot, workspaceRoot, commitIdentity, effectId, bindingJson, jsonlModulePath, appModulePath] = process.argv.slice(1);
const { JsonlOperationCompletionJournal } = await import(pathToFileURL(jsonlModulePath).href);
const { createResponsesFileToolExecutor } = await import(pathToFileURL(appModulePath).href);
const binding = JSON.parse(bindingJson);
const journal = new JsonlOperationCompletionJournal(journalPath);
const read = await journal.readExact({ commitIdentity, binding, effectId });
let output = null;
if (read.state === 'confirmed') {
  const built = createResponsesFileToolExecutor({ workspaceRoot, projectKey: '${projectKey}', artifactRoot });
  output = JSON.stringify(await built.toolOutputs.readReport({
    outputRef: read.receipt.fact.result.outputRef,
    outputDigest: read.receipt.fact.result.outputDigest,
  }));
}
process.stdout.write(JSON.stringify({ read, output }));
`;

function runColdRead(input: {
  readonly journalPath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly commitIdentity: string;
  readonly effectId: string;
  readonly binding: EffectExecutionBinding;
}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const jsonlModulePath = join(process.cwd(), 'dist', 'tests', 'packages', 'adapters', 'jsonl', 'src', 'operation-completion.js');
  const appModulePath = join(process.cwd(), 'dist', 'tests', 'packages', 'app', 'src', 'provider-tool-execution.js');
  const args = [
    '--input-type=module',
    '--eval',
    COLD_READ_SCRIPT,
    input.journalPath,
    input.artifactRoot,
    input.workspaceRoot,
    input.commitIdentity,
    input.effectId,
    JSON.stringify(input.binding),
    jsonlModulePath,
    appModulePath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('F2 W2 cold-reads the exact receipt and output bytes from a fresh process', async () => {
  await withFixture('fresh', async ({ workspaceRoot, artifactRoot, journalPath }) => {
    const content = 'fresh process cold read';
    const writer = createResponsesFileToolExecutor({
      workspaceRoot,
      projectKey,
      artifactRoot,
      operationCompletionPortFor: () => new JsonlOperationCompletionJournal(journalPath),
    });
    const returned = await writer.executor.execute(fileWriteRequest(content));

    const value = binding();
    const effectId = await fileWriteEffectId(value);
    const commitIdentity = await completionCommitIdentity(value, effectId);
    const child = await runColdRead({ journalPath, artifactRoot, workspaceRoot, commitIdentity, effectId, binding: value });

    assert.equal(child.code, 0, `fresh process exited ${String(child.code)}; stderr=${child.stderr.slice(-500)}`);
    const parsed = JSON.parse(child.stdout.trim()) as { readonly read: CompletionReadback; readonly output: string | null };
    const read = parsed.read;
    assert.equal(read.state, 'confirmed');
    if (read.state !== 'confirmed') throw new Error('fresh-process read must be confirmed');
    assert.equal(read.receipt.commitIdentity, commitIdentity);
    assert.equal(read.receipt.fact.binding.execution.operationId.value, parentOperationId.value);
    assert.equal(read.receipt.fact.binding.toolOperationId.value, toolOperationId.value);
    assert.equal(read.receipt.fact.binding.execution.executionEpoch, 7);
    assert.equal(read.receipt.fact.binding.requestId, requestId);
    assert.equal(read.receipt.fact.binding.callId, callId);
    assert.equal(read.receipt.fact.effect.relativePath, 'nested/f2-w2.txt');
    assert.equal(read.receipt.fact.result.operationId.value, toolOperationId.value);
    assert.equal(parsed.output, returned.output, 'the fresh process must read the exact output bytes the executor returned');
  });
});

test('F2 W2 rejects a mismatched readback digest before the completion commit', async () => {
  await withFixture('digest', async ({ root }) => {
    const owner = new OperationCompletionOwner(new JsonlOperationCompletionJournal(join(root, 'evidence', 'missing.jsonl')));
    const value = binding();
    const writeEffect = await effectFor(value, `workspace:${projectKey}`, 'independent write');
    const wrongDigest = await sha256Digest('wrong');
    const outputDigest = await sha256Digest('{}');
    await assert.rejects(() => owner.commit(value, writeEffect, wrongDigest, {
      operationId: toolOperationId,
      status: 'succeeded',
      outputRef: 'asset://provider-tool/output/f2-w2',
      outputDigest,
      evidenceRefs: [],
      verifier: { name: 'file-write-readback-digest', version: '1', decision: 'no' },
      completedAt: new Date().toISOString(),
    }), /readback digest does not match/);
  });
});
