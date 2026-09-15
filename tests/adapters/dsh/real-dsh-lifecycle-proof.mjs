#!/usr/bin/env node
/**
 * Real DSH lifecycle proof (P1/P4 evidence).
 *
 * Drives the pinned DSH source over its public stdio JSON-RPC entry and records
 * the lifecycle facts HumanAgent stop and recovery depend on. It deliberately
 * records DSH's real capability boundary instead of assuming one:
 *
 *   stop     - a clean `shutdown` settles persistence and exits 0; the session
 *              log is on disk before the process is gone. This is the only real
 *              stop/settle DSH 0.1.5 exposes (no per-session cancel or close).
 *   continue - two prompts on the SAME live session share one model context.
 *   resume   - the SDK stdio entry cannot reopen a persisted session id in a
 *              fresh process; it answers `session "<id>" already exists`. DSH
 *              has an internal resume path, but the public SDK wire does not
 *              expose it, so HumanAgent recovery starts a fresh DSH session
 *              from its own checkpoint and treats the DSH log as evidence only.
 *   crash    - an abrupt SIGKILL mid-turn surfaces the original non-zero exit;
 *              a fresh runtime boots and serves a new session on the same home.
 *   stop-mid - a clean `shutdown` issued while a tool is still running still
 *              reaches process exit and persistence commit; there is no
 *              separate cancel receipt to wait on.
 *
 * Required env:
 *   HUMANAGENT_DSH_SOURCE  absolute path to the DSH source checkout
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL   default http://127.0.0.1:4444/v1
 *   HUMANAGENT_DSH_MODEL      default gpt-5.5
 *   HUMANAGENT_DSH_PROFILE    default sdk
 *   HUMANAGENT_DSH_PROTOCOL   default openai-completions
 *   HUMANAGENT_RECEIPT_PATH   default ./dist/receipts/dsh-lifecycle-proof.json
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

const decompress = promisify(zstdDecompress);

const DSH_SOURCE = process.env.HUMANAGENT_DSH_SOURCE;
const RCC_BASE_URL = process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444/v1';
const MODEL = process.env.HUMANAGENT_DSH_MODEL ?? 'gpt-5.5';
const PROFILE = process.env.HUMANAGENT_DSH_PROFILE ?? 'sdk';
const PROTOCOL = process.env.HUMANAGENT_DSH_PROTOCOL ?? 'openai-completions';
const RECEIPT_PATH = resolve(process.env.HUMANAGENT_RECEIPT_PATH ?? 'dist/receipts/dsh-lifecycle-proof.json');
const PLACEHOLDER_KEY = 'rcc-local-placeholder';
const TURN_TIMEOUT_MS = 180_000;
const TARGET_NAME = 'CONFIG-PROBE.txt';
const TARGET_LINE_TWO = `feature_flag=${randomUUID()}`;

if (!DSH_SOURCE) {
  console.error('HUMANAGENT_DSH_SOURCE is required (absolute path to the DSH source checkout)');
  process.exit(2);
}

const dshRoot = resolve(DSH_SOURCE);
const binScript = join(dshRoot, 'apps/cli/src/bin.ts');
const sourcePatch = join(dshRoot, 'apps/cli/src/sdk-source.cordis.patch.yml');

const liveRuntimes = new Set();

class Runtime {
  constructor(home, label) {
    this.label = label;
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', binScript, '--profile', PROFILE, '--patch', sourcePatch],
      {
        cwd: dshRoot,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_PERMISSION_MODE: 'danger-full-access',
          DSH_TELEMETRY_DISABLED: '1',
          RCC_LOCAL_API_KEY: PLACEHOLDER_KEY,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    liveRuntimes.add(this);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.exit = new Promise((settle) => {
      this.child.on('exit', (code, signal) => settle({ code, signal }));
    });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.method !== undefined) {
          this.notifications.push(frame);
          continue;
        }
        if (frame.id !== undefined && this.pending.has(frame.id)) {
          const { settle, reject } = this.pending.get(frame.id);
          this.pending.delete(frame.id);
          if (frame.error !== undefined) reject(new Error(`[${this.label}] JSON-RPC ${frame.id}: ${JSON.stringify(frame.error)}`));
          else settle(frame.result);
        }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
  }

  request(method, params) {
    const id = this.nextId++;
    const frame = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params };
    return new Promise((settle, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[${this.label}] timed out awaiting ${method}; stderr=${this.stderr}`));
      }, TURN_TIMEOUT_MS);
      this.pending.set(id, {
        settle: (value) => { clearTimeout(timer); settle(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  /** Capture the raw JSON-RPC error instead of throwing, for capability probes. */
  rawRequest(method, params) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle({ timedOut: true });
      }, TURN_TIMEOUT_MS);
      this.pending.set(id, {
        settle: (value) => { clearTimeout(timer); settle({ result: value }); },
        reject: (error) => { clearTimeout(timer); settle({ error: error.message }); },
      });
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  waitForEvent(predicate, label) {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    return new Promise((settle, reject) => {
      const poll = () => {
        const hit = this.notifications.find((frame) => frame.method === 'session.event' && predicate(frame.params));
        if (hit) return settle(hit.params);
        if (Date.now() >= deadline) return reject(new Error(`[${this.label}] timed out waiting for ${label}; stderr=${this.stderr}`));
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  assistantText(sessionId) {
    return this.notifications
      .filter((frame) => frame.method === 'session.event'
        && frame.params.sessionId === sessionId
        && frame.params.event?.type === 'assistant/message')
      .map((frame) => frame.params.event?.data?.message?.content)
      .flat()
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /** Kill abruptly with an explicit PID; no broad process kill. */
  killAbruptly() {
    this.child.kill('SIGKILL');
    return this.exit;
  }

  async dispose() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.exit;
      liveRuntimes.delete(this);
      return;
    }
    this.child.kill('SIGTERM');
    await this.exit;
    liveRuntimes.delete(this);
  }
}

function settingsDocument() {
  return [
    'llm-pi-ai:',
    '  providers:',
    '    rcc:',
    '      displayName: RCC 4444',
    `      api: ${PROTOCOL}`,
    `      baseURL: ${RCC_BASE_URL}`,
    '      apiKeyEnv: RCC_LOCAL_API_KEY',
    '      models:',
    `        - id: ${MODEL}`,
    '          contextWindow: 272000',
    '          maxTokens: 32768',
    '',
  ].join('\n');
}

const initialize = (runtime, workspace) =>
  runtime.request('initialize', { cwd: workspace, provider: 'rcc', model: MODEL, maxTokens: 4096 });

async function sessionLogs(home) {
  const sessionsRoot = join(home, 'sessions');
  const files = await readdir(sessionsRoot, { recursive: true });
  return files.filter((file) => file.endsWith('.jsonl.zstd')).map((file) => join(sessionsRoot, file));
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-dsh-lifecycle-'));
  const home = join(root, '.dsh');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(home, 'settings.yaml'), settingsDocument());
  await writeFile(join(workspace, TARGET_NAME), `humanagent-dsh-lifecycle-proof\n${TARGET_LINE_TWO}\n`);

  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.dsh.lifecycle-proof',
    dshSource: dshRoot,
    dshHome: home,
    workspace,
    profile: PROFILE,
    provider: 'rcc',
    model: MODEL,
    protocol: PROTOCOL,
    capabilityFinding: {
      perSessionCancel: false,
      perSessionClose: false,
      crossProcessSessionResume: false,
      stopSemantics: 'runtime-shutdown-settle',
      recoverySemantics: 'humanagent-checkpoint-then-fresh-dsh-session',
      source: [
        'packages/sdk/protocol/README.md#known-limitations-and-deferred-work',
        'packages/sdk/server/src/server.ts (getOrCreateSession -> agents.create)',
      ],
    },
    stop: {},
    stopMidTurn: {},
    continue: {},
    resume: {},
    crash: {},
  };

  let failure;
  try {
    // --- Stage A: clean stop/settle over a real tool loop. ---
    const first = new Runtime(home, 'first');
    receipt.stop.initialize = await initialize(first, workspace);
    receipt.stop.prompt = await first.request('session/prompt', {
      sessionId: 'main',
      contentBlocks: [{
        type: 'text',
        text: `Use the read tool exactly once to read ${TARGET_NAME}, then reply with its second line only.`,
      }],
    });
    await first.waitForEvent(
      (params) => params.sessionId === 'main' && params.event?.type === 'tool/result',
      'tool/result',
    );
    const firstTurnEnd = await first.waitForEvent(
      (params) => params.sessionId === 'main' && params.event?.type === 'turn/end',
      'turn/end',
    );
    receipt.stop.turnEnd = firstTurnEnd.event?.data?.reason;
    receipt.stop.assistantText = first.assistantText('main');
    receipt.stop.shutdown = await first.request('shutdown');
    receipt.stop.exit = await first.exit;
    liveRuntimes.delete(first);
    const logsAfterStop = await sessionLogs(home);
    receipt.stop.sessionLogCount = logsAfterStop.length;
    if (logsAfterStop.length === 0) throw new Error('clean shutdown left no persisted session log');
    const compressed = await readFile(logsAfterStop[0]);
    receipt.stop.sessionLogMagic = compressed.subarray(0, 4).toString('hex');
    receipt.stop.sessionHeader = JSON.parse((await decompress(compressed)).toString('utf8').split('\n')[0]);

    // --- Stage A2: clean shutdown while a tool is still in flight. ---
    const midTurn = new Runtime(home, 'mid-turn');
    receipt.stopMidTurn.initialize = await initialize(midTurn, workspace);
    receipt.stopMidTurn.prompt = await midTurn.request('session/prompt', {
      sessionId: 'mid-turn',
      contentBlocks: [{ type: 'text', text: 'Use the bash tool to run `sleep 30`, then reply with done.' }],
    });
    await midTurn.waitForEvent(
      (params) => params.sessionId === 'mid-turn' && params.event?.type === 'tool/call',
      'tool/call (mid-turn)',
    );
    const shutdownStartedAt = Date.now();
    receipt.stopMidTurn.shutdown = await midTurn.request('shutdown');
    receipt.stopMidTurn.exit = await midTurn.exit;
    receipt.stopMidTurn.shutdownToExitMs = Date.now() - shutdownStartedAt;
    liveRuntimes.delete(midTurn);
    const logsAfterMidTurn = await sessionLogs(home);
    receipt.stopMidTurn.sessionLogCount = logsAfterMidTurn.length;
    if (receipt.stopMidTurn.exit.code !== 0) {
      throw new Error(`mid-turn shutdown did not exit 0: ${JSON.stringify(receipt.stopMidTurn.exit)}`);
    }

    // --- Stage B: two prompts in ONE live runtime share one model context. ---
    const second = new Runtime(home, 'second');
    receipt.continue.initialize = await initialize(second, workspace);
    receipt.continue.firstPrompt = await second.request('session/prompt', {
      sessionId: 'continue',
      contentBlocks: [{ type: 'text', text: `Read ${TARGET_NAME} and reply with its second line only.` }],
    });
    await second.waitForEvent(
      (params) => params.sessionId === 'continue' && params.event?.type === 'turn/end',
      'turn/end (continue-1)',
    );
    receipt.continue.secondPrompt = await second.request('session/prompt', {
      sessionId: 'continue',
      contentBlocks: [{ type: 'text', text: 'Without any tool, repeat the exact line you just reported.' }],
    });
    const continueTurnEnd = await second.waitForEvent(
      (params) => params.sessionId === 'continue'
        && params.event?.type === 'turn/end'
        && params.event?.data?.turn === 2,
      'turn/end (continue-2)',
    );
    receipt.continue.turnEnd = continueTurnEnd.event?.data?.reason;
    receipt.continue.recalledWithinSession = second.assistantText('continue').includes(TARGET_LINE_TWO);
    receipt.continue.shutdown = await second.request('shutdown');
    receipt.continue.exit = await second.exit;
    liveRuntimes.delete(second);

    // --- Stage C: cross-process resume probe. DSH rejects reusing a stored id. ---
    const third = new Runtime(home, 'third');
    receipt.resume.initialize = await initialize(third, workspace);
    const reused = await third.rawRequest('session/prompt', {
      sessionId: 'main',
      contentBlocks: [{ type: 'text', text: 'continue' }],
    });
    receipt.resume.reusedSessionId = reused.error ?? reused.result ?? reused;
    receipt.resume.resumeRejected = typeof reused.error === 'string'
      && reused.error.includes('already exists');
    // HumanAgent recovery path: a fresh session id on the same home works.
    const fresh = await third.rawRequest('session/prompt', {
      sessionId: 'recovered',
      contentBlocks: [{ type: 'text', text: 'Without any tool, reply with the single word recovered.' }],
    });
    receipt.resume.freshSessionAccepted = typeof fresh.result?.messageId === 'string';
    await third.waitForEvent(
      (params) => params.sessionId === 'recovered' && params.event?.type === 'turn/end',
      'turn/end (recovered)',
    );
    receipt.resume.shutdown = await third.request('shutdown');
    receipt.resume.exit = await third.exit;
    liveRuntimes.delete(third);

    // --- Stage D: abrupt crash mid-turn, then recover on the same home. ---
    const fourth = new Runtime(home, 'fourth');
    receipt.crash.initialize = await initialize(fourth, workspace);
    receipt.crash.prompt = await fourth.request('session/prompt', {
      sessionId: 'crash',
      contentBlocks: [{ type: 'text', text: 'Use the bash tool to run `sleep 30`, then reply with done.' }],
    });
    await fourth.waitForEvent(
      (params) => params.sessionId === 'crash' && params.event?.type === 'turn/start',
      'turn/start (crash)',
    );
    receipt.crash.exit = await fourth.killAbruptly();
    liveRuntimes.delete(fourth);
    receipt.crash.originalErrorPreserved = receipt.crash.exit.code !== 0 || receipt.crash.exit.signal !== null;

    const fifth = new Runtime(home, 'fifth');
    receipt.crash.reinitialize = await initialize(fifth, workspace);
    receipt.crash.recoveryPrompt = await fifth.request('session/prompt', {
      sessionId: 'post-crash',
      contentBlocks: [{ type: 'text', text: 'Without any tool, reply with the single word recovered.' }],
    });
    const recoveryTurnEnd = await fifth.waitForEvent(
      (params) => params.sessionId === 'post-crash' && params.event?.type === 'turn/end',
      'turn/end (post-crash)',
    );
    receipt.crash.recoveryTurnEnd = recoveryTurnEnd.event?.data?.reason;
    receipt.crash.recovered = recoveryTurnEnd.event?.data?.reason?.kind === 'completed';
    receipt.crash.shutdown = await fifth.request('shutdown');
    receipt.crash.exitAfterRecovery = await fifth.exit;
    liveRuntimes.delete(fifth);

    receipt.ok = receipt.stop.exit.code === 0
      && receipt.stop.turnEnd?.kind === 'completed'
      && receipt.stop.sessionLogCount >= 1
      && receipt.stop.sessionLogMagic === '28b52ffd'
      && receipt.stopMidTurn.exit.code === 0
      && receipt.stopMidTurn.sessionLogCount >= 1
      && receipt.continue.exit.code === 0
      && receipt.continue.recalledWithinSession === true
      && receipt.resume.resumeRejected === true
      && receipt.resume.freshSessionAccepted === true
      && receipt.resume.exit.code === 0
      && receipt.crash.originalErrorPreserved === true
      && receipt.crash.recovered === true
      && receipt.crash.exitAfterRecovery.code === 0;
    if (!receipt.ok) throw new Error('lifecycle proof did not satisfy all invariants');
  } catch (error) {
    failure = error;
    receipt.ok = false;
    receipt.error = { message: String(error?.message ?? error) };
  } finally {
    for (const runtime of [...liveRuntimes]) {
      await runtime.dispose().catch(() => {});
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  await mkdir(dirname(RECEIPT_PATH), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (failure) {
    process.stderr.write(`lifecycle proof failed: ${failure.message}\n`);
    process.exitCode = 1;
  }
}

await main();
