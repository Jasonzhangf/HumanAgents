import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { ConfigurationError, DEFAULT_UI_DISPLAY_PREFERENCE, applyManualDisplaySelection, compileAgentProviderBindings, declareDefaultProduct, ensureControlLayout, formatPairingCommand, listConfiguredProjects, loadConfiguration, parseToml, readDefaultProductSelection, resolveProductPaths, resolveProjectSourceManifest, resolveRuntimePaths, resolveUiDisplayMode, resolveWebSearchBackendConfig, resolveProviderCredential, saveUiDisplayPreference, validateInternalConfig, validateProjectOverride, validateUiDisplayPreference, validateUserConfig, type EffectiveAgentProviderBinding, type ProviderCredentialRef, type RuntimePaths } from '../../packages/config/src/index.js';

const minimalInteractionAgent = () => ({
  agentId: 'interaction-default',
  roleId: 'interaction',
  templateRef: 'builtin/interaction@1.0.0',
  driverRef: 'fake',
  skills: ['input-normalization'],
  tools: ['input.receive'],
  permissions: ['task.read'],
  memoryScopes: ['task'],
  resourceClass: 'foreground',
});

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

test('pairing config resolves product paths without workspace or product config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-product-paths-'));
  const explicitRoot = join(root, 'explicit-control');
  const environmentRoot = join(root, 'environment-control');
  await mkdir(join(explicitRoot, 'security'), { recursive: true });
  await mkdir(environmentRoot, { recursive: true });
  await writeFile(join(explicitRoot, 'internal.toml'), 'not valid toml =', 'utf8');
  await writeFile(join(explicitRoot, 'config.toml'), '[project]\nworkspace = 7\n', 'utf8');
  const previous = process.env.HUMANAGENT_HOME;
  process.env.HUMANAGENT_HOME = environmentRoot;
  try {
    const explicit = await resolveProductPaths({ controlRoot: explicitRoot });
    assert.equal(explicit.controlRoot, await realpath(explicitRoot));
    assert.equal(explicit.securityRoot, join(explicit.controlRoot, 'security'));
    assert.equal(explicit.webAccessCredentialPath, join(explicit.controlRoot, 'security', 'web-access.json'));
    const environment = await resolveProductPaths({});
    assert.equal(environment.controlRoot, await realpath(environmentRoot));
    await assert.rejects(() => stat(join(environment.controlRoot, 'config.toml')), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.HUMANAGENT_HOME;
    else process.env.HUMANAGENT_HOME = previous;
  }
});

test('pairing config selects the declared default product without environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-default-product-'));
  const home = join(root, 'home');
  const declaredRoot = join(root, 'declared-product');
  await mkdir(home);
  await mkdir(declaredRoot);
  const previousHome = process.env.HOME;
  const previousHumanagentHome = process.env.HUMANAGENT_HOME;
  process.env.HOME = home;
  delete process.env.HUMANAGENT_HOME;
  try {
    const declared = await declareDefaultProduct(declaredRoot);
    assert.deepEqual(declared, { schemaVersion: 1, controlRoot: await realpath(declaredRoot) });
    assert.deepEqual(await readDefaultProductSelection(), declared);
    const paths = await resolveProductPaths({});
    assert.equal(paths.controlRoot, await realpath(declaredRoot));
    assert.match(formatPairingCommand(paths), /--control-root/);
    for (const entry of ['security', 'config.toml', 'internal.toml']) {
      await assert.rejects(() => stat(join(declaredRoot, entry)), /ENOENT/);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHumanagentHome === undefined) delete process.env.HUMANAGENT_HOME;
    else process.env.HUMANAGENT_HOME = previousHumanagentHome;
  }
});

test('pairing config explicit and environment roots bypass and preserve the declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-default-precedence-'));
  const home = join(root, 'home');
  const declaredRoot = join(root, 'declared-product');
  const explicitRoot = join(root, 'explicit-product');
  const environmentRoot = join(root, 'environment-product');
  await mkdir(home);
  await mkdir(declaredRoot);
  await mkdir(explicitRoot);
  await mkdir(environmentRoot);
  const previousHome = process.env.HOME;
  const previousHumanagentHome = process.env.HUMANAGENT_HOME;
  process.env.HOME = home;
  delete process.env.HUMANAGENT_HOME;
  try {
    await declareDefaultProduct(declaredRoot);
    const declarationPath = join(home, '.humanagent', 'default-product.toml');
    const before = await readFile(declarationPath, 'utf8');
    const explicit = await resolveProductPaths({ controlRoot: explicitRoot });
    assert.equal(explicit.controlRoot, await realpath(explicitRoot));
    assert.equal(await readFile(declarationPath, 'utf8'), before);
    process.env.HUMANAGENT_HOME = environmentRoot;
    const environment = await resolveProductPaths({});
    assert.equal(environment.controlRoot, await realpath(environmentRoot));
    assert.equal(await readFile(declarationPath, 'utf8'), before);
    delete process.env.HUMANAGENT_HOME;
    const declared = await resolveProductPaths({});
    assert.equal(declared.controlRoot, await realpath(declaredRoot));
    await writeFile(declarationPath, 'schemaVersion = 2\ncontrolRoot = "relative/root"\n', 'utf8');
    const explicitAgain = await resolveProductPaths({ controlRoot: explicitRoot });
    assert.equal(explicitAgain.controlRoot, await realpath(explicitRoot));
    process.env.HUMANAGENT_HOME = environmentRoot;
    const environmentAgain = await resolveProductPaths({});
    assert.equal(environmentAgain.controlRoot, await realpath(environmentRoot));
    delete process.env.HUMANAGENT_HOME;
    let invalid: unknown;
    try {
      await resolveProductPaths({});
    } catch (error) {
      invalid = error;
    }
    assert.equal(invalid instanceof ConfigurationError, true);
    assert.equal((invalid as ConfigurationError).code, 'default-product-selection-invalid');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHumanagentHome === undefined) delete process.env.HUMANAGENT_HOME;
    else process.env.HUMANAGENT_HOME = previousHumanagentHome;
  }
});

