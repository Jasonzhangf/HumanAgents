import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, loadConfiguration, parseToml, resolveProjectSourceManifest, resolveRuntimePaths, validateInternalConfig, validateUserConfig } from '../../packages/config/src/index.js';

test('parses agent array tables and sections', () => {
  const value = parseToml('schemaVersion = 1\n[[agents]]\nagentId = "one"\nroleId = "interaction"\ntemplateRef = "t"\ndriverRef = "fake"\nskills = ["a"]\ntools = ["b"]\npermissions = ["c"]\nmemoryScopes = ["task"]\nresourceClass = "foreground"\n[project]\nreviewRequired = true\n');
  assert.equal((value.agents as unknown[]).length, 1);
  assert.equal((value.project as { reviewRequired: boolean }).reviewRequired, true);
});

test('rejects duplicate TOML keys and table declarations', () => {
  assert.throws(() => parseToml('schemaVersion = 1\nschemaVersion = 1\n'), /duplicate key/);
  assert.throws(() => parseToml('[project]\nreviewRequired = true\n[project]\n'), /duplicate table/);
  assert.throws(() => parseToml('[[agents]]\nagentId = "one"\nagentId = "two"\n'), /duplicate key/);
});

test('resolves all persistence below control root and keeps workspace separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  assert.equal(paths.agentCwd, paths.controlRoot);
  assert.equal(paths.mainRoot, join(paths.controlRoot, 'main'));
  assert.equal(paths.mainSessionsRoot, join(paths.controlRoot, 'main', 'sessions'));
  assert.equal(paths.projectRoot, join(paths.controlRoot, 'sessions', paths.projectKey));
  assert.equal(paths.sessionsRoot, paths.projectRoot);
  assert.equal(paths.projectRoot === paths.workspaceCwd, false);
  assert.equal(paths.projectRoot.startsWith(paths.controlRoot), true);
  assert.equal(paths.workspaceCwd, await realpath(workspace));
  assert.equal(paths.projectKey, (await realpath(workspace)).replaceAll('/', '-') || '-');
  const loaded = await loadConfiguration(paths);
  assert.equal(loaded.agentRoster.length, 2);
  assert.equal(JSON.stringify(loaded.effective.provider), JSON.stringify({
    provider: 'rcc',
    binding: 'rcc-entry',
    protocol: 'responses',
    model: 'MiniMax-M3',
    route: 'default',
    baseUrl: 'http://127.0.0.1:4444',
  }));
});

test('resolves an explicitly declared cwd-named local Skill source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-project-source-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await writeFile(paths.projectManifest, JSON.stringify({
    schemaVersion: 1,
    projectKey: paths.projectKey,
    workspaceCwd: paths.workspaceCwd,
    sources: { localSkill: { root, name: 'workspace' } },
  }), 'utf8');
  const manifest = await resolveProjectSourceManifest(paths);
  assert.equal(JSON.stringify(manifest.sources?.localSkill), JSON.stringify({ root: await realpath(root), name: 'workspace' }));
});

test('rejects malformed, duplicate, identity-mismatched, non-absolute, and misnamed project sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-project-source-invalid-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const cases: readonly [string, unknown, RegExp][] = [
    ['malformed', [], /project manifest must be a JSON object/],
    ['identity', { schemaVersion: 1, projectKey: 'other', workspaceCwd: paths.workspaceCwd }, /project manifest does not match/],
    ['non-absolute', { schemaVersion: 1, projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd, sources: { localSkill: { root: 'relative', name: 'workspace' } } }, /absolute path/],
    ['misnamed', { schemaVersion: 1, projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd, sources: { localSkill: { root, name: 'other' } } }, /canonical workspace basename/],
    ['duplicate', { schemaVersion: 1, projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd, sources: { localSkill: [{ root, name: 'workspace' }, { root, name: 'workspace' }] } }, /single object/],
  ];
  for (const [, manifest, expected] of cases) {
    await writeFile(paths.projectManifest, JSON.stringify(manifest), 'utf8');
    await assert.rejects(() => resolveProjectSourceManifest(paths), expected);
  }
});

test('uses HUMANAGENT_HOME when no explicit control root is provided', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-env-home-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'configured-control');
  await mkdir(workspace);
  const previous = process.env.HUMANAGENT_HOME;
  process.env.HUMANAGENT_HOME = controlRoot;
  try {
    const paths = await resolveRuntimePaths({ workspace });
    assert.equal(paths.controlRoot, await realpath(controlRoot));
    assert.equal(paths.agentCwd, paths.controlRoot);
    await ensureControlLayout(paths);
    assert.equal(paths.projectRoot.startsWith(paths.controlRoot), true);
  } finally {
    if (previous === undefined) delete process.env.HUMANAGENT_HOME;
    else process.env.HUMANAGENT_HOME = previous;
  }
});

