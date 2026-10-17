import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(projectRoot, 'dist', 'release');
const manifestPath = join(releaseRoot, 'release-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const artifact = manifest.packageArtifactPath;
if (typeof artifact !== 'string' || !artifact) throw new Error('release manifest has no packageArtifactPath; run pnpm package:release to create the package');
execFileSync('npm', ['install', '--global', artifact], { stdio: 'inherit' });
console.log(artifact);
