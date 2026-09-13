import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(projectRoot, 'dist', 'release');
const manifestPath = join(releaseRoot, 'release-manifest.json');
execFileSync(process.execPath, ['scripts/check-release.mjs', manifestPath], { cwd: projectRoot, stdio: 'inherit' });
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const artifact = manifest.packageArtifactPath;
if (typeof artifact !== 'string' || !artifact) throw new Error('release manifest has no package artifact; run pnpm package:release after a clean release check');
execFileSync('npm', ['install', '--global', artifact], { stdio: 'inherit' });
console.log(artifact);
