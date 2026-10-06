#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoPath = process.cwd();
const cliPath = join(repoPath, 'dist', 'app', 'app', 'src', 'cli.js');
const playwrightPath = process.env.PLAYWRIGHT_PATH ?? '/opt/homebrew/lib/node_modules/playwright/index.js';
const startupTimeoutMs = 30_000;
const requestTimeoutMs = 5_000;
const exitTimeoutMs = 20_000;
const DARWIN_O_EXLOCK = 0x20;
const CREDENTIAL_LOCK_FLAGS = 0x2 | 0x200 | DARWIN_O_EXLOCK | 0x4;

function parseArgs(argv) {
  const evidenceIndex = argv.indexOf('--evidence');
  const caseIndex = argv.indexOf('--case');
  return {
    evidencePath: evidenceIndex === -1 ? null : argv[evidenceIndex + 1],
    caseName: caseIndex === -1 ? null : argv[caseIndex + 1],
  };
}

function firstJsonValue(buffer) {
  const start = buffer.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(buffer.slice(start, index + 1));
    }
  }
  return undefined;
}

function sanitizedHeaders(headers) {
  const result = {};
  for (const name of ['allow', 'cache-control', 'content-type']) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

async function request(url, init = {}, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return {
      status: response.status,
      headers: sanitizedHeaders(response.headers),
      body,
      setCookie: response.headers.get('set-cookie'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForExit(child, timeoutMs = exitTimeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve({ exited: false, code: child.exitCode, signal: child.signalCode });
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    };
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode, signalSent: false };
  }
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch (error) {
    return { exited: false, error: String(error), signalSent: false };
  }
  const exited = await waitForExit(child);
  return { ...exited, signalSent: true };
}

async function pidExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function portRefused(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ refused: false, error: 'timeout' });
    }, 2_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ refused: false, error: 'connected' });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve({ refused: error.code === 'ECONNREFUSED', error: error.code ?? String(error) });
    });
  });
}

function ipv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function ipv6Addresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv6' && !entry.internal && !entry.address.endsWith('%')) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)];
}

function isTailscaleIpv4(address) {
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function networkEvidence() {
  const ipv4 = ipv4Addresses();
  return {
    ipv4,
    ipv6: ipv6Addresses(),
    lan: ipv4.filter((address) => !isTailscaleIpv4(address)),
    tailscale: ipv4.filter(isTailscaleIpv4),
  };
}

function originFor(address, port) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

async function startServe(options) {
  const attemptRoot = options.attemptRoot ?? await mkdtemp(join(tmpdir(), 'humanagent-real-network-'));
  const workspace = options.workspace ?? join(attemptRoot, 'workspace');
  const controlRoot = options.controlRoot ?? join(attemptRoot, 'control');
  await mkdir(workspace, { recursive: true });
  await mkdir(controlRoot, { recursive: true });
  const args = [
    cliPath,
    'serve',
    '--workspace', workspace,
    '--control-root', controlRoot,
    '--provider', 'fake',
    '--port', String(options.port ?? 0),
  ];
  if (options.host !== undefined) args.push('--host', options.host);
  if (options.fakeStepDelayMs !== undefined) {
    args.push('--fake-step-delay-ms', String(options.fakeStepDelayMs));
  }
  const child = spawn(process.execPath, args, {
    cwd: repoPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let banner;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`serve startup timed out; stderr=${stderr.slice(-1200)}`));
    }, startupTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (banner) return;
      try {
        const parsed = firstJsonValue(stdout);
        if (parsed) {
          banner = parsed;
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {
        // Keep buffering until the complete startup object is available.
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`serve exited before readiness (${String(code ?? signal)}); stderr=${stderr.slice(-1200)}`));
    });
  });

  try {
    await ready;
  } catch (error) {
    const shutdown = await stopChild(child);
    if (shutdown.exited) await rm(attemptRoot, { recursive: true, force: true });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      attemptRoot,
      pid: child.pid,
      shutdown,
    });
  }

  const port = Number(banner.listenPort ?? banner.port);
  assert.equal(Number.isSafeInteger(port), true, 'serve banner must include an actual port');
  return {
    attemptRoot,
    workspace,
    controlRoot,
    child,
    banner,
    pid: child.pid,
    port,
    loopbackOrigin: originFor('127.0.0.1', port),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function closeServe(serve) {
  const shutdown = await stopChild(serve.child);
  const pidGone = !(await pidExists(serve.pid));
  const port = await portRefused('127.0.0.1', serve.port);
  let rootReleased = false;
  if (shutdown.exited) {
    await rm(serve.attemptRoot, { recursive: true, force: true });
    rootReleased = !existsSync(serve.attemptRoot);
  }
  return {
    ...shutdown,
    pidGone,
    portRefused: port.refused,
    portProbeError: port.error,
    rootReleased,
    retainedRoot: rootReleased ? null : serve.attemptRoot,
  };
}

async function runCli(args, options = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: repoPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exit = await waitForExit(child, options.timeoutMs ?? exitTimeoutMs);
  return { exit, stdout, stderr };
}

async function prepareServeRestart(serve) {
  const lease = JSON.parse(await readFile(serve.banner.supervisor.leasePath, 'utf8'));
  const { deriveSupervisorToken } = await import(
    pathToFileURL(join(repoPath, 'dist/app/app/src/ui-runtime/access-control.js')).href
  );
  const token = await deriveSupervisorToken(
    join(serve.controlRoot, 'security', 'web-access.json'),
    lease.leaseId,
    lease.generation,
  );
  return () => request(`${serve.loopbackOrigin}/api/runtime/restart`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ leaseId: lease.leaseId, generation: lease.generation }),
  });
}

async function runPair(serve, options = {}) {
  const result = await runCli([
    'pair',
    '--workspace', serve.workspace,
    '--control-root', serve.controlRoot,
  ], options);
  if (options.expectFailure) return result;
  assert.equal(result.exit.exited, true, 'pair must exit');
  assert.equal(result.exit.code, 0, `pair failed: ${result.stderr.slice(-800)}`);
  const receipt = firstJsonValue(result.stdout);
  assert.equal(typeof receipt?.code, 'string', 'pair must return a code');
  assert.equal(typeof receipt?.expiresAt, 'string', 'pair must return an expiry');
  return { ...result, receipt };
}

function cookieValue(setCookie) {
  assert.equal(typeof setCookie, 'string', 'pairing must set a cookie');
  return setCookie.split(';')[0];
}

async function postPair(origin, code, options = {}) {
  const headers = { 'content-type': 'application/json' };
  if (options.origin !== null) headers.origin = options.origin ?? origin;
  return request(`${origin}/api/auth/pair`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code }),
  });
}

function authHeaders(cookie, origin, extra = {}) {
  return { cookie, origin, ...extra };
}

