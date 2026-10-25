#!/usr/bin/env node
/**
 * Real parent-turn reconciliation recovery black box.
 *
 * Production failure under proof: one explicit-intake turn is owned by a daemon
 * that is killed mid-Provider-stream. A later generation takes the lease over,
 * the user retries the exact same input, so the raw owner commits an
 * `owner-reconciliation` in `continue` mode and opens the next physical epoch —
 * and that continued epoch is killed too, before any terminal output. From then
 * on every new explicit input in the scope was refused forever:
 *
 *   unclosed interaction parent turn ... requires its exact prior input before
 *   new input; it cannot be discharged: an owner reconciliation is committed
 *
 * The reproduction uses no hand-written journal data at all:
 *
 *   1. generation 1 (`first`) serves the real UI runtime assembly, takes one
 *      explicit input and is SIGKILLed while its Provider SSE stream is still
 *      live, so the parent turn stays open with no terminal output;
 *   2. generation 2 (`retry`) takes the lease over and re-sends that exact same
 *      input, which is the real reconciliation lane: the agent commits an
 *      `owner-reconciliation` with mode `continue` and effective epoch 2, then
 *      dies inside the continued epoch's stream without a terminal output;
 *   3. generation 3 (`serve`) takes the lease over again and must serve a NEW
 *      input: HTTP 2xx with a confirmable draft, while the disk journal must
 *      show the old turn closed by its own committed `turn-execution-failure`
 *      for the continued epoch, never by a fabricated abandonment or a
 *      fabricated resource close.
 *
 * Everything except the external Provider upstream is the real runtime: the
 * lease, the takeover receipts, the journals, the HTTP API, the Provider adapter
 * and the transport. Nothing touches the shared production instance on 10086:
 * the control root, workspace, journals and port belong to this run.
 *
 * Usage: node tests/app/parent-turn-reconciliation-blackbox.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
// Progress goes to stderr so the stdout receipt stays a single JSON document.
const phase = (message) => process.stderr.write(`[parent-turn-reconciliation] ${message}\n`);
const firstInput = '第一次输入会死在流里';
const nextInput = '恢复之后的新输入';
const draftTitle = '恢复后的可确认草稿';

phase('starting');
const root = await mkdtemp(join(tmpdir(), 'humanagent-parent-turn-reconciliation-'));
await mkdir(join(root, 'workspace'), { recursive: true });
await mkdir(join(root, 'control'), { recursive: true });

const sse = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
const requirement = JSON.stringify({
  kind: 'requirement',
  normalizedInput: nextInput,
  knownFacts: [],
  decisionRefs: [],
  proposal: {
    revision: 1,
    intent: 'create',
    title: draftTitle,
    objective: '验证恢复后新的显式输入可以产生可确认草稿',
    deliverable: '一个可确认的显式草稿',
    deliveryConditions: [],
    evidenceRefs: [],
    blockingGaps: [],
  },
});

let upstreamRequests = 0;
const upstream = createServer(async (request, response) => {
  for await (const _discard of request) { /* drain the request body */ }
  upstreamRequests += 1;
  const index = upstreamRequests;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (index === 1 || index === 2) {
    // The first stream is the turn-input epoch, the second is the reconciled
    // continuation epoch. Both accept one durable reasoning unit and then never
    // finish: the daemon is killed while this stream is still live.
    response.write(sse([
      { type: 'response.created', response: { id: `parent-turn-reconciliation-${index}` } },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: `rs-parent-turn-${index}`,
        delta: index === 1 ? '第一个 epoch 死之前的推理' : '续 epoch 死之前的推理',
      },
    ]));
    return;
  }
  response.write(sse([
    { type: 'response.created', response: { id: `parent-turn-reconciliation-${index}` } },
    { type: 'response.output_text.done', item_id: 'final', text: requirement },
    { type: 'response.completed', response: { id: `parent-turn-reconciliation-${index}` } },
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
  const child = spawn(process.execPath, [join(process.cwd(), 'tests/app/parent-turn-reconciliation-blackbox-worker.mjs')], {
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
/** Every durable fact of this run, paired with the record payload it came from. */
const journalEntries = async () => {
  const entries = [];
  for (const path of await journalPaths()) {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const payload = deepFind(parsed, (value) => typeof value.discriminant === 'string');
      if (payload !== undefined) entries.push({ path: path.slice(root.length + 1), line, payload });
    }
  }
  return entries;
};
const factsOf = async (discriminant) => (await journalEntries())
  .filter((entry) => entry.payload.discriminant === discriminant);

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

/**
 * Everything the recovery decision depends on, read straight off the disk
 * journal instead of from the daemon that wrote it.
 */
const scanDurable = async (turnId) => {
  const entries = await journalEntries();
  const ofTurn = (entry) => entry.payload.turn?.turnId === turnId;
  const reconciliations = entries
    .filter((entry) => entry.payload.discriminant === 'owner-reconciliation' && ofTurn(entry))
    .map((entry) => ({
      mode: entry.payload.fact.mode,
      effectiveExecutionEpoch: entry.payload.fact.effectiveExecutionEpoch,
      previousGeneration: entry.payload.fact.previousOwner.daemonGeneration,
      replacementGeneration: entry.payload.fact.replacementOwner.daemonGeneration,
      unsettledRequestIds: entry.payload.fact.unsettledRequestIds,
    }));
  const executionFailures = entries
    .filter((entry) => entry.payload.discriminant === 'turn-execution-failure' && ofTurn(entry))
    .map((entry) => ({
      executionEpoch: entry.payload.fact.execution.executionEpoch,
      failedAt: entry.payload.fact.failedAt,
    }));
  const acceptedFactEpochs = entries
    .filter((entry) => entry.payload.discriminant === 'accepted-fact' && ofTurn(entry))
    .map((entry) => entry.payload.execution.executionEpoch);
  const requestPhases = entries
    .filter((entry) => entry.payload.discriminant === 'request' && ofTurn(entry))
    .map((entry) => entry.payload.record.phase);
  const requestCompleteForTurn = entries
    .filter((entry) => entry.payload.discriminant === 'accepted-fact' && ofTurn(entry)
      && entry.payload.entry?.envelope?.fact?.kind === 'request-complete').length;
  const assistantTextForTurn = entries
    .filter((entry) => entry.payload.discriminant === 'accepted-fact' && ofTurn(entry)
      && entry.payload.entry?.envelope?.fact?.kind === 'content'
      && entry.payload.entry?.envelope?.fact?.channel === 'assistant-text').length;
  return {
    journals: [...new Set(entries.map((entry) => entry.path))].sort(),
    turnId,
    reconciliations,
    executionFailures,
    abandonments: entries.filter((entry) => entry.payload.discriminant === 'turn-abandonment' && ofTurn(entry)).length,
    parseFailures: entries.filter((entry) => entry.payload.discriminant === 'turn-parse-failure' && ofTurn(entry)).length,
    resourceCloses: entries.filter((entry) => entry.payload.discriminant === 'resource-close' && ofTurn(entry)).length,
    providerSettlements: entries.filter((entry) => entry.payload.discriminant === 'provider-settlement' && ofTurn(entry)).length,
    acceptedFactEpochs: [...new Set(acceptedFactEpochs)].sort(),
    acceptedFacts: acceptedFactEpochs.length,
    requestPhases,
    requestCompleteForTurn,
    assistantTextForTurn,
  };
};
const waitFor = async (probe, description, deadlineMs = 30_000) => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(100);
  }
};

const receipt = { instance: root, provider: upstreamUrl };
try {
  // ---- Generation 1: a real turn whose stream dies with its daemon --------
  phase('generation 1: first');
  const first = await startWorker('first');
  if (first.info.generation !== 1) throw new Error('the first worker must own generation 1');
  receipt.first = { generation: first.info.generation, origin: first.info.origin };
  const firstCookie = await pair(first.info.origin, first.info.pairingCode);
  const created = await call(first.info.origin, firstCookie, '/api/explicit/inputs', {
    channel: 'business', sourceRef: 'blackbox:parent-turn-reconciliation-first', rawInput: firstInput,
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`the first input create failed: ${JSON.stringify(created)}`);
  }
  const interactionId = created.body?.interactionId;
  if (typeof interactionId !== 'string') throw new Error(`first input create returned no interaction: ${JSON.stringify(created)}`);
  // Fire the interpret without awaiting it: the daemon dies inside this stream.
  const inFlight = call(first.info.origin, firstCookie,
    `/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {}).catch(() => undefined);
  const turnId = await waitFor(async () => {
    const entry = (await factsOf('turn-input')).find((candidate) => candidate.line.includes(interactionId));
    return entry?.payload.turn?.turnId;
  }, 'the first turn input to commit');
  // Kill only after this exact turn accepted a real stream unit. A fixed sleep
  // could kill before dispatch and test a different failure than the incident.
  await waitFor(async () => {
    const entries = await factsOf('accepted-fact');
    return entries.some((entry) => entry.payload.turn?.turnId === turnId) ? true : undefined;
  }, 'the first stream to accept a durable unit');
  process.kill(first.child.pid, 'SIGKILL');
  await waitClosed(first.child);
  await inFlight;
  receipt.first.interactionId = interactionId;
  receipt.first.turnId = turnId;
  receipt.first.durable = await scanDurable(turnId);

  const stranded = receipt.first.durable;
  if (stranded.reconciliations.length !== 0) throw new Error('a killed daemon cannot reconcile its own owner');
  if (stranded.executionFailures.length !== 0) throw new Error('a killed daemon cannot close its own epoch');
  if (stranded.abandonments !== 0) throw new Error('a killed daemon cannot discharge its own turn');
  if (stranded.requestCompleteForTurn !== 0) throw new Error('the killed stream must not have completed');
  if (stranded.resourceCloses !== 0) throw new Error('the killed stream must not have closed its provider');
  phase(`turn ${turnId} is durable and its daemon is dead`);

  // ---- Generation 2: the real reconciliation lane, killed again -----------
  phase('generation 2: retry the exact same input');
  const retry = await startWorker('retry');
  if (retry.info.generation !== 2) throw new Error('the second worker must own generation 2');
  receipt.retry = { generation: retry.info.generation, origin: retry.info.origin };
  const retryCookie = await pair(retry.info.origin, retry.info.pairingCode);
  const retryInFlight = call(retry.info.origin, retryCookie,
    `/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {}).catch(() => undefined);
  const reconciliation = await waitFor(async () => (await scanDurable(turnId)).reconciliations[0], 'the owner reconciliation to commit');
  // Kill inside the continued epoch, after it accepted a durable unit and before
  // any terminal output could exist.
  await waitFor(async () => {
    const entries = await factsOf('accepted-fact');
    return entries.some((entry) => entry.payload.turn?.turnId === turnId
      && entry.payload.execution.executionEpoch === reconciliation.effectiveExecutionEpoch) ? true : undefined;
  }, 'the continued epoch to accept a durable unit');
  process.kill(retry.child.pid, 'SIGKILL');
  await waitClosed(retry.child);
  await retryInFlight;
  receipt.retry.reconciliation = reconciliation;
  receipt.retry.durable = await scanDurable(turnId);

  const reconciled = receipt.retry.durable;
  if (reconciled.reconciliations.length !== 1) throw new Error('the retry must commit exactly one owner reconciliation');
  if (reconciled.reconciliations[0]?.mode !== 'continue') {
    throw new Error(`the retry must open the continuation lane, got ${String(reconciled.reconciliations[0]?.mode)}`);
  }
  if (reconciled.reconciliations[0]?.effectiveExecutionEpoch !== 2) {
    throw new Error('the continuation lane must open physical epoch 2');
  }
  if (reconciled.executionFailures.length !== 0) throw new Error('a killed daemon cannot close its own continued epoch');
  if (reconciled.abandonments !== 0) throw new Error('the continued epoch must not be discharged as abandonment');
  if (reconciled.requestCompleteForTurn !== 0) throw new Error('the continued stream must not have completed');
  if (reconciled.resourceCloses !== 0) throw new Error('the continued stream must not have closed its provider');
  phase(`reconciliation committed (continue, epoch ${String(reconciled.reconciliations[0]?.effectiveExecutionEpoch)}) and the continued epoch is dead`);

  // ---- Generation 3: a new input must be served ---------------------------
  phase('generation 3: serve a new input');
  const serve = await startWorker('serve');
  if (serve.info.generation !== 3) throw new Error('the third worker must own generation 3');
  receipt.serve = { generation: serve.info.generation, origin: serve.info.origin };
  const serveCookie = await pair(serve.info.origin, serve.info.pairingCode);
  const next = await call(serve.info.origin, serveCookie, '/api/explicit/inputs', {
    channel: 'business', sourceRef: 'blackbox:parent-turn-reconciliation-next', rawInput: nextInput,
  });
  const interpreted = await call(serve.info.origin, serveCookie,
    `/api/explicit/interactions/${encodeURIComponent(next.body?.interactionId)}/interpret`, {});
  receipt.next = {
    createStatus: next.status,
    interactionId: next.body?.interactionId,
    interpretStatus: interpreted.status,
    state: interpreted.body?.state,
    draftTitle: interpreted.body?.revision?.title,
    draftProposal: interpreted.body?.draft?.proposal,
    errorCode: interpreted.body?.error?.code,
    errorMessage: interpreted.body?.error?.message,
  };
  receipt.durable = await scanDurable(turnId);

  const lease = JSON.parse(await readFile(await leasePath(), 'utf8'));
  receipt.lease = {
    generation: lease.generation,
    terminatedGenerations: (lease.terminations ?? []).map((entry) => entry.previousGeneration),
  };

  if (receipt.next.interpretStatus !== 200) {
    throw new Error(`the new input did not interpret: ${JSON.stringify(receipt.next)}`);
  }
  if (receipt.next.state !== 'awaiting-confirmation') {
    throw new Error(`the new input did not produce a confirmable draft: ${JSON.stringify(receipt.next)}`);
  }
  if (typeof receipt.next.draftProposal !== 'string' || !receipt.next.draftProposal.includes(draftTitle)) {
    throw new Error(`the confirmable draft does not carry the interpreted proposal: ${JSON.stringify(receipt.next)}`);
  }
  if (receipt.durable.executionFailures.length !== 1) {
    throw new Error(`the dead reconciled epoch must be closed exactly once: ${JSON.stringify(receipt.durable.executionFailures)}`);
  }
  if (receipt.durable.executionFailures[0].executionEpoch !== 2) {
    throw new Error(`the closure must name the continued epoch, got ${String(receipt.durable.executionFailures[0].executionEpoch)}`);
  }
  if (receipt.durable.abandonments !== 0) throw new Error('the recovered turn must not be discharged as abandonment');
  if (receipt.durable.parseFailures !== 0) throw new Error('the recovered turn must not be closed as unparseable');
  if (receipt.durable.resourceCloses !== 0) throw new Error('the recovered turn must not invent a resource close');
  if (receipt.durable.providerSettlements !== 0) throw new Error('the recovered turn must not invent a provider settlement');
  if (!receipt.lease.terminatedGenerations.includes(1) || !receipt.lease.terminatedGenerations.includes(2)) {
    throw new Error('the lease did not retain both termination receipts');
  }
  console.log(JSON.stringify({ ...receipt, outcome: 'reconciled-turn-recovered-across-two-generations' }, null, 2));
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
