#!/usr/bin/env node
/**
 * Real DSH entry proof (P1).
 *
 * Boots the pinned DSH source checkout over its public out-of-process stdio
 * JSON-RPC entry, binds a hand-declared `openai-responses` provider route to a
 * live RCC 4444 endpoint, and drives one prompt through a real model -> tool ->
 * tool result -> same-session continuation loop before a clean shutdown.
 *
 * This is deliberately not a unit test: it depends on an external DSH source
 * tree and a live RCC listener, so it is an explicit, opt-in receipt generator.
 * It writes a JSON receipt to stdout and never falls back to a fake runtime.
 *
 * Required env:
 *   HUMANAGENT_DSH_SOURCE  absolute path to the DSH source checkout
 * Optional env:
 *   HUMANAGENT_RCC_BASE_URL  default http://127.0.0.1:4444/v1
 *   HUMANAGENT_DSH_MODEL     default gpt-5.5
 *   HUMANAGENT_DSH_PROFILE   default sdk
 *   HUMANAGENT_DSH_PROTOCOL  default openai-completions
 *   HUMANAGENT_RECEIPT_PATH  default ./dist/receipts/dsh-entry-proof.json
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
// RCC 4444's Responses endpoint reports tool calls with the non-standard terminal
// status `requires_action`, which pi-ai 0.85.1 refuses. Its chat-completions
// endpoint reports the standard `finish_reason: tool_calls`, so the entry proof
// binds that protocol by default.
const PROTOCOL = process.env.HUMANAGENT_DSH_PROTOCOL ?? 'openai-completions';
const RECEIPT_PATH = resolve(process.env.HUMANAGENT_RECEIPT_PATH ?? 'dist/receipts/dsh-entry-proof.json');
const PLACEHOLDER_KEY = 'rcc-local-placeholder';
const TURN_TIMEOUT_MS = 180_000;

if (!DSH_SOURCE) {
  console.error('HUMANAGENT_DSH_SOURCE is required (absolute path to the DSH source checkout)');
  process.exit(2);
}

const dshRoot = resolve(DSH_SOURCE);
const binScript = join(dshRoot, 'apps/cli/src/bin.ts');
// Clean source checkouts have no build-generated Typert contributor modules; the
// SDK JSON-RPC application does not consume them, so the checked-in source patch
// disables that loader row. It must be passed explicitly when launching from src.
const sourcePatch = join(dshRoot, 'apps/cli/src/sdk-source.cordis.patch.yml');

/** Newline-delimited JSON-RPC driver over one child's stdio. */
class JsonRpcDriver {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stdoutLines = [];
    this.stderr = '';
    this.exit = new Promise((resolveExit) => {
      child.on('exit', (code, signal) => resolveExit({ code, signal }));
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        this.stdoutLines.push(line);
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
          const { resolve: settle, reject } = this.pending.get(frame.id);
          this.pending.delete(frame.id);
          if (frame.error !== undefined) reject(new Error(`JSON-RPC ${frame.id} error: ${JSON.stringify(frame.error)}`));
          else settle(frame.result);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const frame = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params };
    return new Promise((settle, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out awaiting ${method} (id=${id}); stderr=${this.stderr}`));
      }, TURN_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); settle(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Resolve once a session.event notification matching the predicate arrives. */
  waitForEvent(predicate, label) {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    return new Promise((settle, reject) => {
      const poll = () => {
        const hit = this.notifications.find((frame) => frame.method === 'session.event' && predicate(frame.params));
        if (hit) {
          settle(hit.params);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${label}; stderr=${this.stderr}`));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  eventsOfType(type) {
    return this.notifications
      .filter((frame) => frame.method === 'session.event')
      .map((frame) => frame.params)
      .filter((params) => params.event?.type === type);
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

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-dsh-entry-'));
  const home = join(root, '.dsh');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(home, 'settings.yaml'), settingsDocument());

  // A per-run nonce makes a guessed answer incapable of satisfying the proof.
  const targetName = 'CONFIG-PROBE.txt';
  const targetSecondLine = `feature_flag=${randomUUID()}`;
  const targetBody = `humanagent-dsh-entry-proof\n${targetSecondLine}\n`;
  await writeFile(join(workspace, targetName), targetBody);

  const child = spawn(process.execPath, ['--import', 'tsx/esm', binScript, '--profile', PROFILE, '--patch', sourcePatch], {
    cwd: dshRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      RCC_LOCAL_API_KEY: PLACEHOLDER_KEY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = new JsonRpcDriver(child);

  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.dsh.entry-proof',
    dshSource: dshRoot,
    dshHome: home,
    workspace,
    profile: PROFILE,
    provider: 'rcc',
    model: MODEL,
    rccBaseUrl: RCC_BASE_URL,
    stages: {},
    events: [],
    persistence: {},
    exit: {},
  };

  let failure;
  try {
    const initialized = await rpc.request('initialize', {
      cwd: workspace,
      provider: 'rcc',
      model: MODEL,
      maxTokens: 4096,
    });
    receipt.stages.initialize = initialized;

    const prompt = await rpc.request('session/prompt', {
      sessionId: 'main',
      contentBlocks: [{
        type: 'text',
        text: `Use the read tool exactly once to read the file ${targetName} in the working directory,`
          + ' then reply with the exact contents of its second line and nothing else.'
          + ' The file contains a random value that can only be obtained by reading it.',
      }],
    });
    receipt.stages.prompt = prompt;

    const toolCall = await rpc.waitForEvent(
      (params) => params.sessionId === 'main' && params.event?.type === 'tool/call',
      'tool/call',
    );
    const toolResult = await rpc.waitForEvent(
      (params) => params.sessionId === 'main' && params.event?.type === 'tool/result',
      'tool/result',
    );
    const turnEnd = await rpc.waitForEvent(
      (params) => params.sessionId === 'main' && params.event?.type === 'turn/end',
      'turn/end',
    );
    receipt.stages.toolCall = toolCall.event;
    receipt.stages.toolResult = toolResult.event;
    receipt.stages.turnEnd = turnEnd.event;

    // Continuation proof: the assistant must produce a message after the tool
    // result within the same session, i.e. the model saw the tool output.
    const assistantMessages = rpc.eventsOfType('assistant/message');
    receipt.stages.assistantMessageCount = assistantMessages.length;
    const assistantText = assistantMessages
      .flatMap((params) => params.event?.data?.message?.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');

    const shutdown = await rpc.request('shutdown');
    receipt.stages.shutdown = shutdown;
    receipt.exit = await rpc.exit;

    const sessionsRoot = join(home, 'sessions');
    const files = await readdir(sessionsRoot, { recursive: true });
    const log = files.find((file) => file.endsWith('.jsonl.zstd'));
    if (log === undefined) throw new Error(`no session log persisted under ${sessionsRoot}`);
    const compressed = await readFile(join(sessionsRoot, log));
    const header = JSON.parse((await decompress(compressed)).toString('utf8').split('\n')[0]);
    receipt.persistence = {
      sessionLog: join(sessionsRoot, log),
      magic: compressed.subarray(0, 4).toString('hex'),
      sessionHeader: header,
    };

    const resultBlock = toolResult.event?.data?.message?.content?.find(
      (block) => block.type === 'tool-result',
    );
    // Continuation proof: the tool result must be followed by an assistant
    // message in a later step of the same turn, i.e. the model consumed the
    // tool output inside the same DSH session rather than a fresh request.
    const toolStep = toolCall.event?.data?.step;
    const continued = assistantMessages.some(
      (params) => params.event?.data?.turn === toolCall.event?.data?.turn
        && params.event?.data?.step > toolStep,
    );
    const ok = receipt.exit.code === 0
      && toolCall.event?.data?.name === 'read'
      && resultBlock?.toolCallId === toolCall.event?.data?.callId
      && resultBlock?.isError === false
      && continued
      && assistantText.includes(targetSecondLine)
      && receipt.stages.turnEnd?.data?.reason?.kind === 'completed';
    receipt.ok = ok;
    receipt.continuation = {
      toolCallId: toolCall.event?.data?.callId,
      toolStep,
      assistantMessageCount: assistantMessages.length,
      continuedAfterToolResult: continued,
      expectedSecondLine: targetSecondLine,
      observedExpectedSecondLine: assistantText.includes(targetSecondLine),
    };
    if (!ok) throw new Error('entry proof did not satisfy all invariants');
  } catch (error) {
    failure = error;
    receipt.ok = false;
    receipt.error = { message: String(error?.message ?? error), stderr: rpc.stderr };
  } finally {
    if (receipt.exit.code === undefined) {
      child.kill('SIGTERM');
      receipt.exit = await rpc.exit;
    }
  }

  receipt.events = rpc.notifications
    .filter((frame) => frame.method === 'session.event')
    .map((frame) => ({
      type: frame.params.event?.type,
      seq: frame.params.event?.seq,
      sessionId: frame.params.sessionId,
      data: frame.params.event?.data,
    }));
  receipt.notifications = rpc.notifications;
  receipt.stdoutLines = rpc.stdoutLines;

  await mkdir(dirname(RECEIPT_PATH), { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

  if (failure) {
    process.stderr.write(`entry proof failed: ${failure.message}\n`);
    process.exitCode = 1;
  }
}

await main();
