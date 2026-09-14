import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runStages } from './checkpoint-runner.mjs';
import { checkpointStages } from './checkpoint-stages.mjs';
import { digest, treeDigest } from './digests.mjs';
import { configuredReleaseVersion } from './release-version.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const projectRoot = resolve(option(process.argv.slice(2), '--project-root', process.cwd()));
const releaseVersion = process.env.HUMANAGENT_RELEASE_VERSION || configuredReleaseVersion();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (dirty && process.env.HUMANAGENT_ALLOW_DIRTY_RELEASE !== '1') {
  throw new Error('release source is dirty; commit or use HUMANAGENT_ALLOW_DIRTY_RELEASE=1 for a local candidate');
}
const stages = checkpointStages({ includePackaging: true, releaseVersion });
const controlRoot = process.env.HUMANAGENT_HOME || join(homedir(), '.humanagent');
const result = await runStages({
  projectRoot,
  checkpointRoot: join(controlRoot, 'build', 'checkpoints'),
  lockRoot: join(controlRoot, 'build', 'locks'),
  stages,
});
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
