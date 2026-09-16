import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { assertDshSourceMatchesLock, closeRuntime, composeAgentDriver, createJsonlCheckpointJournal, ensureDshSettings, openAgentOperation, openRuntime, probeExecutionRuntime, readRunManifest, resolveDshHome, resumeAgentOperation, resumeRuntime, runAgentOperation, settleSessionOutcome, verifyDshPatches, type RuntimeExecutionBinding } from '../../packages/app/src/index.js';
import { id, type AgentClosure, type AgentInput, type AgentOutput, type EvidenceRef, type ExecutionRuntimePort, type ProviderBinding, type ProviderCloseResult, type ProviderEvent, type ProviderReadiness, type ProviderRecoveryResult, type ProviderSettlement, type ProviderStartReceipt, type ProviderStopReceipt, type ProviderSubmitResult } from '../../packages/contracts/src/index.js';
import { SessionStore } from '../../packages/app/src/session-store.js';
import { FakeAgentDriver } from '../../packages/adapters/testing/src/index.js';
import { JsonlOrganJournal, JournalCommitConflictError } from '../../packages/adapters/jsonl/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';

const providerBinding: ProviderBinding = {
  bindingId: 'binding-integration',
  providerId: 'provider-integration',
  protocol: 'responses',
  endpointRef: 'endpoint-integration',
  modelRef: 'model-integration',
  configDigest: 'sha256:integration-config',
  capabilityDigest: 'sha256:integration-capability',
};

const readiness: ProviderReadiness = {
  bindingId: providerBinding.bindingId,
  providerId: providerBinding.providerId,
  protocol: providerBinding.protocol,
  state: 'ready',
  capabilityDigest: providerBinding.capabilityDigest,
  checkedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  evidenceRefs: [],
};

function executionPort(readinessResult: ProviderReadiness = readiness): ExecutionRuntimePort {
  const identity = { runtimeId: 'runtime-integration', taskId: { scope: 'task' as const, value: 'task-integration' }, operationId: { scope: 'operation' as const, value: 'operation-integration' }, executionEpoch: 1 };
  const evidenceRefs: readonly EvidenceRef[] = [];
  const port: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => readinessResult,
    capabilities: async () => ({ ...readinessResult, capabilities: ['integration'], version: 'test', digest: providerBinding.capabilityDigest }),
    start: async (): Promise<ProviderStartReceipt> => ({ ...identity, startedAt: '2026-01-01T00:00:00.000Z', evidenceRefs }),
    resume: async (): Promise<ProviderRecoveryResult> => ({ ...identity, checkpointId: { scope: 'checkpoint', value: 'checkpoint-integration' }, recovered: true, staleRejected: false, recoveryStateRef: { evidenceId: { scope: 'evidence', value: 'recovery' }, kind: 'execution', source: 'test', locator: 'recovery', scope: { organId: { scope: 'organ', value: 'organ-integration' }, taskId: identity.taskId, operationId: identity.operationId } }, evidenceRefs }),
    submit: async (): Promise<ProviderSubmitResult> => ({ ...identity, status: 'completed', outputRefs: ['output-integration'], evidenceRefs }),
    observe: async function* (): AsyncIterable<ProviderEvent> { yield { ...identity, eventId: 'event-integration', kind: 'terminal', terminalState: 'succeeded', evidenceRefs }; },
    requestStop: async (): Promise<ProviderStopReceipt> => ({ ...identity, status: 'accepted', receivedAt: '2026-01-01T00:00:00.000Z', evidenceRefs }),
    settle: async (): Promise<ProviderSettlement> => ({ ...identity, state: 'succeeded', evidenceRefs, resourceRelease: { state: 'released', evidenceRefs }, persistence: { state: 'committed', evidenceRefs } }),
    close: async (): Promise<ProviderCloseResult> => ({ bindingId: providerBinding.bindingId, providerId: providerBinding.providerId, protocol: providerBinding.protocol, state: 'closed', evidenceRefs }),
  };
  return port;
}

function runtimeBinding(port = executionPort()): RuntimeExecutionBinding {
  return { binding: { runtimeId: 'runtime-integration', provider: providerBinding }, port };
}

async function createConfiguredWorkspace(prefix: string): Promise<{ root: string; controlRoot: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  return { root, controlRoot, workspace };
}