test('concurrent first startup converges on one control layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-concurrent-start-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  await mkdir(workspace);
  const [first, second] = await Promise.all([
    resolveRuntimePaths({ controlRoot, workspace }),
    resolveRuntimePaths({ controlRoot, workspace }),
  ]);
  await Promise.all([ensureControlLayout(first), ensureControlLayout(second)]);
  const loaded = await loadConfiguration(first);
  assert.equal(loaded.paths.projectKey, first.projectKey);
  assert.equal((await loadConfiguration(second)).paths.projectKey, second.projectKey);
});

test('derives project persistence from the validated internal sessionRoot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-session-root-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await mkdir(controlRoot, { recursive: true });
  await writeFile(join(controlRoot, 'internal.toml'), [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "runtime-state"',
    'pluginManifest = "plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n'), 'utf8');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  assert.equal(paths.projectRoot, join(paths.controlRoot, 'runtime-state', paths.projectKey));
  await ensureControlLayout(paths);
  const loaded = await loadConfiguration(paths);
  assert.equal(loaded.internal.sessionRoot, join(paths.controlRoot, 'runtime-state'));
  assert.equal(loaded.paths.projectRoot, join(loaded.internal.sessionRoot, paths.projectKey));
});

test('rejects an internal sessionRoot outside the control root', () => {
  assert.throws(() => validateInternalConfig({
    schemaVersion: 1,
    controlRoot: '~/.humanagent',
    agentCwd: '~/.humanagent',
    sessionRoot: '../outside',
    pluginManifest: 'plugins/manifest.json',
    releaseChannel: 'stable',
    configPolicy: 'internal-overrides-user',
  }, '/tmp/humanagent-control'), /sessionRoot must remain below/);
});

test('rejects misspelled internal configuration keys', () => {
  assert.throws(() => validateInternalConfig({
    schemaVersion: 1,
    controlRoot: '~/.humanagent',
    agentCwd: '~/.humanagent',
    sessionRoot: 'project',
    pluginManifest: 'plugins/manifest.json',
    releaseChannel: 'stable',
    configPolicy: 'internal-overrides-user',
    sesssionRoot: 'ignored-by-accident',
  }, '/tmp/humanagent-control'), /internal config contains unsupported key: sesssionRoot/);
});

test('rejects symlinked control and session roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-symlink-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const actualControlRoot = join(root, 'actual-control');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(controlRoot, { recursive: true });
  await mkdir(actualControlRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  symlinkSync(actualControlRoot, join(root, 'control-link'));
  let controlError: unknown;
  try {
    await resolveRuntimePaths({ controlRoot: join(root, 'control-link'), workspace });
  } catch (error) {
    controlError = error;
  }
  assert.equal(String(controlError).includes('control root cannot be a symlink'), true);
  symlinkSync(outside, join(controlRoot, 'storage'));
  await writeFile(join(controlRoot, 'internal.toml'), [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "storage"',
    'pluginManifest = "plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n'), 'utf8');
  let sessionError: unknown;
  try {
    await resolveRuntimePaths({ controlRoot, workspace });
  } catch (error) {
    sessionError = error;
  }
  assert.equal(String(sessionError).includes('sessionRoot cannot be a symlink'), true);
});

test('rejects missing controlled paths below an in-root symlink ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-symlink-ancestor-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const actualStorage = join(controlRoot, 'actual-storage');
  await mkdir(workspace);
  await mkdir(actualStorage, { recursive: true });
  symlinkSync(actualStorage, join(controlRoot, 'storage'));

  await writeFile(join(controlRoot, 'internal.toml'), [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "storage/missing-projects"',
    'pluginManifest = "plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n'), 'utf8');
  await assert.rejects(() => resolveRuntimePaths({ controlRoot, workspace }), /controlled path cannot traverse a symlink/);

  await writeFile(join(controlRoot, 'internal.toml'), [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "projects"',
    'pluginManifest = "storage/missing-plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n'), 'utf8');
  await assert.rejects(() => resolveRuntimePaths({ controlRoot, workspace }), /controlled path cannot traverse a symlink/);
});

