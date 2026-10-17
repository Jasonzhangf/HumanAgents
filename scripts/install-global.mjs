import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { configuredReleaseVersion } from './release-version.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(projectRoot, 'dist', 'release');
const releaseVersion = configuredReleaseVersion({}, projectRoot);
const artifact = process.argv[2]
  ? resolve(process.argv[2])
  : join(releaseRoot, `humanagent-cli-${releaseVersion}.tgz`);
try {
  await access(artifact);
} catch (error) {
  throw new Error(`local package is not accessible: ${artifact}: ${error.message}`, { cause: error });
}
execFileSync('npm', ['install', '--global', artifact], { stdio: 'inherit' });
console.log(artifact);
