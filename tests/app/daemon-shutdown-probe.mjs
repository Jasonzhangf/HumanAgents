// Diagnostic-only probe for task-14. It is loaded into a real `hm serve`
// process through NODE_OPTIONS=--import and records the shutdown timeline so the
// measurement harness can attribute the exit latency to a stage instead of
// guessing. It never changes control flow: it only observes SIGTERM, the HTTP
// server's shutdown calls, and the active handles at the moment the event loop
// would otherwise drain. Product code is untouched.
import http from 'node:http';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const rawFs = require('node:fs');

const out = process.env.HA_SHUTDOWN_PROBE;
const origin = Date.now();
// Captured before any wrapping so the probe can never recurse into itself.
const rawAppendFileSync = rawFs.appendFileSync;

function record(event, extra = {}) {
  if (out === undefined) return;
  try {
    rawAppendFileSync(out, `${JSON.stringify({ at: Date.now(), rel: Date.now() - origin, pid: process.pid, event, ...extra })}\n`);
  } catch {
    // A diagnostic must never break the process under measurement.
  }
}

// Separates two explanations for a stalled shutdown: synchronous work inside
// the process (CPU is consumed) versus the OS simply not scheduling the
// process (CPU is not consumed). Read-only wrappers; they always call through.
const syncStats = { calls: 0, totalMs: 0, slow: [] };
let recordingSync = false;

function wrapSync(target, name, label) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = function instrumentedSync(...args) {
    if (!recordingSync) return original.apply(this, args);
    const startedAt = Date.now();
    try {
      return original.apply(this, args);
    } finally {
      const ms = Date.now() - startedAt;
      syncStats.calls += 1;
      syncStats.totalMs += ms;
      if (ms >= 10) {
        syncStats.slow.push({ fn: label, ms, rel: Date.now() - origin, path: typeof args[0] === 'string' ? args[0] : null });
      }
    }
  };
}

if (out !== undefined && process.env.HA_SHUTDOWN_PROBE_SYNC !== undefined) {
  wrapSync(rawFs, 'readFileSync', 'readFileSync');
  wrapSync(rawFs, 'appendFileSync', 'appendFileSync');
  wrapSync(rawFs, 'statSync', 'statSync');
  wrapSync(rawFs, 'existsSync', 'existsSync');
  const rawCp = require('node:child_process');
  wrapSync(rawCp, 'execFileSync', 'execFileSync');
}

function connectionsOf(server) {
  try {
    return server?._connections ?? null;
  } catch {
    return null;
  }
}

function activeHandles() {
  try {
    const handles = process._getActiveHandles();
    return handles.map((handle) => handle?.constructor?.name ?? typeof handle);
  } catch {
    return [];
  }
}

