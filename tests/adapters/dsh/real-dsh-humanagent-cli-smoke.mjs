#!/usr/bin/env node
/**
 * Real DSH -> HumanAgent CLI smoke receipt.
 *
 * This is the same-entry proof for the app lifecycle. It runs the built CLI
 * with an explicit `driverRef = "dsh"`, a clean locked DSH source worktree,
 * the live RCC endpoint, and a per-run nonce that must be read by the DSH
 * `read` tool before the model can answer.
 *
 * Required env:
 *   HUMANAGENT_DSH_SOURCE  absolute path to the locked DSH source checkout
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL  default http://127.0.0.1:4444/v1
 *   HUMANAGENT_DSH_MODEL     default gpt-5.5
 *   HUMANAGENT_RECEIPT_PATH  default ./dist/receipts/dsh-humanagent-cli-smoke.json
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

const decompress = promisify(zstdDecompress);

const DSH_SOURCE = process.env.HUMANAGENT_DSH_SOURCE;
const RCC_BASE_URL = process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444/v1';
const MODEL = process.env.HUMANAGENT_DSH_MODEL ?? 'gpt-5.5';
const RECEIPT_PATH = resolve(
  process.env.HUMANAGENT_RECEIPT_PATH ?? 'dist/receipts/dsh-humanagent-cli-smoke.json',
);
const CLI_PATH = resolve('dist/app/app/src/cli.js');
const DSH_PATCH = 'apps/cli/src/sdk-source.cordis.patch.yml';

if (!DSH_SOURCE) {
  console.error('HUMANAGENT_DSH_SOURCE is required (absolute path to the DSH source checkout)');
  process.exit(2);
}

const dshRoot = resolve(DSH_SOURCE);

function gitValue(args) {
  return execFileSyncGit(args).trim();
}

function execFileSyncGit(args) {
  return execFileSync('git', ['-C', dshRoot, ...args], { encoding: 'utf8' });
}

function commandSucceeded(result) {
  return result.code === 0;
}

async function runCommand(command, args, options = {}) {
  return await new Promise((settle) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      settle({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
        error: error === null ? undefined : String(error.message ?? error),
      });
    });
  });
}

function visit(value, predicate) {
  if (value === null || typeof value !== 'object') return false;
  if (predicate(value)) return true;
  if (Array.isArray(value)) return value.some((item) => visit(item, predicate));
  return Object.values(value).some((item) => visit(item, predicate));
}

function findObject(value, predicate) {
  if (value === null || typeof value !== 'object') return undefined;
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = findObject(item, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function containsOrderedKinds(actual, required) {
  let requiredIndex = 0;
  for (const kind of actual) {
    if (kind === required[requiredIndex]) requiredIndex += 1;
    if (requiredIndex === required.length) return true;
  }
  return required.length === 0;
}

async function readJsonl(file) {
  const values = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // An incomplete line is not committed evidence and must not be counted.
    }
  }
  return values;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const nonce = randomUUID();
  const targetSecondLine = `feature_flag=${nonce}`;
  const root = await mkdtemp(join(tmpdir(), 'humanagent-cli-dsh-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  const sessionId = `dsh-smoke-${Date.now()}`;
  const targetName = 'CONFIG-PROBE.txt';
  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.dsh.cli-smoke',
    generatedAt,
    dshSource: dshRoot,
    dshRevision: {
      commit: gitValue(['rev-parse', 'HEAD']),
      tree: gitValue(['rev-parse', 'HEAD^{tree}']),
      describe: gitValue(['describe', '--tags', '--always']),
    },
    cliPath: CLI_PATH,
    rccBaseUrl: RCC_BASE_URL,
    expected: {
      state: 'stopped',
      outcome: 'succeeded',
      requiredObservedKinds: ['tool', 'tool', 'output', 'terminal'],
      targetSecondLine,
    },
  };

  let failure;
  try {
    if (!existsSync(CLI_PATH)) throw new Error(`CLI build is missing: ${CLI_PATH}; run pnpm build first`);
    await mkdir(controlRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, targetName), `humanagent-cli-smoke\n${targetSecondLine}\n`, 'utf8');

    const initialized = await runCommand(process.execPath, [
      CLI_PATH,
      'init',
      '--workspace',
      workspace,
      '--control-root',
      controlRoot,
    ], { timeoutMs: 30_000 });
    if (!commandSucceeded(initialized)) throw new Error(`CLI init failed: ${initialized.stderr || initialized.stdout}`);

    await writeFile(join(controlRoot, 'config.toml'), [
      'schemaVersion = 1',
      '',
      '[[agents]]',
      'agentId = "execution-dsh"',
      'roleId = "execution"',
      'templateRef = "builtin/execution@1.0.0"',
      'driverRef = "dsh"',
      'skills = ["single-capability-worker"]',
      'tools = ["search"]',
      'permissions = ["task.read", "workspace.read"]',
      'memoryScopes = ["task"]',
      'resourceClass = "foreground"',
      '',
      '[project]',
      'defaultAgent = "execution-dsh"',
      'reviewRequired = true',
      '',
      '[execution]',
      'maxConcurrentTasks = 1',
      'stopTimeoutMs = 30000',
      '',
      '[execution.dsh]',
      `sourceRoot = ${JSON.stringify(dshRoot)}`,
      'home = "dsh/home"',
      'profile = "sdk"',
      'provider = "rcc"',
      `model = ${JSON.stringify(MODEL)}`,
      `patchFiles = [${JSON.stringify(DSH_PATCH)}]`,
      'permissionMode = "danger-full-access"',
      'turnTimeoutMs = 180000',
      'shutdownTimeoutMs = 60000',
      '',
    ].join('\n'), 'utf8');

    const healthResponse = await fetch(`${RCC_BASE_URL.replace(/\/v1\/?$/, '')}/health`);
    const healthBody = await healthResponse.text();
    receipt.rccHealth = {
      status: healthResponse.status,
      body: healthBody,
    };
    if (healthResponse.status !== 200) throw new Error(`RCC health returned ${healthResponse.status}`);

    const run = await runCommand(process.execPath, [
      CLI_PATH,
      'run',
      '--workspace',
      workspace,
      '--control-root',
      controlRoot,
      '--plan',
      'default',
      '--session',
      sessionId,
      '--prompt',
      `Use the read tool exactly once to read ${targetName} in the working directory,`
        + ' then reply with the exact contents of its second line and nothing else.'
        + ' The file contains a random value that can only be obtained by reading it.',
    ], {
      timeoutMs: 300_000,
      env: { ...process.env, RCC_LOCAL_API_KEY: 'rcc-local-placeholder' },
    });
    if (!commandSucceeded(run)) throw new Error(`CLI run failed: ${run.stderr || run.stdout}`);
    const cliRun = JSON.parse(run.stdout);
    receipt.cliRun = cliRun;
    receipt.observedKinds = cliRun.observedKinds;
    receipt.checkpointId = cliRun.checkpointId;

    const projectEntries = await readdir(join(controlRoot, 'project'), { withFileTypes: true });
    const projectDir = projectEntries.find((entry) => entry.isDirectory());
    if (!projectDir) throw new Error('CLI run did not create a project journal namespace');
    const checkpointFile = join(controlRoot, 'project', projectDir.name, 'journal', 'checkpoints.jsonl');
    const checkpoints = await readJsonl(checkpointFile);
    receipt.humanagentCheckpointCommitted = checkpoints.some((value) => (
      visit(value, (object) => JSON.stringify(object).includes(cliRun.checkpointId)
        && object.outcome === 'succeeded')
    ));
    const checkpointArtifact = `${RECEIPT_PATH}.checkpoints.jsonl`;
    await mkdir(dirname(checkpointArtifact), { recursive: true });
    await copyFile(checkpointFile, checkpointArtifact);
    receipt.humanagentCheckpointArtifact = checkpointArtifact;

    const dshHome = join(controlRoot, 'dsh', 'home');
    const sessionFiles = (await readdir(join(dshHome, 'sessions'), { recursive: true }))
      .filter((file) => file.endsWith('.jsonl.zstd'))
      .map((file) => join(dshHome, 'sessions', file));
    const sessionEvidence = [];
    for (const sessionFile of sessionFiles) {
      const records = await readJsonlFromZstd(sessionFile);
      const toolCallIndexes = records
        .map((object, index) => object.type === 'tool/call' && object.data?.name === 'read' ? index : -1)
        .filter((index) => index >= 0);
      const toolCallIndex = toolCallIndexes.length === 1 ? toolCallIndexes[0] : -1;
      const toolCallId = toolCallIndex < 0 ? undefined : records[toolCallIndex]?.data?.callId;
      const toolResultIndex = records.findIndex((object, index) => index > toolCallIndex
        && object.type === 'tool/result'
        && Array.isArray(object.data?.message?.content)
        && object.data.message.content.some((content) => content?.toolCallId === toolCallId));
      const assistantIndex = records.findIndex((object, index) => index > toolResultIndex
        && object.type === 'assistant/message'
        && JSON.stringify(object).includes(targetSecondLine));
      sessionEvidence.push({
        file: sessionFile,
        toolCallRead: toolCallIndex >= 0,
        readCallCount: toolCallIndexes.length,
        exactlyOneReadCall: toolCallIndexes.length === 1,
        matchingToolResult: toolResultIndex > toolCallIndex,
        assistantReportedNonceAfterResult: assistantIndex > toolResultIndex,
        sameSessionContinuation: toolCallIndex >= 0
          && toolCallIndexes.length === 1
          && toolResultIndex > toolCallIndex
          && assistantIndex > toolResultIndex,
      });
    }
    receipt.dshSessionEvidence = sessionEvidence;
    if (sessionEvidence[0] !== undefined) {
      const sessionLogArtifact = `${RECEIPT_PATH}.session.v3.jsonl.zstd`;
      await copyFile(sessionEvidence[0].file, sessionLogArtifact);
      receipt.dshSessionLogArtifact = sessionLogArtifact;
    }

    receipt.ok = cliRun.state === receipt.expected.state
      && cliRun.outcome === receipt.expected.outcome
      && containsOrderedKinds(cliRun.observedKinds, receipt.expected.requiredObservedKinds)
      && receipt.humanagentCheckpointCommitted === true
      && sessionEvidence.some((entry) => entry.sameSessionContinuation);
    if (!receipt.ok) throw new Error('CLI smoke did not satisfy all invariants');
  } catch (error) {
    failure = error;
    receipt.ok = false;
    receipt.error = { message: String(error?.message ?? error) };
    receipt.temporaryRoot = root;
  } finally {
    if (!failure) await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  await mkdir(dirname(RECEIPT_PATH), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (failure) {
    process.stderr.write(`CLI smoke failed: ${failure.message}\n`);
    process.exitCode = 1;
  }
}

async function readJsonlFromZstd(file) {
  const compressed = await readFile(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let index = 0; index <= compressed.length - magic.length; index += 1) {
    if (compressed.subarray(index, index + magic.length).equals(magic)) starts.push(index);
  }
  if (starts.length === 0) throw new Error(`DSH session log has no zstd frame: ${file}`);
  const frames = [];
  for (let index = 0; index < starts.length; index += 1) {
    frames.push(await decompress(compressed.subarray(starts[index], starts[index + 1] ?? compressed.length)));
  }
  return Buffer.concat(frames)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

await main();