class CrashSubmitDriver extends FakeAgentDriver {
  async submit(): Promise<never> {
    throw new Error('DSH runtime exited before settle');
  }
}

class CountingCrashSubmitDriver extends CrashSubmitDriver {
  settleCalls = 0;

  override async settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    this.settleCalls += 1;
    return await super.settle(input);
  }
}

class RejectPromptDriver extends FakeAgentDriver {
  override async submit(input: AgentInput): Promise<AgentOutput> {
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: { status: 'failed' },
      outputRefs: [],
      evidenceRefs: [{
        evidenceId: id('evidence', `prompt-rejected-${input.assignmentId}`),
        kind: 'operation',
        source: 'test-reject-prompt',
        locator: `dsh://session/${input.assignmentId}/prompt-rejected`,
        scope: { organId: id('organ', 'agent-execution-fake'), taskId: input.taskId },
      }],
    };
  }
}

test('HumanAgent operation identity is stable across driver and provider bindings', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stable-identity-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const agent = {
    agentId: 'execution-stable',
    roleId: 'execution' as const,
    templateRef: 'builtin/execution@1.0.0',
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'] as const,
    resourceClass: 'foreground',
  };
  const fake = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stable-fake',
    plan: 'default',
    prompt: 'inspect the configuration',
    agent: { ...agent, driverRef: 'fake' },
    composed: { driver: new FakeAgentDriver() },
  });
  const dsh = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stable-dsh',
    plan: 'default',
    prompt: 'inspect the configuration',
    agent: { ...agent, driverRef: 'dsh' },
    composed: { driver: new FakeAgentDriver() },
  });
  assert.deepEqual(fake.snapshot().scope.organId, dsh.snapshot().scope.organId);
  assert.equal(fake.snapshot().scope.organId.value, 'agent-execution-stable');

  const source = await readFile(join(process.cwd(), 'packages/app/src/agent-operation.ts'), 'utf8');
  assert.equal(/adapters[\\/]dsh|dshExecutionOrganId|dshOperationIdFor/.test(source), false);
});

test('CLI config failures preserve structured owner and next action evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-error-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await writeFile(join(controlRoot, 'config.toml'), 'misspelled = true\n', 'utf8');
  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'), 'doctor', '--workspace', workspace, '--control-root', controlRoot], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'config-invalid');
    assert.equal(parsed.error.ownerId, 'config-loader');
    assert.equal(typeof parsed.error.nextAction, 'string');
    return true;
  });
});

test('CLI host failures remain structured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-host-error-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'), 'unknown', '--workspace', workspace], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'host-error');
    assert.equal(parsed.error.ownerId, 'host');
    assert.equal(typeof parsed.error.nextAction, 'string');
    return true;
  });
});

test('app composes a provider-neutral execution port and preserves adapter ownership', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-execution-');
  const port = executionPort();
  const handle = await openRuntime({
    controlRoot,
    workspace,
    plan: 'default',
    sessionId: 'session-execution',
    execution: runtimeBinding(port),
  });
  assert.equal(handle.execution?.port, port);
  assert.equal(handle.execution?.binding.provider.providerId, 'provider-integration');
  const observedReadiness = await probeExecutionRuntime(handle.execution!);
  assert.equal(observedReadiness.state, 'ready');
  await handle.lock.release();
  const resumed = await resumeRuntime({ controlRoot, workspace, sessionId: 'session-execution', execution: runtimeBinding(port) });
  assert.equal(resumed.execution?.port, port);
  await closeRuntime(resumed, 'checkpoint:execution');
});

test('app rejects an invalid adapter binding before acquiring a session lock', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-execution-invalid-');
  const invalidBinding = { ...runtimeBinding(), binding: { ...runtimeBinding().binding, provider: { ...providerBinding, protocol: 'invalid' as never } } };
  let caught: unknown;
  try {
    await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-invalid-execution', execution: invalidBinding });
  } catch (error) {
    caught = error;
  }
  assert.equal((caught as { code?: string }).code, 'execution-binding-invalid');
  assert.equal((caught as { ownerId?: string }).ownerId, 'execution-runtime');
  assert.equal(typeof (caught as { nextAction?: string }).nextAction, 'string');
  assert.equal((caught as { cause?: unknown }).cause instanceof Error, true);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const store = new SessionStore(paths);
  await assert.rejects(() => store.open('session-invalid-execution'), /session does not exist/);
});

