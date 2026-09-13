import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runStages } from '../../scripts/checkpoint-runner.mjs';
import { digest, treeDigest } from '../../scripts/digests.mjs';
import { assemblePackage } from '../../scripts/package-assembly.mjs';
import { validateReleaseVersion } from '../../scripts/release-version.mjs';

const node = process.execPath;
const command = (source) => [node, '-e', source];

test('release versions are path-safe semantic versions', () => {
  assert.equal(validateReleaseVersion('0.1.0'), '0.1.0');
  assert.throws(() => validateReleaseVersion('../escape'), /valid semantic version/);
  assert.throws(() => validateReleaseVersion('1.0.0/other'), /valid semantic version/);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-release-'));
  const projectRoot = join(root, 'project');
  const checkpointRoot = join(root, 'control', 'build', 'checkpoints');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'input.txt'), 'v1\n', 'utf8');
  await writeFile(join(projectRoot, 'mode.txt'), 'fail\n', 'utf8');
  return { root, projectRoot, checkpointRoot };
}

function stagesFor(modeFile = 'input.txt') {
  return [
    { name: 'compile', owner: 'compile', command: command('process.exit(0)'), inputs: [{ kind: 'literal', value: 'compile-v1' }] },
    { name: 'regression', owner: 'regression', dependsOn: ['compile'], command: command('const fs=require("node:fs"); process.exit(fs.readFileSync("input.txt","utf8").includes("ok") ? 0 : 1)'), inputs: [{ kind: 'path', value: 'input.txt' }] },
    { name: 'ci', owner: 'ci', dependsOn: ['regression'], command: command('process.exit(0)'), inputs: [{ kind: 'path', value: 'input.txt' }] },
  ];
}

test('first run executes all stages and second run reuses passing checkpoints', async () => {
  const fixtureValue = await fixture();
  const first = await runStages({ ...fixtureValue, stages: stagesFor() });
  assert.equal(first.overall, 'fail');
  assert.equal(digest(JSON.parse(await readFile(first.manifestPath, 'utf8'))), first.manifestDigest);
  assert.deepEqual(first.stages.map((stage) => stage.status), ['pass', 'fail', 'blocked']);
  await writeFile(join(fixtureValue.projectRoot, 'input.txt'), 'ok\n', 'utf8');
  const second = await runStages({ ...fixtureValue, stages: stagesFor() });
  assert.equal(second.overall, 'pass');
  assert.equal(second.stages[0].status, 'reused');
  assert.equal(second.stages[1].status, 'pass');
  assert.equal(second.stages[2].status, 'pass');
  const third = await runStages({ ...fixtureValue, stages: stagesFor() });
  assert.equal(third.stages[0].status, 'reused');
  assert.equal(third.stages[1].status, 'reused');
  assert.equal(third.stages[2].status, 'reused');
});

test('command failure is non-zero and records first divergence', async () => {
  const fixtureValue = await fixture();
  const result = await runStages({
    ...fixtureValue,
    stages: [{ name: 'fail', owner: 'test', command: command('console.error("first divergence"); process.exit(7)'), inputs: [{ kind: 'path', value: 'input.txt' }] }],
  });
  assert.equal(result.overall, 'fail');
  assert.equal(result.stages[0].exitCode, 7);
  assert.equal(result.stages[0].firstDivergence, 'first divergence');
  assert.match(result.stages[0].stderrArtifactRef, /artifacts/);
});

test('changing a stage command or environment invalidates its passing checkpoint', async () => {
  const fixtureValue = await fixture();
  const first = await runStages({
    ...fixtureValue,
    stages: [{ name: 'compile', owner: 'compile', command: command('process.exit(process.env.GATE_MODE === "pass" ? 0 : 1)'), env: { GATE_MODE: 'pass' }, inputs: [{ kind: 'literal', value: 'same' }] }],
  });
  assert.equal(first.stages[0].status, 'pass');
  const second = await runStages({
    ...fixtureValue,
    stages: [{ name: 'compile', owner: 'compile', command: command('process.exit(9)'), env: { GATE_MODE: 'changed' }, inputs: [{ kind: 'literal', value: 'same' }] }],
  });
  assert.equal(second.stages[0].status, 'fail');
  assert.equal(second.stages[0].exitCode, 9);
});

