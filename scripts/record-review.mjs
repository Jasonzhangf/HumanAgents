import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { digest } from './digests.mjs';

const BLOCKING_SEVERITIES = new Set(['P0', 'P1', 'blocker', 'important']);

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error('record-review missing ' + name);
  return value;
}

function absolute(value, name) {
  required(value, name);
  if (!isAbsolute(value)) throw new Error(name + ' must be absolute');
  return value;
}

const args = process.argv.slice(2);
const projectRoot = resolve(option(args, '--project-root', process.cwd()));
const manifestPath = resolve(option(args, '--manifest', join(projectRoot, 'dist', 'release', 'release-manifest.json')));
const reviewId = required(option(args, '--review-id'), '--review-id');
const reviewRoot = absolute(resolve(option(args, '--review-root', join(projectRoot, '.agent-collab', 'review'))), '--review-root');
const receiptDir = join(reviewRoot, reviewId);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.review?.status === 'passed') {
  throw new Error('release manifest already has a passed review; refusing to overwrite existing review state');
}
const sourceCommit = required(manifest.sourceCommit, 'manifest.sourceCommit');
const stageManifestDigest = required(manifest.stageManifestDigest, 'manifest.stageManifestDigest');
const artifactDigest = required(manifest.artifactDigest, 'manifest.artifactDigest');
const packageArtifactDigest = required(manifest.packageArtifactDigest, 'manifest.packageArtifactDigest');

const status = JSON.parse(await readFile(join(receiptDir, 'status.json'), 'utf8'));
if (status.state !== 'completed') throw new Error('review receipt is not completed: ' + reviewId);
if (status.mode !== 'commit') throw new Error('review receipt is not bound to a commit: ' + reviewId);
if (status.commit !== sourceCommit) {
  throw new Error('review receipt commit does not match the candidate source commit: ' + reviewId);
}

const finalText = await readFile(join(receiptDir, 'review.final.md'), 'utf8');
let final;
try {
  final = JSON.parse(finalText);
} catch {
  throw new Error('review receipt final result is not valid JSON: ' + reviewId);
}
if (final.scope?.commit !== sourceCommit) {
  throw new Error('review receipt final scope is not bound to the candidate source commit: ' + reviewId);
}
const findings = Array.isArray(final.findings) ? final.findings : [];
const blocking = findings.filter((finding) => BLOCKING_SEVERITIES.has(finding?.severity));
if (blocking.length) {
  throw new Error('review receipt has blocking findings: ' + blocking.map((finding) => finding.severity).join(', '));
}

const review = {
  status: 'passed',
  reviewId,
  sourceCommit,
  stageManifestDigest,
  artifactDigest,
  packageArtifactDigest,
  receiptDigest: digest({ status, final: finalText }),
  reviewedAt: new Date().toISOString(),
};
const unsigned = { ...manifest, review };
delete unsigned.releaseManifestDigest;
const releaseManifest = { ...unsigned, releaseManifestDigest: digest(unsigned) };
await writeFile(manifestPath, JSON.stringify(releaseManifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ manifestPath, review }, null, 2));