test('pairing config rejects invalid default declarations without initializing a product', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-default-invalid-'));
  const home = join(root, 'home');
  const bootstrap = join(home, '.humanagent');
  await mkdir(bootstrap, { recursive: true });
  const declarationPath = join(bootstrap, 'default-product.toml');
  const previousHome = process.env.HOME;
  const previousHumanagentHome = process.env.HUMANAGENT_HOME;
  process.env.HOME = home;
  delete process.env.HUMANAGENT_HOME;
  try {
    const invalidCases = [
      'not valid toml =',
      'schemaVersion = 2\ncontrolRoot = "/tmp/other-product"\n',
      'schemaVersion = 1\ncontrolRoot = "relative/root"\n',
      `schemaVersion = 1\ncontrolRoot = ${JSON.stringify(join(root, 'missing-product'))}\n`,
      'schemaVersion = 1\ncontrolRoot = 7\n',
    ];
    for (const contents of invalidCases) {
      await writeFile(declarationPath, contents, 'utf8');
      let failure: unknown;
      try {
        await resolveProductPaths({});
      } catch (error) {
        failure = error;
      }
      assert.equal(failure instanceof ConfigurationError, true);
      assert.equal((failure as ConfigurationError).code, 'default-product-selection-invalid');
    }
    for (const entry of ['security', 'config.toml', 'internal.toml']) {
      await assert.rejects(() => stat(join(bootstrap, entry)), /ENOENT/);
    }
    const missingTarget = join(root, 'not-created-product');
    let declareFailure: unknown;
    try {
      await declareDefaultProduct(missingTarget);
    } catch (error) {
      declareFailure = error;
    }
    assert.equal(declareFailure instanceof ConfigurationError, true);
    assert.equal((declareFailure as ConfigurationError).code, 'default-product-selection-invalid');
    await assert.rejects(() => stat(missingTarget), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHumanagentHome === undefined) delete process.env.HUMANAGENT_HOME;
    else process.env.HUMANAGENT_HOME = previousHumanagentHome;
  }
});

test('pairing config declared workspace is independent of cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-declared-workspace-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'brain');
  const firstCwd = join(root, 'first-cwd');
  const secondCwd = join(root, 'second-cwd');
  await mkdir(controlRoot);
  await mkdir(workspace);
  await mkdir(firstCwd);
  await mkdir(secondCwd);
  await writeFile(join(controlRoot, 'config.toml'), `[project]\nworkspace = ${JSON.stringify(workspace)}\n`, 'utf8');
  const processApi = process as unknown as { cwd(): string; chdir(path: string): void };
  const previousCwd = processApi.cwd();
  try {
    processApi.chdir(firstCwd);
    const first = await resolveRuntimePaths({ controlRoot });
    processApi.chdir(secondCwd);
    const second = await resolveRuntimePaths({ controlRoot });
    assert.equal(first.workspaceCwd, await realpath(workspace));
    assert.equal(second.workspaceCwd, first.workspaceCwd);
    assert.equal(second.projectKey, first.projectKey);
  } finally {
    processApi.chdir(previousCwd);
  }
});

test('pairing config explicit workspace wins without rewriting product config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-explicit-workspace-'));
  const controlRoot = join(root, 'control');
  const declaredWorkspace = join(root, 'declared');
  const explicitWorkspace = join(root, 'explicit');
  await mkdir(controlRoot);
  await mkdir(declaredWorkspace);
  await mkdir(explicitWorkspace);
  const configPath = join(controlRoot, 'config.toml');
  await writeFile(configPath, `[project]\nworkspace = ${JSON.stringify(declaredWorkspace)}\n`, 'utf8');
  const before = await readFile(configPath, 'utf8');
  const paths = await resolveRuntimePaths({ controlRoot, workspace: explicitWorkspace });
  assert.equal(paths.workspaceCwd, await realpath(explicitWorkspace));
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('pairing config returns typed workspace selection failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-workspace-selection-'));
  const controlRoot = join(root, 'control');
  await mkdir(controlRoot);
  let missing: unknown;
  try {
    await resolveRuntimePaths({ controlRoot });
  } catch (error) {
    missing = error;
  }
  assert.equal(missing instanceof ConfigurationError, true);
  assert.equal((missing as ConfigurationError).code, 'workspace-selection-missing');
  assert.match((missing as ConfigurationError).nextAction, /--workspace/);
  let empty: unknown;
  try {
    await resolveRuntimePaths({ controlRoot, workspace: '' });
  } catch (error) {
    empty = error;
  }
  assert.equal(empty instanceof ConfigurationError, true);
  assert.equal((empty as ConfigurationError).code, 'workspace-selection-invalid');
  const configPath = join(controlRoot, 'config.toml');
  await assert.rejects(() => stat(configPath), /ENOENT/);
  await writeFile(configPath, '[project]\nworkspace = "relative/workspace"\n', 'utf8');
  let invalid: unknown;
  try {
    await resolveRuntimePaths({ controlRoot });
  } catch (error) {
    invalid = error;
  }
  assert.equal(invalid instanceof ConfigurationError, true);
  assert.equal((invalid as ConfigurationError).code, 'workspace-selection-invalid');
  assert.match((invalid as ConfigurationError).message, /absolute/);
});

test('pairing config formatPairingCommand quotes custom control roots', () => {
  const canonicalRoot = join(process.env.HOME ?? '', '.humanagent');
  assert.equal(formatPairingCommand({ controlRoot: canonicalRoot }), `humanagent pair --control-root '${canonicalRoot}'`);
  const customRoot = "/tmp/human agent's root";
  const command = formatPairingCommand({ controlRoot: customRoot });
  assert.equal(command, "humanagent pair --control-root '/tmp/human agent'\\''s root'");
  assert.equal(command.includes('--workspace'), false);
});

test('pairing config validates product workspace and rejects project override workspace', () => {
  const workspace = '/Volumes/Intel/playground/humanagent/example';
  const valid = validateUserConfig({
    schemaVersion: 1,
    agents: [minimalInteractionAgent()],
    project: { workspace },
  });
  assert.equal(valid.project?.workspace, workspace);
  assert.throws(() => validateProjectOverride({ project: { workspace } }), /unsupported key: workspace/);
});

