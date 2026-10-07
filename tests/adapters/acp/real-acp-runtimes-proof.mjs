#!/usr/bin/env node
/**
 * Real ACP runtime proof, driven through the real HumanAgent entry.
 *
 *   config.toml -> loadConfiguration -> runAgentOperation
 *   -> composeAgentDriver -> AcpClientDriver -> runtime adaptor -> real engine
 *   -> checkpoint commit -> readRunManifest -> resumeAgentOperation
 *
 * `opencode` is a real ACP v1 server, so it is driven directly. `antigravity`
 * and `dsh` ship no ACP server, so their native one-shot CLI protocol is
 * bridged by an adaptor shim. Nothing here is mocked: every answer comes from
 * a real engine process, and every checkpoint below is committed through the
 * app entry that a user's `humanagent run` calls.
 *
 * This is deliberately not a unit test. It depends on installed runtime
 * binaries and on a live model endpoint, so it is an explicit, opt-in receipt
 * generator. It writes a JSON receipt and never falls back to a fake runtime.
 *
 * Required env:
 *   HUMANAGENT_OPENCODE_COMMAND      absolute path to the opencode executable
 *   HUMANAGENT_ANTIGRAVITY_COMMAND   absolute path to the agy executable
 *   HUMANAGENT_DSH_COMMAND           absolute path to the dsh executable
 * Optional env:
 *   HUMANAGENT_OPENCODE_ARGS         default "acp --pure"
 *   HUMANAGENT_DSH_ARGS              default "--profile headless --json"
 *   HUMANAGENT_ACP_TIMEOUT_MS        default 120000
 *   HUMANAGENT_ACP_RUNTIMES          comma list, default "opencode,antigravity,acp-dsh"
 *   HUMANAGENT_ACP_WORKSPACE         default a fresh temp dir per runtime
 *   HUMANAGENT_RECEIPT_PATH          default dist/receipts/acp-runtimes-proof.json
 *
 * opencode resolves its model provider from `opencode.json` in the session cwd.
 * When HUMANAGENT_OPENCODE_BASE_URL and HUMANAGENT_OPENCODE_MODEL are set, the
 * proof writes one for them; otherwise pass a HUMANAGENT_ACP_WORKSPACE that
 * already contains one.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const distApp = join(repoRoot, 'dist', 'app');

const { ensureControlLayout, loadConfiguration, resolveRuntimePaths } = await import(join(distApp, 'config', 'src', 'index.js'));
const { readRunManifest, resumeAgentOperation, runAgentOperation } = await import(join(distApp, 'app', 'src', 'index.js'));

const OPENCODE_COMMAND = process.env.HUMANAGENT_OPENCODE_COMMAND;
const ANTIGRAVITY_COMMAND = process.env.HUMANAGENT_ANTIGRAVITY_COMMAND;
const DSH_COMMAND = process.env.HUMANAGENT_DSH_COMMAND;
const TIMEOUT_MS = Number(process.env.HUMANAGENT_ACP_TIMEOUT_MS ?? 120_000);
// The delivery contract is all three runtimes. `HUMANAGENT_ACP_RUNTIMES` can
// narrow the run for debugging, but a narrowed run cannot report PASS.
const KNOWN_RUNTIMES = ['opencode', 'antigravity', 'acp-dsh'];
const REQUESTED = (process.env.HUMANAGENT_ACP_RUNTIMES ?? KNOWN_RUNTIMES.join(','))
  .split(',').map((value) => value.trim()).filter((value) => value.length > 0);
const RECEIPT_PATH = resolve(process.env.HUMANAGENT_RECEIPT_PATH ?? join(repoRoot, 'dist', 'receipts', 'acp-runtimes-proof.json'));
// A receipt that is not bound to a revision cannot be evidence for one.
const CANDIDATE_REVISION = (() => {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const WORKTREE_DIRTY = (() => {
  try {
    return execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return true;
  }
})();
// The script imports the compiled entry, so a receipt must identify that
// artifact: a revision alone cannot show which build produced the result.
const ARTIFACT = (() => {
  const hash = createHash('sha256');
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(relative(distApp, full));
      hash.update('\0');
      hash.update(readFileSync(full));
      hash.update('\0');
      files += 1;
    }
  };
  try {
    walk(distApp);
  } catch (error) {
    return { digest: `unreadable: ${error instanceof Error ? error.message : String(error)}`, files: 0 };
  }
  return { digest: hash.digest('hex'), files };
})();

const FIXED_WORKSPACE = process.env.HUMANAGENT_ACP_WORKSPACE;
const OPENCODE_BASE_URL = process.env.HUMANAGENT_OPENCODE_BASE_URL;
const OPENCODE_MODEL = process.env.HUMANAGENT_OPENCODE_MODEL;
const OPENCODE_API_KEY = process.env.HUMANAGENT_OPENCODE_API_KEY ?? 'local-placeholder';
const PROMPT = 'Reply with exactly one word: POGS. Nothing else.';

if (REQUESTED.length === 0) {
  console.error('HUMANAGENT_ACP_RUNTIMES selected no runtime; the proof must run at least one');
  process.exit(2);
}
const unknownRuntimes = REQUESTED.filter((value) => !KNOWN_RUNTIMES.includes(value));
if (unknownRuntimes.length > 0) {
  console.error(`unknown runtime(s): ${unknownRuntimes.join(', ')}; known: ${KNOWN_RUNTIMES.join(', ')}`);
  process.exit(2);
}
const uncoveredRuntimes = KNOWN_RUNTIMES.filter((value) => !REQUESTED.includes(value));

// A receipt can only be attributed to a revision if the tree it was produced
// from is that revision.
if (WORKTREE_DIRTY) {
  console.error('worktree is dirty; commit the candidate before generating a proof receipt');
  process.exit(2);
}

const missing = [
  ...(REQUESTED.includes('opencode') && !OPENCODE_COMMAND ? ['HUMANAGENT_OPENCODE_COMMAND'] : []),
  ...(REQUESTED.includes('antigravity') && !ANTIGRAVITY_COMMAND ? ['HUMANAGENT_ANTIGRAVITY_COMMAND'] : []),
  ...(REQUESTED.includes('acp-dsh') && !DSH_COMMAND ? ['HUMANAGENT_DSH_COMMAND'] : []),
];
if (missing.length > 0) {
  console.error(`missing required env: ${missing.join(', ')}`);
  process.exit(2);
}

const argsFor = (raw, fallback) => (raw === undefined ? fallback : raw.split(' ').filter((value) => value.length > 0));

/**
 * opencode resolves its model provider from `opencode.json` in the session cwd.
 * The proof writes one only from explicit env, so no endpoint is baked in.
 */
