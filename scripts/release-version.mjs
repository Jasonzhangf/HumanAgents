import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.\d{4}$/;

export function validateReleaseVersion(value) {
  if (typeof value !== 'string' || (!SEMVER.test(value) && !RELEASE_VERSION.test(value))) {
    throw new Error('releaseVersion must be a valid semantic version');
  }
  return value;
}

export function configuredReleaseVersion(environment = process.env, projectRoot = process.cwd()) {
  if (environment.HUMANAGENT_RELEASE_VERSION) return validateReleaseVersion(environment.HUMANAGENT_RELEASE_VERSION);
  const packageJson = JSON.parse(readFileSync(join(resolve(projectRoot), 'package.json'), 'utf8'));
  return validateReleaseVersion(packageJson.version || '0.1.0001');
}

export function bumpReleaseVersion(value, kind = 'patch') {
  const current = validateReleaseVersion(value);
  if (current.includes('-') || current.includes('+')) throw new Error('cannot bump a prerelease or build-metadata version automatically');
  const parts = current.split('.');
  const patch = Number(parts[2]);
  const nextPatch = (value) => String(value).padStart(4, '0');
  if (kind === 'major') return `${Number(parts[0]) + 1}.0.0001`;
  if (kind === 'minor') return `${parts[0]}.${Number(parts[1]) + 1}.0001`;
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${nextPatch(patch + 1)}`;
  throw new Error('release bump kind must be patch, minor, or major');
}