test('resolves all persistence below control root and keeps workspace separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  assert.equal(paths.agentCwd, paths.controlRoot);
  assert.equal(paths.securityRoot, join(paths.controlRoot, 'security'));
  assert.equal(paths.webAccessCredentialPath, join(paths.controlRoot, 'security', 'web-access.json'));
  assert.equal(paths.mainRoot, join(paths.controlRoot, 'main'));
  assert.equal(paths.mainSessionsRoot, join(paths.controlRoot, 'main', 'sessions'));
  assert.equal(paths.projectRoot, join(paths.controlRoot, 'sessions', paths.projectKey));
  assert.equal(paths.sessionsRoot, paths.projectRoot);
  assert.equal(paths.projectRoot === paths.workspaceCwd, false);
  assert.equal(paths.projectRoot.startsWith(paths.controlRoot), true);
  assert.equal((await stat(paths.securityRoot)).mode & 0o777, 0o700);
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

test('project catalog uses manifest identity without writing configured project state', async () => {
  const runRoot = '/Volumes/Intel/playground/humanagent/.worker-runs/ux-restart-20261012/w5-f-config-binding-join-gcm-20261013';
  await mkdir(runRoot, { recursive: true });
  const root = await mkdtemp(join(runRoot, 'catalog-fixture-'));
  const controlRoot = join(root, 'control');
  const offlineWorkspace = join(root, 'offline-workspace');
  const firstWorkspace = join(root, 'workspace', 'a-b');
  const secondWorkspace = join(root, 'workspace', 'a', 'b');
  const offlineProjectKey = createReadableProjectKey(offlineWorkspace);
  const onlineProjectKey = createReadableProjectKey(firstWorkspace);
  const collisionProjectKey = createProjectCollisionKey(secondWorkspace);
  await mkdir(controlRoot, { recursive: true });
  await mkdir(join(controlRoot, 'projects', offlineProjectKey), { recursive: true });
  await mkdir(join(controlRoot, 'projects', onlineProjectKey), { recursive: true });
  await mkdir(join(controlRoot, 'projects', collisionProjectKey), { recursive: true });
  await mkdir(join(controlRoot, 'projects', 'mismatch-project'), { recursive: true });
  await mkdir(join(controlRoot, 'projects', 'impossible-project'), { recursive: true });
  await mkdir(firstWorkspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  await writeFile(join(controlRoot, 'projects', offlineProjectKey, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: offlineProjectKey,
    workspaceCwd: offlineWorkspace,
  }), 'utf8');
  await writeFile(join(controlRoot, 'projects', onlineProjectKey, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: onlineProjectKey,
    workspaceCwd: firstWorkspace,
  }), 'utf8');
  await writeFile(join(controlRoot, 'projects', collisionProjectKey, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: collisionProjectKey,
    workspaceCwd: secondWorkspace,
  }), 'utf8');
  await writeFile(join(controlRoot, 'projects', 'mismatch-project', 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: 'renamed-project',
    workspaceCwd: join(root, 'another-same-name'),
  }), 'utf8');
  await writeFile(join(controlRoot, 'projects', 'impossible-project', 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: 'impossible-project',
    workspaceCwd: join(root, 'impossible-workspace'),
  }), 'utf8');

  const sessionRoot = join(controlRoot, 'projects');
  const snapshot = async (): Promise<Record<string, string>> => {
    const entries: Record<string, string> = {};
    const walk = async (directory: string, relative: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[childRelative] = '<dir>';
          await walk(childPath, childRelative);
        } else {
          entries[childRelative] = await readFile(childPath, 'utf8');
        }
      }
    };
    await walk(sessionRoot, '');
    return entries;
  };
  const before = await snapshot();
  const catalog = await listConfiguredProjects({
    controlRoot,
    agentCwd: controlRoot,
    securityRoot: join(controlRoot, 'security'),
    webAccessCredentialPath: join(controlRoot, 'security', 'web-access.json'),
    mainRoot: join(controlRoot, 'main'),
    mainSessionsRoot: join(controlRoot, 'main', 'sessions'),
    workspaceCwd: firstWorkspace,
    projectKey: onlineProjectKey,
    projectRoot: join(sessionRoot, onlineProjectKey),
    projectManifest: join(sessionRoot, onlineProjectKey, 'project.json'),
    sessionsRoot: join(sessionRoot, onlineProjectKey),
    journalRoot: join(sessionRoot, onlineProjectKey, 'journal'),
    checkpointsRoot: join(sessionRoot, onlineProjectKey, 'checkpoints'),
    indexRoot: join(sessionRoot, onlineProjectKey, 'index'),
    artifactsRoot: join(sessionRoot, onlineProjectKey, 'artifacts'),
    memoryRoot: join(sessionRoot, onlineProjectKey, 'memory'),
    userRoot: join(controlRoot, 'user'),
    globalMemoryRoot: join(controlRoot, 'memory', 'global'),
    locksRoot: join(sessionRoot, onlineProjectKey, 'locks'),
    runNotesRoot: join(sessionRoot, onlineProjectKey, 'run-notes'),
  });
  const after = await snapshot();

  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(after, before);
  assert.deepEqual(catalog.projects.map(({ projectKey, workspaceCwd, projectRoot, checkpointsRoot }) => ({ projectKey, workspaceCwd, projectRoot, checkpointsRoot })).sort((a, b) => a.projectKey.localeCompare(b.projectKey)), [
    {
      projectKey: offlineProjectKey,
      workspaceCwd: offlineWorkspace,
      projectRoot: join(sessionRoot, offlineProjectKey),
      checkpointsRoot: join(sessionRoot, offlineProjectKey, 'checkpoints'),
    },
    {
      projectKey: onlineProjectKey,
      workspaceCwd: firstWorkspace,
      projectRoot: join(sessionRoot, onlineProjectKey),
      checkpointsRoot: join(sessionRoot, onlineProjectKey, 'checkpoints'),
    },
    {
      projectKey: collisionProjectKey,
      workspaceCwd: secondWorkspace,
      projectRoot: join(sessionRoot, collisionProjectKey),
      checkpointsRoot: join(sessionRoot, collisionProjectKey, 'checkpoints'),
    },
  ]);
  assert.equal(catalog.projects.some((project) => project.projectKey === 'impossible-project'), false);
  assert.equal(catalog.failures.length, 2);
  const mismatchFailure = catalog.failures.find((failure) => failure.message.includes('mismatch-project'));
  const impossibleFailure = catalog.failures.find((failure) => failure.message.includes('impossible-project'));
  assert.equal(mismatchFailure?.code, 'project-identity-mismatch');
  assert.equal(impossibleFailure?.code, 'project-identity-mismatch');
  assert.equal(mismatchFailure?.ownerId, 'humanagent.config');
  assert.equal(impossibleFailure?.ownerId, 'humanagent.config');
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