function seedOpencodeWorkspace(workspace, tag) {
  if (OPENCODE_BASE_URL === undefined || OPENCODE_MODEL === undefined) return;
  const provider = OPENCODE_BASE_URL.replace(/\/+$/, '').split('/').pop() || 'provider';
  const model = OPENCODE_MODEL.includes('/') ? OPENCODE_MODEL.split('/').pop() : OPENCODE_MODEL;
  writeFileSync(join(workspace, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [provider]: {
        name: 'ACP proof provider',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: OPENCODE_BASE_URL,
          apiKey: OPENCODE_API_KEY,
          headers: { 'x-session-id': `ha-acp-${tag}`, 'x-conversation-id': `ha-acp-${tag}` },
        },
        models: { [model]: { name: model, reasoning: true, tool_call: true, limit: { context: 65536, output: 8192 } } },
      },
    },
  }, null, 2), 'utf8');
}

/**
 * Writes the config a user would write, including the ACP execution section.
 * The default agent is the ACP driver under test, so `runAgentOperation`
 * selects it exactly as a real run does.
 */
function writeAcpConfig(controlRoot, driverRef) {
  const commands = { opencode: OPENCODE_COMMAND, antigravity: ANTIGRAVITY_COMMAND, 'acp-dsh': DSH_COMMAND };
  const command = commands[driverRef];
  if (command === undefined) throw new Error(`unknown ACP runtime: ${driverRef}`);
  const args = driverRef === 'opencode' ? argsFor(process.env.HUMANAGENT_OPENCODE_ARGS, ['acp', '--pure'])
    : driverRef === 'acp-dsh' ? argsFor(process.env.HUMANAGENT_DSH_ARGS, ['--profile', 'headless', '--json'])
    : undefined;
  const configKey = driverRef === 'acp-dsh' ? 'dshAcp' : driverRef;
  const lines = [
    'schemaVersion = 1',
    '',
    '[[agents]]',
    `agentId = "interaction-${driverRef}"`,
    'roleId = "interaction"',
    'templateRef = "builtin/interaction@1.0.0"',
    `driverRef = "${driverRef}"`,
    'skills = ["input-normalization"]',
    'tools = ["input.receive"]',
    'permissions = ["task.read"]',
    'memoryScopes = ["task"]',
    'resourceClass = "foreground"',
    '',
    '[project]',
    `defaultAgent = "interaction-${driverRef}"`,
    'reviewRequired = false',
    '',
    '[execution]',
    'maxConcurrentTasks = 1',
    `stopTimeoutMs = ${Math.max(1000, TIMEOUT_MS)}`,
    '',
    `[execution.${configKey}]`,
    `command = "${command.replace(/\\/g, '\\\\')}"`,
    ...(args === undefined ? [] : [`args = ${JSON.stringify(args)}`]),
    `timeoutMs = ${TIMEOUT_MS}`,
    '',
  ];
  writeFileSync(join(controlRoot, 'config.toml'), lines.join('\n'), 'utf8');
}

