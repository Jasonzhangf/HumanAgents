import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assemblePackage } from './package-assembly.mjs';
import { configuredPackageVersion, configuredReleaseVersion } from './release-version.mjs';

const projectRoot = process.cwd();
const releaseRoot = join(projectRoot, 'dist', 'release');
await mkdir(releaseRoot, { recursive: true });
const result = await assemblePackage({
  projectRoot,
  releaseRoot,
  version: configuredPackageVersion(projectRoot),
  releaseVersion: configuredReleaseVersion({}, projectRoot),
});
console.log(JSON.stringify(result, null, 2));