test('requires an explicit executable for each ACP runtime execution config', () => {
  const acpAgent = (driverRef: string) => ({
    agentId: `interaction-${driverRef}`,
    roleId: 'interaction',
    templateRef: 'builtin/interaction@1.0.0',
    driverRef,
    skills: ['input-normalization'],
    tools: ['input.receive'],
    permissions: ['task.read'],
    memoryScopes: ['task'],
    resourceClass: 'foreground',
  });

  const valid = validateUserConfig({
    schemaVersion: 1,
    agents: [acpAgent('opencode'), acpAgent('antigravity'), acpAgent('acp-dsh')],
    execution: {
      opencode: { command: '/opt/opencode/bin/opencode', args: ['acp', '--pure'], timeoutMs: 120000 },
      antigravity: { command: '/opt/agy/bin/agy' },
      dshAcp: { command: '/opt/dsh/bin/dsh', args: ['--profile', 'headless', '--json'] },
    },
  });
  assert.equal(valid.execution?.opencode?.command, '/opt/opencode/bin/opencode');
  assert.equal(valid.execution?.antigravity?.command, '/opt/agy/bin/agy');
  assert.equal(valid.execution?.dshAcp?.args?.[0], '--profile');

  // The host never guesses where a runtime binary lives.
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [acpAgent('opencode')],
    execution: { opencode: { args: ['acp', '--pure'] } },
  }), /execution\.opencode\.command is required/);

  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [acpAgent('acp-dsh')],
    execution: { dshAcp: { command: '/opt/dsh/bin/dsh', prompt: 'x' } },
  }), /unsupported key/);
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

  const credentialRef: ProviderCredentialRef = 'env:HUMANAGENT_CONFIG_TEST_CREDENTIAL';
  const credential = validateUserConfig({
    schemaVersion: 1,
    agents,
    provider: {
      provider: 'http',
      source: 'http',
      binding: 'credential-entry',
      protocol: 'responses',
      model: 'model-a',
      route: 'route-a',
      baseUrl: 'http://127.0.0.1:4444',
      credentialRef,
    },
  });
  assert.equal(credential.provider?.credentialRef, credentialRef);
  const reads: string[] = [];
  const env = {
    get HUMANAGENT_CONFIG_TEST_CREDENTIAL() {
      reads.push('declared');
      return '  fake-secret  ';
    },
    get UNDECLARED(): string {
      throw new Error('undeclared environment key read');
    },
  };
  assert.equal(resolveProviderCredential(undefined, env), undefined);
  assert.deepEqual(reads, []);
  assert.equal(resolveProviderCredential(credentialRef, env), '  fake-secret  ');
  assert.deepEqual(reads, ['declared']);
  const credentialError = (ref: ProviderCredentialRef, injected: Readonly<Record<string, string | undefined>>): ConfigurationError => {
    try {
      resolveProviderCredential(ref, injected);
    } catch (error) {
      if (error instanceof ConfigurationError) return error;
      throw error;
    }
    throw new Error('expected ConfigurationError');
  };
  for (const injected of [{}, { HUMANAGENT_CONFIG_TEST_CREDENTIAL: '' }, { HUMANAGENT_CONFIG_TEST_CREDENTIAL: '   ' }]) {
    const error = credentialError(credentialRef, injected);
    assert.equal(error.code, 'config-credential-unavailable');
    for (const text of [error.message, error.nextAction]) {
      assert.equal(text.includes(credentialRef), false);
      assert.equal(text.includes('HUMANAGENT_CONFIG_TEST_CREDENTIAL'), false);
    }
  }
  for (const invalid of ['literal-secret', 'file:credential', 'env:bad-name', 'env:1BAD', 'env:', 'env:BAD\n']) {
    try {
      validateUserConfig({
        schemaVersion: 1,
        agents,
        provider: { ...credential.provider, credentialRef: invalid },
      });
      throw new Error('expected invalid credentialRef');
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      assert.equal(error.code, 'config-invalid');
      assert.equal(error.message.includes(invalid), false);
      assert.equal(error.nextAction.includes(invalid), false);
    }
  }
  const invalidResolver = credentialError('env:bad-name', {});
  assert.equal(invalidResolver.code, 'config-invalid');
  assert.equal(invalidResolver.message.includes('env:bad-name'), false);
  assert.equal(invalidResolver.nextAction.includes('env:bad-name'), false);
  for (const source of [undefined, 'rcc']) {
    assert.throws(() => validateUserConfig({
      schemaVersion: 1,
      agents,
      provider: { ...credential.provider, source, credentialRef },
    }), /credentialRef requires source = "http"/);
  }
});

test('preserves an explicit provider source through TOML while an omitted source keeps the legacy RCC shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-provider-source-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);

  const legacy = await loadConfiguration(paths);
  assert.equal(legacy.effective.provider?.provider, 'rcc');
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.effective.provider, 'source'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.effective.provider, 'credentialRef'), false);

  const configPath = join(paths.controlRoot, 'config.toml');
  const base = await readFile(configPath, 'utf8');
  await writeFile(configPath, base.replace('provider = "rcc"', 'provider = "http"\nsource = "http"'), 'utf8');
  const explicit = await loadConfiguration(paths);
  assert.equal(explicit.effective.provider?.provider, 'http');
  assert.equal(explicit.effective.provider?.source, 'http');

  await writeFile(configPath, base.replace('provider = "rcc"', 'provider = "http"\nsource = "http"\ncredentialRef = "env:HUMANAGENT_CONFIG_TEST_CREDENTIAL"'), 'utf8');
  const withRef = await loadConfiguration(paths);
  assert.equal(withRef.effective.provider?.source, 'http');
  assert.equal(withRef.effective.provider?.credentialRef, 'env:HUMANAGENT_CONFIG_TEST_CREDENTIAL');

  // `provider` is a local label, not the source strategy: rcc + http stays legal.
  await writeFile(configPath, base.replace('provider = "rcc"', 'provider = "rcc"\nsource = "http"'), 'utf8');
  const labeled = await loadConfiguration(paths);
  assert.equal(labeled.effective.provider?.provider, 'rcc');
  assert.equal(labeled.effective.provider?.source, 'http');

  await writeFile(configPath, base.replace('provider = "rcc"', 'provider = "rcc"\nsource = "unsupported"'), 'utf8');
  await assert.rejects(() => loadConfiguration(paths), /unsupported provider source: unsupported/);
});

