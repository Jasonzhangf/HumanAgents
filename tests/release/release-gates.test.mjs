import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { assemblePackage } from '../../scripts/package-assembly.mjs';
import { bumpReleaseVersion, configuredPackageVersion, configuredReleaseVersion, packageVersionForRelease, validateReleaseVersion } from '../../scripts/release-version.mjs';

const node = process.execPath;
const repositoryRoot = new URL('../..', import.meta.url);

test('release versions are path-safe semantic versions', () => {
  assert.equal(validateReleaseVersion('0.1.0'), '0.1.0');
  const packageJson = JSON.parse(readFileSync(new URL('package.json', repositoryRoot), 'utf8'));
  assert.equal(configuredReleaseVersion({}, repositoryRoot.pathname), packageJson.releaseVersion);
  assert.equal(configuredPackageVersion(repositoryRoot.pathname), packageJson.version);
  assert.equal(configuredReleaseVersion({ HUMANAGENT_RELEASE_VERSION: '9.9.0009' }, repositoryRoot.pathname), '9.9.0009');
  assert.equal(packageVersionForRelease('0.1.0001'), '0.1.1');
  assert.equal(bumpReleaseVersion('0.1.0', 'patch'), '0.1.0001');
  assert.equal(bumpReleaseVersion('0.1.0001', 'patch'), '0.1.0002');
  assert.equal(bumpReleaseVersion('0.1.0001', 'minor'), '0.2.0001');
  assert.equal(bumpReleaseVersion('0.1.0001', 'major'), '1.0.0001');
  assert.throws(() => bumpReleaseVersion('0.1.9999', 'patch'), /sequence exhausted/);
  assert.throws(() => bumpReleaseVersion('0.1.0-alpha.1'), /cannot bump a prerelease/);
  assert.throws(() => bumpReleaseVersion('0.1.0', 'invalid'), /release bump kind/);
  assert.throws(() => validateReleaseVersion('../escape'), /valid semantic version/);
  assert.throws(() => validateReleaseVersion('1.0.0/other'), /valid semantic version/);
});

test('release bump preserves the split npm and HumanAgent version sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-release-bump-'));
  const packagePaths = ['package.json', 'packages/app/package.json', 'packages/config/package.json', 'packages/contracts/package.json'];
  for (const relativePath of packagePaths) {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ name: relativePath, version: '0.1.1', releaseVersion: '0.1.0001' }) + '\n', 'utf8');
  }
  await mkdir(join(root, 'docs', 'architecture'), { recursive: true });
  await writeFile(join(root, 'docs', 'architecture', 'release-version.md'), 'old source wording\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'HumanAgent Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  execFileSync(node, ['scripts/bump-release-version.mjs', '--project-root', root], {
    cwd: repositoryRoot.pathname,
    encoding: 'utf8',
  });

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.1.2');
  assert.equal(packageJson.releaseVersion, '0.1.0002');
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-release-'));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  return { root, projectRoot };
}

