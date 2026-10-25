#!/usr/bin/env node
/**
 * Real task-plan phase-membership black box.
 *
 * Production defect (0.1.0040, task ui-task-a3198d24-d2ae-4da9-86cd-41e437a1b401-24):
 * a short task finished its turn and committed its checkpoint, then settled
 * `blocked` with `task plan node n1 phaseId does not match phase membership`
 * and `code: runtime.execution.failure`, `retryable: false`. The Planner model
 * omitted the optional node `phaseId` while its phase declared those nodes as
 * members, so the one-sided membership failed the Contracts validator after
 * real success.
 *
 * Everything except the scripted upstream is the real runtime: the CLI serve
 * entry, the UI Runtime HTTP API, the task create and grant control paths, the
 * execution entry, the Provider adapter, the real closed-turn Planner call and
 * the real settlement. Nothing touches the shared production instance on 10086:
 * control root, workspace, journals and port belong to this run.
 *
 * Case A (the fixed entry): the Planner omits the node `phaseId` but the phase
 * claims the nodes. The same entry must end `succeeded` with the exact output.
 * Case B (the real inconsistency): the Planner declares a node phaseId that
 * conflicts with the phase that claims it. The entry must still fail with the
 * original text and publish no plan revision. Case B proves the fix completes
 * one-sided membership without bypassing or swallowing the validator.
 *
 * Usage: node tests/app/task-phase-membership-blackbox.mjs
 * Requires the built CLI at dist/app/app/src/cli.js.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve('dist/app/app/src/cli.js');
const MODEL = process.env.HUMANAGENT_UI_MODEL ?? 'gpt-5.5';
const TERMINAL_TIMEOUT_MS = 180_000;
const ORIGINAL_ERROR = 'task plan node n1 phaseId does not match phase membership';

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
const phase = (message) => process.stderr.write(`[phase-membership] ${message}\n`);

function startServe(root, baseUrl) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', 'rcc-entry',
    '--provider', 'rcc',
    '--model', MODEL,
    '--route', 'default',
    '--rcc-base-url', baseUrl,
    '--workspace', join(root, 'workspace'),
    '--control-root', join(root, 'control'),
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr}`)), 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/\{[\s\S]*?\n\}/);
      if (!match) return;
      try {
        const parsed = JSON.parse(match[0]);
        clearTimeout(timer);
        settle(parsed);
      } catch {
        // keep buffering until the JSON object is complete
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr}`)));
  });

  return {
    ready,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 400)}`);
  }
  if (!response.ok) throw new Error(`request failed ${response.status} ${url}: ${text.slice(0, 600)}`);
  return body;
}

async function waitForTerminal(url, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dashboard = await jsonRequest(`${url}/api/tasks/${taskId}/dashboard`);
    if (!['created', 'admitted', 'running', 'waiting', 'settling'].includes(dashboard.state)) return dashboard;
    if (Date.now() > deadline) return dashboard;
    await sleep(250);
  }
}

async function startTask(url, title, prompt) {
  const task = await jsonRequest(`${url}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, directive: prompt }),
  });
  const taskId = task.taskId.value;
  const grantRead = await jsonRequest(`${url}/api/tasks/${taskId}/control/grant`, {});
  const currentRevision = grantRead.readback?.grant?.revision ?? 0;
  const grant = await jsonRequest(`${url}/api/tasks/${taskId}/control/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `blackbox-grant-${taskId}`, expectedRevision: currentRevision }),
  });
  const startedAtMs = Date.now();
  const started = await jsonRequest(`${url}/api/tasks/${taskId}/executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'rcc', prompt }),
  });
  return {
    taskId,
    operationId: started.operationId,
    startedAtMs,
    grantState: grant.readback?.grant?.state ?? null,
  };
}

/** Reads a whole-task snapshot out of the Planner request, if this is one. */
function plannerRequest(body) {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    return undefined;
  }
  return wire.input
    ?.filter((item) => item.role === 'user')
    .flatMap((item) => item.content ?? [])
    .map((part) => {
      try {
        return JSON.parse(part.text ?? '');
      } catch {
        return undefined;
      }
    })
    .find((value) => value?.role === 'planner');
}

function turnEndFrames(deliveryText) {
  return [
    { type: 'response.output_item.done', output_index: 0, item: {
      type: 'function_call', call_id: 'phase-blackbox-end', name: 'humanagent_turn_end',
      arguments: JSON.stringify({
        summary: {
          goal: { text: 'Reply with exactly: OK', evidenceRefs: [] },
          actions: { text: 'No tools were required.', evidenceRefs: [] },
          result: { text: `Delivered exactly "${deliveryText}".`, evidenceRefs: [] },
          expectedNextStep: { text: 'No further work.', evidenceRefs: [] },
        },
        deliveryText,
        deliveryRefs: [],
      }),
    } },
  ];
}