test('validates explicit provider retry candidates under user execution config and rejects them from project override', async () => {
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
    execution: {
      providerRetry: {
        candidates: [
          { provider: 'rcc', binding: 'provider-a', protocol: 'responses', model: 'model-a', route: 'route-a', baseUrl: 'http://127.0.0.1:4444' },
          { provider: 'rcc', binding: 'provider-b', protocol: 'responses', model: 'model-b', route: 'route-b', baseUrl: 'http://127.0.0.1:4444' },
        ],
      },
    },
  });
  assert.equal(valid.execution?.providerRetry?.candidates.length, 2);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents,
    execution: { providerRetry: { candidates: [] } },
  }), /candidates must include at least one provider candidate/);

  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-provider-retry-project-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.projectRoot, 'config.toml'), '[execution.providerRetry]\ncandidates = []\n', 'utf8');
  await assert.rejects(() => loadConfiguration(paths), /project execution config contains unsupported key: providerRetry/);
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

test('web search backend binding is read from the environment at execution time', () => {
  const configured = resolveWebSearchBackendConfig({
    HUMANAGENT_WEB_SEARCH_PROVIDER: 'other-provider',
    HUMANAGENT_WEB_SEARCH_COMMAND: '/opt/bin/other-cli',
    HUMANAGENT_WEB_SEARCH_ENDPOINT: '/v2/lookup',
    HUMANAGENT_WEB_SEARCH_PAGE_CEILING: '4',
    HUMANAGENT_WEB_SEARCH_POLL_INTERVAL_MS: '250',
    HUMANAGENT_WEB_SEARCH_POLL_TIMEOUT_MS: '45000',
    HUMANAGENT_WEB_SEARCH_PURPOSE: 'humanagent test route',
  });
  assert.deepEqual(configured, {
    provider: 'other-provider',
    command: '/opt/bin/other-cli',
    endpoint: '/v2/lookup',
    pageCeiling: 4,
    pollIntervalMs: 250,
    pollTimeoutMs: 45_000,
    purpose: 'humanagent test route',
  });
  // An unconfigured environment keeps the documented local binding so the bare
  // entry stays usable; every field above still overrides it without a source edit.
  assert.deepEqual(resolveWebSearchBackendConfig({}), {
    provider: 'tinyfish',
    command: 'monid',
    endpoint: '/search',
    pageCeiling: 10,
    pollIntervalMs: 2000,
    pollTimeoutMs: 30_000,
    purpose: 'humanagent web.search tool',
  });
});

test('web search backend binding rejects an empty route or an out-of-range bound', () => {
  assert.throws(
    () => resolveWebSearchBackendConfig({ HUMANAGENT_WEB_SEARCH_ENDPOINT: '   ' }),
    /HUMANAGENT_WEB_SEARCH_ENDPOINT must not be empty/,
  );
  assert.throws(
    () => resolveWebSearchBackendConfig({ HUMANAGENT_WEB_SEARCH_PAGE_CEILING: '11' }),
    /HUMANAGENT_WEB_SEARCH_PAGE_CEILING must be an integer between 0 and 10/,
  );
  assert.throws(
    () => resolveWebSearchBackendConfig({ HUMANAGENT_WEB_SEARCH_POLL_INTERVAL_MS: 'ten' }),
    /HUMANAGENT_WEB_SEARCH_POLL_INTERVAL_MS must be an integer between 100 and 30000/,
  );
});

test('agent provider binding compiles independent per-agent selections from a config fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-agent-binding-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.controlRoot, 'config.toml'), [
    'schemaVersion = 1',
    '',
    '[provider]',
    'provider = "rcc"',
    'binding = "shared"',
    'protocol = "responses"',
    'model = "shared-model"',
    'route = "default"',
    'baseUrl = "http://127.0.0.1:4444"',
    '',
    '[[agents]]',
    'agentId = "interaction-a"',
    'roleId = "interaction"',
    'templateRef = "builtin/interaction@1.0.0"',
    'driverRef = "fake"',
    'skills = ["input-normalization"]',
    'tools = ["input.receive"]',
    'permissions = ["task.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    'provider.provider = "rcc"',
    'provider.source = "http"',
    'provider.binding = "binding-a"',
    'provider.protocol = "responses"',
    'provider.model = "model-a"',
    'provider.route = "route-a"',
    'provider.baseUrl = "http://127.0.0.1:4444"',
    'provider.credentialRef = "env:HUMANAGENT_CONFIG_TEST_CREDENTIAL"',
    '',
    '[[agents]]',
    'agentId = "execution-b"',
    'roleId = "execution"',
    'templateRef = "builtin/execution@1.0.0"',
    'driverRef = "fake"',
    'skills = ["single-capability-worker"]',
    'tools = ["search"]',
    'permissions = ["task.read", "workspace.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    'provider.provider = "rcc"',
    'provider.binding = "binding-b"',
    'provider.protocol = "anthropic"',
    'provider.model = "model-b"',
    'provider.route = "route-b"',
    'provider.baseUrl = "http://127.0.0.1:5555"',
    '',
  ].join('\n'), 'utf8');

  const loaded = await loadConfiguration(paths);
  const bindings = loaded.agentProviderBindings;
  assert.equal(bindings.length, 2);
  const a = bindings.find((binding) => binding.agentId === 'interaction-a');
  const b = bindings.find((binding) => binding.agentId === 'execution-b');
  assert.deepEqual(a, {
    agentId: 'interaction-a',
    roleId: 'interaction',
    source: 'agent',
    provider: { provider: 'rcc', source: 'http', binding: 'binding-a', protocol: 'responses', model: 'model-a', route: 'route-a', baseUrl: 'http://127.0.0.1:4444', credentialRef: 'env:HUMANAGENT_CONFIG_TEST_CREDENTIAL' },
  });
  assert.deepEqual(b, {
    agentId: 'execution-b',
    roleId: 'execution',
    source: 'agent',
    provider: { provider: 'rcc', binding: 'binding-b', protocol: 'anthropic', model: 'model-b', route: 'route-b', baseUrl: 'http://127.0.0.1:5555' },
  });
  // The two agents must not share protocol, model, route, binding or endpoint.
  assert.equal(a?.provider?.model === b?.provider?.model, false);
  assert.equal(a?.provider?.protocol === b?.provider?.protocol, false);
  assert.equal(a?.provider?.route === b?.provider?.route, false);
  assert.equal(a?.provider?.binding === b?.provider?.binding, false);
  assert.equal(a?.provider?.baseUrl === b?.provider?.baseUrl, false);
  // The shared top-level provider stays untouched by per-agent selections.
  assert.deepEqual(loaded.effective.provider, {
    provider: 'rcc', binding: 'shared', protocol: 'responses', model: 'shared-model', route: 'default', baseUrl: 'http://127.0.0.1:4444',
  });
});

