import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { digest } from './digests.mjs';

const BLOCKING_SEVERITIES = new Set(['P0', 'P1']);
const REVIEW_SEVERITIES = new Set(['P0', 'P1', 'P2']);

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

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateReviewFinal(final, status, sourceCommit, reviewId) {
  if (!exactKeys(final, ['contract_version', 'scope', 'module_boundary_evidence', 'findings'])) {
    throw new Error('review receipt final result does not match the review output contract: ' + reviewId);
  }
  if (final.contract_version !== '1') {
    throw new Error('review receipt final result has an unsupported contract version: ' + reviewId);
  }
  if (!exactKeys(final.scope, ['mode', 'commit', 'base']) || final.scope.mode !== 'commit' || final.scope.commit !== sourceCommit || final.scope.base !== status.base) {
    throw new Error('review receipt final scope is not bound to the candidate source commit: ' + reviewId);
  }
  const validEvidence = Array.isArray(final.module_boundary_evidence) && final.module_boundary_evidence.every((entry) =>
    exactKeys(entry, ['module', 'owner', 'paths', 'edges', 'resources', 'gates']) &&
    ['module', 'owner', 'paths', 'edges', 'resources', 'gates'].every((key) => typeof entry[key] === 'string' && entry[key].trim()));
  if (!validEvidence) {
    throw new Error('review receipt module boundary evidence is invalid: ' + reviewId);
  }
  const validFindings = Array.isArray(final.findings) && final.findings.every((finding) =>
    exactKeys(finding, ['severity', 'file', 'line', 'rule', 'evidence', 'remediation']) &&
    REVIEW_SEVERITIES.has(finding.severity) &&
    typeof finding.file === 'string' && finding.file.trim() &&
    Number.isInteger(finding.line) && finding.line > 0 &&
    ['rule', 'evidence', 'remediation'].every((key) => typeof finding[key] === 'string' && finding[key].trim()));
  if (!validFindings) {
    throw new Error('review receipt findings are invalid: ' + reviewId);
  }
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

const status = JSON.parse(await readFile(join(receiptDir, 'status.json'), 'utf8'));
if (status.state !== 'completed') throw new Error('review receipt is not completed: ' + reviewId);
if (status.verdict !== 'pass' || status.failureClass != null || status.exitCode !== 0) {
  throw new Error('review receipt is not a passing review: ' + reviewId);
}
if (status.mode !== 'commit') throw new Error('review receipt is not bound to a commit: ' + reviewId);
if (status.commit !== sourceCommit) {
  throw new Error('review receipt commit does not match the candidate source commit: ' + reviewId);
}
const baseCommit = required(status.base, 'review receipt base');

const finalText = await readFile(join(receiptDir, 'review.final.md'), 'utf8');
let final;
try {
  final = JSON.parse(finalText);
} catch {
  throw new Error('review receipt final result is not valid JSON: ' + reviewId);
}
validateReviewFinal(final, status, sourceCommit, reviewId);
const blocking = final.findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
if (blocking.length) {
  throw new Error('review receipt has blocking findings: ' + blocking.map((finding) => finding.severity).join(', '));
}

const review = {
  status: 'passed',
  reviewId,
  sourceCommit,
  baseCommit,
  receiptDigest: digest({ status, final: finalText }),
  reviewedAt: new Date().toISOString(),
};
const unsigned = { ...manifest, review };
delete unsigned.releaseManifestDigest;
const releaseManifest = { ...unsigned, releaseManifestDigest: digest(unsigned) };
await writeFile(manifestPath, JSON.stringify(releaseManifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ manifestPath, review }, null, 2));