async function openSse(url, cookie) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: cookie ? { cookie } : {},
    signal: controller.signal,
  });
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/event-stream')) {
    return {
      response: {
        status: response.status,
        headers: sanitizedHeaders(response.headers),
        body: await response.json().catch(() => ({})),
      },
      events: [],
      closed: true,
      close: async () => controller.abort(),
      waitFor: async () => { throw new Error('stream did not open'); },
      waitForClosed: async () => true,
    };
  }

  const events = [];
  let closed = false;
  const waiters = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = {};
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event.event = line.slice(7).trim();
            if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (dataLines.length > 0) {
            try {
              event.data = JSON.parse(dataLines.join('\n'));
            } catch {
              event.data = { raw: dataLines.join('\n').slice(0, 500) };
            }
          }
          events.push(event);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(event)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(event);
          }
          separator = buffer.indexOf('\n\n');
        }
      }
    } finally {
      closed = true;
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('SSE stream closed before the expected event'));
      }
    }
  })().catch(() => undefined);

  return {
    response: { status: response.status, headers: sanitizedHeaders(response.headers) },
    events,
    get closed() {
      return closed;
    },
    waitFor(predicate, label, timeoutMs = 8_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`timed out waiting for ${label}; saw ${events.map((event) => event.event ?? event.data?.kind ?? 'message').join(', ')}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async waitForClosed(timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (!closed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return closed;
    },
    async close() {
      if (!closed) controller.abort();
      await pump;
    },
  };
}

async function createTaskAndStart(serve, cookie, prompt = 'network blackbox execution') {
  const created = await request(`${serve.banner.url}/api/tasks`, {
    method: 'POST',
    headers: authHeaders(cookie, serve.banner.url, { 'content-type': 'application/json' }),
    body: JSON.stringify({ title: 'network blackbox task' }),
  });
  assert.equal(created.status, 201, `task creation failed: ${JSON.stringify(created)}`);
  const taskId = created.body?.taskId?.value;
  assert.equal(typeof taskId, 'string', 'task creation must return a task id');
  const started = await request(`${serve.banner.url}/api/tasks/${encodeURIComponent(taskId)}/executions`, {
    method: 'POST',
    headers: authHeaders(cookie, serve.banner.url, { 'content-type': 'application/json' }),
    body: JSON.stringify({ mode: 'fake', prompt }),
  });
  assert.equal(started.status, 202, `execution start failed: ${JSON.stringify(started)}`);
  assert.equal(typeof started.body?.operationId, 'string', 'execution start must return an operation id');
  return { taskId, operationId: started.body.operationId };
}

async function waitForServeEvent(serve, eventName, timeoutMs = 20_000) {
  const pattern = new RegExp(`"event"\\s*:\\s*"${eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(serve.stdout())) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${eventName}; stdout=${serve.stdout().slice(-1200)}; stderr=${serve.stderr().slice(-1200)}`);
}

async function confirmRequirement(origin, cookie, spec) {
  const headers = authHeaders(cookie, origin, { 'content-type': 'application/json' });
  const received = await request(`${origin}/api/explicit/inputs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channel: 'business', sourceRef: spec.sourceRef, rawInput: spec.rawInput }),
  });
  assert.equal(received.status, 201, `explicit input failed: ${JSON.stringify(received)}`);
  const interactionId = received.body?.interactionId;
  assert.equal(typeof interactionId, 'string', 'explicit input must return an interaction id');
  const scoped = `${origin}/api/explicit/interactions/${encodeURIComponent(interactionId)}`;
  const matching = await request(`${scoped}/matching`, { method: 'POST', headers });
  assert.equal(matching.status, 202, `matching failed: ${JSON.stringify(matching)}`);
  const match = await request(`${scoped}/match`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ normalizedInput: spec.rawInput, matchedTasks: [], knownFacts: [] }),
  });
  assert.equal(match.status, 202, `match failed: ${JSON.stringify(match)}`);
  const proposal = await request(`${scoped}/proposal`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ proposedIntent: 'create', proposal: spec.proposal }),
  });
  assert.equal(proposal.status, 202, `proposal failed: ${JSON.stringify(proposal)}`);
  const inspected = await request(scoped, { headers });
  assert.equal(inspected.status, 200, `inspection failed: ${JSON.stringify(inspected)}`);
  const draftId = inspected.body?.draft?.draftId;
  assert.equal(typeof draftId, 'string', `draft missing: ${JSON.stringify(inspected)}`);
  const confirmation = await request(`${scoped}/confirmation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      draftId,
      inputRevision: 1,
      confirmationRef: `confirmation:${spec.sourceRef}`,
      confirmedBy: 'human:network-e2e',
      confirmedAt: '2026-10-03T00:00:00.000Z',
      payloadRef: `asset://requirements/${spec.sourceRef}`,
    }),
  });
  assert.equal(confirmation.status, 200, `confirmation failed: ${JSON.stringify(confirmation)}`);
  return { interactionId, draftId };
}

async function findJournalFiles(root) {
  let entries = [];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => join(root, entry));
}