async function runOne(which) {
  const tag = `${which}-${process.pid}`;
  const workspace = FIXED_WORKSPACE ?? mkdtempSync(join(tmpdir(), `humanagent-acp-${which}-`));
  const controlRoot = mkdtempSync(join(tmpdir(), `humanagent-acp-${which}-control-`));
  const sessionId = `session-${tag}`;
  if (which === 'opencode') seedOpencodeWorkspace(workspace, tag);
  writeAcpConfig(controlRoot, which);

  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);

  const result = await runAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId,
    plan: 'default',
    prompt: PROMPT,
  });

  const checkpointText = readFileSync(join(paths.journalRoot, 'checkpoints.jsonl'), 'utf8');
  const manifest = await readRunManifest(paths, sessionId);
  const resumed = await resumeAgentOperation({
    paths,
    configuration,
    workspace,
    sessionId,
    plan: 'default',
    prompt: PROMPT,
    taskId: manifest.taskId,
    cycleId: manifest.cycleId,
    scope: manifest.scope,
    executionEpoch: manifest.executionEpoch,
    directiveRevision: manifest.directiveRevision,
    agentId: manifest.agentId,
    driverRef: manifest.driverRef,
  });

  // The turn answer is carried by the driver in `output.payload.outputText`.
  const answer = typeof result.receipt.output?.payload?.outputText === 'string' ? result.receipt.output.payload.outputText : '';
  // The same answer must reach the app as an ordered output event, which is how
  // every downstream role reads provider output.
  const outputEvents = (result.semanticEvents ?? []).filter((event) => event.kind === 'provider.output');
  const streamAnswer = outputEvents.map((event) => event.summary ?? '').join('');
  // `observedKinds` are driver-level kinds; the projection to `execution.terminal`
  // lives in `semanticEvents`. There are two terminals: the provider one, then
  // the final one after the checkpoint commits, so take the last.
  const semanticKinds = (result.semanticEvents ?? []).map((event) => event.kind);
  // The projection emits the provider terminal and then the final one, after
  // the checkpoint commits, so the terminal that ends the operation is last.
  const terminal = [...(result.semanticEvents ?? [])]
    .reverse()
    .find((event) => event.kind === 'execution.terminal');
  // The acceptance contract of this receipt is the wiring: a real engine answer
  // must reach the committed checkpoint, the readable manifest, and a resumable
  // session.
  const wiringPassed = result.checkpoint.outcome === 'succeeded'
    && manifest.driverRef === which
    && manifest.scope.organId.value === result.checkpoint.scope.organId.value
    && manifest.scope.operationId?.value === result.checkpoint.scope.operationId?.value
    && result.receipt.observedKinds.includes('terminal')
    && terminal?.state === 'succeeded'
    && terminal?.terminalPhase === 'final'
    && checkpointText.includes('"outcome":"succeeded"')
    // `resumeAgentOperation` reports a terminal checkpoint without running a new
    // turn, so this proves the committed checkpoint is recallable through the
    // recovery entry, not that a second turn ran.
    && resumed.recovered?.checkpoint.id.value === result.checkpoint.id.value
    && resumed.waitingReason === `checkpoint is terminal: ${result.checkpoint.outcome}`;
  // The engine's wording is not our contract. What this receipt must prove is
  // that the answer the driver returned is the same string the app published on
  // its ordered `provider.output` stream: an answer cannot be committed without
  // reaching the stream that every downstream role reads.
  const answerPassed = answer.length > 0 && answer === streamAnswer;
  const passed = wiringPassed && answerPassed;

  if (FIXED_WORKSPACE === undefined) {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(controlRoot, { recursive: true, force: true });
  }
  return {
    runtime: which,
    wiringPassed,
    answerPassed,
    passed,
    answer,
    streamAnswer,
    checkpoint: {
      outcome: result.checkpoint.outcome,
      organId: result.checkpoint.scope.organId.value,
      cycleId: result.checkpoint.scope.cycleId?.value,
      operationId: result.checkpoint.scope.operationId?.value,
    },
    manifest: {
      driverRef: manifest.driverRef,
      organId: manifest.scope.organId.value,
      operationId: manifest.scope.operationId?.value,
    },
    observedKinds: result.receipt.observedKinds,
    eventKinds: semanticKinds,
    terminalPhase: terminal?.terminalPhase,
    providerClose: result.receipt.providerClose?.state,
    recoveredCheckpointId: resumed.recovered?.checkpoint.id.value,
    recoveryWaitingReason: resumed.waitingReason,
    command: which === 'opencode' ? OPENCODE_COMMAND
      : (which === 'antigravity' ? ANTIGRAVITY_COMMAND : DSH_COMMAND),
    sessionId,
    workspace,
    controlRoot,
  };
}

