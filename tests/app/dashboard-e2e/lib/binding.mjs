/**
 * Candidate binding and isolated runtime registration — design skeleton.
 *
 * Owns graph node: candidate_binding.
 *
 * Binds the attempt to one candidate SHA/tree/diff digest and registers the
 * resources this attempt creates (owner, run id, workspace, control root,
 * serve PID, loopback port, temp paths) before any work starts, so cleanup has
 * an authoritative inventory.
 */

export function bindCandidate() {
  throw notImplemented('bindCandidate');
}

export function registerAttemptResources() {
  throw notImplemented('registerAttemptResources');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e binding.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