async function readRuntimeJournal(controlRoot) {
  const files = await findJournalFiles(join(controlRoot, 'sessions'));
  const interactionFiles = await findJournalFiles(join(controlRoot, 'main'));
  const readRecords = async (path) => {
    try {
      return (await readFile(path, 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const runtimeRecords = [];
  for (const path of files) runtimeRecords.push(...await readRecords(path));
  const stateRecords = [];
  for (const path of interactionFiles) stateRecords.push(...await readRecords(path));
  const all = [...runtimeRecords, ...stateRecords];
  const lastState = [...all].reverse().find((record) => record.kind === 'explicit-brain.state');
  return {
    taskCreated: all.filter((record) => record.kind === 'task.created').length,
    operationStarted: all.filter((record) => record.kind === 'operation.started').length,
    pendingDraftIds: lastState?.state?.inbox?.pendingDraftIds ?? [],
    recordCount: all.length,
  };
}

async function waitForTaskCompletion(serve, cookie, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await request(`${serve.banner.url}/api/tasks`, { headers: { cookie } });
    if (last.status === 200 && (last.body?.counts?.completed ?? 0) >= 1) return last.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`task did not reach completed state; last=${JSON.stringify(last)}`);
}

async function assertRefused(host, port) {
  const result = await portRefused(host, port);
  assert.equal(result.refused, true, `${host}:${port} should be refused, got ${result.error}`);
  return result;
}

async function rawHttpRequest(host, port, requestText, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw HTTP request timed out; response=${JSON.stringify(response.slice(0, 500))}`));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function spawnCredentialLockHolder(lockPath) {
  const child = spawn(process.execPath, [
    '-e',
    [
      "const fs = require('node:fs');",
      `const handle = fs.openSync(${JSON.stringify(lockPath)}, ${CREDENTIAL_LOCK_FLAGS}, 0o600);`,
      "process.stdout.write('locked\\n');",
      "process.on('SIGTERM', () => { fs.closeSync(handle); process.exit(0); });",
      'setInterval(() => {}, 1000);',
    ].join(''),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`credential lock holder did not start; stderr=${stderr.slice(-500)}`)), 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return child;
}

async function createDeadCredentialLockFixture(lockPath) {
  const child = spawn(process.execPath, [
    '-e',
    [
      "const fs = require('node:fs');",
      `const handle = fs.openSync(${JSON.stringify(lockPath)}, ${CREDENTIAL_LOCK_FLAGS}, 0o600);`,
      "fs.writeFileSync(handle, JSON.stringify({ token: 'dead-owner-fixture', pid: 999999, acquiredAt: '2026-10-03T00:00:00.000Z' }) + '\\n');",
      'fs.closeSync(handle);',
    ].join(''),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exit = await waitForExit(child, 5_000);
  assert.equal(exit.exited, true, `dead-lock fixture process must exit; stderr=${stderr.slice(-500)}`);
  assert.equal(exit.code, 0, `dead-lock fixture process failed; stderr=${stderr.slice(-500)}`);
}

async function runCase(report, name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const details = await fn();
    report.cases.push({ name, status: 'PASS', startedAt, finishedAt: new Date().toISOString(), details });
  } catch (error) {
    report.cases.push({
      name,
      status: 'FAIL',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function wildcardBindCase(evidenceDir) {
  const defaultServe = await startServe({ fakeStepDelayMs: 100 });
  try {
    assert.equal(defaultServe.banner.listenAddress, '127.0.0.1', 'default serve must bind IPv4 loopback');
    assert.equal(defaultServe.banner.supervisor?.controlEndpoint?.host, '127.0.0.1', 'default control endpoint must stay loopback');
    assert.equal(defaultServe.banner.url, `${defaultServe.loopbackOrigin}`, 'default display URL must name loopback');
  } finally {
    const closure = await closeServe(defaultServe);
    assert.equal(closure.exited, true, 'default serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'default serve PID must be gone');
    assert.equal(closure.portRefused, true, 'default serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }

  const serve = await startServe({ host: '0.0.0.0', fakeStepDelayMs: 100 });
  try {
    const networks = networkEvidence();
    assert.equal(serve.banner.listenAddress, '0.0.0.0', 'default serve must bind IPv4 wildcard');
    assert.equal(serve.banner.supervisor?.controlEndpoint?.host, '127.0.0.1', 'wildcard control endpoint must be IPv4 loopback');
    assert.equal(serve.banner.supervisor?.controlEndpoint?.port, serve.port, 'control endpoint must use the actual listener port');
    const display = new URL(serve.banner.url);
    assert.notEqual(display.hostname, '0.0.0.0', 'display URL must not expose wildcard');
    assert.equal(networks.lan.includes(display.hostname), true, 'display URL should use a reachable LAN IPv4 address');

    // `--host 0.0.0.0` is an IPv4 wildcard listener. Only real IPv4 non-loopback
    // interfaces can reach it; IPv6 link-local addresses require a scope id and
    // belong to the IPv6 wildcard (`::`) case.
    const nonLoopbackOrigins = [
      ...networks.lan.map((address) => [`lan:${address}`, originFor(address, serve.port)]),
      ...networks.tailscale.map((address) => [`tailscale:${address}`, originFor(address, serve.port)]),
    ];
    assert.equal(nonLoopbackOrigins.length > 0, true, 'IPv4 wildcard bind requires a real non-loopback IPv4 interface');

    const probes = [];
    for (const [label, origin] of [
      ['loopback', serve.loopbackOrigin],
      ['display', serve.banner.url],
      ...nonLoopbackOrigins,
    ]) {
      const response = await request(`${origin}/api/liveness`);
      assert.equal(response.status, 200, `${label} liveness failed`);
      assert.equal(response.body?.status, 'alive');
      assert.equal(response.body?.providerReady, undefined);
      probes.push({ label, origin, status: response.status, body: response.body });
    }

    const lanOrigin = nonLoopbackOrigins.find(([label]) => label.startsWith('lan:'))?.[1] ?? serve.banner.url;
    const unauthLoopbackTasks = await request(`${serve.loopbackOrigin}/api/tasks`);
    assert.equal(unauthLoopbackTasks.status, 401);
    assert.equal(unauthLoopbackTasks.body?.error?.code, 'auth.session.missing');
    const unauthLanTasks = await request(`${lanOrigin}/api/tasks`);
    assert.equal(unauthLanTasks.status, 401, 'unauthenticated LAN access must be rejected');
    assert.equal(unauthLanTasks.body?.error?.code, 'auth.session.missing');

    const pair = await runPair(serve);
    assert.equal(pair.exit.code, 0);
    const paired = await postPair(lanOrigin, pair.receipt.code);
    assert.equal(paired.status, 200, `LAN-origin pairing failed: ${JSON.stringify(paired)}`);
    assert.equal(paired.body?.authenticated, true);
    const cookie = cookieValue(paired.setCookie);
    const authorizedLanTasks = await request(`${lanOrigin}/api/tasks`, { headers: { cookie } });
    assert.equal(authorizedLanTasks.status, 200, 'authenticated LAN read must succeed');

    const lanHost = new URL(lanOrigin).host;
    const supervisorFromLan = await request(`${lanOrigin}/api/runtime/identity`);
    assert.equal(supervisorFromLan.status, 403, 'supervisor endpoint must reject non-loopback callers');
    assert.equal(supervisorFromLan.body?.error?.code, 'auth.supervisor.forbidden');
    const loopbackIdentity = await request(`${serve.loopbackOrigin}/api/runtime/identity`);
    assert.equal(loopbackIdentity.status, 401, 'loopback supervisor call without a token must be unauthorized');
    assert.equal(loopbackIdentity.body?.error?.code, 'auth.supervisor.required');
    const rawLanLiveness = await rawHttpRequest(
      new URL(lanOrigin).hostname,
      serve.port,
      `GET /api/liveness HTTP/1.1\r\nHost: ${lanHost}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(rawLanLiveness.split('\r\n', 1)[0], /^HTTP\/1\.1 200 /, 'raw LAN HTTP request must reach the listener');
    const rawLanTasks = await rawHttpRequest(
      new URL(lanOrigin).hostname,
      serve.port,
      `GET /api/tasks HTTP/1.1\r\nHost: ${lanHost}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(rawLanTasks.split('\r\n', 1)[0], /^HTTP\/1\.1 401 /, 'raw unauthenticated LAN API request must be rejected');
    assert.match(rawLanTasks, /"code":"auth\.session\.missing"/, 'LAN rejection must keep the typed error code');

    await mkdir(evidenceDir, { recursive: true });
    return {
      banner: {
        url: serve.banner.url,
        listenAddress: serve.banner.listenAddress,
        listenPort: serve.banner.listenPort,
        controlEndpoint: serve.banner.supervisor?.controlEndpoint,
      },
      networks,
      probes,
      lanOrigin,
      unauthenticated: {
        loopback: { status: unauthLoopbackTasks.status, code: unauthLoopbackTasks.body?.error?.code },
        lan: { status: unauthLanTasks.status, code: unauthLanTasks.body?.error?.code },
      },
      authenticatedLanTasks: { status: authorizedLanTasks.status, total: authorizedLanTasks.body?.counts?.total },
      supervisorLoopbackOnly: {
        lan: { status: supervisorFromLan.status, code: supervisorFromLan.body?.error?.code },
        loopbackWithoutToken: { status: loopbackIdentity.status, code: loopbackIdentity.body?.error?.code },
      },
      rawLanHttp: {
        livenessStatusLine: rawLanLiveness.split('\r\n', 1)[0],
        tasksStatusLine: rawLanTasks.split('\r\n', 1)[0],
        tasksBody: rawLanTasks.slice(rawLanTasks.indexOf('\r\n\r\n') + 4).slice(0, 400),
      },
    };
  } finally {
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function pairingAndSseCase() {
  const serve = await startServe({ fakeStepDelayMs: 1_000 });
  try {
    const pair = await runPair(serve);
    const missingOrigin = await postPair(serve.banner.url, pair.receipt.code, { origin: null });
    assert.equal(missingOrigin.status, 403);
    assert.equal(missingOrigin.body?.error?.code, 'auth.origin.invalid');
    const wrongOrigin = await postPair(serve.banner.url, pair.receipt.code, { origin: 'http://wrong.example' });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.body?.error?.code, 'auth.origin.invalid');
    const invalid = await postPair(serve.banner.url, 'invalid-code');
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body?.error?.code, 'auth.pair.invalid');

    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200);
    assert.equal(paired.body?.authenticated, true);
    assert.match(paired.setCookie ?? '', /HttpOnly/);
    assert.match(paired.setCookie ?? '', /SameSite=Strict/);
    assert.match(paired.setCookie ?? '', /Path=\//);
    assert.doesNotMatch(paired.setCookie ?? '', new RegExp(pair.receipt.code));
    const cookie = cookieValue(paired.setCookie);

    const reused = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(reused.status, 401);
    assert.equal(reused.body?.error?.code, 'auth.pair.invalid');

    const session = await request(`${serve.banner.url}/api/auth/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.body?.authenticated, true);
    const tasks = await request(`${serve.banner.url}/api/tasks`, { headers: { cookie } });
    assert.equal(tasks.status, 200);

    const missingOriginCreate = await request(`${serve.banner.url}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'must not be created' }),
    });
    assert.equal(missingOriginCreate.status, 403);
    assert.equal(missingOriginCreate.body?.error?.code, 'auth.origin.invalid');
    const wrongOriginCreate = await request(`${serve.banner.url}/api/tasks`, {
      method: 'POST',
      headers: authHeaders(cookie, 'http://wrong.example', { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'must not be created either' }),
    });
    assert.equal(wrongOriginCreate.status, 403);
    const afterRejectedMutations = await request(`${serve.banner.url}/api/tasks`, { headers: { cookie } });
    assert.equal(afterRejectedMutations.body?.counts?.total, 0);

    const { operationId } = await createTaskAndStart(serve, cookie);
    const unauthorizedSse = await openSse(`${serve.banner.url}/api/executions/${encodeURIComponent(operationId)}/events`);
    assert.equal(unauthorizedSse.response.status, 401);
    assert.doesNotMatch(unauthorizedSse.response.headers['content-type'] ?? '', /text\/event-stream/);
    assert.equal(unauthorizedSse.response.body?.error?.code, 'auth.session.missing');

    const stream = await openSse(`${serve.banner.url}/api/executions/${encodeURIComponent(operationId)}/events`, cookie);
    await stream.waitFor((event) => event.data?.kind !== undefined || event.event !== undefined, 'first SSE event');
    const logout = await request(`${serve.banner.url}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(cookie, serve.banner.url),
    });
    assert.equal(logout.status, 200);
    await stream.waitFor((event) => event.event === 'auth.invalidated' || event.data?.code === 'auth.session.invalid', 'auth.invalidated SSE');
    assert.equal(await stream.waitForClosed(), true);
    const oldCookie = await request(`${serve.banner.url}/api/tasks`, { headers: { cookie } });
    assert.equal(oldCookie.status, 401);
    const invalidCookie = await request(`${serve.banner.url}/api/tasks`, { headers: { cookie: 'HA_SESSION=invalid.token' } });
    assert.equal(invalidCookie.status, 401);
    await stream.close();

    return {
      pairExitCode: pair.exit.code,
      missingOrigin: { status: missingOrigin.status, code: missingOrigin.body?.error?.code },
      wrongOrigin: { status: wrongOrigin.status, code: wrongOrigin.body?.error?.code },
      invalidCode: { status: invalid.status, code: invalid.body?.error?.code },
      paired: { status: paired.status, cookieFlags: ['HttpOnly', 'SameSite=Strict', 'Path=/'] },
      reusedCode: { status: reused.status, code: reused.body?.error?.code },
      session: { status: session.status, authenticated: session.body?.authenticated },
      authorizedTasks: tasks.status,
      rejectedMutations: [
        { status: missingOriginCreate.status, code: missingOriginCreate.body?.error?.code },
        { status: wrongOriginCreate.status, code: wrongOriginCreate.body?.error?.code },
      ],
      unauthorizedSse: { status: unauthorizedSse.response.status, contentType: unauthorizedSse.response.headers['content-type'] },
      logout: { status: logout.status, sseClosed: true, oldCookieStatus: oldCookie.status },
      invalidCookieStatus: invalidCookie.status,
    };
  } finally {
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function invalidRequestTargetCase() {
  const serve = await startServe({ fakeStepDelayMs: 1_000 });
  try {
    const initialLiveness = await request(`${serve.loopbackOrigin}/api/liveness`);
    assert.equal(initialLiveness.status, 200, 'daemon must be live before the raw request');
    const raw = await rawHttpRequest('127.0.0.1', serve.port, 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const statusLine = raw.split('\r\n', 1)[0];
    assert.match(statusLine, /^HTTP\/1\.1 400 /, `invalid request target must be rejected with HTTP 400: ${JSON.stringify(raw.slice(0, 500))}`);
    assert.match(raw, /"code":"request\.target\.invalid"/, 'invalid target error must stay typed');
    const aliveAfterReject = await request(`${serve.loopbackOrigin}/api/liveness`);
    assert.equal(aliveAfterReject.status, 200, 'same daemon must stay alive after invalid target');
    const pidAlive = await pidExists(serve.pid);
    assert.equal(pidAlive, true, 'serve PID must remain alive after invalid target');

    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200, `pairing after rejection failed: ${JSON.stringify(paired)}`);
    const cookie = cookieValue(paired.setCookie);
    const { operationId } = await createTaskAndStart(serve, cookie, 'continue after invalid request target');
    const stream = await openSse(`${serve.banner.url}/api/executions/${encodeURIComponent(operationId)}/events`, cookie);
    await stream.waitFor((event) => event.data?.kind !== undefined || event.event !== undefined, 'post-rejection task SSE');
    await stream.close();

    return {
      pid: serve.pid,
      port: serve.port,
      initialLiveness: initialLiveness.status,
      rawStatusLine: statusLine,
      rawErrorCode: 'request.target.invalid',
      samePidAlive: pidAlive,
      livenessAfterReject: aliveAfterReject.status,
      postRejectTask: { operationId, sseOpened: true },
    };
  } finally {
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function healthCase() {
  const serve = await startServe({ fakeStepDelayMs: 50 });
  try {
    const liveness = await request(`${serve.banner.url}/api/liveness`);
    assert.equal(liveness.status, 200);
    assert.equal(liveness.body?.providerReady, undefined);
    const legacy = await request(`${serve.banner.url}/api/health/probe`);
    assert.equal(legacy.status, 405);
    assert.equal(legacy.headers.allow, 'POST');
    const unauthProbe = await request(`${serve.banner.url}/api/health/probe`, { method: 'POST' });
    assert.equal(unauthProbe.status, 401);
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200);
    const cookie = cookieValue(paired.setCookie);
    const missingOrigin = await request(`${serve.banner.url}/api/health/probe`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(missingOrigin.status, 403);
    const snapshotBefore = await request(`${serve.banner.url}/api/health/snapshot`, { headers: { cookie } });
    assert.equal(snapshotBefore.status, 409);
    assert.equal(snapshotBefore.body?.error?.code, 'health-snapshot-missing');
    const probe = await request(`${serve.banner.url}/api/health/probe`, {
      method: 'POST',
      headers: authHeaders(cookie, serve.banner.url),
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.body?.surface, 'organ-health');
    const snapshotAfter = await request(`${serve.banner.url}/api/health/snapshot`, { headers: { cookie } });
    assert.equal(snapshotAfter.status, 200);
    assert.equal(snapshotAfter.body?.surface, 'organ-health');
    return {
      liveness: { status: liveness.status, body: liveness.body },
      legacyProbe: { status: legacy.status, allow: legacy.headers.allow },
      unauthProbe: { status: unauthProbe.status, code: unauthProbe.body?.error?.code },
      missingOriginProbe: { status: missingOrigin.status, code: missingOrigin.body?.error?.code },
      snapshotBefore: { status: snapshotBefore.status, code: snapshotBefore.body?.error?.code },
      probe: { status: probe.status, state: probe.body?.healthState, checkedAt: probe.body?.checkedAt },
      snapshotAfter: { status: snapshotAfter.status, state: snapshotAfter.body?.healthState },
    };
  } finally {
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function loopbackCase() {
  const networks = networkEvidence();
  const results = {};
  for (const host of ['127.0.0.1', '::1', '::']) {
    const serve = await startServe({ host, fakeStepDelayMs: 25 });
    try {
      assert.equal(serve.banner.listenAddress, host);
      assert.equal(serve.banner.supervisor?.controlEndpoint?.host, host === '::' ? '127.0.0.1' : host);
      const loopback = host === '::1' ? `http://[::1]:${serve.port}` : `http://127.0.0.1:${serve.port}`;
      const liveness = await request(`${loopback}/api/liveness`);
      assert.equal(liveness.status, 200);
      const pair = await runPair(serve);
      assert.equal(pair.exit.code, 0);
      if (host !== '::') {
        for (const address of [...networks.lan, ...networks.tailscale]) {
          await assertRefused(address, serve.port);
        }
      }
      const display = new URL(serve.banner.url);
      if (host === '::') {
        assert.match(display.hostname, /^\[[0-9a-f:]+\]$/i, 'IPv6 wildcard display URL must name a bracketed IPv6 address');
      } else {
        assert.equal(display.hostname, host === '::1' ? '[::1]' : host, 'loopback display URL must keep the loopback host');
      }
      results[host] = {
        banner: {
          listenAddress: serve.banner.listenAddress,
          url: serve.banner.url,
          controlEndpoint: serve.banner.supervisor?.controlEndpoint,
        },
        livenessStatus: liveness.status,
        pairExitCode: pair.exit.code,
        refused: host === '::' ? [] : [...networks.lan, ...networks.tailscale],
      };
    } finally {
      const closure = await closeServe(serve);
      assert.equal(closure.exited, true, `${host} serve must exit after SIGTERM`);
      assert.equal(closure.pidGone, true, `${host} serve PID must be gone`);
      assert.equal(closure.portRefused, true, `${host} serve port must be refused after exit`);
      assert.equal(closure.rootReleased, true, `${host} owned attempt root must be removed`);
    }
  }
  return results;
}

async function startupFailureCase() {
  const invalidRoot = await mkdtemp(join(tmpdir(), 'humanagent-network-invalid-host-'));
  await mkdir(join(invalidRoot, 'workspace'), { recursive: true });
  await mkdir(join(invalidRoot, 'control'), { recursive: true });
  const invalid = await runCli([
    'serve',
    '--workspace', join(invalidRoot, 'workspace'),
    '--control-root', join(invalidRoot, 'control'),
    '--provider', 'fake',
    '--host', 'bad.invalid',
    '--port', '0',
  ]);
  await rm(invalidRoot, { recursive: true, force: true });
  assert.equal(invalid.exit.exited, true);
  assert.notEqual(invalid.exit.code, 0);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /serve\.host\.invalid|host must be/);

  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const address = blocker.address();
  assert.equal(typeof address, 'object');
  const occupiedPort = address.port;
  const occupiedRoot = await mkdtemp(join(tmpdir(), 'humanagent-network-occupied-port-'));
  await mkdir(join(occupiedRoot, 'workspace'), { recursive: true });
  await mkdir(join(occupiedRoot, 'control'), { recursive: true });
  const occupied = await runCli([
    'serve',
    '--workspace', join(occupiedRoot, 'workspace'),
    '--control-root', join(occupiedRoot, 'control'),
    '--provider', 'fake',
    '--host', '127.0.0.1',
    '--port', String(occupiedPort),
  ]);
  await rm(occupiedRoot, { recursive: true, force: true });
  await new Promise((resolve) => blocker.close(resolve));
  assert.equal(occupied.exit.exited, true);
  assert.notEqual(occupied.exit.code, 0);
  assert.match(`${occupied.stdout}\n${occupied.stderr}`, /EADDRINUSE|address already in use|port/i);
  return {
    invalidHost: { exitCode: invalid.exit.code, stderr: invalid.stderr.slice(-500) },
    occupiedPort: { port: occupiedPort, exitCode: occupied.exit.code, stderr: occupied.stderr.slice(-500) },
  };
}

async function browserCase(evidenceDir) {
  const serve = await startServe({ fakeStepDelayMs: 250 });
  let browser;
  try {
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200, `browser pairing failed: ${JSON.stringify(paired)}`);
    const cookie = cookieValue(paired.setCookie);
    const playwrightModule = await import(pathToFileURL(playwrightPath).href);
    const playwright = playwrightModule.default ?? playwrightModule;
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await context.addCookies([{
      name: 'HA_SESSION',
      value: cookie.slice(cookie.indexOf('=') + 1),
      url: serve.banner.url,
      httpOnly: true,
      sameSite: 'Strict',
    }]);
    await page.goto(`${serve.banner.url}/`, { waitUntil: 'domcontentloaded' });
    const currentApi = await page.evaluate(async () => {
      const response = await fetch('/api/tasks');
      return { status: response.status, body: await response.json() };
    });
    assert.equal(currentApi.status, 200);
    const { operationId } = await createTaskAndStart(serve, cookie);
    const eventSource = await page.evaluate(async (id) => {
      return await new Promise((resolve) => {
        const source = new EventSource(`/api/executions/${encodeURIComponent(id)}/events`);
        const timer = setTimeout(() => {
          source.close();
          resolve({ opened: false, reason: 'timeout' });
        }, 10_000);
        source.addEventListener('execution.started', (event) => {
          clearTimeout(timer);
          source.close();
          resolve({ opened: true, kind: event.type });
        });
        source.onerror = () => {
          clearTimeout(timer);
          source.close();
          resolve({ opened: false, reason: 'error' });
        };
      });
    }, operationId);
    assert.equal(eventSource.opened, true);
    await mkdir(evidenceDir, { recursive: true });
    const screenshotPath = join(evidenceDir, 'browser-login-dashboard.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const logout = await page.evaluate(async () => {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      return response.status;
    });
    assert.equal(logout, 200);
    const afterLogout = await page.evaluate(async () => {
      const response = await fetch('/api/tasks');
      return response.status;
    });
    assert.equal(afterLogout, 401);
    const cookiesAfterLogout = await context.cookies();
    return {
      url: page.url(),
      pairingStatus: paired.status,
      currentOriginTasks: currentApi.status,
      eventSource,
      screenshotPath,
      logout,
      afterLogout,
      cookieClearedAfterLogout: !cookiesAfterLogout.some((item) => item.name === 'HA_SESSION' && item.value),
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function expiryCase() {
  const attemptRoot = await mkdtemp(join(tmpdir(), 'humanagent-network-expiry-'));
  const { AccessControlService } = await import(pathToFileURL(join(repoPath, 'dist/app/app/src/ui-runtime/access-control.js')).href);
  const { startUiRuntime, buildFakeExecutionPort } = await import(pathToFileURL(join(repoPath, 'dist/app/app/src/ui-runtime/index.js')).href);
  const { MemoryCoordinator } = await import(pathToFileURL(join(repoPath, 'dist/app/runtime/src/index.js')).href);
  const { DeterministicMemoryBackend } = await import(pathToFileURL(join(repoPath, 'dist/app/adapters/memory/src/index.js')).href);
  const { id } = await import(pathToFileURL(join(repoPath, 'dist/app/contracts/src/index.js')).href);
  const binding = {
    bindingId: 'network-expiry-binding',
    providerId: 'network-expiry-provider',
    protocol: 'responses',
    endpointRef: 'fake:network-expiry',
    modelRef: 'network-expiry-model',
    configDigest: 'sha256:network-expiry-config',
    capabilityDigest: 'sha256:network-expiry-capability',
  };
  const accessControl = await AccessControlService.open({
    credentialPath: join(attemptRoot, 'control', 'security', 'web-access.json'),
    create: true,
    sessionTtlMs: 1_500,
    pairingTtlMs: 1_500,
  });
  const challenge = accessControl.createPairingChallenge('expiry-lease', 1);
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl,
    organId: id('organ', 'network-expiry'),
    binding,
    port: buildFakeExecutionPort(binding, 50),
    checkpointRoot: join(attemptRoot, 'checkpoints'),
    evidenceRoot: join(attemptRoot, 'evidence'),
    uiRoot: join(repoPath, 'docs', 'ui'),
    providerState: 'ready',
    host: '127.0.0.1',
    portNumber: 0,
    projectKey: 'network-expiry',
    workspaceRoot: attemptRoot,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'network-expiry',
      roleId: 'execution',
    },
    explicitBrainInterpreter: {
      async interpret() {
        throw new Error('explicit brain is not used by the network expiry harness');
      },
    },
  });
  try {
    const paired = await postPair(runtime.server.url, challenge.code);
    assert.equal(paired.status, 200);
    const cookie = cookieValue(paired.setCookie);
    const { operationId } = await createTaskAndStart({
      banner: { url: runtime.server.url },
    }, cookie);
    const stream = await openSse(`${runtime.server.url}/api/executions/${encodeURIComponent(operationId)}/events`, cookie);
    await stream.waitFor((event) => event.data?.kind !== undefined || event.event !== undefined, 'first SSE event');
    await stream.waitFor((event) => event.event === 'auth.invalidated' || event.data?.code === 'auth.session.invalid', 'session expiry SSE', 5_000);
    assert.equal(await stream.waitForClosed(5_000), true);
    const expired = await request(`${runtime.server.url}/api/tasks`, { headers: { cookie } });
    assert.equal(expired.status, 401);
    await stream.close();
    return {
      sessionTtlMs: 1_500,
      pairedStatus: paired.status,
      sseClosed: true,
      expiredCookieStatus: expired.status,
      expiredCode: expired.body?.error?.code,
    };
  } finally {
    const receipt = await runtime.server.close();
    await rm(attemptRoot, { recursive: true, force: true });
    return {
      receipt,
    };
  }
}

async function credentialWatchFailureActiveStopCase() {
  const attemptRoot = await mkdtemp(join(tmpdir(), 'humanagent-network-close-watch-failure-'));
  const { AccessControlError, AccessControlService } = await import(pathToFileURL(join(repoPath, 'dist/app/app/src/ui-runtime/access-control.js')).href);
  const { startUiRuntime, buildFakeExecutionPort } = await import(pathToFileURL(join(repoPath, 'dist/app/app/src/ui-runtime/index.js')).href);
  const { MemoryCoordinator } = await import(pathToFileURL(join(repoPath, 'dist/app/runtime/src/index.js')).href);
  const { DeterministicMemoryBackend } = await import(pathToFileURL(join(repoPath, 'dist/app/adapters/memory/src/index.js')).href);
  const { id } = await import(pathToFileURL(join(repoPath, 'dist/app/contracts/src/index.js')).href);
  const binding = {
    bindingId: 'network-close-watch-failure-binding',
    providerId: 'network-close-watch-failure-provider',
    protocol: 'responses',
    endpointRef: 'fake:network-close-watch-failure',
    modelRef: 'network-close-watch-failure-model',
    configDigest: 'sha256:network-close-watch-failure-config',
    capabilityDigest: 'sha256:network-close-watch-failure-capability',
  };
  const accessControl = await AccessControlService.open({
    credentialPath: join(attemptRoot, 'control', 'security', 'web-access.json'),
    create: true,
  });
  const credentialWatchFailure = new AccessControlError(
    'auth.credentials.unavailable',
    'web access credential is unavailable',
    'repair the control-root credential path',
    503,
  );
  let runtimeReceiverWatcherClosed;
  const failingAccessControl = Object.create(accessControl);
  failingAccessControl.closeCredentialWatch = async () => {
    runtimeReceiverWatcherClosed = await accessControl.closeCredentialWatch.call(failingAccessControl);
    assert.equal(runtimeReceiverWatcherClosed, true, 'shutdown must close the credential watcher owned by the runtime receiver');
    throw credentialWatchFailure;
  };
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl: failingAccessControl,
    organId: id('organ', 'network-close-watch-failure'),
    binding,
    port: buildFakeExecutionPort(binding, 60_000),
    checkpointRoot: join(attemptRoot, 'checkpoints'),
    evidenceRoot: join(attemptRoot, 'evidence'),
    uiRoot: join(repoPath, 'docs', 'ui'),
    providerState: 'ready',
    host: '127.0.0.1',
    portNumber: 0,
    projectKey: 'network-close-watch-failure',
    workspaceRoot: attemptRoot,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'network-close-watch-failure',
      roleId: 'execution',
    },
    explicitBrainInterpreter: {
      async interpret() {
        throw new Error('explicit brain is not used by the close-watch-failure harness');
      },
    },
  });
  try {
    const tasksBefore = await request(`${runtime.server.url}/api/tasks`);
    assert.equal(tasksBefore.status, 401, 'credential watch failure harness must keep the business API protected');
    const task = runtime.service.createTask({ title: 'credential watch failure close task' });
    runtime.service.startExecution(task.taskId, { prompt: 'hold active until close-watch failure shutdown' });
    const deadline = Date.now() + 5_000;
    while (runtime.service.taskDashboard(task.taskId).state !== 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(runtime.service.taskDashboard(task.taskId).state, 'running', 'execution must be active before close-watch failure');
    assert.equal(runtime.service.listTasks().counts.running, 1);

    let closeError;
    try {
      await runtime.close();
      assert.fail('close-watch failure must remain observable');
    } catch (error) {
      closeError = error;
    }
    assert.equal(closeError?.code, 'auth.credentials.unavailable');
    assert.equal(
      runtimeReceiverWatcherClosed,
      true,
      'injected failure must follow the actual runtime receiver closing its credential watcher',
    );
    assert.equal(runtime.service.taskDashboard(task.taskId).state, 'stopped');
    assert.equal(runtime.service.taskDashboard(task.taskId).checkpoint?.outcome, 'stopped');
    assert.equal(runtime.service.listTasks().counts.running, 0);
    await assert.rejects(
      () => runtime.close(),
      (error) => error.code === 'auth.credentials.unavailable',
    );

    const checkpointFiles = await findJournalFiles(join(attemptRoot, 'checkpoints'));
    assert.equal(checkpointFiles.length >= 1, true, 'stop settlement must write a checkpoint journal');
    const checkpointRecords = [];
    for (const checkpointFile of checkpointFiles) {
      checkpointRecords.push(
        ...(await readFile(checkpointFile, 'utf8'))
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line)),
      );
    }
    const stoppedCheckpoint = checkpointRecords.find(
      (record) => record.kind === 'checkpoint' && record.checkpoint?.outcome === 'stopped',
    );
    assert.ok(stoppedCheckpoint, 'checkpoint journal must contain the stopped outcome');

    await rm(attemptRoot, { recursive: true, force: true });
    assert.equal(existsSync(attemptRoot), false, 'owned lifecycle root must be removed');
    return {
      closeCode: closeError.code,
      failureInjection: 'access-control.closeCredentialWatch-after-runtime-receiver-close',
      watcherClosedOnRuntimeReceiver: runtimeReceiverWatcherClosed,
      finalState: runtime.service.taskDashboard(task.taskId).state,
      checkpointOutcome: stoppedCheckpoint.checkpoint.outcome,
      runningAfter: runtime.service.listTasks().counts.running,
      rootReleased: !existsSync(attemptRoot),
    };
  } finally {
    if (existsSync(attemptRoot)) await rm(attemptRoot, { recursive: true, force: true });
  }
}

async function restartChallengeInvalidationCase() {
  const serve = await startServe({ fakeStepDelayMs: 25 });
  try {
    const stale = await runPair(serve);
    assert.equal(stale.exit.code, 0, `pre-restart pair failed: ${stale.stderr.slice(-600)}`);
    const existingPair = await runPair(serve);
    assert.equal(existingPair.exit.code, 0, `pre-restart session pair failed: ${existingPair.stderr.slice(-600)}`);
    const existingChallenge = await postPair(serve.banner.url, existingPair.receipt.code);
    assert.equal(existingChallenge.status, 200, `pre-restart session challenge failed: ${JSON.stringify(existingChallenge)}`);
    const existingCookie = cookieValue(existingChallenge.setCookie);
    const configRoot = serve.controlRoot;

    const restart = await runCli([
      'restart',
      '--workspace', serve.workspace,
      '--control-root', configRoot,
    ]);
    assert.equal(restart.exit.exited, true, 'restart CLI must exit');
    assert.equal(restart.exit.code, 0, `restart CLI failed: ${restart.stderr.slice(-800)}`);
    await waitForServeEvent(serve, 'restart.ready');

    const oldChallenge = await postPair(serve.banner.url, stale.receipt.code);
    assert.equal(oldChallenge.status, 401, `stale challenge survived restart: ${JSON.stringify(oldChallenge)}`);
    assert.equal(oldChallenge.body?.error?.code, 'auth.pair.invalid');

    const existingSession = await request(`${serve.banner.url}/api/auth/session`, { headers: { cookie: existingCookie } });
    assert.equal(existingSession.body?.authenticated, true, 'valid browser session must survive restart');

    const fresh = await runPair(serve);
    assert.equal(fresh.exit.code, 0, `post-restart pair failed: ${fresh.stderr.slice(-600)}`);
    const paired = await postPair(serve.banner.url, fresh.receipt.code);
    assert.equal(paired.status, 200, `fresh challenge rejected after restart: ${JSON.stringify(paired)}`);
    const cookie = cookieValue(paired.setCookie);
    const session = await request(`${serve.banner.url}/api/auth/session`, { headers: { cookie } });
    assert.equal(session.body?.authenticated, true);

    return {
      staleChallenge: { status: oldChallenge.status, code: oldChallenge.body?.error?.code },
      existingSession: { authenticated: existingSession.body?.authenticated },
      freshChallenge: { pairExitCode: fresh.exit.code, status: paired.status, authenticated: session.body?.authenticated },
      restartCli: { exitCode: restart.exit.code },
    };
  } finally {
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function restartPendingFifoCase() {
  const serve = await startServe({ fakeStepDelayMs: 25 });
  try {
    const restartServe = await prepareServeRestart(serve);
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200);
    const cookie = cookieValue(paired.setCookie);

    // Confirm a requirement and restart inside the 100ms FIFO visibility window
    // so the retired runtime's pending visibility timer is the only thing that
    // could still dispatch it.
    await confirmRequirement(serve.banner.url, cookie, {
      sourceRef: 'ui:restart-pending-fifo',
      rawInput: 'restart before the confirmed FIFO drains',
      proposal: 'create restart pending FIFO work',
    });
    const preRestart = await readRuntimeJournal(serve.controlRoot);
    assert.equal(preRestart.pendingDraftIds.length, 1, `confirmation must be durably queued before restart: ${JSON.stringify(preRestart)}`);

    const restart = await restartServe();
    assert.equal(restart.status, 202, `authenticated restart failed: ${JSON.stringify(restart)}`);
    await waitForServeEvent(serve, 'restart.ready');

    // The replacement runtime hydrates the durable queue and dispatches it once.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tasks = await waitForTaskCompletion(serve, cookie, 15_000);
    assert.equal(tasks.counts.total, 1, `replacement runtime must materialize exactly one task: ${JSON.stringify(tasks.counts)}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const postRestart = await readRuntimeJournal(serve.controlRoot);
    assert.equal(postRestart.taskCreated, 1, `expected exactly one task.created across restart: ${JSON.stringify(postRestart)}`);
    assert.equal(postRestart.operationStarted, 1, `expected exactly one operation.started across restart: ${JSON.stringify(postRestart)}`);
    assert.deepEqual(postRestart.pendingDraftIds, [], `durable queue must drain exactly once: ${JSON.stringify(postRestart)}`);

    return {
      preRestartPending: preRestart.pendingDraftIds.length,
      taskCreated: postRestart.taskCreated,
      operationStarted: postRestart.operationStarted,
      completed: tasks.counts.completed,
      pendingAfter: postRestart.pendingDraftIds.length,
      restartStatus: restart.status,
    };
  } finally {
    const closure = await closeServe(serve);
    assert.equal(closure.exited, true, 'serve must exit after SIGTERM');
    assert.equal(closure.pidGone, true, 'serve PID must be gone');
    assert.equal(closure.portRefused, true, 'serve port must be refused after exit');
    assert.equal(closure.rootReleased, true, 'owned attempt root must be removed');
  }
}

async function sigtermPendingFifoCase() {
  const serve = await startServe({ fakeStepDelayMs: 25 });
  try {
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200);
    const cookie = cookieValue(paired.setCookie);

    await confirmRequirement(serve.banner.url, cookie, {
      sourceRef: 'ui:sigterm-pending-fifo',
      rawInput: 'shutdown before the confirmed FIFO drains',
      proposal: 'create shutdown pending FIFO work',
    });
    const preShutdown = await readRuntimeJournal(serve.controlRoot);
    assert.equal(preShutdown.pendingDraftIds.length, 1, `confirmation must be durably queued before shutdown: ${JSON.stringify(preShutdown)}`);
    assert.equal(preShutdown.taskCreated, 0, 'no task may be created before the quiesced shutdown');

    const shutdown = await stopChild(serve.child);
    const pidGone = !(await pidExists(serve.pid));
    const port = await portRefused('127.0.0.1', serve.port);
    assert.equal(shutdown.exited, true, 'serve must exit after SIGTERM');
    assert.equal(pidGone, true, 'serve PID must be gone');
    assert.equal(port.refused, true, 'serve port must be refused after exit');

    const postShutdown = await readRuntimeJournal(serve.controlRoot);
    assert.equal(postShutdown.taskCreated, 0, `retired runtime must not dispatch after shutdown: ${JSON.stringify(postShutdown)}`);
    assert.equal(postShutdown.operationStarted, 0, `retired runtime must not start after shutdown: ${JSON.stringify(postShutdown)}`);
    assert.equal(postShutdown.pendingDraftIds.length, 1, `durable queue must survive shutdown for replay: ${JSON.stringify(postShutdown)}`);

    await rm(serve.attemptRoot, { recursive: true, force: true });
    assert.equal(existsSync(serve.attemptRoot), false);
    return {
      pendingBefore: preShutdown.pendingDraftIds.length,
      taskCreated: postShutdown.taskCreated,
      operationStarted: postShutdown.operationStarted,
      pendingAfter: postShutdown.pendingDraftIds.length,
      pidGone,
      portRefused: port.refused,
      rootReleased: !existsSync(serve.attemptRoot),
    };
  } finally {
    if (serve.child.exitCode === null && serve.child.signalCode === null) {
      const shutdown = await stopChild(serve.child);
      if (!shutdown.exited) throw new Error(`serve PID ${serve.pid} did not exit; retained root ${serve.attemptRoot}`);
    }
    if (existsSync(serve.attemptRoot)) await rm(serve.attemptRoot, { recursive: true, force: true });
  }
}

async function sigtermCase() {
  const serve = await startServe({ fakeStepDelayMs: 6_000 });
  let stream;
  try {
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200);
    const cookie = cookieValue(paired.setCookie);
    const { operationId } = await createTaskAndStart(serve, cookie, 'hold the listener open until SIGTERM');
    stream = await openSse(`${serve.banner.url}/api/executions/${encodeURIComponent(operationId)}/events`, cookie);
    await stream.waitFor((event) => event.data?.kind !== undefined || event.event !== undefined, 'first active SSE event');
    const shutdownStartedAt = Date.now();
    const shutdown = await stopChild(serve.child);
    const shutdownElapsedMs = Date.now() - shutdownStartedAt;
    assert.equal(
      shutdown.exited,
      true,
      `serve must exit after SIGTERM; elapsedMs=${shutdownElapsedMs}; exitCode=${String(serve.child.exitCode)}; signalCode=${String(serve.child.signalCode)}`,
    );
    assert.equal(await stream.waitForClosed(8_000), true, 'active SSE must close during SIGTERM shutdown');
    const shutdownEvent = stream.events.find((event) => event.event === 'server.shutdown');
    assert.ok(shutdownEvent, 'active SSE should receive server.shutdown');
    const pidGone = !(await pidExists(serve.pid));
    const port = await portRefused('127.0.0.1', serve.port);
    assert.equal(pidGone, true);
    assert.equal(port.refused, true);
    await rm(serve.attemptRoot, { recursive: true, force: true });
    assert.equal(existsSync(serve.attemptRoot), false);
    return {
      pid: serve.pid,
      port: serve.port,
      shutdownElapsedMs,
      shutdownEvent: true,
      sseClosed: true,
      pidGone,
      portRefused: port.refused,
      rootReleased: !existsSync(serve.attemptRoot),
    };
  } finally {
    if (stream) await stream.close();
    if (serve.child.exitCode === null && serve.child.signalCode === null) {
      const shutdown = await stopChild(serve.child);
      if (!shutdown.exited) {
        throw new Error(`serve PID ${serve.pid} did not exit; retained root ${serve.attemptRoot}`);
      }
    }
    if (existsSync(serve.attemptRoot)) await rm(serve.attemptRoot, { recursive: true, force: true });
  }
}

async function sharedControlRootCrossProcessCase() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-real-shared-control-'));
  const controlRoot = join(root, 'control');
  const serveA = await startServe({
    attemptRoot: join(root, 'serve-a'),
    workspace: join(root, 'workspace-a'),
    controlRoot,
    fakeStepDelayMs: 1_000,
    port: 0,
  });
  const serveB = await startServe({
    attemptRoot: join(root, 'serve-b'),
    workspace: join(root, 'workspace-b'),
    controlRoot,
    fakeStepDelayMs: 1_000,
    port: 0,
  });
  let streamA;
  let streamB;
  let streamA2;
  let streamB2;
  const readGeneration = async () => {
    const credential = JSON.parse(await readFile(join(controlRoot, 'security', 'web-access.json'), 'utf8'));
    assert.equal(Number.isSafeInteger(credential.sessionGeneration), true, 'persisted generation must be a safe integer');
    return credential.sessionGeneration;
  };
  const pairAndOpenSse = async (serve, label) => {
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200, `${label} post-restart pairing failed: ${JSON.stringify(paired)}`);
    const cookie = cookieValue(paired.setCookie);
    const { operationId } = await createTaskAndStart(serve, cookie, `${label} shared-control-root task`);
    const stream = await openSse(`${serve.banner.url}/api/executions/${encodeURIComponent(operationId)}/events`, cookie);
    await stream.waitFor((event) => event.data?.kind !== undefined || event.event !== undefined, `${label} first SSE event`);
    return { cookie, operationId, stream };
  };

  try {
    const firstA = await pairAndOpenSse(serveA, 'a');
    const firstB = await pairAndOpenSse(serveB, 'b');
    streamA = firstA.stream;
    streamB = firstB.stream;
    const generationBeforeLogoutA = await readGeneration();

    const logoutA = await request(`${serveA.banner.url}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(firstA.cookie, serveA.banner.url),
    });
    assert.equal(logoutA.status, 200, `logout through A failed: ${JSON.stringify(logoutA)}`);
    const generationAfterLogoutA = await readGeneration();
    assert.equal(generationAfterLogoutA, generationBeforeLogoutA + 1, 'logout through A must increment the shared persistent generation');

    await streamA.waitForClosed();
    await streamB.waitForClosed();
    assert.equal(await streamB.closed, true, 'foreign logout must close the other server active SSE');
    const oldCookieA = await request(`${serveA.banner.url}/api/tasks`, { headers: { cookie: firstA.cookie } });
    const oldCookieB = await request(`${serveB.banner.url}/api/tasks`, { headers: { cookie: firstB.cookie } });
    assert.equal(oldCookieA.status, 401, `old cookie must be rejected on A after logout: ${JSON.stringify(oldCookieA)}`);
    assert.equal(oldCookieB.status, 401, `old cookie must be rejected on B after foreign logout: ${JSON.stringify(oldCookieB)}`);

    const secondA = await pairAndOpenSse(serveA, 'a2');
    const secondB = await pairAndOpenSse(serveB, 'b2');
    streamA2 = secondA.stream;
    streamB2 = secondB.stream;
    const generationBeforeLogoutB = await readGeneration();

    const logoutB = await request(`${serveB.banner.url}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(secondB.cookie, serveB.banner.url),
    });
    assert.equal(logoutB.status, 200, `logout through B failed: ${JSON.stringify(logoutB)}`);
    const generationAfterLogoutB = await readGeneration();
    assert.equal(generationAfterLogoutB, generationBeforeLogoutB + 1, 'logout through B must increment the shared persistent generation');

    await streamA2.waitForClosed();
    await streamB2.waitForClosed();
    const secondOldA = await request(`${serveA.banner.url}/api/tasks`, { headers: { cookie: secondA.cookie } });
    const secondOldB = await request(`${serveB.banner.url}/api/tasks`, { headers: { cookie: secondB.cookie } });
    assert.equal(secondOldA.status, 401, `second old cookie must be rejected on A after B logout: ${JSON.stringify(secondOldA)}`);
    assert.equal(secondOldB.status, 401, `second old cookie must be rejected on B after its logout: ${JSON.stringify(secondOldB)}`);

    const thirdA = await pairAndOpenSse(serveA, 'a3');
    const thirdB = await pairAndOpenSse(serveB, 'b3');
    const generationBeforeConcurrent = await readGeneration();
    const [concurrentA, concurrentB] = await Promise.all([
      request(`${serveA.banner.url}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(thirdA.cookie, serveA.banner.url),
      }),
      request(`${serveB.banner.url}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(thirdB.cookie, serveB.banner.url),
      }),
    ]);
    assert.equal(concurrentA.status, 200, `concurrent A logout failed: ${JSON.stringify(concurrentA)}`);
    assert.equal(concurrentB.status, 200, `concurrent B logout failed: ${JSON.stringify(concurrentB)}`);
    const generationAfterConcurrent = await readGeneration();
    assert.ok(
      generationAfterConcurrent >= generationBeforeConcurrent + 2,
      `concurrent invalidations must serialize and increase generation: before=${generationBeforeConcurrent}, after=${generationAfterConcurrent}`,
    );

    return {
      ports: { a: serveA.port, b: serveB.port },
      pids: { a: serveA.pid, b: serveB.pid },
      generations: {
        beforeLogoutA: generationBeforeLogoutA,
        afterLogoutA: generationAfterLogoutA,
        beforeLogoutB: generationBeforeLogoutB,
        afterLogoutB: generationAfterLogoutB,
        beforeConcurrent: generationBeforeConcurrent,
        afterConcurrent: generationAfterConcurrent,
      },
      logoutA: { status: logoutA.status, foreignSseClosed: await streamB.closed, foreignCookieStatus: oldCookieB.status },
      logoutB: { status: logoutB.status, foreignSseClosed: await streamA2.closed, foreignCookieStatus: secondOldA.status },
      concurrent: { statuses: [concurrentA.status, concurrentB.status] },
      sessionIssuanceAfterForeignRevocation: {
        a: { status: 200, authenticated: true },
        b: { status: 200, authenticated: true },
      },
    };
  } finally {
    if (streamA) await streamA.close();
    if (streamB) await streamB.close();
    if (streamA2) await streamA2.close();
    if (streamB2) await streamB2.close();
    for (const serve of [serveA, serveB]) {
      const closure = await closeServe(serve);
      assert.equal(closure.exited, true, `serve PID ${serve.pid} must exit after SIGTERM`);
      assert.equal(closure.pidGone, true, `serve PID ${serve.pid} must be gone`);
      assert.equal(closure.portRefused, true, `serve port ${serve.port} must be refused after exit`);
      assert.equal(closure.rootReleased, true, `owned attempt root ${serve.attemptRoot} must be removed`);
    }
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, 'shared control root must be removed after both servers close');
  }
}

async function staleCredentialLockRecoveryCase() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-real-stale-credential-lock-'));
  const controlRoot = join(root, 'control');
  const serveA = await startServe({
    attemptRoot: join(root, 'serve-a'),
    workspace: join(root, 'workspace-a'),
    controlRoot,
    fakeStepDelayMs: 1_000,
    port: 0,
  });
  const serveB = await startServe({
    attemptRoot: join(root, 'serve-b'),
    workspace: join(root, 'workspace-b'),
    controlRoot,
    fakeStepDelayMs: 1_000,
    port: 0,
  });
  const credentialPath = join(controlRoot, 'security', 'web-access.json');
  const lockPath = `${credentialPath}.lock`;
  let streamA;
  let streamB;
  let holder;
  const readGeneration = async () => {
    const credential = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.equal(Number.isSafeInteger(credential.sessionGeneration), true, 'persisted generation must be a safe integer');
    return credential.sessionGeneration;
  };
  const pairAndOpenSse = async (serve, label) => {
    const pair = await runPair(serve);
    const paired = await postPair(serve.banner.url, pair.receipt.code);
    assert.equal(paired.status, 200, `${label} pairing failed: ${JSON.stringify(paired)}`);
    const cookie = cookieValue(paired.setCookie);
    const { operationId } = await createTaskAndStart(serve, cookie, `${label} stale-lock recovery task`);
    const stream = await openSse(`${serve.banner.url}/api/executions/${encodeURIComponent(operationId)}/events`, cookie);
    await stream.waitFor((event) => event.data?.kind !== undefined || event.event !== undefined, `${label} first SSE event`);
    return { cookie, stream };
  };

  try {
    const firstA = await pairAndOpenSse(serveA, 'a');
    const firstB = await pairAndOpenSse(serveB, 'b');
    streamA = firstA.stream;
    streamB = firstB.stream;

    await createDeadCredentialLockFixture(lockPath);
    assert.equal(existsSync(lockPath), true, 'dead-owner lock fixture must exist before recovery');
    const generationBefore = await readGeneration();

    const [logoutA, logoutB] = await Promise.all([
      request(`${serveA.banner.url}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(firstA.cookie, serveA.banner.url),
      }),
      request(`${serveB.banner.url}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(firstB.cookie, serveB.banner.url),
      }),
    ]);
    assert.equal(logoutA.status, 200, `stale-recovery logout A failed: ${JSON.stringify(logoutA)}`);
    assert.equal(logoutB.status, 200, `stale-recovery logout B failed: ${JSON.stringify(logoutB)}`);
    assert.deepEqual([logoutA.status, logoutB.status], [200, 200], 'both stale-recovery mutations must be accepted');
    const generationAfter = await readGeneration();
    assert.equal(generationAfter, generationBefore + 2, 'two accepted mutations must produce exactly two generation increments');
    await streamA.waitForClosed();
    await streamB.waitForClosed();
    const oldA = await request(`${serveA.banner.url}/api/tasks`, { headers: { cookie: firstA.cookie } });
    const oldB = await request(`${serveB.banner.url}/api/tasks`, { headers: { cookie: firstB.cookie } });
    assert.equal(oldA.status, 401, 'cookie invalidated by the first mutation must be rejected');
    assert.equal(oldB.status, 401, 'cookie invalidated by the second mutation must be rejected');

    const betweenPair = await runPair(serveA);
    const between = await postPair(serveA.banner.url, betweenPair.receipt.code);
    assert.equal(between.status, 200, `between-invalidation pairing failed: ${JSON.stringify(between)}`);
    const betweenCookie = cookieValue(between.setCookie);

    holder = await spawnCredentialLockHolder(lockPath);
    const busy = await request(`${serveA.banner.url}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(betweenCookie, serveA.banner.url),
    }, { timeoutMs: 8_000 });
    assert.equal(busy.status, 503, `active owner must not be stolen: ${JSON.stringify(busy)}`);
    assert.equal(busy.body?.error?.code, 'auth.credentials.busy', 'busy lock must fail explicitly');
    const stillValid = await request(`${serveA.banner.url}/api/tasks`, { headers: { cookie: betweenCookie } });
    assert.equal(stillValid.status, 200, 'failed logout must not revoke the active session');
    const holderPid = holder.pid;
    const holderExit = await stopChild(holder);
    holder = undefined;
    assert.equal(holderExit.exited, true, 'credential lock holder must exit after exact SIGTERM');
    assert.equal(await pidExists(holderPid), false, 'credential lock holder PID must be gone');

    const laterLogout = await request(`${serveB.banner.url}/api/auth/logout`, {
      method: 'POST',
      headers: authHeaders(betweenCookie, serveB.banner.url),
    });
    assert.equal(laterLogout.status, 200, `later logout failed: ${JSON.stringify(laterLogout)}`);
    const rejectedBetween = await request(`${serveB.banner.url}/api/tasks`, { headers: { cookie: betweenCookie } });
    assert.equal(rejectedBetween.status, 401, 'session issued between completed invalidations must be rejected by later logout');
    assert.equal(await readGeneration(), generationAfter + 1, 'later logout must increment exactly once');

    return {
      ports: { a: serveA.port, b: serveB.port },
      pids: { a: serveA.pid, b: serveB.pid },
      staleFixture: { lockExisted: true, generationBefore },
      concurrentLogout: {
        statuses: [logoutA.status, logoutB.status],
        acceptedMutations: 2,
        generationAfter,
        generationDelta: generationAfter - generationBefore,
      },
      oldCredentials: { a: oldA.status, b: oldB.status },
      activeOwner: {
        holderPid,
        busyStatus: busy.status,
        busyCode: busy.body?.error?.code,
        holderExit,
        sessionStillValid: stillValid.status,
      },
      laterLogout: {
        status: laterLogout.status,
        betweenSessionStatusAfterLogout: rejectedBetween.status,
        generationAfter: await readGeneration(),
      },
    };
  } finally {
    if (streamA) await streamA.close();
    if (streamB) await streamB.close();
    if (holder?.pid) {
      const holderExit = await stopChild(holder);
      if (!holderExit.exited) throw new Error(`credential lock holder PID ${holder.pid} did not exit`);
    }
    for (const serve of [serveA, serveB]) {
      const closure = await closeServe(serve);
      assert.equal(closure.exited, true, `serve PID ${serve.pid} must exit after SIGTERM`);
      assert.equal(closure.pidGone, true, `serve PID ${serve.pid} must be gone`);
      assert.equal(closure.portRefused, true, `serve port ${serve.port} must be refused after exit`);
      assert.equal(closure.rootReleased, true, `owned attempt root ${serve.attemptRoot} must be removed`);
    }
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, 'stale-lock fixture root must be removed after all owners exit');
  }
}

