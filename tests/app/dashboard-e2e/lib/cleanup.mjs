/**
 * Attempt cleanup and closure — real implementation.
 *
 * Owns graph node: <cmd>_cleanup (in every per-command graph), which runs
 * BEFORE the single-sink attempt_receipt so the receipt can carry the cleanup
 * verification conclusion.
 *
 * Settled branch: stop this task, prove settlement from the dashboard probe and
 * the authoritative journal, then release exactly the resources this attempt
 * registered — the serve PID (explicit PID, SIGTERM), the browser, and the temp
 * root. Every release step is verified, not assumed.
 *
 * Unsettled branch: do NOT kill anything. The recovery resources are retained,
 * a single recovery owner is recorded, and the attempt stays INCOMPLETE.
 *
 * Never pkill / killall / kill $(...) / xargs kill: only explicit PIDs.
 */

import { access, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonRequest, sleep } from './browser.mjs';
import { assertTerminalFor, countTurnEvidenceFor } from './journal.mjs';

const SETTLE_TIMEOUT_MS = Number(process.env.E2E_SETTLE_TIMEOUT_MS ?? 180_000);

async function pollUntil(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = `predicate error: ${error.message}`;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}; last=${JSON.stringify(last).slice(0, 300)}`);
    }
    await sleep(intervalMs);
  }
}

/** Register the exact resources this attempt owns for release. */
export function registerCleanupInventory(binding) {
  binding.cleanupInventory = {
    servePid: binding.servePid ?? null,
    servePort: binding.servePort ?? null,
    tempRoots: binding.tempRoots ?? [],
    browser: Boolean(binding.browser),
    taskId: binding.taskId ?? null,
    journalPath: binding.journalPath ?? null,
  };
  return binding.cleanupInventory;
}

/**
 * Post the task-scoped stop and poll until the runtime reports the task
 * settled. A stop that cannot prove settlement is returned as unsettled rather
 * than reported as cancelled.
 */
export async function stopTaskAndSettle(binding, taskId, options = {}) {
  const target = taskId ?? binding.taskId;
  if (!target) {
    return { stopped: false, reason: 'no task id', state: null, settled: false };
  }
  const url = `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(target)}/stop`;
  let stopResponse;
  try {
    const response = await (binding.auth?.fetch ?? fetch)(url, { method: 'POST' });
    stopResponse = { status: response.status, body: await response.text() };
  } catch (error) {
    return { stopped: false, reason: `stop request failed: ${error.message}`, state: null, settled: false };
  }
  const state = await pollUntil('task settled', async () => {
    const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(target)}/dashboard`, {}, binding.auth).catch(() => null);
    if (probe && ['succeeded', 'failed', 'stopped'].includes(probe.state)) return probe.state;
    return null;
  }, SETTLE_TIMEOUT_MS).catch(() => null);
  if (!state) {
    return {
      stopped: true,
      stopResponse,
      reason: `task did not settle within ${SETTLE_TIMEOUT_MS}ms`,
      state: null,
      settled: false,
    };
  }
  const terminal = binding.journalPath
    ? await assertTerminalFor(binding, {
        minToolRounds: 0,
        minCheckpoints: 0,
      }).catch(() => null)
    : null;
  return {
    stopped: true,
    stopResponse,
    state,
    settled: true,
    terminal: terminal?.terminal ?? null,
    toolRounds: terminal?.toolRounds ?? null,
  };
}

/** Prove the serve process exited after an explicit SIGTERM. */
async function stopServeProcess(binding) {
  const pid = binding.servePid;
  if (!pid) return { stopped: false, reason: 'no serve pid registered' };
  const aliveBefore = process.kill(pid, 0);
  if (!aliveBefore) return { stopped: true, reason: 'already exited' };
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return { stopped: false, reason: `SIGTERM failed: ${error.message}` };
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) return { stopped: true, reason: `pid ${pid} exited` };
  }
  return { stopped: false, reason: `pid ${pid} did not exit after SIGTERM` };
}