test('app assembly remains DSH-neutral at the source boundary', async () => {
  const source = await readFile(join(process.cwd(), 'packages/app/src/execution.ts'), 'utf8');
  assert.equal(/adapters[\\/]dsh|from ['\"]dsh['\"]|require\\(['\"]dsh['\"]\\)/i.test(source), false);
  assert.equal(/SessionId|SessionEvent/.test(source), false);
});

test('driver composition selects fake or dsh explicitly and never falls back', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-driver-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const fake = composeAgentDriver({
    agent: {
      agentId: 'execution-fake',
      roleId: 'execution',
      templateRef: 'builtin/execution@1.0.0',
      driverRef: 'fake',
      skills: ['single-capability-worker'],
      tools: ['search'],
      permissions: ['task.read', 'workspace.read'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    },
    paths,
    runtimeId: 'runtime-fake',
    workspace,
  });
  assert.equal(fake.driver.kind, 'humanagent.fake');
  assert.equal(fake.execution, undefined);

  const dshAgent = {
    agentId: 'execution-dsh',
    roleId: 'execution' as const,
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'dsh' as const,
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'] as const,
    resourceClass: 'foreground',
  };
  assert.throws(() => composeAgentDriver({ agent: dshAgent, paths, runtimeId: 'runtime-dsh', workspace }), /execution\.dsh is not configured/);
});

test('DSH home must stay below the HumanAgent control root', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-dsh-home-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  assert.equal(resolveDshHome({ paths, configuredHome: '~/.humanagent/dsh/home' }), join(await realpath(controlRoot), 'dsh', 'home'));
  assert.equal(resolveDshHome({ paths, configuredHome: 'dsh/other' }), join(await realpath(controlRoot), 'dsh', 'other'));
  assert.throws(() => resolveDshHome({ paths, configuredHome: join(workspace, 'dsh') }), /must remain below the HumanAgent control root/);
  assert.throws(() => resolveDshHome({ paths, configuredHome: '~/outside-dsh' }), /must remain below the HumanAgent control root/);
});

test('DSH home rejects a symlink escaping the control root', async () => {
  const { root, controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-dsh-home-link-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const outside = join(root, 'outside-dsh');
  await mkdir(outside);
  await mkdir(join(controlRoot, 'dsh'));
  await symlink(outside, join(controlRoot, 'dsh', 'link'));
  assert.throws(() => resolveDshHome({ paths, configuredHome: 'dsh/link/home' }), /must remain below the HumanAgent control root/);
});

test('DSH settings quote configured provider and model scalars', async () => {
  const { root } = await createConfiguredWorkspace('humanagent-app-dsh-settings-');
  const home = join(root, 'dsh-home');
  await ensureDshSettings(home, {
    sourceRoot: '/locked/dsh',
    home: '~/.humanagent/dsh/home',
    profile: 'sdk',
    provider: 'rcc\n    injected: true',
    model: 'gpt-5.5\n          injected: true',
  });
  const document = await readFile(join(home, 'settings.yaml'), 'utf8');
  assert.match(document, /^    "rcc\\n    injected: true":$/m);
  assert.match(document, /^        - id: "gpt-5\.5\\n          injected: true"$/m);
  assert.equal(document.includes('\n    injected: true'), false);
  assert.equal(document.includes('\n          injected: true'), false);
});

test('DSH driver rejects a sourceRoot that does not match the locked DSH commit', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-dsh-lock-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const agent = {
    agentId: 'execution-dsh',
    roleId: 'execution' as const,
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'dsh' as const,
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'] as const,
    resourceClass: 'foreground',
  };
  assert.throws(() => composeAgentDriver({
    agent,
    paths,
    dsh: {
      sourceRoot: join(workspace, 'missing-dsh-source'),
      home: '~/.humanagent/dsh/home',
      profile: 'sdk',
      provider: 'rcc',
      model: 'gpt-5.5',
    },
    runtimeId: 'runtime-dsh-lock',
    workspace,
  }), /DSH source is not the locked commit/);
});

test('DSH source lock rejects untracked source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-dsh-source-lock-'));
  execFileSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'tracked.ts'), 'export const tracked = true;\n', 'utf8');
  execFileSync('git', ['add', 'tracked.ts'], { cwd: root, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=HumanAgent Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: root, encoding: 'utf8' });
  const lock = {
    source: 'test-fixture',
    reference: 'refs/heads/main',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
    describe: execFileSync('git', ['describe', '--tags', '--always'], { cwd: root, encoding: 'utf8' }).trim(),
    versionTag: 'fixture',
    recordedAt: '2026-09-14T00:00:00.000Z',
  };
  assertDshSourceMatchesLock(root, lock);
  await writeFile(join(root, 'untracked.ts'), 'export const untracked = true;\n', 'utf8');
  assert.throws(() => assertDshSourceMatchesLock(root, lock), /DSH source is not the locked commit/);
});

