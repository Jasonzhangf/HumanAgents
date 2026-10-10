/**
 * Attempt cleanup and closure — real implementation.
 *
 * Owns graph node: <cmd>_cleanup (in every per-command graph), which runs
 * BEFORE the single-sink attempt_receipt so the receipt can carry the cleanup
 * verification conclusion.
 *
 * Settled branch (candidate service): stop this task, prove settlement from the
 * authoritative journal, then release exactly the resources this attempt
 * registered — the candidate serve PID (explicit PID, SIGTERM), the browser and
 * the ephemeral attempt root. Every release step is verified, not assumed. The
 * canonical control root, journal/checkpoint roots and this attempt's
 * run-notes receipts/screenshots are persistent and are NOT deleted.
 *
 * Settled branch (installed-attach): release only this attempt's attachment and
 * browser. The formal owner's PID/port/service are kept; PID-exit and
 * port-closed are reported as not-applicable with the retained-identity proof.
 *
 * Unsettled branch: do NOT stop the owned serve or the attached owner. The
 * recovery resources (service, workspace, control root, journal and evidence)
 * are retained, one actual recovery owner is recorded, and the attempt stays
 * INCOMPLETE.
 *
 * Never pkill / killall / kill $(...) / xargs kill: only explicit PIDs.
 */

import { access, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { jsonRequest, sleep } from './browser.mjs';
import { taskIdValue } from './binding.mjs';
import {
  assessSettlement,
  isLegalTerminalState,
  journalPathFor,
  resolveExecutionIdentity,
} from './journal.mjs';

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

function idValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && value !== null ? value.value : String(value);
}

