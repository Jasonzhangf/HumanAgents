import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assemblePackage } from './package-assembly.mjs';
import { configuredReleaseVersion } from './release-version.mjs';

const projectRoot = process.cwd();
const releaseRoot = join(projectRoot, 'dist', 'release');
await mkdir(releaseRoot, { recursive: true });
const result = await assemblePackage({
  projectRoot,
  releaseRoot,
  version: configuredReleaseVersion(),
});
console.log(JSON.stringify(result, null, 2));
