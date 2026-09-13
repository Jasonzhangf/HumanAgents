import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, rm, stat, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest } from './digests.mjs';

const SCHEMA_VERSION = 1;
const MAX_INLINE_OUTPUT = 8192;
const CONTROL_ROOT = process.env.HUMANAGENT_HOME || join(homedir(), '.humanagent');

function projectKey(projectRoot) {
  return projectRoot.replaceAll(sep, '/').replaceAll('/', '-') || '-';
}

function collisionSafeProjectKey(readableKey, projectRoot) {
  const suffix = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return `${readableKey}--${suffix}`;
}

async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function inputDigest(projectRoot, input) {
  const value = typeof input === 'string' ? { kind: 'path', value: input } : input;
  if (value.kind === 'literal') return digest({ kind: 'literal', value: value.value });
  if (typeof value.value !== 'string' || !value.value || isAbsolute(value.value)) {
    throw new Error('checkpoint input must be a non-empty project-relative path');
  }
  const canonicalRoot = await realpath(projectRoot);
  const path = resolve(canonicalRoot, value.value);
  const canonicalPath = await realpath(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) {
    throw new Error('checkpoint input escapes project root: ' + value.value);
  }
  const info = await stat(canonicalPath);
  if (info.isDirectory()) {
    const entries = [];
    const visitedPhysicalDirectories = new Set();
    async function visit(logicalDirectory, physicalDirectory) {
      if (visitedPhysicalDirectories.has(physicalDirectory)) {
        throw new Error('checkpoint input contains a directory cycle: ' + logicalDirectory);
      }
      visitedPhysicalDirectories.add(physicalDirectory);
      const children = (await readdir(physicalDirectory, { withFileTypes: true }))
        .filter((entry) => !['.git', 'dist', 'node_modules', '.humanagent'].includes(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of children) {
        const logicalChild = join(logicalDirectory, entry.name);
        const physicalChild = await realpath(join(physicalDirectory, entry.name));
        const childRelative = relative(canonicalRoot, physicalChild);
        if (childRelative.startsWith('..' + sep) || isAbsolute(childRelative)) {
          throw new Error('checkpoint input escapes project root: ' + logicalChild);
        }
        const childInfo = await stat(physicalChild);
        if (childInfo.isDirectory()) await visit(logicalChild, physicalChild);
        else entries.push({ path: relative(canonicalRoot, logicalChild), digest: digest(await readFile(physicalChild)) });
      }
    }
    await visit(value.value, canonicalPath);
    return digest({ kind: 'directory', value: value.value, entries });
  }
  return digest({ kind: 'file', value: value.value, content: digest(await readFile(canonicalPath)) });
}

async function outputDigest(projectRoot, output) {
  const value = typeof output === 'string' ? { kind: 'path', value: output } : output;
  if (value.kind !== 'path' || typeof value.value !== 'string' || !value.value || isAbsolute(value.value)) {
    throw new Error('checkpoint output must be a non-empty project-relative path');
  }
  const canonicalRoot = await realpath(projectRoot);
  const lexicalPath = resolve(canonicalRoot, value.value);
  const lexicalRelative = relative(canonicalRoot, lexicalPath);
  if (lexicalRelative.startsWith('..' + sep) || isAbsolute(lexicalRelative)) {
    throw new Error('checkpoint output escapes project root: ' + value.value);
  }
  let existingAncestor = lexicalPath;
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      const ancestorRelative = relative(canonicalRoot, canonicalAncestor);
      if (ancestorRelative.startsWith('..' + sep) || isAbsolute(ancestorRelative)) {
        throw new Error('checkpoint output escapes project root: ' + value.value);
      }
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  try {
    return await inputDigest(canonicalRoot, value);
  } catch (error) {
    if (error?.code === 'ENOENT' || /ENOENT/.test(error?.message || '')) return null;
    throw error;
  }
}

function sameEvidence(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
}

async function acquireCheckpointLock(root) {
  const lockPath = join(root, '.run.lock');
  await mkdir(root, { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('checkpoint is already running: ' + root);
    throw error;
  }
  try {
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, runId: randomUUID(), acquiredAt: new Date().toISOString() }) + '\n', 'utf8');
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  return async () => rm(lockPath, { recursive: true, force: false });
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error('checkpoint manifest is invalid: ' + error.message);
  }
}