const results = [];
for (const which of REQUESTED) {
  process.stdout.write(`\n===== ${which} =====\n`);
  try {
    const result = await runOne(which);
    console.log(`  answer=${JSON.stringify(result.answer)} stream=${JSON.stringify(result.streamAnswer)}`);
    console.log(`  checkpoint=${result.checkpoint.outcome} organ=${result.checkpoint.organId} op=${result.checkpoint.operationId}`);
    console.log(`  manifest=${result.manifest.driverRef} organ=${result.manifest.organId} op=${result.manifest.operationId}`);
    console.log(`  driver=${result.observedKinds.join(',')}`);
    console.log(`  semantic=${result.eventKinds.join(',')}`);
    console.log(`  providerClose=${result.providerClose} recovered=${result.recoveryWaitingReason}`);
    console.log(`  wiring=${result.wiringPassed ? 'PASS' : 'FAIL'} answer=${result.answerPassed ? 'PASS' : 'FAIL'}`);
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}`);
    results.push(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ERROR ${message}`);
    results.push({ runtime: which, passed: false, error: message });
  }
}

// A subset run, or a run where a requested runtime produced no result, must not
// be reportable as the full proof.
const ranEveryRequested = results.length === REQUESTED.length
  && REQUESTED.every((runtime) => results.some((result) => result.runtime === runtime));
const allPassed = ranEveryRequested
  && uncoveredRuntimes.length === 0
  && results.every((result) => result.passed);
const shortfall = [
  ...(ranEveryRequested ? [] : ['not every requested runtime produced a result']),
  ...(uncoveredRuntimes.length === 0 ? [] : [`not covered: ${uncoveredRuntimes.join(', ')}`]),
];
writeFileSync(RECEIPT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  candidateRevision: CANDIDATE_REVISION,
  worktreeDirty: WORKTREE_DIRTY,
  artifact: { digest: ARTIFACT.digest, files: ARTIFACT.files, root: relative(repoRoot, distApp) },
  requested: REQUESTED,
  knownRuntimes: KNOWN_RUNTIMES,
  uncoveredRuntimes,
  prompt: PROMPT,
  allPassed,
  results,
}, null, 2), 'utf8');
console.log(`\nreceipt=${RECEIPT_PATH}`);
console.log(`artifact=${ARTIFACT.digest} (${ARTIFACT.files} files)`);
if (shortfall.length > 0) console.log(`shortfall=${shortfall.join('; ')}`);
console.log(`overall=${allPassed ? 'PASS' : 'FAIL'}`);
process.exit(allPassed ? 0 : 1);
