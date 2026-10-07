#!/usr/bin/env node
/**
 * Real ACP runtime proof.
 *
 * Drives all three ACP runtimes through the real HumanAgent wiring:
 *
 *   user config -> validateUserConfig -> composeAgentDriver
 *   -> AcpClientDriver -> runtime adaptor -> real engine process
 *
 * `opencode` is a real ACP v1 server, so it is driven directly. `antigravity`
 * and `dsh` ship no ACP server, so their native one-shot CLI protocol is
 * bridged by an adaptor shim. Nothing here is mocked: every answer below comes
 * from a real engine process.
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
 * opencode needs a model provider in its workspace. When
 * HUMANAGENT_OPENCODE_BASE_URL and HUMANAGENT_OPENCODE_MODEL are set, the proof
 * writes an `opencode.json` for them; otherwise pass a HUMANAGENT_ACP_WORKSPACE
 * that already contains one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const distApp = join(repoRoot, 'dist', 'app');

const { validateUserConfig } = await import(join(distApp, 'config', 'src', 'index.js'));
const { composeAgentDriver } = await import(join(distApp, 'app', 'src', 'agent-driver-composition.js'));

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
  const separator = OPENCODE_MODEL.indexOf('/');
  if (separator < 1) throw new Error('HUMANAGENT_OPENCODE_MODEL must look like <provider>/<model>');
  const provider = OPENCODE_MODEL.slice(0, separator);
  const model = OPENCODE_MODEL.slice(separator + 1);
  writeFileSync(join(workspace, 'opencode.json'), `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: OPENCODE_MODEL,
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
  }, null, 2)}\n`, 'utf8');
}

const paths = {
  controlRoot: join(tmpdir(), 'humanagent-acp-proof'),
  agentCwd: join(tmpdir(), 'humanagent-acp-proof'),
  mainRoot: join(tmpdir(), 'humanagent-acp-proof'),
  mainSessionsRoot: join(tmpdir(), 'humanagent-acp-proof'),
  workspaceCwd: join(tmpdir(), 'humanagent-acp-proof'),
  projectKey: 'acp-proof',
  projectRoot: join(tmpdir(), 'humanagent-acp-proof'),
  projectManifest: join(tmpdir(), 'humanagent-acp-proof', 'project.json'),
  sessionsRoot: join(tmpdir(), 'humanagent-acp-proof'),
  journalRoot: join(tmpdir(), 'humanagent-acp-proof'),
  checkpointsRoot: join(tmpdir(), 'humanagent-acp-proof'),
  indexRoot: join(tmpdir(), 'humanagent-acp-proof'),
  artifactsRoot: join(tmpdir(), 'humanagent-acp-proof'),
  memoryRoot: join(tmpdir(), 'humanagent-acp-proof'),
  userRoot: join(tmpdir(), 'humanagent-acp-proof'),
  globalMemoryRoot: join(tmpdir(), 'humanagent-acp-proof'),
  locksRoot: join(tmpdir(), 'humanagent-acp-proof'),
  runNotesRoot: join(tmpdir(), 'humanagent-acp-proof'),
};

const acpAgent = (driverRef) => ({
  agentId: `interaction-${driverRef}`,
  roleId: 'interaction',
  templateRef: 'builtin/interaction@1.0.0',
  driverRef,
  skills: ['input-normalization'],
  tools: ['input.receive'],
  permissions: ['task.read'],
  memoryScopes: ['task'],
  resourceClass: 'foreground',
});

const executionFor = (which) => {
  if (which === 'opencode') return { command: OPENCODE_COMMAND, args: argsFor(process.env.HUMANAGENT_OPENCODE_ARGS, ['acp', '--pure']), timeoutMs: TIMEOUT_MS };
  if (which === 'antigravity') return { command: ANTIGRAVITY_COMMAND, timeoutMs: TIMEOUT_MS };
  if (which === 'acp-dsh') return { command: DSH_COMMAND, args: argsFor(process.env.HUMANAGENT_DSH_ARGS, ['--profile', 'headless', '--json']), timeoutMs: TIMEOUT_MS };
  throw new Error(`unknown ACP runtime: ${which}`);
};

async function runOne(which) {
  const tag = `${which}-${process.pid}`;
  const workspace = FIXED_WORKSPACE ?? mkdtempSync(join(tmpdir(), `humanagent-acp-${which}-`));
  if (which === 'opencode') seedOpencodeWorkspace(workspace, tag);
  const execution = { [which === 'acp-dsh' ? 'dshAcp' : which]: executionFor(which) };
  const parsed = validateUserConfig({ schemaVersion: 1, execution, agents: [acpAgent(which)] });
  const agent = parsed.agents[0];
  const composed = composeAgentDriver({
    agent,
    paths,
    runtimeId: `runtime-${tag}`,
    workspace,
    opencode: parsed.execution?.opencode,
    antigravity: parsed.execution?.antigravity,
    dshAcp: parsed.execution?.dshAcp,
  });
  const driver = composed.driver;

  const scoped = (scope, value) => ({ scope, value });
  const runtimeId = `runtime-${tag}`;
  const epoch = 1;
  const taskId = scoped('task', `task-${tag}`);
  const operationId = scoped('operation', `operation-${tag}`);
  const assignmentId = `assignment-${tag}`;

  await driver.start({ runtimeId, taskId, executionEpoch: epoch, assignmentId, organId: scoped('organ', `organ-${tag}`), operationId });
  const output = await driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: { prompt: PROMPT } });
  const events = [];
  for await (const event of driver.observe({ runtimeId })) {
    events.push({ kind: event.kind, terminalState: event.terminalState });
    if (event.terminalState !== undefined) break;
  }
  const closure = await driver.settle({ runtimeId, executionEpoch: epoch });
  const answer = typeof output.payload.outputText === 'string' ? output.payload.outputText : '';
  const passed = answer.trim().toUpperCase().includes('POGS')
    && output.payload.stopReason === 'end_turn'
    && closure.state === 'succeeded'
    && events.some((event) => event.kind === 'execution.terminal');
  if (FIXED_WORKSPACE === undefined) rmSync(workspace, { recursive: true, force: true });
  return { runtime: which, passed, answer, stopReason: output.payload.stopReason, closureState: closure.state, events };
}

const results = [];
for (const which of REQUESTED) {
  process.stdout.write(`\n===== ${which} =====\n`);
  try {
    const result = await runOne(which);
    console.log(`  answer=${JSON.stringify(result.answer)} stopReason=${result.stopReason} closure=${result.closureState}`);
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}`);
    results.push(result);
  } catch (error) {
    console.log(`  ERROR: ${error?.code ?? error?.name} - ${error?.message}`);
    results.push({ runtime: which, passed: false, error: `${error?.code ?? error?.name}: ${error?.message}` });
  }
}

const failures = results.filter((result) => !result.passed).length;
const receipt = {
  schemaVersion: 1,
  kind: 'humanagent.acp-runtimes-proof',
  prompt: PROMPT,
  timeoutMs: TIMEOUT_MS,
  runtimes: results,
  failures,
  verdict: failures === 0 ? 'pass' : 'fail',
};
mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(`\nreceipt: ${RECEIPT_PATH}`);
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