test('DSH patches are contained, required, and content-addressed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-dsh-patches-'));
  const sourceRoot = join(root, 'source');
  const patchRef = 'apps/cli/src/approved.patch.yml';
  const patchFile = join(sourceRoot, patchRef);
  await mkdir(join(sourceRoot, 'apps/cli/src'), { recursive: true });
  await writeFile(patchFile, '- id: approved\n', 'utf8');
  const approvedDigest = `sha256:${createHash('sha256').update('- id: approved\n').digest('hex')}`;
  const approved = [{ ref: patchRef, digest: approvedDigest }];

  const verified = verifyDshPatches(sourceRoot, [patchRef], approved);
  assert.deepEqual(verified.refs, [patchRef]);
  assert.deepEqual(verified.files, [await realpath(patchFile)]);
  assert.deepEqual(verified.digests, [approvedDigest]);
  assert.throws(() => verifyDshPatches(sourceRoot, [], approved), /patch set must contain exactly/);

  await writeFile(patchFile, '- id: modified\n', 'utf8');
  assert.throws(() => verifyDshPatches(sourceRoot, [patchRef], approved), /content does not match/);

  const outsideRef = '../outside.patch.yml';
  await writeFile(join(root, 'outside.patch.yml'), '- id: outside\n', 'utf8');
  const outsideDigest = `sha256:${createHash('sha256').update('- id: outside\n').digest('hex')}`;
  assert.throws(
    () => verifyDshPatches(sourceRoot, [outsideRef], [{ ref: outsideRef, digest: outsideDigest }]),
    /outside the locked source tree/,
  );
});

test('run creates a HumanAgent task, operation, checkpoint, and run manifest', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-run-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-run',
    plan: 'default',
    prompt: 'inspect the configuration',
  });
  assert.equal(result.taskId.value, 'session-run');
  assert.equal(result.executionEpoch, 1);
  assert.equal(result.checkpoint.outcome, 'succeeded');
  assert.equal(result.receipt.observedKinds.includes('fake.operation'), true);
  assert.equal(result.checkpoint.scope.operationId?.value, result.operationId.value);
  const manifest = await readRunManifest(paths, 'session-run');
  assert.equal(manifest.taskId.value, result.taskId.value);
  assert.equal(manifest.operationId.value, result.operationId.value);
  assert.equal(manifest.driverRef, 'fake');
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  assert.match(await readFile(checkpointFile, 'utf8'), /"outcome":"succeeded"/);
});

test('real JSONL checkpoint journal deduplicates retries by stable commit identity and rejects conflicts', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-checkpoint-commit-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const filePath = join(paths.journalRoot, 'checkpoint-commit-identity.jsonl');
  const journal = createJsonlCheckpointJournal({ filePath });
  const scope = {
    organId: id('organ', 'checkpoint-commit-organ'),
    taskId: id('task', 'checkpoint-commit-task'),
    cycleId: id('cycle', 'checkpoint-commit-cycle'),
  };
  const recoveryStateRef: EvidenceRef = {
    evidenceId: id('evidence', 'checkpoint-commit-recovery'),
    kind: 'operation',
    source: 'test',
    locator: 'records/recovery',
    scope,
  };
  const checkpoint = {
    id: id('checkpoint', 'checkpoint-commit-1'),
    scope,
    cycleId: scope.cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded' as const,
    summary: 'stable checkpoint commit',
    recoveryStateRef,
    evidenceRefs: [{
      evidenceId: id('evidence', 'checkpoint-commit-evidence'),
      kind: 'operation' as const,
      source: 'test',
      locator: 'records/evidence',
      scope,
    }],
    next: { kind: 'continue' as const, ref: 'next' },
  };
  const request = {
    ownerId: 'checkpoint-owner',
    commitId: checkpointCommitId(checkpoint),
    checkpoint,
  };

  const first = await journal.append(request);
  const retry = await journal.append(request);
  assert.equal(first.seq, 1);
  assert.deepEqual(retry, first);
  assert.equal((await readFile(filePath, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await new JsonlOrganJournal(filePath).findByCommitId(request.commitId))?.seq, 1);

  await assert.rejects(
    () => journal.append({
      ...request,
      checkpoint: { ...checkpoint, summary: 'different checkpoint fact' },
    }),
    (error: unknown) => error instanceof JournalCommitConflictError,
  );
});