test('assembled CLI package installs and runs its public consumer behavior', async (t) => {
  const fixtureValue = await fixture();
  t.after(() => rm(fixtureValue.root, { recursive: true, force: true }));
  const releaseRoot = join(fixtureValue.root, 'release');
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'app'), { recursive: true });
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'app', 'agent-templates', 'templates', 'builtin'), { recursive: true });
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'app', 'app', 'src'), { recursive: true });
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'app', 'ui'), { recursive: true });
  await mkdir(join(fixtureValue.projectRoot, 'packages', 'contracts', 'dist'), { recursive: true });
  await writeFile(join(fixtureValue.projectRoot, 'dist', 'app', 'agent-templates', 'templates', 'builtin', 'prompt-registry.json'), '{}\n', 'utf8');
  await writeFile(join(fixtureValue.projectRoot, 'dist', 'app', 'ui', 'index.html'), '<!doctype html><title>humanagent</title>\n', 'utf8');
  await writeFile(join(fixtureValue.projectRoot, 'dist', 'app', 'placeholder.txt'), 'runtime\n', 'utf8');
  await writeFile(join(fixtureValue.projectRoot, 'packages', 'contracts', 'dist', 'index.js'), 'export const id = (scope, value) => ({ scope, value });\n', 'utf8');
  await writeFile(join(fixtureValue.projectRoot, 'dist', 'app', 'app', 'src', 'cli.js'), [
    "import { readFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "import { id } from '@humanagent/contracts';",
    "export const formatCliError = (error) => error.message;",
    "export async function main() {",
    "  const registry = JSON.parse(await readFile(join(process.env.HUMANAGENT_TEMPLATE_ROOT, 'builtin', 'prompt-registry.json'), 'utf8'));",
    "  const ui = await readFile(join(process.env.HUMANAGENT_UI_ROOT, 'index.html'), 'utf8');",
    "  console.log(JSON.stringify({ releaseVersion: process.env.HUMANAGENT_RELEASE_VERSION, contract: id('fixture', 'ok'), registry, ui: ui.trim() }));",
    "}",
    '',
  ].join('\n'), 'utf8');
  const result = await assemblePackage({ projectRoot: fixtureValue.projectRoot, releaseRoot, version: '0.1.1', releaseVersion: '0.1.0001' });
  const mode = (await stat(join(result.packageRoot, 'bin', 'humanagent.mjs'))).mode;
  assert.equal(mode & 0o111, 0o111);
  assert.equal((await stat(join(result.packageRoot, 'runtime', 'agent-templates', 'templates', 'builtin', 'prompt-registry.json'))).isFile(), true);
  const contractsPackage = JSON.parse(await readFile(join(result.packageRoot, 'runtime', 'node_modules', '@humanagent', 'contracts', 'package.json'), 'utf8'));
  assert.equal(contractsPackage.name, '@humanagent/contracts');
  assert.equal(contractsPackage.version, '0.1.1');
  assert.equal(contractsPackage.releaseVersion, '0.1.0001');
  assert.equal(contractsPackage.exports['.'], './dist/index.js');
  const cliPackage = JSON.parse(await readFile(join(result.packageRoot, 'package.json'), 'utf8'));
  assert.equal(cliPackage.version, '0.1.1');
  assert.equal(cliPackage.releaseVersion, '0.1.0001');
  const consumerRoot = join(fixtureValue.root, 'consumer');
  execFileSync('npm', ['install', '--prefix', consumerRoot, '--ignore-scripts', result.packagePath], {
    cwd: fixtureValue.root,
    stdio: 'pipe',
  });
  const cli = join(consumerRoot, 'node_modules', '.bin', 'humanagent');
  const hm = join(consumerRoot, 'node_modules', '.bin', 'hm');
  await access(hm);
  const output = JSON.parse(execFileSync(cli, { encoding: 'utf8' }));
  assert.deepEqual(output, {
    releaseVersion: '0.1.0001',
    contract: { scope: 'fixture', value: 'ok' },
    registry: {},
    ui: '<!doctype html><title>humanagent</title>',
  });
});

async function localInstallerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-local-installer-'));
  const projectRoot = join(root, 'project');
  const callerRoot = join(root, 'caller workspace');
  const fakeBin = join(root, 'fake-bin');
  const npmArgsPath = join(root, 'npm-args.json');
  await mkdir(join(projectRoot, 'scripts'), { recursive: true });
  await mkdir(callerRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(projectRoot, 'scripts', 'install-global.mjs'), await readFile(new URL('../../scripts/install-global.mjs', import.meta.url)), 'utf8');
  await writeFile(join(projectRoot, 'scripts', 'release-version.mjs'), await readFile(new URL('../../scripts/release-version.mjs', import.meta.url)), 'utf8');
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ version: '0.1.31', releaseVersion: '0.1.0031' }) + '\n', 'utf8');
  const npmPath = join(fakeBin, 'npm');
  await writeFile(npmPath, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.HUMANAGENT_NPM_ARGS, JSON.stringify(process.argv.slice(2)));",
    "console.log('fake npm invoked');",
    "if (process.env.HUMANAGENT_NPM_EXIT) process.exit(Number(process.env.HUMANAGENT_NPM_EXIT));",
    '',
  ].join('\n'), 'utf8');
  await chmod(npmPath, 0o755);
  return { root, projectRoot, callerRoot, fakeBin, npmArgsPath };
}

async function releaseBuildFixture() {
  const fixtureValue = await fixture();
  const fakeBin = join(fixtureValue.root, 'fake-bin');
  const logPath = join(fixtureValue.root, 'pnpm-calls.jsonl');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fixtureValue.projectRoot, 'package.json'), JSON.stringify({ releaseVersion: '0.1.0001' }) + '\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: fixtureValue.projectRoot });
  await writeFile(join(fakeBin, 'pnpm'), [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.HUMANAGENT_PNPM_CALLS, JSON.stringify({ args: process.argv.slice(2), releaseVersion: process.env.HUMANAGENT_RELEASE_VERSION }) + '\\n');",
    "if (process.env.HUMANAGENT_PNPM_FAIL_SCRIPT === process.argv[3]) {",
    "  console.error(`release fixture failed script: ${process.argv[3]}`);",
    "  process.exit(Number(process.env.HUMANAGENT_PNPM_FAIL_EXIT || 1));",
    "}",
    '',
  ].join('\n'), 'utf8');
  await chmod(join(fakeBin, 'pnpm'), 0o755);
  return { ...fixtureValue, fakeBin, logPath };
}

