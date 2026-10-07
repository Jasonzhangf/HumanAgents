#!/usr/bin/env node
/**
 * A minimal, real ACP v1 server over stdio, used by the app-level acceptance
 * test for the ACP runtimes.
 *
 * It is not a mock of the HumanAgent side: the test spawns this as a child
 * process and speaks the same NDJSON JSON-RPC 2.0 wire protocol that opencode
 * speaks. Only the model answer is scripted, so the test exercises the real
 * transport, the real driver bookkeeping, and the real checkpoint commit.
 *
 * Usage: node acp-stub-server.mjs <answer-text> [hold] [hold-marker-path] [cancel-marker-path]
 *
 * `hold` makes session/prompt stay in flight until session/cancel arrives. The
 * cancel then resolves the held turn with stopReason `cancelled`, which is what
 * a real ACP agent does. Without `hold`, a prompt answers immediately.
 *
 * `hold-marker-path` names a file that is created when a prompt is held. A test
 * that stops a turn reads that file to know the turn is really in flight.
 *
 * `cancel-marker-path` names a file that is created when session/cancel is
 * received. A test reads that file to prove the cancel reached this server.
 */

import { writeFileSync } from 'node:fs';

const answer = process.argv[2] ?? 'POGS';
const holdPrompts = process.argv[3] === 'hold';
const holdMarker = process.argv[4];
const cancelMarker = process.argv[5];
let buffer = '';
let sessionSeq = 0;
/** The prompt frames that are still in flight, by JSON-RPC request id. */
const inFlight = new Map();

/** Reports that a turn is being held, so a test can stop it while it runs. */
function markHeld() {
  writeMarker(holdMarker, 'held');
}

/** Reports that this server received session/cancel, so a test can see delivery. */
function markCancelled() {
  writeMarker(cancelMarker, 'cancelled');
}

/** The markers are test scaffolding; a write failure must not change the protocol. */
function writeMarker(path, value) {
  if (path === undefined) return;
  try {
    writeFileSync(path, value);
  } catch {
    // Ignored on purpose: see the comment above.
  }
}

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
}

/** Streams the scripted answer and resolves one prompt with the given stop reason. */
function answerPrompt(frame, stopReason) {
  // The answer travels as an ACP session/update notification, exactly as a
  // real ACP agent streams its message chunks.
  if (stopReason !== 'cancelled') {
    send({
      method: 'session/update',
      params: {
        sessionId: frame.params?.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: frame.params?.messageId ?? 'stub-message',
          content: { type: 'text', text: answer },
        },
      },
    });
  }
  send({ id: frame.id, result: { stopReason } });
}

function handle(frame) {
  if (frame.method === 'initialize') {
    send({
      id: frame.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'acp-stub', version: '1.0.0' },
        agentCapabilities: { loadSession: false },
      },
    });
    return;
  }
  if (frame.method === 'session/new') {
    sessionSeq += 1;
    send({ id: frame.id, result: { sessionId: `stub-session-${sessionSeq}` } });
    return;
  }
  if (frame.method === 'session/prompt') {
    if (holdPrompts) {
      // Stay in flight until the client cancels this turn. A held turn is the
      // only state in which a cancel is accepted, so this is what makes the
      // stop path reachable.
      inFlight.set(frame.id, frame);
      markHeld();
      return;
    }
    answerPrompt(frame, 'end_turn');
    return;
  }
  if (frame.method === 'session/cancel') {
    // session/cancel is a notification: no response frame. It resolves every
    // held turn with stopReason `cancelled`, exactly as a real ACP agent stops
    // the work it was doing.
    markCancelled();
    for (const held of inFlight.values()) answerPrompt(held, 'cancelled');
    inFlight.clear();
    return;
  }
  if (frame.id !== undefined) {
    send({ id: frame.id, error: { code: -32601, message: `unknown method ${frame.method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`stub failed to decode a frame: ${error.message}\n`);
    }
  }
});

// Exit when the client closes stdin; this is the real process lifecycle.
process.stdin.on('end', () => process.exit(0));
