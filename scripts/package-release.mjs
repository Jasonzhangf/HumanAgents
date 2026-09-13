import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const projectRoot = process.cwd();
const releaseRoot = join(projectRoot, 'dist', 'release');
const manifestPath = join(releaseRoot, 'release-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
execFileSync(process.execPath, ['scripts/check-release.mjs', manifestPath], { cwd: projectRoot, stdio: 'inherit' });
console.log(JSON.stringify({ releaseManifest: manifestPath, package: manifest.packageArtifactPath }, null, 2));