test('agent provider binding keeps the legacy single top-level provider effective config compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-agent-binding-legacy-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  // Default layout writes the legacy single `[provider]` and agents without a provider block.
  await ensureControlLayout(paths);
  const loaded = await loadConfiguration(paths);
  const legacy = {
    provider: 'rcc', binding: 'rcc-entry', protocol: 'responses', model: 'MiniMax-M3', route: 'default', baseUrl: 'http://127.0.0.1:4444',
  };
  assert.deepEqual(loaded.effective.provider, legacy);
  assert.equal(loaded.agentProviderBindings.length, loaded.effective.agents.length);
  for (const binding of loaded.agentProviderBindings) {
    assert.equal(binding.source, 'inherited');
    assert.deepEqual(binding.provider, legacy);
  }
});

test('agent provider binding rejects an invalid per-agent provider selection', () => {
  const agent = {
    agentId: 'interaction-a',
    roleId: 'interaction',
    templateRef: 'builtin/interaction@1.0.0',
    driverRef: 'fake',
    skills: ['input-normalization'],
    tools: ['input.receive'],
    permissions: ['task.read'],
    memoryScopes: ['task'],
    resourceClass: 'foreground',
  };
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [{ ...agent, provider: { provider: 'rcc', binding: 'b', protocol: 'custom', model: 'm', route: 'r', baseUrl: 'http://127.0.0.1:4444' } }],
  }), /unsupported provider protocol: custom/);
  assert.throws(() => validateUserConfig({
    schemaVersion: 1,
    agents: [{ ...agent, provider: { provider: 'dsh', binding: 'b', protocol: 'responses', model: 'm', route: 'r', baseUrl: 'http://127.0.0.1:4444' } }],
  }), /unknown provider: dsh/);
});

test('agent provider binding applies the agent model override over the binding model', () => {
  const base = {
    roleId: 'interaction',
    templateRef: 'builtin/interaction@1.0.0',
    driverRef: 'fake',
    skills: ['input-normalization'],
    tools: ['input.receive'],
    permissions: ['task.read'],
    memoryScopes: ['task'],
    resourceClass: 'foreground',
  };
  const compiled = compileAgentProviderBindings(validateUserConfig({
    schemaVersion: 1,
    provider: { provider: 'rcc', binding: 'shared', protocol: 'responses', model: 'shared-model', route: 'default', baseUrl: 'http://127.0.0.1:4444' },
    agents: [
      { ...base, agentId: 'explicit-default', provider: { provider: 'rcc', binding: 'b', protocol: 'anthropic', model: 'binding-model', route: 'r', baseUrl: 'http://127.0.0.1:5555' } },
      { ...base, agentId: 'explicit-override', model: 'override-model', provider: { provider: 'rcc', source: 'http', binding: 'b', protocol: 'anthropic', model: 'binding-model', route: 'r', baseUrl: 'http://127.0.0.1:5555', credentialRef: 'env:HUMANAGENT_CONFIG_TEST_CREDENTIAL' } },
      { ...base, agentId: 'inherited-override', model: 'inherited-override-model' },
    ],
  }));
  assert.equal(compiled.find((binding) => binding.agentId === 'explicit-default')?.provider?.model, 'binding-model');
  assert.equal(compiled.find((binding) => binding.agentId === 'explicit-override')?.provider?.model, 'override-model');
  assert.equal(compiled.find((binding) => binding.agentId === 'explicit-override')?.provider?.credentialRef, 'env:HUMANAGENT_CONFIG_TEST_CREDENTIAL');
  assert.equal(compiled.find((binding) => binding.agentId === 'inherited-override')?.provider?.model, 'inherited-override-model');
  // Overriding the model does not change the selected protocol/endpoint.
  assert.equal(compiled.find((binding) => binding.agentId === 'explicit-override')?.provider?.protocol, 'anthropic');
});

test('agent provider binding rejects prototype traversal without polluting shared state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-agent-binding-proto-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  await writeFile(join(paths.controlRoot, 'config.toml'), [
    'schemaVersion = 1',
    '',
    '[[agents]]',
    'agentId = "attacker"',
    'roleId = "interaction"',
    'templateRef = "builtin/interaction@1.0.0"',
    'driverRef = "fake"',
    'skills = ["input-normalization"]',
    'tools = ["input.receive"]',
    'permissions = ["task.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    'provider.provider = "rcc"',
    'provider.binding = "attacker"',
    'provider.protocol = "responses"',
    'provider.route = "route-a"',
    'provider.baseUrl = "http://127.0.0.1:4444"',
    'provider.__proto__.model = "injected-model"',
    '',
    '[[agents]]',
    'agentId = "later"',
    'roleId = "execution"',
    'templateRef = "builtin/execution@1.0.0"',
    'driverRef = "fake"',
    'skills = ["single-capability-worker"]',
    'tools = ["search"]',
    'permissions = ["task.read", "workspace.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    'provider.provider = "rcc"',
    'provider.binding = "later"',
    'provider.protocol = "anthropic"',
    'provider.route = "route-b"',
    'provider.baseUrl = "http://127.0.0.1:5555"',
    '',
  ].join('\n'), 'utf8');

  let error: unknown;
  try {
    await loadConfiguration(paths);
  } catch (caught) {
    error = caught;
  }
  const polluted = Object.prototype.hasOwnProperty.call(Object.prototype, 'model');
  delete (Object.prototype as { model?: unknown }).model;
  assert.equal(polluted, false);
  assert.match(String(error), /invalid key: provider\.__proto__\.model/);
});