function runReleaseBuild(fixtureValue, { failScript, failExit = 7 } = {}) {
  return execFileSync(node, ['scripts/build-release.mjs', '--project-root', fixtureValue.projectRoot], {
    cwd: repositoryRoot.pathname,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${fixtureValue.fakeBin}${delimiter}${process.env.PATH}`,
      HUMANAGENT_ALLOW_DIRTY_RELEASE: '1',
      HUMANAGENT_RELEASE_VERSION: '0.1.0001',
      HUMANAGENT_PNPM_CALLS: fixtureValue.logPath,
      ...(failScript ? { HUMANAGENT_PNPM_FAIL_SCRIPT: failScript, HUMANAGENT_PNPM_FAIL_EXIT: String(failExit) } : {}),
    },
  });
}

test('release build runs the fixed command sequence and verifies the package artifact', async (t) => {
  const fixtureValue = await releaseBuildFixture();
  t.after(() => rm(fixtureValue.root, { recursive: true, force: true }));
  let failure;
  try {
    runReleaseBuild(fixtureValue);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.status, 1);
  assert.match(failure.stderr, /did not produce the expected candidate artifact/);
  const calls = (await readFile(fixtureValue.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(calls.every((call) => call.releaseVersion === '0.1.0001'));

  const packageArtifact = join(fixtureValue.projectRoot, 'dist', 'release', 'humanagent-cli-0.1.0001.tgz');
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'release'), { recursive: true });
  await writeFile(packageArtifact, 'package fixture\n', 'utf8');
  const output = JSON.parse(runReleaseBuild(fixtureValue));
  assert.equal(output.releaseVersion, '0.1.0001');
  assert.equal(output.packageArtifactPath, packageArtifact);
});

test('release build propagates the first failure and does not run later commands', async (t) => {
  const fixtureValue = await releaseBuildFixture();
  t.after(() => rm(fixtureValue.root, { recursive: true, force: true }));
  let failure;
  try {
    runReleaseBuild(fixtureValue, { failScript: 'test:compiled:services' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /release fixture failed script: test:compiled:services/);
  assert.match(failure.stderr, /Command failed: pnpm run test:compiled:services/);
  assert.match(failure.stderr, /status: 7/);
  const calls = (await readFile(fixtureValue.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args[1]), ['typecheck', 'build:raw', 'test:compiled:services']);
});

function runLocalInstaller(fixtureValue, args = [], { cwd = fixtureValue.projectRoot, npmExit = 0 } = {}) {
  return execFileSync(node, [join(fixtureValue.projectRoot, 'scripts', 'install-global.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixtureValue.fakeBin}:${process.env.PATH}`,
      HUMANAGENT_NPM_ARGS: fixtureValue.npmArgsPath,
      HUMANAGENT_NPM_EXIT: String(npmExit),
    },
  });
}

test('local installer selects the package and preserves npm failures', async (t) => {
  const fixtureValue = await localInstallerFixture();
  t.after(() => rm(fixtureValue.root, { recursive: true, force: true }));
  const defaultArtifact = join(fixtureValue.projectRoot, 'dist', 'release', 'humanagent-cli-0.1.0031.tgz');
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'release'), { recursive: true });
  await writeFile(defaultArtifact, 'package fixture\n', 'utf8');
  assert.match(runLocalInstaller(fixtureValue), /humanagent-cli-0\.1\.0031\.tgz/);
  assert.deepEqual(JSON.parse(await readFile(fixtureValue.npmArgsPath, 'utf8')), ['install', '--global', await realpath(defaultArtifact)]);

  const explicitArtifact = join(fixtureValue.callerRoot, 'local package.tgz');
  await writeFile(explicitArtifact, 'explicit package fixture\n', 'utf8');
  await rm(fixtureValue.npmArgsPath, { force: true });
  runLocalInstaller(fixtureValue, ['local package.tgz'], { cwd: fixtureValue.callerRoot });
  assert.deepEqual(JSON.parse(await readFile(fixtureValue.npmArgsPath, 'utf8')), ['install', '--global', await realpath(explicitArtifact)]);

  await rm(defaultArtifact, { force: true });
  await rm(fixtureValue.npmArgsPath, { force: true });
  assert.throws(() => runLocalInstaller(fixtureValue), /ENOENT/);
  await assert.rejects(access(fixtureValue.npmArgsPath));

  await writeFile(defaultArtifact, 'package fixture\n', 'utf8');
  await rm(fixtureValue.npmArgsPath, { force: true });
  let failure;
  try {
    runLocalInstaller(fixtureValue, [], { npmExit: 7 });
  } catch (error) {
    failure = error;
  }
  assert.notEqual(failure.status, 0);
  assert.deepEqual(JSON.parse(await readFile(fixtureValue.npmArgsPath, 'utf8')), ['install', '--global', await realpath(defaultArtifact)]);
  assert.doesNotMatch(failure.stdout, /humanagent-cli-0\.1\.0031\.tgz/);
});