test('rejects a symlinked project persistence namespace before writing outside control root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-project-symlink-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(controlRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(controlRoot, 'internal.toml'), [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "runtime-state"',
    'pluginManifest = "plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n'), 'utf8');
  await mkdir(join(controlRoot, 'runtime-state'), { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  symlinkSync(outside, paths.projectRoot);
  await assert.rejects(() => ensureControlLayout(paths), /persistence path cannot contain a symlink/);
});

test('rejects any caller-supplied persistence path outside the control root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-layout-boundary-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await assert.rejects(() => ensureControlLayout({ ...paths, sessionsRoot: outside }), /persistence path escaped control root/);
});

test('rejects managed configuration files symlinked outside the control root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-file-symlink-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(controlRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'internal.toml'), 'schemaVersion = 1\n', 'utf8');
  symlinkSync(join(outside, 'internal.toml'), join(controlRoot, 'internal.toml'));
  await assert.rejects(() => resolveRuntimePaths({ controlRoot, workspace }), /managed file cannot be a symlink/);

  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'second-control'), workspace });
  await writeFile(join(outside, 'config.toml'), 'schemaVersion = 1\n', 'utf8');
  symlinkSync(join(outside, 'config.toml'), join(paths.controlRoot, 'config.toml'));
  await assert.rejects(() => loadConfiguration(paths), /symlink/);
});

test('rejects a regular file as the execution workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-file-workspace-'));
  const workspace = join(root, 'workspace-file');
  await writeFile(workspace, 'not a directory\n', 'utf8');
  await assert.rejects(() => resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace }), /workspace is not a directory/);
});

test('rejects internal override in user config', async () => {
  assert.throws(() => {
    const value = parseToml('schemaVersion = 1\ncontrolRoot = "/tmp"\n');
    validateUserConfig(value);
  }, /internal key/);
});

test('loads project overrides without allowing a second agent roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-project-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[project]\ndefaultAgent = "interaction-default"\n[execution]\nmaxConcurrentTasks = 1\n', 'utf8');
  const loaded = await loadConfiguration(paths);
  assert.equal(loaded.projectOverride?.project?.defaultAgent, 'interaction-default');
  assert.equal(loaded.projectOverride?.execution?.maxConcurrentTasks, 1);
  assert.equal(loaded.effective.execution?.maxConcurrentTasks, 1);
});

test('rejects project overrides that widen concurrency or disable required review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-policy-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[project]\nreviewRequired = false\n[execution]\nmaxConcurrentTasks = 2\n', 'utf8');
  let reviewError: unknown;
  try {
    await loadConfiguration(paths);
  } catch (error) {
    reviewError = error;
  }
  assert.equal(String(reviewError).includes('cannot disable the user review requirement'), true);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[execution]\nmaxConcurrentTasks = 2\n', 'utf8');
  let concurrencyError: unknown;
  try {
    await loadConfiguration(paths);
  } catch (error) {
    concurrencyError = error;
  }
  assert.equal(String(concurrencyError).includes('cannot exceed the user limit'), true);
});

test('separates colliding readable project keys with a canonical-path suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-collision-'));
  const controlRoot = join(root, 'control');
  const firstWorkspace = join(root, 'workspace', 'a-b');
  const secondWorkspace = join(root, 'workspace', 'a', 'b');
  await mkdir(firstWorkspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  const first = await resolveRuntimePaths({ controlRoot, workspace: firstWorkspace });
  await ensureControlLayout(first);
  const second = await resolveRuntimePaths({ controlRoot, workspace: secondWorkspace });
  assert.equal(first.projectKey === second.projectKey, false);
  assert.equal(/--[0-9a-f]{16}$/.test(second.projectKey), true);
  await ensureControlLayout(second);
});

test('separates colliding project keys below a non-default session root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-session-collision-'));
  const controlRoot = join(root, 'control');
  const firstWorkspace = join(root, 'workspace', 'a-b');
  const secondWorkspace = join(root, 'workspace', 'a', 'b');
  await mkdir(firstWorkspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  await mkdir(controlRoot, { recursive: true });
  await writeFile(join(controlRoot, 'internal.toml'), [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "runtime-state"',
    'pluginManifest = "plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n'), 'utf8');
  const first = await resolveRuntimePaths({ controlRoot, workspace: firstWorkspace });
  await ensureControlLayout(first);
  const second = await resolveRuntimePaths({ controlRoot, workspace: secondWorkspace });
  assert.match(second.projectKey, /--[0-9a-f]{16}$/);
  await ensureControlLayout(second);
});