test('config binding catalog join preserves per-agent transport source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-binding-join-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  const configPath = join(paths.controlRoot, 'config.toml');
  const config = (source: string) => [
    'schemaVersion = 1',
    '',
    '[provider]',
    'provider = "rcc"',
    'binding = "shared"',
    'protocol = "responses"',
    'model = "shared-model"',
    'route = "default"',
    'baseUrl = "http://127.0.0.1:4444"',
    '',
    '[[agents]]',
    'agentId = "interaction-a"',
    'roleId = "interaction"',
    'templateRef = "builtin/interaction@1.0.0"',
    'driverRef = "fake"',
    'skills = ["input-normalization"]',
    'tools = ["input.receive"]',
    'permissions = ["task.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    'model = "agent-model"',
    'provider.provider = "rcc"',
    `provider.source = "${source}"`,
    'provider.binding = "agent-binding"',
    'provider.protocol = "anthropic"',
    'provider.model = "binding-model"',
    'provider.route = "agent-route"',
    'provider.baseUrl = "http://127.0.0.1:5555"',
    '',
    '[[agents]]',
    'agentId = "execution-b"',
    'roleId = "execution"',
    'templateRef = "builtin/execution@1.0.0"',
    'driverRef = "fake"',
    'skills = ["single-capability-worker"]',
    'tools = ["search"]',
    'permissions = ["task.read", "workspace.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    '',
  ].join('\n');
  const expectedBinding: EffectiveAgentProviderBinding = {
    agentId: 'interaction-a',
    roleId: 'interaction',
    source: 'agent',
    provider: {
      provider: 'rcc',
      source: 'http',
      binding: 'agent-binding',
      protocol: 'anthropic',
      model: 'agent-model',
      route: 'agent-route',
      baseUrl: 'http://127.0.0.1:5555',
    },
  };
  const assertExpectedBinding = (binding: EffectiveAgentProviderBinding | undefined): void => {
    assert.deepEqual(binding, expectedBinding);
  };

  await writeFile(configPath, config('http'), 'utf8');
  const loaded = await loadConfiguration(paths);
  const agentBinding = loaded.agentProviderBindings.find((binding) => binding.agentId === 'interaction-a');
  assertExpectedBinding(agentBinding);
  const inherited = loaded.agentProviderBindings.find((binding) => binding.agentId === 'execution-b');
  assert.equal(inherited?.source, 'inherited');
  assert.equal(inherited?.provider?.model, 'shared-model');
  assert.equal(Object.prototype.hasOwnProperty.call(inherited?.provider, 'source'), false);

  const droppedSourceCopy = {
    ...agentBinding!,
    provider: { ...agentBinding!.provider, source: undefined },
  } as EffectiveAgentProviderBinding;
  assert.throws(() => assertExpectedBinding(droppedSourceCopy));

  await writeFile(configPath, config('unsupported'), 'utf8');
  await assert.rejects(() => loadConfiguration(paths), /unsupported provider source: unsupported/);
});
function createReadableProjectKey(workspace: string): string {
  return workspace.replaceAll(sep, '/').replaceAll('/', '-') || '-';
}
function createProjectCollisionKey(workspace: string): string {
  return `${createReadableProjectKey(workspace)}--${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`;
}

// Failure mode: a cold start with no saved preference must fall back to the
// documented `current` view instead of an arbitrary or undefined mode.
test('defaults the UI display preference to the cold-start current view', () => {
  const valid = validateUserConfig({ schemaVersion: 1, agents: [minimalInteractionAgent()] });
  assert.equal(valid.ui?.display.mode, 'current');
  assert.equal(valid.ui?.display.lastManual, null);
  assert.equal(resolveUiDisplayMode(valid.ui!.display), 'current');
  assert.equal(resolveUiDisplayMode(DEFAULT_UI_DISPLAY_PREFERENCE), 'current');
});

// Failure mode: a saved selection is dropped on reload, or an explicit link is
// ignored in favour of the saved preference. Priority must be explicit link >
// saved preference > cold-start default, and the value must persist.
test('persists a UI display selection in config.toml and applies explicit-link priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-ui-preference-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);

  const cold = await loadConfiguration(paths);
  assert.equal(cold.effective.ui?.display.mode, 'current');

  const base = await readFile(join(paths.controlRoot, 'config.toml'), 'utf8');
  await writeFile(join(paths.controlRoot, 'config.toml'), `${base}\n[ui.display]\nschemaVersion = 1\nmode = "semantic"\n`, 'utf8');
  const loaded = await loadConfiguration(paths);
  assert.equal(loaded.effective.ui?.display.mode, 'semantic');
  assert.equal(resolveUiDisplayMode(loaded.effective.ui!.display), 'semantic');
  // An explicit link selection outranks the saved preference.
  assert.equal(resolveUiDisplayMode(loaded.effective.ui!.display, 'raw'), 'raw');
});

// Failure mode: `follow-last` resolves to a stale or invented mode, or an
// unknown enum/version silently selects another view.
test('resolves follow-last against the last manual selection and rejects invalid values', () => {
  const follow = validateUiDisplayPreference({ schemaVersion: 1, mode: 'follow-last', lastManual: 'actions' });
  assert.equal(resolveUiDisplayMode(follow), 'actions');
  assert.equal(resolveUiDisplayMode(follow, 'semantic'), 'semantic');
  const cold = validateUiDisplayPreference({ schemaVersion: 1, mode: 'follow-last' });
  assert.equal(cold.lastManual, null);
  assert.equal(resolveUiDisplayMode(cold), 'current');

  assert.throws(() => validateUiDisplayPreference({ schemaVersion: 1, mode: 'bogus' }), /not a supported display mode/);
  assert.throws(() => validateUiDisplayPreference({ schemaVersion: 2, mode: 'current' }), /unsupported ui.display schema/);
  assert.throws(() => validateUiDisplayPreference({ schemaVersion: 1, mode: 'current', lastManual: 'bogus' }), /lastManual is not a supported display mode/);
  assert.throws(() => validateUiDisplayPreference({ schemaVersion: 1, mode: 'current', extra: true }), /unsupported key: extra/);
});

// Failure mode: a navigation update mutates a fixed preference, or a failed
// manual selection overwrites a valid saved value.
test('only a follow-last preference tracks manual selection and keeps the valid value on rejection', () => {
  const follow = validateUiDisplayPreference({ schemaVersion: 1, mode: 'follow-last' });
  const updated = applyManualDisplaySelection(follow, 'actions');
  assert.equal(updated.mode, 'follow-last');
  assert.equal(updated.lastManual, 'actions');
  assert.equal(resolveUiDisplayMode(updated), 'actions');

  const fixed = validateUiDisplayPreference({ schemaVersion: 1, mode: 'semantic' });
  assert.equal(applyManualDisplaySelection(fixed, 'raw'), fixed);
  assert.equal(resolveUiDisplayMode(fixed), 'semantic');

  assert.throws(() => applyManualDisplaySelection(follow, 'bogus' as never), /manual display selection is not supported/);
  assert.equal(follow.lastManual, null);
});

// Failure mode: an invalid enum in the persisted file loads silently instead of
// failing visibly, or a project override carries a user display preference.
test('rejects an invalid persisted UI preference and keeps it user-scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-ui-invalid-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);

  const base = await readFile(join(paths.controlRoot, 'config.toml'), 'utf8');
  await writeFile(join(paths.controlRoot, 'config.toml'), `${base}\n[ui.display]\nschemaVersion = 1\nmode = "bogus"\n`, 'utf8');
  await assert.rejects(() => loadConfiguration(paths), /not a supported display mode/);

  await writeFile(join(paths.controlRoot, 'config.toml'), base, 'utf8');
  await writeFile(join(paths.projectRoot, 'config.toml'), '[ui.display]\nmode = "raw"\n', 'utf8');
  await assert.rejects(() => loadConfiguration(paths), /project config contains unsupported key: ui/);
});