function sameId(left, right) {
  const a = idValue(left);
  const b = idValue(right);
  return a !== null && b !== null && a === b;
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
  const expectedOutcome = options.expectedOutcome ?? binding.outcome ?? 'success';
  const attached = binding.serviceMode === 'installed-attach';
  const terminalState = options.terminalState ?? binding.terminalState ?? null;
  // The stop POST is issued at most once. Its receipt is cached independently of
  // the settlement assessment, so a later call with a complete execution
  // identity reassesses read-only instead of re-POSTing or blindly returning the
  // earlier (possibly incomplete-scope) assessment.
  const control = binding.attemptControl ?? (binding.attemptControl = {});
  const hasStopAttempt = control.stopAttempted === true;
  // Read-only path. An installed-attach attempt never stops the formal owner,
  // and a task that already reached a legal terminal is only assessed. Neither
  // case sends a stop.
  if (attached || isLegalTerminalState(terminalState)) {
    await ensureJournalPaths(binding);
    const settlement = await assessSettlement(binding, {
      expectedOutcome,
      minCheckpoints: options.minCheckpoints,
      minToolRounds: options.minToolRounds,
    });
    control.settlement = settlement;
    return {
      stopped: false,
      readOnly: true,
      attached,
      state: terminalState,
      settled: settlement.settled,
      reason: settlement.reason,
      settlementReason: settlement.reason,
      terminal: settlement.terminal ?? null,
      evidence: settlement.evidence ?? null,
    };
  }
  if (!target) {
    return { stopped: false, reason: 'no task id', state: null, settled: false };
  }
  // A stop is a control operation. Its identity prerequisite is enforced here,
  // in the single owner that can issue the POST, including the runner's generic
  // exception path. A missing/corrupt/ambiguous Journal or a Dashboard
  // disagreement leaves the task untouched for recovery.
  if (hasStopAttempt) {
    await ensureJournalPaths(binding);
    const settlement = await assessSettlement(binding, {
      expectedOutcome,
      minCheckpoints: options.minCheckpoints,
      minToolRounds: options.minToolRounds,
    });
    control.settlement = settlement;
    return {
      stopped: control.stopResponse !== null && control.stopResponse !== undefined,
      readOnly: true,
      reassessed: true,
      stopResponse: control.stopResponse ?? null,
      state: terminalState,
      settled: settlement.settled,
      reason: settlement.reason,
      settlementReason: settlement.reason,
      terminal: settlement.terminal ?? null,
      evidence: settlement.evidence ?? null,
    };
  }
  const identity = await verifyStopIdentity(binding, target);
  if (!identity.ok) {
    control.identityError = identity.reason;
    return {
      stopped: false,
      identityVerified: false,
      state: null,
      settled: false,
      reason: identity.reason,
      settlementReason: identity.reason,
    };
  }
  control.identity = identity.identity;
  control.dashboardIdentity = identity.dashboard;
  // Only a running candidate-owned task reaches here: issue the single formal
  // task-scoped stop through the paired session.
  const url = `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(target))}/stop`;
  if (!hasStopAttempt) {
    let stopResponse;
    try {
      const response = await (binding.auth?.fetch ?? fetch)(url, { method: 'POST' });
      stopResponse = { status: response.status, body: await response.text() };
    } catch (error) {
      control.stopAttempted = true;
      control.stopResponse = null;
      control.stopError = `stop request failed: ${error.message}`;
      return { stopped: false, reason: control.stopError, state: null, settled: false };
    }
    control.stopAttempted = true;
    control.stopResponse = stopResponse;
  }
  const stopResponse = control.stopResponse;
  const state = await pollUntil('task settled', async () => {
    const probe = await jsonRequest(`${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(target))}/dashboard`, {}, binding.auth).catch(() => null);
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
  await ensureJournalPaths(binding);
  // Truthful settlement: the dashboard state alone is insufficient. Require the
  // authoritative Journal terminal plus compatible checkpoint/operation closure
  // and effect evidence. A missing/corrupt journal leaves the attempt unsettled.
  const settlement = await assessSettlement(binding, {
    expectedOutcome,
    minCheckpoints: options.minCheckpoints,
    minToolRounds: options.minToolRounds,
  });
  control.settlement = settlement;
  const terminal = settlement.settled ? settlement.terminal : (settlement.terminal ?? null);
  return {
    stopped: true,
    stopResponse,
    state,
    settled: settlement.settled,
    reason: settlement.settled ? undefined : settlement.reason,
    terminal,
    toolRounds: settlement.evidence?.toolRounds ?? null,
    checkpointCommitted: settlement.evidence?.checkpointCommitted ?? null,
    settlementReason: settlement.reason,
    evidence: settlement.evidence ?? null,
  };
}

/**
 * Read the authoritative Journal and the task-scoped Dashboard before a stop.
 * The target task must agree with any already-bound scope, the verified
 * operation.started identity must be complete, and the Dashboard must expose
 * the same operation/epoch. No Dashboard value is used to invent identity.
 */
async function verifyStopIdentity(binding, target) {
  const boundTask = binding.taskId ?? binding.scope?.taskId ?? null;
  if (boundTask !== null && !sameId(boundTask, target)) {
    return {
      ok: false,
      reason: `stop target ${JSON.stringify(idValue(target))} conflicts with bound task ${JSON.stringify(idValue(boundTask))}`,
    };
  }
  const scopedTask = binding.scope?.taskId ?? null;
  if (scopedTask !== null && !sameId(scopedTask, target)) {
    return {
      ok: false,
      reason: `stop target ${JSON.stringify(idValue(target))} conflicts with execution scope task ${JSON.stringify(idValue(scopedTask))}`,
    };
  }
  await ensureJournalPaths(binding);
  if (!binding.journalPaths?.length) {
    return { ok: false, reason: 'verified execution identity unavailable: no authoritative journal path' };
  }
  const expectedBinding = {
    ...binding,
    taskId: target,
    scope: {
      ...(binding.scope ?? {}),
      taskId: target,
    },
  };
  const resolved = await resolveExecutionIdentity(expectedBinding).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (!resolved.ok) {
    return { ok: false, reason: `verified execution identity unavailable: ${resolved.reason}` };
  }
  const identity = resolved.identity;
  if (!sameId(identity.taskId, target)) {
    return {
      ok: false,
      reason: `verified execution identity task ${JSON.stringify(idValue(identity.taskId))} does not match stop target ${JSON.stringify(idValue(target))}`,
    };
  }
  if (!identity.operationId || !Number.isSafeInteger(identity.executionEpoch) || identity.executionEpoch <= 0) {
    return { ok: false, reason: 'verified execution identity is incomplete: operationId and positive executionEpoch are required' };
  }
  if (binding.operationId && !sameId(binding.operationId, identity.operationId)) {
    return {
      ok: false,
      reason: `verified execution identity operation ${JSON.stringify(idValue(identity.operationId))} conflicts with bound operation ${JSON.stringify(idValue(binding.operationId))}`,
    };
  }
  if (binding.executionEpoch !== null && binding.executionEpoch !== undefined
      && binding.executionEpoch !== identity.executionEpoch) {
    return {
      ok: false,
      reason: `verified execution identity epoch ${identity.executionEpoch} conflicts with bound epoch ${binding.executionEpoch}`,
    };
  }
  let dashboard;
  try {
    dashboard = await jsonRequest(
      `${binding.serveBaseUrl}/api/tasks/${encodeURIComponent(taskIdValue(target))}/dashboard`,
      {},
      binding.auth,
    );
  } catch (error) {
    return {
      ok: false,
      reason: `stop identity dashboard probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!sameId(dashboard?.operationId, identity.operationId)) {
    return {
      ok: false,
      reason: `dashboard operationId ${JSON.stringify(idValue(dashboard?.operationId))} does not match verified journal operation ${JSON.stringify(idValue(identity.operationId))}`,
    };
  }
  if (!Number.isSafeInteger(dashboard?.executionEpoch) || dashboard.executionEpoch !== identity.executionEpoch) {
    return {
      ok: false,
      reason: `dashboard executionEpoch ${JSON.stringify(dashboard?.executionEpoch)} does not match verified journal epoch ${identity.executionEpoch}`,
    };
  }
  return {
    ok: true,
    identity,
    dashboard: {
      state: dashboard.state ?? null,
      operationId: dashboard.operationId,
      executionEpoch: dashboard.executionEpoch,
    },
  };
}

/** Resolve the attempt's journal path if a journal has been written but not yet located. */
async function ensureJournalPaths(binding) {
  if (binding.journalPaths?.length) return binding.journalPaths;
  if (binding.journalPath) {
    binding.journalPaths = [binding.journalPath];
    return binding.journalPaths;
  }
  if (!binding.controlRoot) return [];
  const path = await journalPathFor(binding).catch(() => null);
  return path ? (binding.journalPaths ?? [path]) : [];
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

function pathContains(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

async function removeTempRoots(binding, options = {}) {
  const results = [];
  const attemptRoot = binding.attemptRoot ? resolve(binding.attemptRoot) : null;
  for (const root of binding.tempRoots ?? []) {
    const resolvedRoot = resolve(root);
    if (options.requireAttemptRoot === true && (!attemptRoot || !pathContains(attemptRoot, resolvedRoot))) {
      results.push({
        path: root,
        removed: false,
        owner: 'attempt',
        reason: `refused: temp root is not within this attempt's registered root ${binding.attemptRoot ?? '<missing>'}`,
      });
      continue;
    }
    const protectedPath = (options.protectedPaths ?? []).find((candidate) => candidate && pathsOverlap(resolvedRoot, candidate));
    if (protectedPath) {
      results.push({
        path: root,
        removed: false,
        owner: 'attempt',
        protectedPath,
        reason: `refused: attempt temp root overlaps retained formal/evidence path ${protectedPath}`,
      });
      continue;
    }
    try {
      await rm(root, { recursive: true, force: true });
      results.push({ path: root, owner: 'attempt', ...(await verifyPathRemoved(root)) });
    } catch (error) {
      results.push({ path: root, owner: 'attempt', removed: false, reason: `rm failed for ${root}: ${error.message}` });
    }
  }
  return results;
}

