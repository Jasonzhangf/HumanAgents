/**
 * Scenario: local read-only search — design skeleton.
 *
 * Owns graph nodes: local_search_entry, local_search_browser_assertion.
 *
 * The real Responses tool loop must call `file.search` first and then read a
 * file that the search actually matched; reading a known path directly, using
 * the Explicit Brain intent, or substituting a read-only code inspection does
 * not satisfy the contract.
 *
 * Assertions this module owns:
 *  - `ProviderEvent.toolCall` is the only source of callId, toolId, arguments;
 *  - the same callId correlates the invoke and the typed result through the
 *    Dashboard API, SSE and DOM;
 *  - the task-scoped tool-output endpoint returns a report containing the query
 *    and the matching paths/line summaries;
 *  - the following `file.read` reads the same matched path;
 *  - workspace file manifests (relative path sorted, SHA-256 per file) taken
 *    before and after are identical, proving no file was modified;
 *  - a genuine zero-match search is reported as a real zero-match, never as a
 *    search that did not run.
 */

export const SCENARIO = 'local-file-search';

export async function runLocalFileSearchScenario() {
  throw notImplemented('runLocalFileSearchScenario');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e local-file-search.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
