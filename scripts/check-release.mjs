import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { digest, treeDigest } from './digests.mjs';
import { validateReleaseVersion } from './release-version.mjs';

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error('release manifest missing ' + name);
  return value;
}

function absolute(value, name) {
  required(value, name);
  if (resolve(value) !== value) throw new Error(name + ' must be absolute');
  return value;
}

function isWithin(root, candidate) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return candidate === root || candidate.startsWith(prefix);
}

function timestamp(value, name) {
  required(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new Error(name + ' must be a valid timestamp');
}

async function validateStageArtifact(stage, field, checkpointRoot) {
  const artifactPath = absolute(stage[field], `${stage.name}.${field}`);
  const canonicalRoot = await realpath(checkpointRoot);
  const canonicalArtifact = await realpath(artifactPath).catch(() => {
    throw new Error(`release stage artifact is missing: ${stage.name}.${field}`);
  });
  if (!isWithin(canonicalRoot, canonicalArtifact)) throw new Error(`release stage artifact escapes checkpointRoot: ${stage.name}.${field}`);
  const info = await stat(canonicalArtifact);
  if (!info.isFile()) throw new Error(`release stage artifact is not a file: ${stage.name}.${field}`);
}

async function validateStageEvidence(stage, checkpointRoot) {
  if (!required(stage.name, 'stage.name') || !required(stage.owner, `${stage.name}.owner`)) throw new Error('release stage is incomplete');
  if (!Array.isArray(stage.command) || stage.command.length === 0) throw new Error(`release stage command is missing: ${stage.name}`);
  if (stage.exitCode !== 0 || stage.signal !== null) throw new Error(`release stage did not exit successfully: ${stage.name}`);
  required(stage.runId, `${stage.name}.runId`);
  required(stage.identity, `${stage.name}.identity`);
  required(stage.reusableEvidenceIdentity, `${stage.name}.reusableEvidenceIdentity`);
  required(stage.evidenceIdentity, `${stage.name}.evidenceIdentity`);
  timestamp(stage.startedAt, `${stage.name}.startedAt`);
  timestamp(stage.finishedAt, `${stage.name}.finishedAt`);
  if (!Array.isArray(stage.inputDigests) || stage.inputDigests.some((value) => typeof value !== 'string' || !value)) throw new Error(`release stage input evidence is invalid: ${stage.name}`);
  if (!Array.isArray(stage.outputDigests) || stage.outputDigests.some((value) => typeof value !== 'string' || !value)) throw new Error(`release stage output evidence is incomplete: ${stage.name}`);
  if (!Array.isArray(stage.dependencyPassIdentities) || stage.dependencyPassIdentities.some((value) => value !== null && (typeof value !== 'string' || !value))) throw new Error(`release stage dependency evidence is invalid: ${stage.name}`);
  if (stage.reusableEvidenceIdentity !== digest({ identity: stage.identity, outputDigests: stage.outputDigests })) {
    throw new Error(`release stage reusable evidence mismatch: ${stage.name}`);
  }
  if (stage.evidenceIdentity !== digest({ reusableEvidenceIdentity: stage.reusableEvidenceIdentity, runId: stage.runId })) {
    throw new Error(`release stage evidence mismatch: ${stage.name}`);
  }
  await validateStageArtifact(stage, 'stdoutArtifactRef', checkpointRoot);
  await validateStageArtifact(stage, 'stderrArtifactRef', checkpointRoot);
  if (stage.status === 'reused' && (stage.underlyingStatus !== 'pass' || !required(stage.reusedFromRun, `${stage.name}.reusedFromRun`))) {
    throw new Error(`reused release stage evidence is incomplete: ${stage.name}`);
  }
}

const file = resolve(process.argv[2] || 'dist/release/release-manifest.json');
const manifest = JSON.parse(await readFile(file, 'utf8'));
validateReleaseVersion(required(manifest.releaseVersion, 'releaseVersion'));
absolute(manifest.repositoryRoot, 'repositoryRoot');
required(manifest.sourceCommit, 'sourceCommit');
absolute(manifest.stageManifestPath, 'stageManifestPath');
absolute(manifest.checkpointRoot, 'checkpointRoot');
required(manifest.stageManifestDigest, 'stageManifestDigest');
absolute(manifest.artifactPath, 'artifactPath');
required(manifest.artifactDigest, 'artifactDigest');
absolute(manifest.packageArtifactPath, 'packageArtifactPath');
required(manifest.packageArtifactDigest, 'packageArtifactDigest');
if (manifest.workingTreeClean !== true) throw new Error('release source was not clean');
if (manifest.configSchemaVersion !== 1) throw new Error('unsupported configSchemaVersion');
if (!Array.isArray(manifest.gateCommands)) throw new Error('release manifest missing gateCommands');
if (manifest.pluginManifest?.status !== 'not-applicable' && typeof manifest.pluginManifest?.digest !== 'string') throw new Error('release manifest has invalid pluginManifest evidence');
if (manifest.dshBaseline?.status !== 'not-applicable' && typeof manifest.dshBaseline?.baseline !== 'string') throw new Error('release manifest has invalid dshBaseline evidence');
if (manifest.review?.status !== 'passed' || typeof manifest.review.reviewId !== 'string' || !manifest.review.reviewId) throw new Error('release review evidence is not passed');
const unsigned = { ...manifest };
delete unsigned.releaseManifestDigest;
if (manifest.releaseManifestDigest !== digest(unsigned)) throw new Error('release manifest digest mismatch');
const currentHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: manifest.repositoryRoot, encoding: 'utf8' }).trim();
if (currentHead !== manifest.sourceCommit) throw new Error('release source commit does not match current HEAD');
const currentStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: manifest.repositoryRoot, encoding: 'utf8' }).trim();
if (currentStatus) throw new Error('release source is dirty');
if (manifest.stageManifestPath !== join(manifest.checkpointRoot, 'manifest.json') || resolve(dirname(manifest.stageManifestPath)) !== manifest.checkpointRoot) throw new Error('stage manifest is not bound to checkpointRoot');
if (manifest.artifactPath !== join(manifest.repositoryRoot, 'dist', 'app')) throw new Error('artifactPath is not bound to repository dist/app');
if (manifest.packageArtifactPath !== join(manifest.repositoryRoot, 'dist', 'release', `humanagent-cli-${manifest.releaseVersion}.tgz`)) throw new Error('packageArtifactPath is not bound to release version');
if (await treeDigest(manifest.artifactPath) !== manifest.artifactDigest) throw new Error('release artifact digest mismatch');
if (digest(await readFile(manifest.packageArtifactPath)) !== manifest.packageArtifactDigest) throw new Error('release package artifact digest mismatch');
const stageManifest = JSON.parse(await readFile(manifest.stageManifestPath, 'utf8'));
if (stageManifest.projectRoot !== manifest.repositoryRoot) throw new Error('stage manifest projectRoot does not match repositoryRoot');
const actualStageDigest = digest(stageManifest);
if (actualStageDigest !== manifest.stageManifestDigest) throw new Error('stage manifest digest mismatch');
if (stageManifest.overall !== 'pass' || !Array.isArray(stageManifest.stages)) throw new Error('release stages are not passing');
for (const requiredStage of ['typecheck', 'compile', 'regression', 'ci', 'package', 'package-smoke']) {
  if (!stageManifest.stages.some((stage) => stage.name === requiredStage)) throw new Error('release stage is missing: ' + requiredStage);
}
for (const stage of stageManifest.stages) {
  if (stage.status === 'reused' && stage.underlyingStatus !== 'pass') {
    throw new Error('reused release stage is not passing: ' + stage.name);
  }
  if (!['pass', 'reused'].includes(stage.status)) {
    throw new Error('release stage is not passing: ' + stage.name);
  }
  await validateStageEvidence(stage, manifest.checkpointRoot);
  const gate = manifest.gateCommands.find((candidate) => candidate.name === stage.name);
  if (!gate || JSON.stringify(gate.command) !== JSON.stringify(stage.command) || gate.status !== stage.status) {
    throw new Error('release gate evidence mismatch: ' + stage.name);
  }
}
console.log(JSON.stringify({ valid: true, releaseVersion: manifest.releaseVersion, sourceCommit: manifest.sourceCommit, stages: stageManifest.stages.map((stage) => ({ name: stage.name, status: stage.status })) }, null, 2));