function formalRecoveryResources(binding) {
  const owner = binding.attachedOwner;
  if (!owner) {
    throw new Error('installed-attach recovery requires the verified attachedOwner identity');
  }
  const missing = ['ownerId', 'pid', 'port', 'leaseId', 'generation'].filter((key) => owner[key] === undefined || owner[key] === null);
  if (!binding.formalWorkspace) missing.push('formalWorkspace');
  if (!binding.formalPaths?.controlRoot) missing.push('formalPaths.controlRoot');
  if (!binding.formalPaths?.projectRoot) missing.push('formalPaths.projectRoot');
  if (!binding.attachedLeasePath) missing.push('attachedLeasePath');
  if (missing.length > 0) {
    throw new Error(`installed-attach recovery requires verified formal identity/paths: missing ${missing.join(', ')}`);
  }
  const formalPaths = binding.formalPaths ?? {};
  const journalPath = binding.journalPath ?? (binding.journalPaths ?? []).find(Boolean) ?? null;
  const checkpointPaths = (binding.journalPaths ?? []).filter((path) => path && path !== journalPath);
  const resources = [{
    kind: 'formal-owner',
    owner: 'formal',
    ownerId: owner.ownerId ?? null,
    pid: owner.pid ?? null,
    port: owner.port ?? null,
    leaseId: owner.leaseId ?? null,
    generation: owner.generation ?? null,
  }];
  if (binding.formalWorkspace) {
    resources.push({ kind: 'formal-workspace', owner: 'formal', path: binding.formalWorkspace });
  }
  if (formalPaths.controlRoot) {
    resources.push({ kind: 'formal-control-root', owner: 'formal', path: formalPaths.controlRoot });
  }
  if (formalPaths.projectRoot) {
    resources.push({ kind: 'formal-project-root', owner: 'formal', path: formalPaths.projectRoot });
  }
  if (binding.attachedLeasePath) {
    resources.push({
      kind: 'formal-lease',
      owner: 'formal',
      path: binding.attachedLeasePath,
      projectRoot: binding.attachedLeaseProjectRoot ?? null,
    });
  }
  if (journalPath) {
    resources.push({ kind: 'formal-journal', owner: 'formal', path: journalPath });
    resources.push({ kind: 'formal-checkpoint-root', owner: 'formal', path: dirname(journalPath) });
  }
  for (const checkpointPath of checkpointPaths) {
    resources.push({ kind: 'formal-checkpoint', owner: 'formal', path: checkpointPath });
  }
  return resources;
}

