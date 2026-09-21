import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredReleaseVersion } from './release-version.mjs';

const projectRoot = process.cwd();
const releaseRoot = join(projectRoot, 'dist', 'release');
const releaseVersion = configuredReleaseVersion();
const packagePath = join(releaseRoot, `humanagent-cli-${releaseVersion}.tgz`);
const root = await mkdtemp(join(tmpdir(), 'humanagent-package-smoke-'));
const prefix = join(root, 'prefix');
const workspace = join(root, 'workspace');
const controlRoot = join(root, 'control');
await mkdir(workspace, { recursive: true });
execFileSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', packagePath], { stdio: 'inherit' });
const cli = join(prefix, 'node_modules', '.bin', 'humanagent');
const hm = join(prefix, 'node_modules', '.bin', 'hm');
await access(hm);
execFileSync(hm, ['--help'], { stdio: 'inherit' });
execFileSync(cli, ['doctor', '--workspace', workspace, '--control-root', controlRoot], { stdio: 'inherit' });
const runArgs = ['run', '--workspace', workspace, '--control-root', controlRoot, '--plan', 'default', '--session', 'package-smoke', '--prompt', 'package smoke', '--json'];
execFileSync(cli, runArgs, { stdio: 'inherit' });
let lifecycleError = '';
try {
  execFileSync(cli, runArgs, { encoding: 'utf8' });
} catch (error) {
  lifecycleError = `${error.stdout || ''}${error.stderr || ''}`;
}
if (!lifecycleError.includes('"code":"session-exists"') || !lifecycleError.includes('"ownerId":"session-store"') || !lifecycleError.includes('"nextAction"')) {
  throw new Error('package smoke did not preserve structured lifecycle error evidence');
}
execFileSync(cli, ['session', 'inspect', '--workspace', workspace, '--control-root', controlRoot, '--session', 'package-smoke'], { stdio: 'inherit' });

const serve = spawn(cli, ['serve', '--provider', 'fake', '--workspace', workspace, '--control-root', controlRoot, '--port', '0'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let errors = '';
serve.stdout.setEncoding('utf8');
serve.stderr.setEncoding('utf8');
serve.stdout.on('data', (chunk) => { output += chunk; });
serve.stderr.on('data', (chunk) => { errors += chunk; });
try {
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`package smoke serve did not start: ${errors}`)), 10000);
    serve.stdout.on('data', () => {
      if (!output.trim().endsWith('}')) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.trim())); } catch { /* wait for the remaining pretty-printed JSON */ }
    });
    serve.once('error', reject);
    serve.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`package smoke serve exited ${code}: ${errors}`));
    });
  });
  const baseUrl = started.url;
  for (const path of ['/', '/dashboard.html', '/interaction.html']) {
    const response = await fetch(`${baseUrl}${path}`);
    if (response.status !== 200) throw new Error(`package smoke UI route failed: ${path} ${response.status}`);
  }
  const explicitInput = await fetch(`${baseUrl}/api/explicit/inputs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'business', sourceRef: 'package-smoke', rawInput: 'start explicit session' }),
  });
  if (explicitInput.status !== 201) throw new Error(`package smoke explicit session start failed: ${explicitInput.status}`);
  await access(join(controlRoot, 'main', 'sessions', 'explicit-brain.jsonl'));
  const tasksResponse = await fetch(`${baseUrl}/api/tasks`);
  if (tasksResponse.status !== 200) throw new Error(`package smoke runtime API failed: /api/tasks ${tasksResponse.status}`);
} finally {
  if (serve.exitCode === null) {
    serve.kill('SIGTERM');
    await new Promise((resolve) => serve.once('exit', resolve));
  }
}
console.log(JSON.stringify({ package: packagePath, workspace, controlRoot, lifecycleError: 'structured', arbitraryCwdUi: 'passed' }, null, 2));
