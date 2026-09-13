import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runStages } from './checkpoint-runner.mjs';
import { digest, treeDigest } from './digests.mjs';
import { configuredReleaseVersion } from './release-version.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const projectRoot = resolve(option(process.argv.slice(2), '--project-root', process.cwd()));
const releaseVersion = configuredReleaseVersion();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (dirty && process.env.HUMANAGENT_ALLOW_DIRTY_RELEASE !== '1') {
  throw new Error('release source is dirty; commit or use HUMANAGENT_ALLOW_DIRTY_RELEASE=1 for a local candidate');
}
const stages = [
  { name: 'typecheck', owner: 'compile', command: ['pnpm', 'run', 'typecheck'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'tsconfig.json' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }, { kind: 'path', value: 'scripts' }] },
  { name: 'compile', owner: 'compile', dependsOn: ['typecheck'], command: ['pnpm', 'run', 'build'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }, { kind: 'path', value: 'scripts' }], outputs: [{ kind: 'path', value: 'dist/app' }] },
  { name: 'regression', owner: 'regression', dependsOn: ['compile'], command: ['pnpm', 'run', 'test'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }, { kind: 'path', value: 'scripts' }] },
  { name: 'ci', owner: 'ci', dependsOn: ['regression'], command: ['pnpm', 'run', 'ci:check'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: '.gitignore' }, { kind: 'path', value: 'scripts' }, { kind: 'path', value: 'tests/release' }] },
  { name: 'package', owner: 'release-packager', dependsOn: ['ci'], command: ['pnpm', 'run', 'package:candidate'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'scripts' }, { kind: 'path', value: 'dist/app' }], outputs: [{ kind: 'path', value: `dist/release/humanagent-cli-${releaseVersion}.tgz` }] },
  { name: 'package-smoke', owner: 'release-smoke', dependsOn: ['package'], command: ['pnpm', 'run', 'package:smoke'], env: { HUMANAGENT_RELEASE_VERSION: releaseVersion }, inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'scripts' }] },
];
const result = await runStages({ projectRoot, stages });
if (result.overall !== 'pass') {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const artifactPath = join(projectRoot, 'dist', 'app');
  const artifactDigest = await treeDigest(artifactPath);
  const packageArtifactPath = join(projectRoot, 'dist', 'release', `humanagent-cli-${releaseVersion}.tgz`);
  try { await access(packageArtifactPath); } catch { throw new Error('release package stage did not produce the expected candidate artifact: ' + packageArtifactPath); }
  const manifest = {
    schemaVersion: 1,
    releaseVersion,
    repositoryRoot: projectRoot,
    sourceCommit,
    configSchemaVersion: 1,
    stageManifestPath: result.manifestPath,
    checkpointRoot: dirname(result.manifestPath),
    stageManifestDigest: result.manifestDigest,
    gateCommands: result.stages.map((stage) => ({ name: stage.name, command: stage.command, status: stage.status })),
    artifactPath,
    artifactDigest,
    packageArtifactPath,
    packageArtifactDigest: digest(await readFile(packageArtifactPath)),
    pluginManifest: { status: 'not-applicable', reason: 'MVP has no Cordis plugin loader' },
    dshBaseline: { status: 'not-applicable', reason: 'MVP excludes the DSH adapter' },
    review: { status: 'pending', reviewId: null },
    workingTreeClean: !dirty,
    createdAt: new Date().toISOString(),
  };
  const releaseRoot = join(projectRoot, 'dist', 'release');
  await mkdir(releaseRoot, { recursive: true });
  const releaseManifest = { ...manifest, releaseManifestDigest: digest(manifest) };
  await writeFile(join(releaseRoot, 'release-manifest.json'), JSON.stringify(releaseManifest, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(releaseManifest, null, 2));
}
