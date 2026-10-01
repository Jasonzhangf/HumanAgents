/**
 * Receipt emission — design skeleton.
 *
 * Owns graph nodes: web_search_receipt, local_search_receipt, aitest_receipt,
 * attempt_incomplete_receipt.
 *
 * Every attempt writes a receipt bound to the candidate SHA/tree. A failed,
 * timed-out or cancelled attempt writes an INCOMPLETE receipt carrying the
 * first deviation, the original error, the related task/operation/tool-call
 * ids and the cleanup/recovery state; it is never success evidence.
 */

export function buildReceipt() {
  throw notImplemented('buildReceipt');
}

export function writeReceipt() {
  throw notImplemented('writeReceipt');
}

export function writeIncompleteReceipt() {
  throw notImplemented('writeIncompleteReceipt');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e receipt.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