test('rejects agent capabilities outside the role and permission ceiling', () => {
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [{
      agentId: 'unsafe',
      roleId: 'interaction',
      templateRef: 'builtin/interaction@1.0.0',
      driverRef: 'fake',
      skills: ['input-normalization'],
      tools: ['input.receive'],
      permissions: ['admin'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    }],
  }), /permission is not allowed/);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [{
      agentId: 'unverified-template',
      roleId: 'interaction',
      templateRef: 'builtin/interaction@999.999.999',
      driverRef: 'fake',
      skills: ['input-normalization'],
      tools: ['input.receive'],
      permissions: ['task.read'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    }],
  }), /template ref is not locked/);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [{
      agentId: 'unknown-driver',
      roleId: 'execution',
      templateRef: 'builtin/execution@1.0.0',
      driverRef: 'remote',
      skills: ['single-capability-worker'],
      tools: ['search'],
      permissions: ['task.read', 'workspace.read'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    }],
  }), /unknown agent driver: remote/);
});

test('validates DSH execution config and keeps it user-owned', async () => {
  const agents = [{
    agentId: 'execution-dsh',
    roleId: 'execution',
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'dsh',
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
    memoryScopes: ['task'],
    resourceClass: 'foreground',
  }];
  const valid = validateUserConfig({
    schemaVersion: 1,
    agents,
    execution: {
      dsh: {
        sourceRoot: '/Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915',
        home: '~/.humanagent/dsh/home',
        profile: 'humanagent',
        provider: 'rcc',
        model: 'gpt-5.5',
        patchFiles: ['apps/cli/src/sdk-source.cordis.patch.yml'],
        permissionMode: 'read-only',
        turnTimeoutMs: 900000,
        shutdownTimeoutMs: 60000,
      },
    },
  });
  assert.equal(valid.execution?.dsh?.provider, 'rcc');
  assert.equal(valid.execution?.dsh?.turnTimeoutMs, 900000);

  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents,
    execution: { dsh: { sourceRoot: '/tmp/dsh', home: '~/.humanagent/dsh', profile: 'humanagent', provider: 'rcc', model: 'gpt-5.5', turnTimeoutMs: 0 } },
  }), /turnTimeoutMs must be positive/);

  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-dsh-project-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[execution.dsh]\nsourceRoot = "/tmp/project-dsh"\n', 'utf8');
  let projectError: unknown;
  try {
    await loadConfiguration(paths);
  } catch (error) {
    projectError = error;
  }
  assert.equal(String(projectError).includes('project execution config contains unsupported key: dsh'), true);
});

test('validates a global provider separately from the agent driver and rejects unsupported providers', () => {
  const agents = [{
    agentId: 'interaction-default',
    roleId: 'interaction',
    templateRef: 'builtin/interaction@1.0.0',
    driverRef: 'fake',
    skills: ['input-normalization'],
    tools: ['input.receive'],
    permissions: ['task.read'],
    memoryScopes: ['task'],
    resourceClass: 'foreground',
  }];
  const valid = validateUserConfig({
    schemaVersion: 1,
    agents,
    provider: {
      provider: 'rcc',
      binding: 'rcc-entry',
      protocol: 'responses',
      model: 'MiniMax-M3',
      route: 'default',
      baseUrl: 'http://127.0.0.1:4444',
    },
  });
  assert.equal(valid.provider?.provider, 'rcc');
  assert.equal(valid.provider?.baseUrl, 'http://127.0.0.1:4444');
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents,
    provider: { provider: 'dsh', binding: 'dsh', protocol: 'responses', model: 'x', route: 'default', baseUrl: 'http://127.0.0.1:4444' },
  }), /unknown provider: dsh/);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents,
    provider: { provider: 'fake', binding: 'fake', protocol: 'responses', model: 'x', route: 'default', baseUrl: 'fake:replay' },
  }), /unknown provider: fake/);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents,
    provider: { provider: 'rcc', binding: 'rcc', protocol: 'custom', model: 'x', route: 'default', baseUrl: 'http://127.0.0.1:4444' },
  }), /unsupported provider protocol: custom/);
});

test('rejects misspelled user and project configuration keys', async () => {
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    typo: true,
  }), /user config contains unsupported key: typo/);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [{
      agentId: 'interaction-test',
      roleId: 'interaction',
      templateRef: 'builtin/interaction@1.0.0',
      driverRef: 'fake',
      skills: ['input-normalization', 'task-matching', 'confirmation'],
      tools: ['input.receive', 'task.query', 'proposal.render'],
      permissions: ['task.read', 'task.propose'],
      memoryScopes: ['task'],
      resourceClass: 'foreground',
    }],
    project: { reviewRequred: false },
  }), /user project config contains unsupported key: reviewRequred/);

  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-project-typo-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[execution]\nmaxConcurrntTasks = 2\n', 'utf8');
  let projectError: unknown;
  try {
    await loadConfiguration(paths);
  } catch (error) {
    projectError = error;
  }
  assert.equal(String(projectError).includes('project execution config contains unsupported key: maxConcurrntTasks'), true);
});