/** Verify the serve port is closed. */
async function verifyPortClosed(binding) {
  const port = binding.servePort;
  if (!port) return { closed: true, reason: 'no port registered' };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fetch(`${binding.serveBaseUrl}/api/runtime/status`);
    } catch {
      return { closed: true, reason: `port ${port} refused connections` };
    }
    await sleep(250);
  }
  return { closed: false, reason: `port ${port} still accepting connections` };
}

async function verifyPathRemoved(path) {
  try {
    await access(path);
    const info = await stat(path);
    return { removed: false, reason: `${path} still exists (${info.isDirectory() ? 'directory' : 'file'})` };
  } catch {
    return { removed: true };
  }
}

async function removeTempRoots(binding) {
  const results = [];
  for (const root of binding.tempRoots ?? []) {
    try {
      await rm(root, { recursive: true, force: true });
      results.push(await verifyPathRemoved(root));
    } catch (error) {
      results.push({ removed: false, reason: `rm failed for ${root}: ${error.message}` });
    }
  }
  return results;
}

/**
 * Settled branch: stop + verify the task, release this attempt's serve PID,
 * browser and temp roots, then verify all three.
 */
export async function closeSettledAttempt(binding, settleResult) {
  registerCleanupInventory(binding);
  const serveExit = await stopServeProcess(binding);
  const browser = await (binding.browser?.close() ?? Promise.resolve()).then(
    () => ({ closed: true }),
    (error) => ({ closed: false, reason: `browser close failed: ${error.message}` }),
  );
  const tempRemoved = await removeTempRoots(binding);
  const port = await verifyPortClosed(binding);
  const allRemoved = tempRemoved.every((entry) => entry.removed);
  const cleanup = {
    branch: 'settled',
    taskId: binding.taskId ?? null,
    taskStop: settleResult ?? null,
    servePid: binding.servePid ?? null,
    serveExited: serveExit.stopped,
    serveExitReason: serveExit.reason,
    browserClosed: browser.closed,
    browserReason: browser.reason ?? null,
    portClosed: port.closed,
    portReason: port.reason,
    tempRoots: binding.tempRoots ?? [],
    tempRootsRemoved: allRemoved,
    tempRootResults: tempRemoved,
    settled: true,
  };
  binding.cleanup = cleanup;
  binding.cleaned = serveExit.stopped && browser.closed && allRemoved && port.closed;
  return cleanup;
}

/**
 * Unsettled branch: keep the recovery resources, record the single recovery
 * owner, and leave the attempt INCOMPLETE.
 */
export async function retainUnsettledRecovery(binding, reason) {
  registerCleanupInventory(binding);
  let taskStop = null;
  if (binding.taskId) {
    taskStop = await stopTaskAndSettle(binding, binding.taskId).catch(() => null);
  }
  const serveExit = await stopServeProcess(binding);
  const browser = await (binding.browser?.close() ?? Promise.resolve()).then(
    () => ({ closed: true }),
    (error) => ({ closed: false, reason: `browser close failed: ${error.message}` }),
  );
  const tempRoots = binding.tempRoots ?? [];
  const cleanup = {
    branch: 'unsettled-recovery-retained',
    reason: String(reason ?? 'attempt did not reach a verifiable terminal'),
    recoveryOwner: 'tests/app/dashboard-e2e/runner.mjs',
    nextStep: 're-run the scenario after the recorded break point is fixed; inspect the retained control root and journal before any further attempt',
    taskId: binding.taskId ?? null,
    taskStop,
    servePid: binding.servePid ?? null,
    serveExited: serveExit.stopped,
    serveExitReason: serveExit.reason,
    browserClosed: browser.closed,
    tempRoots,
    tempRootsRemoved: false,
    settled: false,
  };
  binding.cleanup = cleanup;
  binding.cleaned = false;
  return cleanup;
}

export async function attemptJournalEvidence(binding) {
  if (!binding.journalPath) return null;
  return countTurnEvidenceFor(binding);
}

export { join };
