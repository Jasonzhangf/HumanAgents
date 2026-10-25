#!/usr/bin/env node
/**
 * Real stranded-turn generation black box.
 *
 * Production failure under proof: a crashed explicit-intake turn stays stranded
 * forever once the daemon advances more than one generation, because the lease
 * kept exactly one takeover receipt. The reproduction here uses no hand-written
 * data at all:
 *
 *   1. generation 1 (child `strand`) serves the real UI runtime assembly, takes
 *      one explicit input and is SIGKILLed while the Provider SSE stream is
 *      still live, so the parent turn stays open with no terminal output;
 *   2. generation 2 (child `crash`) takes the lease over and exits without
 *      releasing it;
 *   3. generation 3 (child `serve`) takes the lease over again and must serve a
 *      new input on its own, with a correct answer and a single honest
 *      abandonment fact for the stranded turn.
 *
 * Everything except the external Provider upstream is the real runtime: the
 * lease, the takeover receipts, the journals, the HTTP API, the Provider
 * adapter and the transport. Nothing touches the shared production instance on
 * 10086: the control root, workspace, journals and port belong to this run.
 *
 * Usage: node tests/app/stranded-turn-generation-blackbox.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
// Progress goes to stderr so the stdout receipt stays a single JSON document.
const phase = (message) => process.stderr.write(`[stranded-generation] ${message}\n`);
const answerText = '换代后的正确答案 42';
const strandedInput = '会被杀掉的第一条输入';
const nextInput = '换代后的新输入';

phase('starting');
const root = await mkdtemp(join(tmpdir(), 'humanagent-stranded-generation-'));
await mkdir(join(root, 'workspace'), { recursive: true });
await mkdir(join(root, 'control'), { recursive: true });

const sse = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
const decision = JSON.stringify({
  kind: 'answer',
  normalizedInput: nextInput,
  knownFacts: [],
  answer: answerText,
  decisionRefs: [],
});

let upstreamRequests = 0;
const upstream = createServer(async (request, response) => {
  for await (const _discard of request) { /* drain the request body */ }
  upstreamRequests += 1;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (upstreamRequests === 1) {
    // The first physical stream accepts one durable reasoning unit and never
    // finishes: the daemon is killed while this stream is still live.
    response.write(sse([
      { type: 'response.created', response: { id: 'stranded-generation-1' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs-stranded', delta: '被杀掉之前的第一段推理' },
    ]));
    return;
  }
  response.write(sse([
    { type: 'response.created', response: { id: `stranded-generation-${upstreamRequests}` } },
    { type: 'response.output_text.done', item_id: 'final', text: decision },
    { type: 'response.completed', response: { id: `stranded-generation-${upstreamRequests}` } },
  ]));
  response.end();
});
const upstreamUrl = await new Promise((settle, fail) => {
  upstream.once('error', fail);
  upstream.listen(0, '127.0.0.1', () => settle(`http://127.0.0.1:${upstream.address().port}`));
});

