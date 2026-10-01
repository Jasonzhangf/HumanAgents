/**
 * Authoritative journal reader — design skeleton.
 *
 * Owns graph nodes: local_search_terminal, aitest_terminal.
 *
 * Turn/tool counting and terminal-state assertions MUST come from the
 * authoritative UI runtime journal of the attempt's isolated control root
 * (`<controlRoot>/sessions/<workspace-key>/checkpoints/ui-runtime/<provider>/ui-runtime-journal.jsonl`),
 * not from the bounded `dashboard.recentEvents` window (last 20 events).
 */

export function journalPathFor() {
  throw notImplemented('journalPathFor');
}

export function readJournalEvents() {
  throw notImplemented('readJournalEvents');
}

export function countTurnEvidence() {
  throw notImplemented('countTurnEvidence');
}

export function assertVerifiableTerminal() {
  throw notImplemented('assertVerifiableTerminal');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e journal.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