function firstDivergence(stdout, stderr, error) {
  const text = [stderr, stdout, error].filter(Boolean).join('\n');
  return text.split(/\r?\n/).find((line) => line.trim()) || 'stage failed without diagnostic output';
}

function runCommand(command, cwd, env) {
  return new Promise((resolveResult) => {
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolveResult({ exitCode: null, stdout, stderr, error: error.message }));
    child.on('close', (exitCode, signal) => resolveResult({ exitCode, signal, stdout, stderr }));
  });
}

function stageCommand(stage) {
  return stage.command.map((part) => String(part));
}

function stageIdentity(stage, inputDigests, dependencyIdentities) {
  return digest({
    name: stage.name,
    owner: stage.owner,
    command: stageCommand(stage),
    env: Object.entries(stage.env || {}).sort(([left], [right]) => left.localeCompare(right)),
    inputDigests,
    dependencyPassIdentities: dependencyIdentities,
  });
}

function stageReusableEvidenceIdentity(identity, outputDigests) {
  return digest({ identity, outputDigests });
}

function validateStages(stages) {
  const names = new Set();
  stages.forEach((stage, index) => {
    if (names.has(stage.name)) throw new Error('duplicate checkpoint stage: ' + stage.name);
    names.add(stage.name);
    for (const dependency of stage.dependsOn || []) {
      if (!names.has(dependency)) throw new Error(`checkpoint stage ${stage.name} depends on a later or missing stage: ${dependency}`);
    }
    if (!stage.owner || !Array.isArray(stage.command) || stage.command.length === 0) {
      throw new Error('checkpoint stage requires owner and argv command: ' + stage.name);
    }
  });
}

function isPass(stage) {
  return stage?.status === 'pass' || (stage?.status === 'reused' && stage?.underlyingStatus === 'pass');
}

function hasCompleteOutputs(outputDigests) {
  return outputDigests.every((outputDigestValue) => outputDigestValue !== null);
}

