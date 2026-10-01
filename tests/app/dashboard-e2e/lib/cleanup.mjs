/**
 * Fixed cleanup closure — design skeleton.
 *
 * Owns graph nodes: web_search_cleanup, local_search_cleanup, aitest_cleanup,
 * attempt_stop_settle, attempt_settled_cleanup, attempt_unsettled_recovery.
 *
 * Two branches, decided by whether the task reached a proven settled terminal
 * state:
 *
 *  - settled: close this attempt's browser context, stop the serve process
 *    owned by this attempt by its exact PID, and verify PID exit, port closed
 *    and every attempt-created path removed, with raw exit codes recorded.
 *  - not settled: POST /api/tasks/{taskId}/stop and poll Dashboard and Journal
 *    until stop/checkpoint settle. If settle cannot be proven, keep the serve
 *    PID/port/paths needed for recovery, record a single recovery owner and the
 *    next step, mark the attempt INCOMPLETE, and do not claim cleanup.
 *
 * Never uses pkill/killall/kill $(...)/port-scan bulk termination.
 */

export function registerCleanupInventory() {
  throw notImplemented('registerCleanupInventory');
}

export async function stopTaskAndSettle() {
  throw notImplemented('stopTaskAndSettle');
}

export async function closeSettledAttempt() {
  throw notImplemented('closeSettledAttempt');
}

export async function retainUnsettledRecovery() {
  throw notImplemented('retainUnsettledRecovery');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e cleanup.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