test('a failed ci stage resumes at ci while regression remains checkpointed', async () => {
  const fixtureValue = await fixture();
  const stages = [
    { name: 'compile', owner: 'compile', command: command('process.exit(0)'), inputs: [{ kind: 'literal', value: 'compile-v1' }] },
    { name: 'regression', owner: 'regression', dependsOn: ['compile'], command: command('process.exit(0)'), inputs: [{ kind: 'path', value: 'input.txt' }] },
    { name: 'ci', owner: 'ci', dependsOn: ['regression'], command: command('const fs=require("node:fs"); process.exit(fs.readFileSync("mode.txt","utf8").includes("pass") ? 0 : 1)'), inputs: [{ kind: 'path', value: 'mode.txt' }] },
  ];
  const first = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(first.stages.map((stage) => stage.status), ['pass', 'pass', 'fail']);
  await writeFile(join(fixtureValue.projectRoot, 'mode.txt'), 'pass\n', 'utf8');
  const second = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(second.stages.map((stage) => stage.status), ['reused', 'reused', 'pass']);
});

test('checkpoint inputs cannot escape the project root through paths or symlinks', async () => {
  const fixtureValue = await fixture();
  const outside = join(fixtureValue.root, 'outside.txt');
  await writeFile(outside, 'outside\n', 'utf8');
  await symlink(outside, join(fixtureValue.projectRoot, 'outside-link.txt'));
  await assert.rejects(() => runStages({
    ...fixtureValue,
    stages: [{ name: 'absolute', owner: 'test', command: command('process.exit(0)'), inputs: [{ kind: 'path', value: outside }] }],
  }), /project-relative path/);
  await assert.rejects(() => runStages({
    ...fixtureValue,
    stages: [{ name: 'traversal', owner: 'test', command: command('process.exit(0)'), inputs: [{ kind: 'path', value: '../outside.txt' }] }],
  }), /escapes project root/);
  await assert.rejects(() => runStages({
    ...fixtureValue,
    stages: [{ name: 'symlink', owner: 'test', command: command('process.exit(0)'), inputs: [{ kind: 'path', value: 'outside-link.txt' }] }],
  }), /escapes project root/);
});

test('checkpoint directory inputs reject in-root symlink cycles', async () => {
  const fixtureValue = await fixture();
  const cycleDirectory = join(fixtureValue.projectRoot, 'cycle');
  await mkdir(cycleDirectory);
  await symlink(cycleDirectory, join(cycleDirectory, 'self'));
  await assert.rejects(() => runStages({
    ...fixtureValue,
    stages: [{ name: 'cycle', owner: 'test', command: command('process.exit(0)'), inputs: [{ kind: 'path', value: 'cycle' }] }],
  }), /directory cycle/);
});

test('a changed declared output invalidates a passing checkpoint and reruns dependents', async () => {
  const fixtureValue = await fixture();
  const stages = [
    { name: 'package', owner: 'package', command: command('require("node:fs").writeFileSync("output.txt", "fresh\\n")'), outputs: [{ kind: 'path', value: 'output.txt' }] },
    { name: 'package-smoke', owner: 'smoke', dependsOn: ['package'], command: command('process.exit(0)') },
  ];
  const first = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(first.stages.map((stage) => stage.status), ['pass', 'pass']);
  const second = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(second.stages.map((stage) => stage.status), ['reused', 'reused']);
  await writeFile(join(fixtureValue.projectRoot, 'output.txt'), 'tampered\n', 'utf8');
  const third = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(third.stages.map((stage) => stage.status), ['pass', 'pass']);
  assert.equal(third.stages[1].reusedFromRun, undefined);
});