export async function runStages(options) {
  validateStages(options.stages);
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const canonicalProjectRoot = await realpathOrFail(projectRoot);
  const checkpointBase = options.checkpointRoot
    ? resolve(options.checkpointRoot)
    : join(options.controlRoot || CONTROL_ROOT, 'build', 'checkpoints');
  const readableProjectKey = projectKey(canonicalProjectRoot);
  const readableRoot = join(checkpointBase, readableProjectKey);
  const readableManifest = await readManifest(join(readableRoot, 'manifest.json'));
  const checkpointProjectKey = readableManifest && readableManifest.projectRoot !== canonicalProjectRoot
    ? collisionSafeProjectKey(readableProjectKey, canonicalProjectRoot)
    : readableProjectKey;
  const root = join(checkpointBase, checkpointProjectKey);
  const manifestPath = join(root, 'manifest.json');
  const releaseCheckpointLock = await acquireCheckpointLock(root);
  try {
  const previous = await readManifest(manifestPath);
  const previousStages = new Map((previous?.stages || []).map((stage) => [stage.name, stage]));
  const runId = 'run-' + randomUUID();
  const stages = [];
  let blocked = false;
  let failed = false;

  for (const stage of options.stages) {
    const inputDigests = [];
    for (const input of stage.inputs || []) inputDigests.push(await inputDigest(canonicalProjectRoot, input));
    const dependencyIdentities = (stage.dependsOn || []).map((name) => {
      const dependency = stages.find((candidate) => candidate.name === name) || previousStages.get(name);
      return dependency?.evidenceIdentity || dependency?.identity || null;
    });
    const identity = stageIdentity(stage, inputDigests, dependencyIdentities);
    const outputDigests = [];
    for (const output of stage.outputs || []) outputDigests.push(await outputDigest(canonicalProjectRoot, output));
    const reusableEvidenceIdentity = stageReusableEvidenceIdentity(identity, outputDigests);
    const old = previousStages.get(stage.name);
    if (!blocked && !failed && old && isPass(old) && hasCompleteOutputs(outputDigests) && old.identity === identity && old.reusableEvidenceIdentity === reusableEvidenceIdentity && sameEvidence(old.outputDigests, outputDigests)) {
      stages.push({ ...old, status: 'reused', underlyingStatus: 'pass', reusedFromRun: previous?.runId || null, identity, reusableEvidenceIdentity, inputDigests, outputDigests, dependencyPassIdentities: dependencyIdentities });
      continue;
    }
    if (failed || blocked) {
      stages.push({ name: stage.name, owner: stage.owner, status: 'blocked', identity, reusableEvidenceIdentity, inputDigests, outputDigests, dependencyPassIdentities: dependencyIdentities, command: stageCommand(stage), nextAction: 'resolve the first failed stage and rerun' });
      blocked = true;
      continue;
    }
    const startedAt = new Date().toISOString();
    const running = { name: stage.name, owner: stage.owner, status: 'running', identity, reusableEvidenceIdentity, inputDigests, outputDigests, dependencyPassIdentities: dependencyIdentities, command: stageCommand(stage), startedAt, runId };
    const runningStages = [...stages, running, ...options.stages.slice(stages.length + 1).map((future) => ({ name: future.name, owner: future.owner, status: 'pending' }))];
    await writeAtomic(manifestPath, { schemaVersion: SCHEMA_VERSION, projectRoot: canonicalProjectRoot, projectKey: checkpointProjectKey, runId, updatedAt: startedAt, stages: runningStages });
    const result = await runCommand({ argv: stageCommand(stage) }, canonicalProjectRoot, stage.env);
    const finishedAt = new Date().toISOString();
    const completedOutputDigests = [];
    for (const output of stage.outputs || []) completedOutputDigests.push(await outputDigest(canonicalProjectRoot, output));
    const completedReusableEvidenceIdentity = stageReusableEvidenceIdentity(identity, completedOutputDigests);
    const completedEvidenceIdentity = digest({ reusableEvidenceIdentity: completedReusableEvidenceIdentity, runId });
    const outputRoot = join(root, 'artifacts', runId, stage.name);
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, 'stdout.txt'), result.stdout, 'utf8');
    await writeFile(join(outputRoot, 'stderr.txt'), result.stderr, 'utf8');
    const missingOutputs = (stage.outputs || [])
      .filter((_, index) => completedOutputDigests[index] === null)
      .map((output) => typeof output === 'string' ? output : output.value);
    const passed = result.exitCode === 0 && missingOutputs.length === 0;
    const failure = missingOutputs.length > 0
      ? `declared output was not produced: ${missingOutputs.join(', ')}`
      : result.error || 'command exited non-zero';
    const completed = {
      ...running,
      evidenceIdentity: completedEvidenceIdentity,
      reusableEvidenceIdentity: completedReusableEvidenceIdentity,
      outputDigests: completedOutputDigests,
      status: passed ? 'pass' : 'fail',
      finishedAt,
      exitCode: result.exitCode,
      signal: result.signal || null,
      stdout: result.stdout.slice(0, MAX_INLINE_OUTPUT),
      stderr: result.stderr.slice(0, MAX_INLINE_OUTPUT),
      stdoutArtifactRef: join(outputRoot, 'stdout.txt'),
      stderrArtifactRef: join(outputRoot, 'stderr.txt'),
      ...(passed ? {} : { error: failure, firstDivergence: firstDivergence(result.stdout, result.stderr, failure) }),
    };
    stages.push(completed);
    if (!passed) failed = true;
  }
  const final = {
    schemaVersion: SCHEMA_VERSION,
    projectRoot: canonicalProjectRoot,
    projectKey: checkpointProjectKey,
    runId,
    updatedAt: new Date().toISOString(),
    overall: failed ? 'fail' : 'pass',
    stages,
  };
  await writeAtomic(manifestPath, final);
  return { ...final, manifestPath, manifestDigest: digest(final) };
  } finally {
    await releaseCheckpointLock();
  }
}

async function realpathOrFail(path) {
  const info = await stat(path).catch((error) => { throw new Error('project root is invalid: ' + error.message); });
  if (!info.isDirectory()) throw new Error('project root is not a directory: ' + path);
  return (await import('node:fs/promises')).realpath(path);
}

export function parseStages(value) {
  return value.map((stage) => {
    if (!stage.name || !stage.owner || !Array.isArray(stage.command) || stage.command.length === 0) {
      throw new Error('stage requires name, owner, and argv command');
    }
    return { ...stage, command: stage.command.map(String) };
  });
}

if (process.argv[1] && process.argv[1].endsWith('checkpoint-runner.mjs')) {
  const result = await runStages({
    projectRoot: process.cwd(),
    stages: [{ name: 'typecheck', owner: 'compile', command: ['pnpm', 'run', 'typecheck'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }] }],
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.overall !== 'pass') process.exitCode = 1;
}