/**
 * A local upstream that answers the real execution and Planner calls.
 *
 * One-sided snapshots carry nodes without `phaseId` while their phase claims
 * them (the exact production shape). The conflicting snapshot declares a node
 * `phaseId` that its claiming phase does not match.
 */
async function startScriptedUpstream(snapshot) {
  const state = { plannerCalls: 0, executionCalls: 0 };
  const upstream = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: 'stub-0.0.0' }));
      return;
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    let frames;
    if (plannerRequest(raw) !== undefined) {
      state.plannerCalls += 1;
      frames = [{ type: 'response.output_text.done', item_id: 'phase-blackbox-plan-text', text: JSON.stringify({
        decision: 'complete',
        reasonText: 'the committed closure confirms the literal reply was delivered',
        snapshot: typeof snapshot === 'function' ? snapshot() : snapshot,
      }) }];
    } else if (raw.includes('function_call_output')) {
      frames = [{ type: 'response.output_text.done', item_id: 'phase-blackbox-drain-text', text: 'drained' }];
    } else {
      state.executionCalls += 1;
      frames = turnEndFrames('OK');
    }
    const id = `phase-blackbox-${state.executionCalls + state.plannerCalls}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'response.created', response: { id } }, ...frames,
      { type: 'response.completed', response: { id } }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const url = await new Promise((settle, fail) => {
    upstream.once('error', fail);
    upstream.listen(0, '127.0.0.1', () => settle(`http://127.0.0.1:${upstream.address().port}`));
  });
  return { url, state, close: () => new Promise((done) => upstream.close(done)) };
}

/** The production shape: both nodes omit `phaseId`; phase p1 claims both. */
function oneSidedSnapshot() {
  return {
    title: 'live stream terminal verification',
    summary: 'One turn replies with exactly OK; no tools were required.',
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{ criterionId: 'ac-1', description: 'The reply is exactly the literal token OK.' }],
    nodes: [
      { nodeId: 'n1', kind: 'verification', title: 'Confirm required reply', intent: 'Establish the required reply.', definition: { expectedReply: 'OK' } },
      { nodeId: 'n2', kind: 'delivery', title: 'Output literal OK', intent: 'Return OK as the whole response.', definition: { reply: 'OK', wholeResponse: true } },
    ],
    phases: [{ phaseId: 'p1', title: 'Terminal verification', memberNodeIds: ['n1', 'n2'] }],
    relations: [],
  };
}

/** The genuine conflict: node n1 declares p2 while phase p1 claims it. */
function conflictingSnapshot() {
  return {
    title: 'conflicting phase verification',
    summary: 'The node declares a phase that does not claim it.',
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{ criterionId: 'ac-1', description: 'The reply is exactly the literal token OK.' }],
    nodes: [
      { nodeId: 'n1', kind: 'verification', title: 'Confirm required reply', intent: 'Establish the required reply.', definition: { expectedReply: 'OK' }, phaseId: 'p2' },
    ],
    phases: [{ phaseId: 'p1', title: 'Terminal verification', memberNodeIds: ['n1'] }],
    relations: [],
  };
}

/** Counts published plan revisions in this run's own control journals. */
async function planRevisionCount(root) {
  const { readFile, readdir } = await import('node:fs/promises');
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await walk(path);
        continue;
      }
      if (entry.name !== 'task-control.jsonl') continue;
      const text = await readFile(path, 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (line.includes('task-plan-revision.published')) total += 1;
      }
    }
    return total;
  };
  return walk(join(root, 'control'));
}

/**
 * The run's own user config. Both configured agents inherit this `[provider]`,
 * and the closed-turn Planner selects its Provider from those bindings, so the
 * base URL here is what actually decides where the Planner call goes.
 */
function userToml(baseUrl, model) {
  return [
    'schemaVersion = 1',
    '',
    '[provider]',
    'provider = "rcc"',
    'binding = "rcc-entry"',
    'protocol = "responses"',
    `model = "${model}"`,
    'route = "default"',
    `baseUrl = "${baseUrl}"`,
    '',
    '[[agents]]',
    'agentId = "interaction-default"',
    'roleId = "interaction"',
    'templateRef = "builtin/interaction@1.0.0"',
    'driverRef = "fake"',
    'skills = ["input-normalization", "task-matching", "confirmation"]',
    'tools = ["input.receive", "task.query", "proposal.render"]',
    'permissions = ["task.read", "task.propose"]',
    'memoryScopes = ["task", "organ", "approved-global"]',
    'resourceClass = "foreground"',
    '',
    '[[agents]]',
    'agentId = "orchestration-default"',
    'roleId = "orchestration"',
    'templateRef = "builtin/orchestration@1.0.0"',
    'driverRef = "fake"',
    'skills = ["stage-planning", "resource-planning", "result-checking"]',
    'tools = ["task.query", "queue.query", "assignment.create", "result.submit"]',
    'permissions = ["task.read", "assignment.create", "review.schedule"]',
    'memoryScopes = ["task", "organ", "approved-global"]',
    'resourceClass = "background"',
    '',
    '[project]',
    'defaultAgent = "interaction-default"',
    'reviewRequired = true',
    '',
    '[execution]',
    'maxConcurrentTasks = 1',
    'stopTimeoutMs = 30000',
    '',
  ].join('\n');
}