test('tampering with the compiled tree reruns compile and package stages', async () => {
  const fixtureValue = await fixture();
  const stages = [
    {
      name: 'compile',
      owner: 'compile',
      command: command('require("node:fs").mkdirSync("dist/app", { recursive: true }); require("node:fs").writeFileSync("dist/app/runtime.js", "fresh\\n")'),
      outputs: [{ kind: 'path', value: 'dist/app' }],
    },
    {
      name: 'package',
      owner: 'package',
      dependsOn: ['compile'],
      command: command('require("node:fs").writeFileSync("package.txt", require("node:fs").readFileSync("dist/app/runtime.js"))'),
      inputs: [{ kind: 'path', value: 'dist/app' }],
      outputs: [{ kind: 'path', value: 'package.txt' }],
    },
  ];
  const first = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(first.stages.map((stage) => stage.status), ['pass', 'pass']);
  const second = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(second.stages.map((stage) => stage.status), ['reused', 'reused']);
  await writeFile(join(fixtureValue.projectRoot, 'dist', 'app', 'runtime.js'), 'tampered\n', 'utf8');
  const third = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(third.stages.map((stage) => stage.status), ['pass', 'pass']);
  assert.equal(third.stages[0].reusedFromRun, undefined);
  assert.equal(third.stages[1].reusedFromRun, undefined);
});

test('an exit-zero stage without its declared output cannot pass or be reused', async () => {
  const fixtureValue = await fixture();
  const stages = [
    { name: 'package', owner: 'package', command: command('process.exit(0)'), outputs: [{ kind: 'path', value: 'missing-output.txt' }] },
    { name: 'package-smoke', owner: 'smoke', dependsOn: ['package'], command: command('process.exit(0)') },
  ];
  const first = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(first.stages.map((stage) => stage.status), ['fail', 'blocked']);
  assert.match(first.stages[0].error, /declared output was not produced/);
  const second = await runStages({ ...fixtureValue, stages });
  assert.deepEqual(second.stages.map((stage) => stage.status), ['fail', 'blocked']);
  assert.equal(second.stages[0].reusedFromRun, undefined);
});

test('colliding readable project keys receive isolated checkpoint namespaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-collision-'));
  const firstRoot = join(root, 'a-b');
  const secondRoot = join(root, 'a', 'b');
  const checkpointRoot = join(root, 'control', 'build', 'checkpoints');
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const stages = [{ name: 'compile', owner: 'compile', command: command('process.exit(0)') }];
  const first = await runStages({ projectRoot: firstRoot, checkpointRoot, stages });
  const second = await runStages({ projectRoot: secondRoot, checkpointRoot, stages });
  assert.notEqual(first.manifestPath, second.manifestPath);
  assert.notEqual(first.projectKey, second.projectKey);
  assert.equal(first.stages[0].status, 'pass');
  assert.equal(second.stages[0].status, 'pass');
});