/**
 * Settled branch: stop + verify the task, release this attempt's serve PID,
 * browser and temp roots, then verify all three.
 */
export async function closeSettledAttempt(binding, settleResult) {
  registerCleanupInventory(binding);
  const attached = binding.serviceMode === 'installed-attach';
  // Candidate mode stops its own exact recorded PID; installed-attach mode never
  // stops the formal owner. Both release this attempt's browser/attachment.
  const serveExit = attached
    ? { stopped: null, reason: 'not applicable: attached owner must be retained' }
    : await stopServeProcess(binding);
  const browser = await (binding.browser?.close() ?? Promise.resolve()).then(
    () => ({ closed: true }),
    (error) => ({ closed: false, reason: `browser close failed: ${error.message}` }),
  );
  // Persistent roots (control root, journal/checkpoint, run-notes receipts) are
  // never part of tempRoots. In attached mode only the attempt-owned ephemeral
  // root is removed; the formal owner's workspace/lease are not registered here.
  const tempRemoved = await removeTempRoots(binding);
  const port = attached
    ? { closed: null, reason: 'not applicable: attached owner owns the listener' }
    : await verifyPortClosed(binding);
  const allRemoved = tempRemoved.every((entry) => entry.removed);
  const cleanup = {
    branch: attached ? 'attached-released' : 'settled',
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
    persistentRetained: binding.persistentRoots ?? [],
    recoveryRetained: [],
    settled: true,
  };
  binding.cleanup = cleanup;
  binding.cleaned = attached
    ? browser.closed && allRemoved
    : serveExit.stopped && browser.closed && allRemoved && port.closed;
  return cleanup;
}

/**
 * Unsettled branch: keep the recovery resources, record the single recovery
 * owner, and leave the attempt INCOMPLETE.
 */