test('run manifest rejects tampered or cross-session identity fields', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-manifest-integrity-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-manifest-integrity',
    plan: 'default',
    prompt: 'inspect the configuration',
  });
  const manifestFile = join(paths.runNotesRoot, 'session-manifest-integrity.manifest.json');
  const original = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, any>;
  const mutations: Array<{ readonly label: string; readonly mutate: (value: Record<string, any>) => void }> = [
    { label: 'session', mutate: (value) => { value.sessionId = 'other-session'; } },
    { label: 'agent', mutate: (value) => { value.agentId = ''; } },
    { label: 'driver', mutate: (value) => { value.driverRef = 'remote'; } },
    { label: 'runtime', mutate: (value) => { value.runtimeId = ''; } },
    { label: 'task', mutate: (value) => { value.taskId.value = 'other-task'; } },
    { label: 'operation', mutate: (value) => { value.operationId.value = 'runtime-other-epoch-1'; } },
    { label: 'epoch', mutate: (value) => { value.executionEpoch = 2; } },
    { label: 'revision', mutate: (value) => { value.directiveRevision = 0; } },
    { label: 'cycle', mutate: (value) => { value.cycleId.value = 'other-cycle'; } },
    { label: 'scope organ', mutate: (value) => { value.scope.organId.value = ''; } },
    { label: 'scope task', mutate: (value) => { value.scope.taskId.value = 'other-task'; } },
  ];
  for (const mutation of mutations) {
    const tampered = structuredClone(original);
    mutation.mutate(tampered);
    await writeFile(manifestFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    await assert.rejects(() => readRunManifest(paths, 'session-manifest-integrity'), /run manifest/);
  }
});

test('run manifest accepts explicit HumanAgent identities without deriving them from the session', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-manifest-explicit-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const taskId = id('task', 'external-task');
  const operationId = id('operation', 'external-operation');
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-manifest-explicit',
    plan: 'default',
    prompt: 'inspect the configuration',
    runtimeId: 'runtime-explicit',
    taskId,
    operationId,
  });
  const manifest = await readRunManifest(paths, 'session-manifest-explicit');
  assert.equal(manifest.runtimeId, 'runtime-explicit');
  assert.deepEqual(manifest.taskId, taskId);
  assert.deepEqual(manifest.operationId, operationId);
  assert.equal(result.taskId.value, taskId.value);
  assert.equal(result.operationId.value, operationId.value);
});

test('resume reads the HumanAgent checkpoint and either resumes or waits explicitly', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-op-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-op',
    plan: 'default',
    prompt: 'inspect the configuration',
  });
  const manifest = await readRunManifest(paths, 'session-resume-op');
  const resumed = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-op',
    plan: 'default',
    prompt: 'continue inspection',
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });
  assert.equal(resumed.recovered?.checkpoint.id.value, result.checkpoint.id.value);
  // A succeeded checkpoint is already terminal, so recovery reports waiting
  // instead of fabricating a new DSH session.
  assert.equal(resumed.execution, undefined);
  assert.match(resumed.waitingReason ?? '', /terminal: succeeded/);
});

test('resume rejects a session whose manifest driver no longer matches configuration', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-driver-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-driver',
    plan: 'default',
    prompt: 'inspect the configuration',
    composed: { driver: new FakeAgentDriver({ 'session-resume-driver-assignment': 'failed' }) },
  });
  const manifest = await readRunManifest(paths, 'session-resume-driver');
  await assert.rejects(
    () => resumeAgentOperation({
      paths,
      configuration,
      workspace,
      sessionId: 'session-resume-driver',
      plan: 'default',
      prompt: 'continue inspection',
      taskId: manifest.taskId,
      cycleId: manifest.cycleId,
      scope: manifest.scope,
      executionEpoch: manifest.executionEpoch,
      directiveRevision: manifest.directiveRevision,
      agentId: manifest.agentId,
      driverRef: manifest.driverRef === 'fake' ? 'dsh' : 'fake',
    }),
    /run manifest requires driver dsh/,
  );
  assert.equal(result.checkpoint.outcome, 'failed');
});