if (out !== undefined) {
  record('probe.loaded', { node: process.version, argv: process.argv.slice(2) });

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let shuttingDown = false;
  let serverCloseCalled = false;
  let sampler = undefined;
  let tickCount = 0;
  let lastSampleRel = null;
  const eventLoopSnapshot = () => ({
    min: histogram.min,
    max: histogram.max,
    mean: histogram.mean,
    current: histogram.current,
  });

  const noopInterval = setInterval(() => {
    tickCount += 1;
    record('probe.tick', { rel: Date.now() - origin, tickCount });
  }, 5);
  noopInterval.unref?.();
  const cpuStartedAt = process.cpuUsage();

  process.on('SIGTERM', () => {
    const cpu0 = process.cpuUsage();
    recordingSync = true;
    record('sigterm.received', { eventLoopMs: eventLoopSnapshot(), cpu: cpu0 });
    shuttingDown = true;
    sampler = setInterval(() => {
      if (!shuttingDown) {
        clearInterval(sampler);
        return;
      }
      record('shutdown.sample', {
        serverCloseCalled,
        handles: activeHandles(),
        eventLoopMs: eventLoopSnapshot(),
      });
      trackPending('shutdown.pendingTimers');
      if (Date.now() - origin > 20_000) {
        clearInterval(sampler);
        sampler = undefined;
      }
    }, 100);
    // A ref'd sampler would itself keep the process alive and fake a long
    // shutdown, so it must not count as a reason to stay.
    sampler.unref?.();
  });
  process.on('SIGINT', () => record('sigint.received'));
  process.on('beforeExit', () => {
    if (sampler !== undefined) clearInterval(sampler);
    record('beforeExit', { handles: activeHandles() });
  });
  process.on('exit', () => {
    record('process.exit', {
      cpuDelta: (() => {
        try {
          const usage = process.cpuUsage(cpuStartedAt);
          return { user: usage.user, system: usage.system };
        } catch {
          return null;
        }
      })(),
      syncStats: { calls: syncStats.calls, totalMs: syncStats.totalMs, slow: syncStats.slow.slice(0, 20) },
    });
  });

  // Observes the takeover side of the handoff: the identity fetch the new
  // owner makes against the previous owner before it may signal it, plus the
  // supervisor control request. Both run before the 2_000 ms graceful clock
  // starts, so their latency is what squeezes the shutdown window under load.
  // Read-only: the original fetch always runs.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function instrumentedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const target = url.includes('/api/internal/supervisor/identity')
      ? 'identity-fetch'
      : url.includes('/api/internal/supervisor/')
        ? 'supervisor-control'
        : 'other';
    if (target !== 'other') record(`fetch.${target}.start`, { url });
    const started = Date.now();
    return originalFetch.apply(globalThis, [input, init]).then(
      (response) => {
        record(`fetch.${target}.response`, { url, ms: Date.now() - started, status: response?.status });
        return response;
      },
      (error) => {
        record(`fetch.${target}.error`, { url, ms: Date.now() - started, error: String(error) });
        throw error;
      },
    );
  };

  // Records every timer that outlives SIGTERM. A pending long timer tells us
  // whether the process is waiting on a real delay or on something else.
  const pendingTimers = new Map();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function instrumentedSetTimeout(callback, delay, ...rest) {
    if (!shuttingDown) return originalSetTimeout.call(globalThis, callback, delay, ...rest);
    const handle = originalSetTimeout.call(globalThis, function trackedTimer(...args) {
      pendingTimers.delete(handle);
      return callback.apply(this, args);
    }, delay, ...rest);
    pendingTimers.set(handle, { delay, armedRel: Date.now() - origin });
    return handle;
  };
  const trackPending = (label) => {
    const entries = [...pendingTimers.values()];
    if (entries.length > 0) record(label, { pending: entries.slice(0, 10) });
  };

  const proto = http.Server.prototype;
  const originalClose = proto.close;
  proto.close = function patchedClose(...args) {
    const server = this;
    serverCloseCalled = true;
    record('server.close.called', { connections: connectionsOf(server) });
    const mapped = args.map((argument) => (
      typeof argument === 'function'
        ? function patchedCloseCallback(...callbackArgs) {
          record('server.close.callback', { connections: connectionsOf(server) });
          return argument.apply(this, callbackArgs);
        }
        : argument
    ));
    return originalClose.apply(server, mapped);
  };

  if (typeof proto.closeIdleConnections === 'function') {
    const originalCloseIdle = proto.closeIdleConnections;
    proto.closeIdleConnections = function patchedCloseIdle(...args) {
      record('server.closeIdleConnections', { connections: connectionsOf(this) });
      return originalCloseIdle.apply(this, args);
    };
  }

  if (typeof proto.closeAllConnections === 'function') {
    const originalCloseAll = proto.closeAllConnections;
    proto.closeAllConnections = function patchedCloseAll(...args) {
      record('server.closeAllConnections', { connections: connectionsOf(this) });
      return originalCloseAll.apply(this, args);
    };
  }
}
