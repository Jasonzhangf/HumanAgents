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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
const REQUESTED = (process.env.HUMANAGENT_ACP_RUNTIMES ?? 'opencode,antigravity,acp-dsh')
  .split(',').map((value) => value.trim()).filter((value) => value.length > 0);
const RECEIPT_PATH = resolve(process.env.HUMANAGENT_RECEIPT_PATH ?? join(repoRoot, 'dist', 'receipts', 'acp-runtimes-proof.json'));
const FIXED_WORKSPACE = process.env.HUMANAGENT_ACP_WORKSPACE;
const OPENCODE_BASE_URL = process.env.HUMANAGENT_OPENCODE_BASE_URL;
const OPENCODE_MODEL = process.env.HUMANAGENT_OPENCODE_MODEL;
const OPENCODE_API_KEY = process.env.HUMANAGENT_OPENCODE_API_KEY ?? 'local-placeholder';
const PROMPT = 'Reply with exactly one word: POGS. Nothing else.';

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

const acpExecutionFor = {
  opencode: ['opencode', 'HUMANAGENT_OPENCODE_ARGS', ['acp', '--pure']],
  antigravity: ['antigravity', undefined, undefined],
  'acp-dsh': ['dshAcp', 'HUMANAGENT_DSH_ARGS', ['--profile', 'headless', '--json']],
};

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
    && resumed.recovered?.checkpoint.id.value === result.checkpoint.id.value;
  // The engine's wording is not our contract. What this receipt must prove is
  // that the engine's bytes survive the transport, the driver, the app
  // projection and the event stream unchanged: the received answer is non-empty
  // and identical in the receipt and in the semantic event stream.
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
    resumed: resumed.recovered?.checkpoint.id.value === result.checkpoint.id.value,
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
    console.log(`  providerClose=${result.providerClose} resumed=${result.resumed}`);
    console.log(`  wiring=${result.wiringPassed ? 'PASS' : 'FAIL'} answer=${result.answerPassed ? 'PASS' : 'FAIL'}`);
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}`);
    results.push(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ERROR ${message}`);
    results.push({ runtime: which, passed: false, error: message });
  }
}

const allPassed = results.every((result) => result.passed);
writeFileSync(RECEIPT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  prompt: PROMPT,
  allPassed,
  results,
}, null, 2), 'utf8');
console.log(`\nreceipt=${RECEIPT_PATH}`);
console.log(`overall=${allPassed ? 'PASS' : 'FAIL'}`);
process.exit(allPassed ? 0 : 1);