test('concurrent checkpoint runs reject the second writer and release the lock', async () => {
  const fixtureValue = await fixture();
  const marker = join(fixtureValue.projectRoot, 'started.txt');
  const stages = [{
    name: 'compile',
    owner: 'compile',
    command: command(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started\\n"); setTimeout(() => process.exit(0), 250)`),
  }];
  const firstRun = runStages({ ...fixtureValue, stages });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(marker);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await assert.rejects(() => runStages({ ...fixtureValue, stages }), /checkpoint is already running/);
  const first = await firstRun;
  assert.equal(first.overall, 'pass');
  const second = await runStages({ ...fixtureValue, stages });
  assert.equal(second.stages[0].status, 'reused');
});

test('assembled CLI bin remains executable', async () => {
  const fixtureValue = await fixture();
  const releaseRoot = join(fixtureValue.root, 'release');
  await mkdir(join(fixtureValue.projectRoot, 'dist', 'app'), { recursive: true });
  await writeFile(join(fixtureValue.projectRoot, 'dist', 'app', 'placeholder.txt'), 'runtime\n', 'utf8');
  const result = await assemblePackage({ projectRoot: fixtureValue.projectRoot, releaseRoot, version: '0.1.0' });
  const mode = (await stat(join(result.packageRoot, 'bin', 'humanagent.mjs'))).mode;
  assert.equal(mode & 0o111, 0o111);
});

async function releaseFixture() {
  const fixtureValue = await fixture();
  const repositoryRoot = join(fixtureValue.root, 'repository');
  const artifactPath = join(repositoryRoot, 'dist', 'app');
  const packageArtifactPath = join(repositoryRoot, 'dist', 'release', 'humanagent-cli-0.1.0.tgz');
  await mkdir(artifactPath, { recursive: true });
  await mkdir(join(repositoryRoot, 'dist', 'release'), { recursive: true });
  await writeFile(join(repositoryRoot, 'source.txt'), 'source\n', 'utf8');
  await writeFile(join(artifactPath, 'app.js'), 'export {}\n', 'utf8');
  await writeFile(packageArtifactPath, 'package fixture\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.name', 'HumanAgent Test'], { cwd: repositoryRoot });
  execFileSync('git', ['add', '.'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repositoryRoot });
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const stageCommands = {
    typecheck: ['pnpm', 'run', 'typecheck'],
    compile: ['pnpm', 'run', 'build'],
    regression: ['pnpm', 'run', 'test'],
    ci: ['pnpm', 'run', 'ci:check'],
    package: ['pnpm', 'run', 'package:candidate'],
    'package-smoke': ['pnpm', 'run', 'package:smoke'],
  };
  const runId = 'run-1';
  const stageArtifactRoot = join(fixtureValue.root, 'artifacts', runId);
  const stages = await Promise.all(Object.entries(stageCommands).map(async ([name, commandValue]) => {
    const stageRoot = join(stageArtifactRoot, name);
    await mkdir(stageRoot, { recursive: true });
    const identity = digest({
      name,
      owner: 'test',
      command: commandValue,
      env: [],
      inputDigests: [],
      dependencyPassIdentities: [],
    });
    const outputDigests = [];
    const reusableEvidenceIdentity = digest({ identity, outputDigests });
    await writeFile(join(stageRoot, 'stdout.txt'), '', 'utf8');
    await writeFile(join(stageRoot, 'stderr.txt'), '', 'utf8');
    return {
      name,
      owner: 'test',
      status: 'pass',
      command: commandValue,
      identity,
      reusableEvidenceIdentity,
      evidenceIdentity: digest({ reusableEvidenceIdentity, runId }),
      inputDigests: [],
      outputDigests,
      dependencyPassIdentities: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      runId,
      exitCode: 0,
      signal: null,
      stdoutArtifactRef: join(stageRoot, 'stdout.txt'),
      stderrArtifactRef: join(stageRoot, 'stderr.txt'),
    };
  }));
  const stageManifest = {
    schemaVersion: 1,
    projectRoot: repositoryRoot,
    projectKey: 'test',
    runId,
    updatedAt: new Date().toISOString(),
    overall: 'pass',
    stages,
  };
  const stagePath = join(fixtureValue.root, 'manifest.json');
  const releasePath = join(fixtureValue.root, 'release.json');
  const stageDigest = digest(stageManifest);
  const unsigned = {
    schemaVersion: 1,
    releaseVersion: '0.1.0',
    repositoryRoot,
    sourceCommit,
    configSchemaVersion: 1,
    stageManifestPath: stagePath,
    checkpointRoot: fixtureValue.root,
    stageManifestDigest: stageDigest,
    gateCommands: stages.map((stage) => ({ name: stage.name, command: stage.command, status: stage.status })),
    artifactPath,
    artifactDigest: await treeDigest(artifactPath),
    packageArtifactPath,
    packageArtifactDigest: digest(await readFile(packageArtifactPath)),
    pluginManifest: { status: 'not-applicable', reason: 'test' },
    dshBaseline: { status: 'not-applicable', reason: 'test' },
    review: { status: 'passed', reviewId: 'review-test-1' },
    workingTreeClean: true,
  };
  await writeFile(stagePath, JSON.stringify(stageManifest), 'utf8');
  await writeFile(releasePath, JSON.stringify({ ...unsigned, releaseManifestDigest: digest(unsigned) }), 'utf8');
  return { ...fixtureValue, repositoryRoot, stagePath, releasePath, packageArtifactPath };
}