test('resume with no HumanAgent checkpoint returns a nullable recovery result', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-missing-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const resumed = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-missing',
    plan: 'default',
    prompt: 'continue',
    taskId: id('task', 'missing-task'),
    cycleId: id('cycle', 'missing-cycle'),
    scope: { organId: id('organ', 'missing-organ'), taskId: id('task', 'missing-task'), operationId: id('operation', 'missing-operation') },
    executionEpoch: 1,
    directiveRevision: 1,
    agentId: 'execution-fake',
    driverRef: 'fake',
  });
  assert.equal(resumed.recovered, null);
  assert.match(resumed.waitingReason ?? '', /no checkpoint exists/);
});

test('app stop writes a stopped checkpoint only after real settle evidence', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop',
    plan: 'default',
    prompt: 'stop after submit',
    composed: { driver: new FakeAgentDriver({ 'session-stop-assignment': 'stopped' }) },
  });
  await controller.start();
  await controller.submit();
  const stopped = await controller.stop();
  if (stopped.state !== 'stopped') {
    throw new Error(`expected a stopped control result, received ${stopped.state}`);
  }
  assert.equal(stopped.checkpoint.outcome, 'stopped');
  assert.equal(stopped.closure.state, 'stopped');
  assert.equal(stopped.checkpoint.scope.operationId?.value, controller.snapshot().operationId.value);
  const manifest = await readRunManifest(paths, 'session-stop');
  assert.equal(manifest.operationId.value, controller.snapshot().operationId.value);
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  assert.match(await readFile(checkpointFile, 'utf8'), /"outcome":"stopped"/);
  let completionError: unknown;
  try {
    await controller.complete();
  } catch (error) {
    completionError = error;
  }
  assert.match((completionError as Error | undefined)?.message ?? '', /agent operation was stopped/);
});

test('app stop does not commit stopped when settle fails', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-stop-settle-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const controller = await openAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-stop-failed',
    plan: 'default',
    prompt: 'fail during settle',
    composed: { driver: new FakeAgentDriver({ 'session-stop-failed-assignment': 'failed' }) },
  });
  await controller.start();
  await controller.submit();
  const result = await controller.stop();
  assert.equal(result.state, 'settling');
  const checkpointFile = join(paths.journalRoot, 'checkpoints.jsonl');
  const content = await readFile(checkpointFile, 'utf8').catch(() => '');
  assert.equal(content.includes('"outcome":"stopped"'), false);
});

test('resume from a failed checkpoint starts a new HumanAgent epoch', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-resume-epoch-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const first = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-epoch',
    plan: 'default',
    prompt: 'fail once',
    composed: { driver: new FakeAgentDriver({ 'session-resume-epoch-assignment': 'failed' }) },
  });
  assert.equal(first.checkpoint.outcome, 'failed');
  const manifest = await readRunManifest(paths, 'session-resume-epoch');
  const recovered = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-resume-epoch',
    plan: 'default',
    prompt: 'continue after failure',
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });
  assert.equal(recovered.recovered?.checkpoint.id.value, first.checkpoint.id.value);
  assert.equal(recovered.execution?.executionEpoch, 2);
  assert.equal(recovered.execution?.checkpoint.outcome, 'succeeded');
});

test('CLI resume closes the session with the checkpoint from the recovered execution', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-resume-state-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const sessionId = 'session-cli-resume-state';
  const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId });
  await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
  await runtime.lock.release();
  const first = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId,
    plan: 'default',
    prompt: 'fail once',
    composed: { driver: new FakeAgentDriver({ [`${sessionId}-assignment`]: 'failed' }) },
  });
  assert.equal(first.checkpoint.outcome, 'failed');

  const resumed = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'),
    'resume',
    '--workspace',
    workspace,
    '--control-root',
    controlRoot,
    '--session',
    sessionId,
    '--prompt',
    'continue after failure',
  ], { encoding: 'utf8', stdio: 'pipe' })) as {
    readonly state: string;
    readonly checkpointId: string;
    readonly recoveredCheckpointId: string;
    readonly resumedOutcome: string;
  };
  assert.equal(resumed.state, 'stopped');
  assert.equal(resumed.resumedOutcome, 'succeeded');
  assert.equal(resumed.recoveredCheckpointId, first.checkpoint.id.value);

  const session = await new SessionStore(paths).open(sessionId);
  assert.equal(session.state, 'stopped');
  assert.equal(session.records.at(-1)?.type, 'session.closed');
  assert.equal(session.records.at(-1)?.checkpointRef, resumed.checkpointId);
});