async function main() {
  const { evidencePath, caseName } = parseArgs(process.argv.slice(2));
  const report = {
    schema: 'humanagent.real-network-access-control.v2',
    startedAt: new Date().toISOString(),
    candidate: {
      cwd: repoPath,
      head: process.env.HUMANAGENT_E2E_HEAD ?? null,
      tree: process.env.HUMANAGENT_E2E_TREE ?? null,
    },
    cliPath,
    cases: [],
    result: 'INCOMPLETE',
  };
  if (!existsSync(cliPath)) throw new Error(`built CLI is missing: ${cliPath}`);
  const evidenceDir = evidencePath ? dirname(evidencePath) : join(tmpdir(), 'humanagent-network-evidence');
  await mkdir(evidenceDir, { recursive: true });

  const cases = [
    ['loopback_default_and_wildcard_lan_tailscale_protected_api', () => wildcardBindCase(evidenceDir)],
    ['pair_session_csrf_logout_active_sse', pairingAndSseCase],
    ['invalid_request_target_survives_daemon', invalidRequestTargetCase],
    ['shared_control_root_cross_process_generation', sharedControlRootCrossProcessCase],
    ['stale_credential_lock_recovery', staleCredentialLockRecoveryCase],
    ['health_method_and_side_effect_boundary', healthCase],
    ['explicit_loopback_v4_v6_isolation', loopbackCase],
    ['invalid_host_and_occupied_port_fail_closed', startupFailureCase],
    ['browser_login_current_origin_api_and_eventsource', () => browserCase(evidenceDir)],
    ['short_ttl_real_server_consumer_expiry', expiryCase],
    ['restart_command_invalidates_pairing_challenge', restartChallengeInvalidationCase],
    ['in_process_restart_pending_fifo_no_duplicate', restartPendingFifoCase],
    ['sigterm_pending_fifo_survives_for_replay', sigtermPendingFifoCase],
    ['sigterm_active_sse_external_closure', sigtermCase],
    ['credential_watch_failure_settles_active_execution', credentialWatchFailureActiveStopCase],
  ].filter(([name]) => caseName === null || name === caseName);
  if (cases.length === 0) throw new Error(`unknown case: ${caseName}`);
  for (const [name, run] of cases) await runCase(report, name, run);

  report.finishedAt = new Date().toISOString();
  report.result = report.cases.every((entry) => entry.status === 'PASS') ? 'PASS' : 'FAIL';
  if (evidencePath) {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify({
    schema: report.schema,
    result: report.result,
    cases: report.cases.map((entry) => ({ name: entry.name, status: entry.status, error: entry.error ?? null })),
    evidencePath,
  }, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}

await main();
