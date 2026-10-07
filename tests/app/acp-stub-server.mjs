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
 * Usage: node acp-stub-server.mjs <answer-text>
 */

const answer = process.argv[2] ?? 'POGS';
let buffer = '';
let sessionSeq = 0;

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
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
    const sessionId = frame.params?.sessionId;
    // The answer travels as an ACP session/update notification, exactly as a
    // real ACP agent streams its message chunks.
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: frame.params?.messageId ?? 'stub-message',
          content: { type: 'text', text: answer },
        },
      },
    });
    send({ id: frame.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (frame.method === 'session/cancel') {
    // session/cancel is a notification: no response frame.
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
