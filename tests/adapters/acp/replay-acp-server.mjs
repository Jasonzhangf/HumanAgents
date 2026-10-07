/**
 * Replays a recorded ACP session over stdio.
 *
 * The fixture holds the server->client frames of one real engine session, in
 * arrival order. This server answers each client request with the recorded
 * response for that method, echoing the client's own request id, and emits the
 * recorded `session/update` notifications in their recorded order.
 *
 * The point is to lock the wire shapes a real engine produces. A hand-written
 * stub only sends what its author thought of; this sends what the engine
 * actually sent, including `agent_thought_chunk`, `usage_update`,
 * `available_commands_update`, and a `session/new` result carrying
 * `configOptions`.
 *
 * Usage: node replay-acp-server.mjs <fixture-path> [exit-after-ms]
 *
 * `exit-after-ms` bounds this server's lifetime. A client that dies without
 * closing the session would otherwise leave this process holding its pipes
 * open, and the test runner would never drain its event loop. A working replay
 * finishes far below any bound a test would set.
 */
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const exitAfterMs = Number(process.argv[3]);
const responses = new Map();
const notifications = [];
for (const frame of fixture.serverFrames) {
  if (frame.id !== undefined) responses.set(frame.id, frame);
  else notifications.push(frame);
}

// Every recorded notification arrives between `session/new` and the prompt
// response, so they are emitted ahead of the prompt response, in order.
let notificationCursor = 0;
let promptCount = 0;
const emitNotifications = () => {
  while (notificationCursor < notifications.length) {
    process.stdout.write(`${JSON.stringify(notifications[notificationCursor])}\n`);
    notificationCursor += 1;
  }
};

if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
  setTimeout(() => process.exit(0), exitAfterMs);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const request = JSON.parse(line);

    // This recording has no cancel. A cancel is a notification with no
    // response, and the recorded turn always completes, so a cancel is
    // ignored here. A cancel-path replay needs its own recording.
    if (request.id === undefined) continue;

    // The recorded session id is an addressing label, so the response keeps it;
    // only the id is echoed from the client, because the client owns correlation.
    if (request.method === 'initialize') {
      const recorded = responses.get(1);
      process.stdout.write(`${JSON.stringify({ ...recorded, id: request.id })}\n`);
      continue;
    }
    if (request.method === 'session/new') {
      const recorded = responses.get(2);
      process.stdout.write(`${JSON.stringify({ ...recorded, id: request.id })}\n`);
      continue;
    }
    if (request.method === 'session/prompt') {
      // The recording holds exactly one turn. Serving a second prompt from the
      // first turn's response would report an answer the engine never gave.
      if (promptCount > 0) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'replay recording holds one prompt' } })}\n`);
        continue;
      }
      promptCount += 1;
      emitNotifications();
      const recorded = responses.get(3);
      process.stdout.write(`${JSON.stringify({ ...recorded, id: request.id })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `replay has no recorded response for ${request.method}` } })}\n`);
  }
});