test('release checker rejects a tampered stage manifest', async () => {
  const fixtureValue = await releaseFixture();
  const valid = execFileSync(node, ['scripts/check-release.mjs', fixtureValue.releasePath], { encoding: 'utf8' });
  assert.match(valid, /"valid": true/);
  const stageManifest = JSON.parse(await readFile(fixtureValue.stagePath, 'utf8'));
  await writeFile(fixtureValue.stagePath, JSON.stringify({ ...stageManifest, overall: 'fail' }), 'utf8');
  assert.throws(() => execFileSync(node, ['scripts/check-release.mjs', fixtureValue.releasePath], { encoding: 'utf8', stdio: 'pipe' }), /stage manifest digest mismatch/);
});

test('release checker rejects a non-passing stage with forged underlying pass status', async () => {
  const fixtureValue = await releaseFixture();
  const stageManifest = JSON.parse(await readFile(fixtureValue.stagePath, 'utf8'));
  stageManifest.stages[0].status = 'blocked';
  stageManifest.stages[0].underlyingStatus = 'pass';
  await writeFile(fixtureValue.stagePath, JSON.stringify(stageManifest), 'utf8');
  const releaseManifest = JSON.parse(await readFile(fixtureValue.releasePath, 'utf8'));
  const unsigned = { ...releaseManifest, stageManifestDigest: digest(stageManifest) };
  delete unsigned.releaseManifestDigest;
  await writeFile(fixtureValue.releasePath, JSON.stringify({ ...unsigned, releaseManifestDigest: digest(unsigned) }), 'utf8');
  assert.throws(() => execFileSync(node, ['scripts/check-release.mjs', fixtureValue.releasePath], { encoding: 'utf8', stdio: 'pipe' }), /release stage is not passing/);
});

test('release checker rejects a forged pass stage without runner evidence', async () => {
  const fixtureValue = await releaseFixture();
  const stageManifest = JSON.parse(await readFile(fixtureValue.stagePath, 'utf8'));
  delete stageManifest.stages[0].evidenceIdentity;
  await writeFile(fixtureValue.stagePath, JSON.stringify(stageManifest), 'utf8');
  const releaseManifest = JSON.parse(await readFile(fixtureValue.releasePath, 'utf8'));
  const unsigned = { ...releaseManifest, stageManifestDigest: digest(stageManifest) };
  delete unsigned.releaseManifestDigest;
  await writeFile(fixtureValue.releasePath, JSON.stringify({ ...unsigned, releaseManifestDigest: digest(unsigned) }), 'utf8');
  assert.throws(() => execFileSync(node, ['scripts/check-release.mjs', fixtureValue.releasePath], { encoding: 'utf8', stdio: 'pipe' }), /typecheck\.evidenceIdentity/);
});

test('release checker rejects a source tree that changed after the manifest was built', async () => {
  const fixtureValue = await releaseFixture();
  await writeFile(join(fixtureValue.repositoryRoot, 'source.txt'), 'changed\n', 'utf8');
  assert.throws(() => execFileSync(node, ['scripts/check-release.mjs', fixtureValue.releasePath], { encoding: 'utf8', stdio: 'pipe' }), /release source is dirty/);
});

test('release checker rejects a candidate package changed after manifest creation', async () => {
  const fixtureValue = await releaseFixture();
  await writeFile(fixtureValue.packageArtifactPath, 'tampered package\n', 'utf8');
  execFileSync('git', ['update-index', '--assume-unchanged', 'dist/release/humanagent-cli-0.1.0.tgz'], { cwd: fixtureValue.repositoryRoot });
  assert.throws(() => execFileSync(node, ['scripts/check-release.mjs', fixtureValue.releasePath], { encoding: 'utf8', stdio: 'pipe' }), /release package artifact digest mismatch/);
});