const children = [];
const waitClosed = (child) => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve() : new Promise((settle) => child.once('close', settle));
const startWorker = async (role) => {
  const child = spawn(process.execPath, [join(process.cwd(), 'tests/app/stranded-turn-generation-blackbox-worker.mjs')], {
    env: {
      ...process.env,
      HUMANAGENT_BLACKBOX_ROLE: role,
      HUMANAGENT_BLACKBOX_ROOT: root,
      HUMANAGENT_BLACKBOX_UPSTREAM: upstreamUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + 60_000;
  while (!stdout.includes('BLACKBOX ') && Date.now() < deadline) await sleep(50);
  const line = stdout.split('\n').find((entry) => entry.startsWith('BLACKBOX '));
  if (line === undefined) throw new Error(`${role} worker never announced: ${stderr}`);
  return { child, info: JSON.parse(line.slice('BLACKBOX '.length)), stderr: () => stderr };
};

const pair = async (origin, code) => {
  const paired = await fetch(`${origin}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (paired.status !== 200) throw new Error(`pairing failed: ${paired.status} ${await paired.text()}`);
  return (paired.headers.get('set-cookie') ?? '').split(';')[0];
};
const call = async (origin, cookie, path, body) => {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
};

const journalPaths = async () => {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (entry.name.endsWith('.jsonl')) found.push(path);
    }
  };
  await walk(root).catch(() => {});
  return found;
};
const journalEntries = async () => {
  const entries = [];
  for (const path of await journalPaths()) {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      entries.push({ path: path.slice(root.length + 1), line, parsed });
    }
  }
  return entries;
};
const deepFind = (value, predicate) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFind(item, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    if (predicate(value)) return value;
    for (const item of Object.values(value)) {
      const hit = deepFind(item, predicate);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
};
const factsOf = async (kind) => (await journalEntries())
  .filter((entry) => entry.line.includes(kind));

const leasePath = async () => {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (entry.name === 'lease.json') found.push(path);
    }
  };
  await walk(join(root, 'control')).catch(() => {});
  if (found.length !== 1) throw new Error(`expected one lease file, found ${found.length}`);
  return found[0];
};

const receipt = { instance: root, provider: upstreamUrl };
try {
  // Generation 1: the stranded turn.
  phase('generation 1: strand');
  const strand = await startWorker('strand');
  receipt.strand = { generation: strand.info.generation, origin: strand.info.origin };
  if (strand.info.generation !== 1) throw new Error('the first worker must own generation 1');
  const strandCookie = await pair(strand.info.origin, strand.info.pairingCode);
  const first = await call(strand.info.origin, strandCookie, '/api/explicit/inputs', {
    channel: 'business', sourceRef: 'blackbox:stranded-first', rawInput: strandedInput,
  });
  if (first.status === undefined) throw new Error('the first input was not created');
  const interactionId = first.body?.interactionId;
  if (typeof interactionId !== 'string') throw new Error(`first input create failed: ${JSON.stringify(first)}`);
  // Fire the interpret without awaiting it: the daemon dies inside this stream.
  const inFlight = call(strand.info.origin, strandCookie,
    `/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {}).catch(() => undefined);

  let strandedTurnId;
  const deadline = Date.now() + 30_000;
  while (strandedTurnId === undefined && Date.now() < deadline) {
    const entry = (await factsOf('turn-input')).find((candidate) => candidate.line.includes(interactionId));
    if (entry !== undefined) {
      const turn = deepFind(entry.parsed, (value) => typeof value.turnId === 'string'
        && typeof value.interactionId === 'string' && value.interactionId === interactionId);
      strandedTurnId = turn?.turnId;
    }
    if (strandedTurnId === undefined) await sleep(100);
  }
  if (strandedTurnId === undefined) throw new Error('the stranded turn input was never committed');
  // Kill only after this exact turn accepted a real stream unit. A fixed sleep
  // could kill before dispatch and test a different failure than the incident.
  while (!(await factsOf('accepted-fact')).some((entry) => entry.line.includes(strandedTurnId))) {
    if (Date.now() >= deadline) throw new Error('the stranded stream never committed a unit');
    await sleep(100);
  }
  process.kill(strand.child.pid, 'SIGKILL');
  await waitClosed(strand.child);
  await inFlight;
  receipt.strand.turnId = strandedTurnId;
  receipt.strand.interactionId = interactionId;
  const beforeRelaunch = await scanDurable();
  receipt.beforeRelaunch = beforeRelaunch;
  if (beforeRelaunch.requestComplete > 0) throw new Error('the killed stream must not have completed');
  if (beforeRelaunch.abandonments !== 0) throw new Error('a killed daemon cannot discharge its own turn');
  if (beforeRelaunch.executionFailures !== 0) throw new Error('a killed daemon cannot close its own epoch');

  phase(`stranded turn ${strandedTurnId} is durable and its daemon is dead`);
  // Generation 2: a real takeover that exits without releasing.
  const crash = await startWorker('crash');
  receipt.crash = { generation: crash.info.generation };
  if (crash.info.generation !== 2) throw new Error('the second worker must own generation 2');
  await waitClosed(crash.child);

  // Generation 3: the takeover that must serve the next input without any manual
  // data edit, even though the stranded owner is two generations back.
  phase('generation 3: serve');
  const serve = await startWorker('serve');
  receipt.serve = { generation: serve.info.generation, origin: serve.info.origin };
  if (serve.info.generation !== 3) throw new Error('the third worker must own generation 3');
  const serveCookie = await pair(serve.info.origin, serve.info.pairingCode);
  const created = await call(serve.info.origin, serveCookie, '/api/explicit/inputs', {
    channel: 'business', sourceRef: 'blackbox:stranded-next', rawInput: nextInput,
  });
  const interpreted = await call(serve.info.origin, serveCookie,
    `/api/explicit/interactions/${encodeURIComponent(created.body?.interactionId)}/interpret`, {});
  receipt.next = {
    createStatus: created.status,
    interpretStatus: interpreted.status,
    state: interpreted.body?.state,
    reply: interpreted.body?.reply,
    errorCode: interpreted.body?.error?.code,
    errorMessage: interpreted.body?.error?.message,
  };

  const lease = JSON.parse(await readFile(await leasePath(), 'utf8'));
  receipt.lease = {
    generation: lease.generation,
    retainedGenerations: (lease.terminations ?? []).map((entry) => entry.previousGeneration),
    terminations: (lease.terminations ?? []).map((entry) => ({
      previousGeneration: entry.previousGeneration,
      termination: entry.termination,
    })),
  };
  const afterRelaunch = await scanDurable();
  receipt.durable = afterRelaunch;

  if (receipt.next.interpretStatus !== 200) {
    throw new Error(`the new input did not interpret: ${JSON.stringify(receipt.next)}`);
  }
  if (!String(receipt.next.reply ?? '').includes(answerText)) {
    throw new Error(`the new input produced the wrong answer: ${JSON.stringify(receipt.next)}`);
  }
  if (afterRelaunch.abandonments !== 1) throw new Error('the stranded turn must be discharged exactly once');
  if (afterRelaunch.executionFailures !== 0) throw new Error('the fix must not fabricate an execution failure');
  if (afterRelaunch.parseFailures !== 0) throw new Error('the fix must not fabricate a parse failure');
  if (!afterRelaunch.abandonedTurnIds.includes(strandedTurnId)) {
    throw new Error('the discharge must name the stranded turn');
  }
  if (lease.generation !== 3) throw new Error('the lease generation is not the expected one');
  if (!receipt.lease.retainedGenerations.includes(1) || !receipt.lease.retainedGenerations.includes(2)) {
    throw new Error('the lease did not retain both termination receipts');
  }
  console.log(JSON.stringify({ ...receipt, outcome: 'stranded-turn-recovered-across-two-generations' }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error(JSON.stringify({ ...receipt, failure: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitClosed(child);
    }
  }
  await new Promise((settle) => upstream.close(settle));
  await rm(root, { recursive: true });
  console.log(JSON.stringify({ cleanup: 'owned children exited and temporary root removed', root }));
}

async function scanDurable() {
  const entries = await journalEntries();
  const abandonedTurnIds = [];
  for (const entry of entries.filter((candidate) => candidate.line.includes('turn-abandonment'))) {
    const turn = deepFind(entry.parsed, (value) => typeof value.turnId === 'string');
    if (turn?.turnId !== undefined && !abandonedTurnIds.includes(turn.turnId)) abandonedTurnIds.push(turn.turnId);
  }
  return {
    journals: [...new Set(entries.map((entry) => entry.path))],
    abandonments: entries.filter((entry) => entry.line.includes('turn-abandonment')).length,
    abandonedTurnIds,
    executionFailures: entries.filter((entry) => entry.line.includes('turn-execution-failure')).length,
    parseFailures: entries.filter((entry) => entry.line.includes('turn-parse-failure')).length,
    requestComplete: entries.filter((entry) => entry.line.includes('request-complete')).length,
  };
}