test('session outcome settlement commits failed checkpoints without marking them recoverable', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-cli-run-failed-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const sessionId = 'session-cli-run-failed';
  const runtime = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId });
  await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
  const state = await settleSessionOutcome(runtime, 'failed', 'checkpoint:failed');
  assert.equal(state, 'failed');
  await runtime.lock.release();

  const session = await new SessionStore(paths).open(sessionId);
  assert.equal(session.state, 'failed');
  assert.equal(session.records.at(-1)?.type, 'session.failed');
  assert.equal(session.records.at(-1)?.checkpointRef, 'checkpoint:failed');
});

test('runtime crash preserves original error in a failed checkpoint and resumes in a new epoch', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-crash-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const driver = new CountingCrashSubmitDriver();
  const first = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-crash-epoch',
    plan: 'default',
    prompt: 'crash during execution',
    composed: { driver },
  });
  assert.equal(first.checkpoint.outcome, 'failed');
  assert.match(first.checkpoint.evidenceRefs[0]?.locator ?? '', /DSH%20runtime%20exited/);
  assert.equal(driver.settleCalls >= 1, true);
  const manifest = await readRunManifest(paths, 'session-crash-epoch');
  const recovered = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-crash-epoch',
    plan: 'default',
    prompt: 'continue after crash',
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });
  assert.equal(recovered.recovered?.checkpoint.id.value, first.checkpoint.id.value);
  assert.equal(recovered.execution?.executionEpoch, 2);
  assert.equal(recovered.execution?.checkpoint.outcome, 'succeeded');
});

test('prompt rejection is committed as a failed checkpoint', async () => {
  const { controlRoot, workspace } = await createConfiguredWorkspace('humanagent-app-prompt-rejected-');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId: 'session-prompt-rejected',
    plan: 'default',
    prompt: 'rejected by provider',
    composed: { driver: new RejectPromptDriver() },
  });
  assert.equal(result.checkpoint.outcome, 'failed');
  assert.match(result.checkpoint.evidenceRefs[0]?.locator ?? '', /prompt-rejected/);
});

test('session lifecycle is persisted below control root and keeps agent cwd separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const created = await store.create({ sessionId: 'session-1', plan: 'default' });
  assert.equal(created.state, 'created');
  assert.equal(created.path.startsWith(paths.controlRoot), true);
  assert.equal(paths.agentCwd, paths.controlRoot);
  const ready = await store.append('session-1', { type: 'session.state', state: 'ready' });
  assert.equal(ready.state, 'ready');
  const closed = await store.close('session-1', 'checkpoint:1');
  assert.equal(closed.state, 'stopped');
  assert.equal((await store.open('session-1')).state, 'stopped');
});

test('session writes are lock-bound and serialized per session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-session-write-lock-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-write-lock');
  await store.create({ sessionId: 'session-write-lock', plan: 'default' }, lock);
  const [ready, running] = await Promise.all([
    store.append('session-write-lock', { type: 'session.state', state: 'ready' }, lock),
    store.append('session-write-lock', { type: 'session.state', state: 'running' }, lock),
  ]);
  assert.equal(ready.records.length, 2);
  assert.equal(running.records.length, 3);
  assert.deepEqual(running.records.map((record) => record.seq), [1, 2, 3]);
  const contender = new SessionStore(paths);
  await assert.rejects(() => contender.append('session-write-lock', { type: 'session.state', state: 'stopping' }), /already owned/);
  await lock.release();
});

test('incomplete trailing session line is visible and never treated as a committed record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-tail-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-tail', plan: 'default' });
  await appendFile(join(paths.sessionsRoot, 'session-tail.jsonl'), '{"schemaVersion":1,"sessionId":"session-tail"', 'utf8');
  const opened = await store.open('session-tail');
  assert.equal(opened.recoverableTail, true);
  assert.equal(opened.state, 'created');
  assert.equal(opened.records.length, 1);
});

