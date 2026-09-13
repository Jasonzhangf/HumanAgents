const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateReleaseVersion(value) {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    throw new Error('releaseVersion must be a valid semantic version');
  }
  return value;
}

export function configuredReleaseVersion(environment = process.env) {
  return validateReleaseVersion(environment.HUMANAGENT_RELEASE_VERSION || '0.1.0');
}