export async function retainUnsettledRecovery(binding, reason, settleResult = null) {
  registerCleanupInventory(binding);
  // Do NOT stop the owned serve (candidate) or the attached owner: the
  // task/service is exactly what recovery needs. Only a side-effect-free browser
  // context is closed; that is not recovery closure and cannot be reported as it.
  //
  // Retention consumes the stop/settle result the attempt already obtained
  // (the single owner ran earlier). It never issues another stop POST or repeats
  // the settlement probe.
  const control = binding.attemptControl ?? null;
  const latestAssessment = control?.settlement
    ? {
        stopped: control.stopAttempted === true,
        stopResponse: control.stopResponse ?? null,
        settled: control.settlement.settled,
        reason: control.settlement.reason ?? null,
        settlementReason: control.settlement.reason ?? null,
        terminal: control.settlement.terminal ?? null,
        evidence: control.settlement.evidence ?? null,
      }
    : null;
  const taskStop = settleResult ?? latestAssessment ?? control?.stopSettle ?? null;
  const browser = await (binding.browser?.close() ?? Promise.resolve()).then(
    () => ({ closed: true }),
    (error) => ({ closed: false, reason: `browser close failed: ${error.message}` }),
  );
  const attached = binding.serviceMode === 'installed-attach';
  const attachedOwner = binding.attachedOwner ?? null;
  // An installed-attach attempt can fail before the owner/PID/endpoint are
  // verified (wrong owner, missing lease, endpoint mismatch, provider probe).
  // That terminal still owns attempt resources, but it has no verified formal
  // identity to retain. Keep the two cases separate so the strict
  // formalRecoveryResources inventory is never loosened for a real owner.
  const unverifiedAttachment = attached && !attachedOwner;
  const recoveryOwner = binding.recoveryOwner ?? 'humanagent.runtime.task-recovery';
  let recoveryRetained;
  let tempRemoved = [];
  let released = [];
  if (attached) {
    // A verified attached owner is external: preserve its identity and formal
    // execution paths. A pre-verification refusal has no formal identity to
    // retain, so only the attempt's own roots are accounted for.
    recoveryRetained = attachedOwner ? formalRecoveryResources(binding) : [];
    // The formal workspace/lease and this attempt's persistent roots are the
    // deletion-protection boundary: a temp root that overlaps any of them is
    // refused rather than removed, using the same ownership/non-overlap guard
    // as the verified-owner branch.
    const protectedPaths = [
      binding.formalWorkspace,
      binding.formalPaths?.controlRoot,
      binding.formalPaths?.projectRoot,
      binding.attachedLeaseProjectRoot,
      binding.attachedLeasePath,
      binding.journalPath,
      ...(binding.journalPaths ?? []),
      binding.controlRoot,
      binding.runNotesRoot,
      binding.receiptDir,
      ...(binding.persistentRoots ?? []),
    ].filter(Boolean);
    tempRemoved = await removeTempRoots(binding, { protectedPaths, requireAttemptRoot: true });
    for (const entry of tempRemoved) {
      if (entry.removed === true) {
        // Recorded as released only after verified removal.
        released.push({ kind: 'attempt-root', owner: 'attempt', path: entry.path, removed: true });
      } else {
        // Ownership/non-overlap could not be proven, or removal failed: keep the
        // exact path, owner, reason, recovery responsibility and next step so a
        // refused root is never misread as released.
        recoveryRetained.push({
          kind: 'attempt-root',
          owner: 'attempt',
          path: entry.path,
          retained: true,
          reason: entry.reason ?? 'attempt temp root was not removed',
          recoveryOwner,
          nextStep: unverifiedAttachment
            ? 'inspect the retained attempt root and the pre-verification refusal, then remove the attempt root; no formal owner was verified so no formal stop/takeover applies'
            : 'the recovery owner inspects the retained attempt root and formal service, settles the task, then removes the attempt root',
        });
      }
    }
  } else {
    // Candidate recovery keeps the live service, persistent control/journal tree
    // and the ephemeral attempt workspace/logs for the recovery owner.
    recoveryRetained = [
      ...(binding.servePid ? [{ kind: 'serve-pid', pid: binding.servePid, port: binding.servePort ?? null }] : []),
      ...(binding.controlRoot ? [{ kind: 'control-root', path: binding.controlRoot }] : []),
      ...(binding.workspace ? [{ kind: 'workspace', path: binding.workspace }] : []),
      ...(binding.receiptDir ? [{ kind: 'evidence', path: binding.receiptDir }] : []),
    ];
  }
  // Recovery acceptance needs real receipt evidence from the accepting owner. A
  // bare owner name proves nothing, so without a receipt reference the handoff
  // stays pending and the attempt remains INCOMPLETE.
  const acceptance = binding.recoveryAcceptance ?? null;
  const acceptanceReceipt = acceptance?.receiptRef ?? acceptance?.receiptPath ?? null;
  const recoveryAccepted = Boolean(acceptanceReceipt);
  const cleanup = {
    branch: 'unsettled-recovery-retained',
    reason: String(reason ?? 'attempt did not reach a verifiable terminal'),
    recoveryOwner,
    recoveryAccepted,
    recoveryAcceptanceStatus: recoveryAccepted ? 'accepted' : 'pending',
    recoveryAcceptedReason: recoveryAccepted
      ? null
      : 'no acceptance receipt: a bare recovery owner name does not prove the handoff was received',
    recoveryAcceptanceReceipt: acceptanceReceipt,
    recoveryAcceptedBy: acceptance?.acceptedBy ?? null,
    nextStep: unverifiedAttachment
      ? 'no formal owner was verified: inspect the retained attempt resources and the pre-verification refusal, remove any retained attempt root, then re-run with a verified formal owner; do not blind-rerun the scenario'
      : 'the recovery owner inspects the retained service, control root and journal, settles the task, then archives/removes only the released attempt resources; do not blind-rerun the scenario',
    taskId: binding.taskId ?? null,
    taskStop,
    servePid: binding.servePid ?? null,
    serveExited: unverifiedAttachment ? null : false,
    serveExitReason: unverifiedAttachment
      ? 'no verified attached owner: no candidate or formal service was started or stopped'
      : 'retained for recovery: the owned/attached service was intentionally not stopped',
    browserClosed: browser.closed,
    tempRoots: binding.tempRoots ?? [],
    tempRootsRemoved: attached ? tempRemoved.every((entry) => entry.removed) : false,
    tempRootResults: tempRemoved,
    persistentRoots: binding.persistentRoots ?? [],
    persistentRetained: binding.persistentRoots ?? [],
    recoveryRetained,
    released,
    settled: false,
  };
  binding.cleanup = cleanup;
  binding.cleaned = false;
  return cleanup;
}

export { join };