test('parses memory update and audit config with safe defaults', () => {
  const parsed = parseToml('schemaVersion = 1\n[memory.update]\nauto = true\n[memory.audit]\nprompt_ref = "project-memory-audit"\n');
  const parsedMemory = parsed.memory as {
    readonly update: { readonly auto: boolean };
    readonly audit: { readonly prompt_ref: string };
  };
  assert.equal(parsedMemory.update.auto, true);
  assert.equal(parsedMemory.audit.prompt_ref, 'project-memory-audit');

  const agents = [{
    agentId: 'memory-default',
    roleId: 'memory',
    templateRef: 'builtin/memory@1.0.0',
    driverRef: 'fake',
    skills: ['history-search', 'novelty-review', 'recurrence-review'],
    tools: ['memory.search', 'memory.ask', 'task.history', 'session.history'],
    permissions: ['task.read', 'memory.read', 'memory.propose'],
    memoryScopes: ['task'],
    resourceClass: 'background',
  }];
  const disabled = validateUserConfig({ schemaVersion: 1, agents, memory: {} });
  assert.equal(disabled.memory?.update.auto, false);
  assert.equal(disabled.memory?.audit.promptRef, 'project-memory-audit');

  const namedPrompt = validateUserConfig({
    schemaVersion: 1,
    agents,
    memory: { audit: { prompt_ref: 'project-audit-v2' } },
  });
  assert.equal(namedPrompt.memory?.update.auto, false);
  assert.equal(namedPrompt.memory?.audit.promptRef, 'project-audit-v2');

  assert.throws(() => validateUserConfig({ schemaVersion: 1, agents, memory: { update: { auto: 'yes' } } }), /memory.update.auto must be boolean/);
  const enabled = validateUserConfig({ schemaVersion: 1, agents, memory: { update: { auto: true } } });
  assert.equal(enabled.memory?.update.auto, true);
  assert.throws(() => validateUserConfig({ schemaVersion: 1, agents, memory: { audit: { prompt: 'embedded text' } } }), /memory.audit contains unsupported key: prompt/);
  assert.throws(() => validateUserConfig({ schemaVersion: 1, agents, memory: { audit: { prompt_ref: '' } } }), /memory.audit.prompt_ref must be a non-empty string/);
  assert.throws(() => validateUserConfig({ schemaVersion: 1, agents, memory: { audit: { prompt_ref: '../prompt' } } }), /memory.audit.prompt_ref must be a safe audit prompt file name/);
  assert.throws(() => validateUserConfig({ schemaVersion: 1, agents, memory: { audit: { prompt_ref: 'source://project-a/audit@r2' } } }), /memory.audit.prompt_ref must be a safe audit prompt file name/);
});

test('rejects multiple memory-role agents so one main agent cannot bind ambiguously', () => {
  const agent = (agentId: string) => ({
    agentId,
    roleId: 'memory',
    templateRef: 'builtin/memory@1.0.0',
    driverRef: 'fake',
    skills: ['history-search', 'novelty-review', 'recurrence-review'],
    tools: ['memory.search', 'memory.ask', 'task.history', 'session.history'],
    permissions: ['memory.read', 'memory.propose'],
    memoryScopes: ['task'],
    resourceClass: 'background',
  });
  assert.throws(
    () => validateUserConfig({
      schemaVersion: 1,
      agents: [agent('memory-a'), agent('memory-b')],
      memory: {},
    }),
    /multiple memory-role agents are not allowed/,
  );
});

test('project memory overrides remain project-scoped and explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-memory-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[memory.update]\nauto = false\n[memory.audit]\nprompt_ref = "project-audit-v2"\n', 'utf8');
  const loaded = await loadConfiguration(paths);
  assert.equal(loaded.effective.memory?.update.auto, false);
  assert.equal(loaded.effective.memory?.audit.promptRef, 'project-audit-v2');

  await writeFile(join(paths.projectRoot, 'config.toml'), '[memory.update]\nauto = true\ntarget = "global"\n', 'utf8');
  await assert.rejects(() => loadConfiguration(paths), /memory.update contains unsupported key: target/);
});