test('appending after a recoverable tail truncates only the uncommitted tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-recover-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-recover', plan: 'default' });
  await appendFile(join(paths.sessionsRoot, 'session-recover.jsonl'), '{"uncommitted":', 'utf8');
  const recovered = await store.append('session-recover', { type: 'session.state', state: 'ready' });
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.recoverableTail, false);
  assert.equal(recovered.records.length, 2);
});

test('a complete final JSON record without a newline is committed and preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-no-newline-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-no-newline', plan: 'default' });
  const sessionPath = join(paths.sessionsRoot, 'session-no-newline.jsonl');
  const content = await readFile(sessionPath, 'utf8');
  await writeFile(sessionPath, content.slice(0, -1), 'utf8');
  const opened = await store.open('session-no-newline');
  assert.equal(opened.recoverableTail, false);
  assert.equal(opened.records.length, 1);
  const ready = await store.append('session-no-newline', { type: 'session.state', state: 'ready' });
  assert.equal(ready.records.length, 2);
  assert.equal((await store.open('session-no-newline')).records.length, 2);
});

test('session path never uses workspace persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-path-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  assert.equal(paths.sessionsRoot.startsWith(paths.controlRoot), true);
  assert.equal(paths.sessionsRoot.startsWith(workspace), false);
});

test('session lock is atomic and remains below control root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-lock');
  assert.equal(lock.path.startsWith(paths.controlRoot), true);
  await assert.rejects(() => store.acquire('session-lock'), /already owned/);
  await lock.release();
  const second = await store.acquire('session-lock');
  await second.release();
});

test('session lock rejects path traversal ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-id-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await assert.rejects(() => store.acquire('../escape'), /invalid session id/);
});

test('closeRuntime releases its lock after the stopped record is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-close-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const handle = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-close' });
  const closed = await closeRuntime(handle, 'checkpoint:close');
  assert.equal(closed.state, 'stopped');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-close');
  await lock.release();
});

test('resumeRuntime reopens an existing non-terminal session without creating a second session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-resume-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const handle = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-resume' });
  await handle.lock.release();
  const resumed = await resumeRuntime({ controlRoot, workspace, sessionId: 'session-resume' });
  assert.equal(resumed.session.state, 'ready');
  await resumed.lock.release();
});

test('session open rejects semantically invalid committed history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-corrupt-history-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-corrupt-history', plan: 'default' });
  const path = join(paths.sessionsRoot, 'session-corrupt-history.jsonl');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, state: 'bogus' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-corrupt-history'), /session record is missing required fields/);
});

test('session history must begin with a created record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-first-record-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);

  await store.create({ sessionId: 'session-first-state', plan: 'default' });
  const firstStatePath = join(paths.sessionsRoot, 'session-first-state.jsonl');
  const firstState = JSON.parse(await readFile(firstStatePath, 'utf8')) as Record<string, unknown>;
  await writeFile(firstStatePath, JSON.stringify({ ...firstState, type: 'session.state', state: 'ready' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-first-state'), /must begin with session.created/);

  await store.create({ sessionId: 'session-first-failed', plan: 'default' });
  const firstFailedPath = join(paths.sessionsRoot, 'session-first-failed.jsonl');
  const firstFailed = JSON.parse(await readFile(firstFailedPath, 'utf8')) as Record<string, unknown>;
  await writeFile(firstFailedPath, JSON.stringify({ ...firstFailed, type: 'session.failed', state: 'failed' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-first-failed'), /must begin with session.created/);
});

test('session append enforces lifecycle transitions and terminal record types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-transition-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-transition', plan: 'default' });
  await assert.rejects(() => store.append('session-transition', { type: 'session.state', state: 'stopped' }), /terminal state requires/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.state', state: 'running' }), /invalid session transition/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.closed', state: 'ready' }), /must commit stopped/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.closed', state: 'stopped' }), /cannot close session/);
  const ready = await store.append('session-transition', { type: 'session.state', state: 'ready' });
  assert.equal(ready.state, 'ready');
});

test('an old lock handle cannot remove a replacement owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-owner-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const first = await store.acquire('session-replaced');
  await rm(first.path, { recursive: true, force: true });
  const second = await store.acquire('session-replaced');
  await assert.rejects(() => first.release(), /owned by another runtime/);
  await second.release();
});