async function makeControlRoot(): Promise<{ root: string; paths: RuntimePaths }> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-config-ui-store-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  return { root, paths };
}

const userConfigFingerprint = (configuration: { user: unknown }): string => {
  const user = configuration.user as {
    schemaVersion?: unknown; agents?: unknown; provider?: unknown; project?: unknown;
    memory?: unknown; execution?: unknown; ui?: unknown;
  };
  return JSON.stringify({
    schemaVersion: user.schemaVersion,
    agents: user.agents,
    provider: user.provider,
    project: user.project,
    memory: user.memory,
    execution: user.execution,
  });
};

// Failure mode: a saved preference is lost on reload, or saving the display
// preference drops unrelated configuration. The write must persist the exact
// value and leave the rest of the user config untouched.
test('saves a UI display preference and reloads it with unrelated config preserved', async () => {
  const { paths } = await makeControlRoot();
  const configPath = join(paths.controlRoot, 'config.toml');
  const before = await loadConfiguration(paths);
  const original = await readFile(configPath, 'utf8');

  const saved = await saveUiDisplayPreference(paths, { schemaVersion: 1, mode: 'follow-last', lastManual: 'actions' });
  assert.deepEqual(saved, { schemaVersion: 1, mode: 'follow-last', lastManual: 'actions' });
  assert.equal(resolveUiDisplayMode(saved), 'actions');

  const text = await readFile(configPath, 'utf8');
  assert.match(text, /\[ui\.display\]/);
  // Every byte before the appended `[ui.display]` table stays byte-identical.
  assert.equal(text.slice(0, text.indexOf('\n[ui.display]\n')), original);

  const after = await loadConfiguration(paths);
  assert.equal(after.effective.ui?.display.mode, 'follow-last');
  assert.equal(after.effective.ui?.display.lastManual, 'actions');
  assert.equal(resolveUiDisplayMode(after.effective.ui!.display), 'actions');
  assert.equal(userConfigFingerprint(after), userConfigFingerprint(before));
});

// Failure mode: a second preference overwrites instead of replacing the saved
// table, or re-saving clobbers unrelated config again. The stored table must be
// replaced in place and repeated saves must stay lossless.
test('replaces an existing UI display table without duplicating it', async () => {
  const { paths } = await makeControlRoot();
  await saveUiDisplayPreference(paths, { schemaVersion: 1, mode: 'semantic', lastManual: 'raw' });
  const after = await loadConfiguration(paths);
  assert.equal(after.effective.ui?.display.mode, 'semantic');
  assert.equal(after.effective.ui?.display.lastManual, 'raw');

  await saveUiDisplayPreference(paths, { schemaVersion: 1, mode: 'current', lastManual: null });
  const text = await readFile(join(paths.controlRoot, 'config.toml'), 'utf8');
  assert.equal((text.match(/\[ui\.display\]/g) ?? []).length, 1);

  const reloaded = await loadConfiguration(paths);
  assert.equal(reloaded.effective.ui?.display.mode, 'current');
  assert.equal(reloaded.effective.ui?.display.lastManual, null);
  assert.equal(reloaded.effective.provider?.route, 'default');
  assert.equal(reloaded.effective.agents.length, 2);
});

// Failure mode: a failed write overwrites the previous valid file or value. A
// failure must keep the old file readable, valid and unchanged.
test('keeps the old valid config.toml when a UI display write fails', async () => {
  const { paths } = await makeControlRoot();
  const configPath = join(paths.controlRoot, 'config.toml');
  await saveUiDisplayPreference(paths, { schemaVersion: 1, mode: 'raw', lastManual: null });
  const before = await readFile(configPath, 'utf8');

  // A read-only control root makes the atomic temp-file write fail.
  await chmod(paths.controlRoot, 0o500);
  await assert.rejects(() => saveUiDisplayPreference(paths, { schemaVersion: 1, mode: 'actions', lastManual: null }));
  await chmod(paths.controlRoot, 0o700);

  const text = await readFile(configPath, 'utf8');
  assert.equal(text, before);
  assert.match(text, /mode = "raw"/);
  assert.equal(text.includes('mode = "actions"'), false);

  const kept = await loadConfiguration(paths);
  assert.equal(kept.effective.ui?.display.mode, 'raw');

  const recovered = await saveUiDisplayPreference(paths, { schemaVersion: 1, mode: 'actions', lastManual: null });
  assert.equal(recovered.mode, 'actions');
  assert.equal((await loadConfiguration(paths)).effective.ui?.display.mode, 'actions');
});

// Failure mode: an unsupported preference is written to disk anyway, or an
// explicit link/navigation selection is persisted as if the user had saved a
// new preference. Validation must reject before any write, and only an explicit
// save call persists a preference.
test('rejects invalid preferences without writing and does not persist explicit link selections', async () => {
  const { paths } = await makeControlRoot();
  const configPath = join(paths.controlRoot, 'config.toml');
  const before = await readFile(configPath, 'utf8');
  const cold = await loadConfiguration(paths);

  const invalid: unknown[] = [
    { schemaVersion: 1, mode: 'bogus', lastManual: null },
    { schemaVersion: 9, mode: 'semantic', lastManual: null },
    { schemaVersion: 1, mode: 'semantic', lastManual: 'bogus' },
  ];
  for (const value of invalid) {
    await assert.rejects(() => saveUiDisplayPreference(paths, value as never));
  }

  assert.equal(await readFile(configPath, 'utf8'), before);
  const untouched = await loadConfiguration(paths);
  assert.equal(userConfigFingerprint(untouched), userConfigFingerprint(cold));
  assert.equal(untouched.effective.ui?.display.mode, 'current');

  // Resolution alone must not write: explicit link selection and follow-last
  // navigation stay out of config.toml.
  assert.equal(resolveUiDisplayMode(untouched.effective.ui!.display, 'raw'), 'raw');
  const resolved = validateUiDisplayPreference({ schemaVersion: 1, mode: 'follow-last' });
  assert.equal(resolveUiDisplayMode(applyManualDisplaySelection(resolved, 'actions')), 'actions');
  assert.equal(await readFile(configPath, 'utf8'), before);
});