async function runCase(root, snapshot, expectations) {
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'control'), { recursive: true });
  const upstream = await startScriptedUpstream(snapshot);
  await writeFile(join(root, 'control', 'config.toml'), userToml(upstream.url, MODEL), 'utf8');
  const serve = startServe(root, upstream.url);
  try {
    const launched = await serve.ready;
    const task = await startTask(launched.url, expectations.title, 'Reply with exactly: OK');
    const dashboard = await waitForTerminal(launched.url, task.taskId, TERMINAL_TIMEOUT_MS);
    const result = {
      taskId: task.taskId,
      operationId: task.operationId,
      grantState: task.grantState,
      state: dashboard.state,
      elapsedMs: Date.now() - task.startedAtMs,
      output: dashboard.output ?? null,
      error: dashboard.error ?? null,
      upstream: { executionCalls: upstream.state.executionCalls, plannerCalls: upstream.state.plannerCalls },
    };
    if (result.upstream.plannerCalls < 1 && dashboard.state !== 'succeeded') {
      throw new Error(`the closed-turn Planner was never called for ${expectations.title}: ${JSON.stringify(result)}`);
    }
    expectations.verify(result);
    return result;
  } finally {
    await serve.stop();
    await upstream.close();
  }
}

async function main() {
  const only = (process.env.PHASE_MEMBERSHIP_CASES ?? 'a,b').split(',').map((v) => v.trim()).filter(Boolean);
  const root = await mkdtemp(join(tmpdir(), 'humanagent-phase-membership-'));
  const receipt = { instance: root, model: MODEL };
  try {
    if (only.includes('a')) {
    phase('case A: Planner omits node phaseId while the phase claims the nodes');
    receipt.a = await runCase(join(root, 'a'), oneSidedSnapshot, {
      title: 'one-sided phase membership',
      verify(result) {
        if (result.state !== 'succeeded') {
          throw new Error(`case A must settle succeeded after real success: ${JSON.stringify(result)}`);
        }
        if (result.output !== 'OK') {
          throw new Error(`case A must keep the delivered output: ${JSON.stringify(result)}`);
        }
        if (result.error !== null && result.error !== undefined) {
          throw new Error(`case A must not carry a settlement error: ${JSON.stringify(result)}`);
        }
      },
    });
    receipt.a.planRevisions = await planRevisionCount(join(root, 'a'));
    if (receipt.a.planRevisions !== 1) {
      throw new Error(`case A must publish exactly one plan revision: ${JSON.stringify(receipt.a)}`);
    }
    phase(`case A settled succeeded with output ${JSON.stringify(receipt.a.output)}`);
    }

    if (only.includes('b')) {

    phase('case B: Planner declares a node phaseId the claiming phase does not match');
    receipt.b = await runCase(join(root, 'b'), conflictingSnapshot, {
      title: 'conflicting phase membership',
      verify(result) {
        if (result.state !== 'blocked') {
          throw new Error(`case B must keep failing instead of fabricating success: ${JSON.stringify(result)}`);
        }
        if (result.error?.message !== ORIGINAL_ERROR) {
          throw new Error(`case B must keep the original validation text: ${JSON.stringify(result)}`);
        }
        if (result.error?.code !== 'runtime.execution.failure' || result.error?.retryable !== false) {
          throw new Error(`case B must keep the production error shape: ${JSON.stringify(result)}`);
        }
      },
    });
    receipt.b.planRevisions = await planRevisionCount(join(root, 'b'));
    if (receipt.b.planRevisions !== 0) {
      throw new Error(`case B must not publish a rejected plan revision: ${JSON.stringify(receipt.b)}`);
    }
    phase('case B kept the original error and published no plan revision');
    }

    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (process.env.PHASE_MEMBERSHIP_KEEP_ROOT !== '1') await rm(root, { recursive: true, force: true });
    else process.stderr.write(`[phase-membership] kept root ${root}
`);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
