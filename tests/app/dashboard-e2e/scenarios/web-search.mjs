/**
 * Scenario: network search — design skeleton.
 *
 * Owns graph nodes: web_search_entry, web_search_terminal.
 *
 * Requires the Agent Reach / Monid TinyFish provider path reviewed in
 * docs/architecture/hand-search-websearch-plan.md: the Dashboard task must make
 * a real provider tool call, and the task detail must show the real call, the
 * real sources (url/title) and a normal terminal state. Provider failure must
 * surface the real provider error; a fabricated empty success is forbidden.
 */

export const SCENARIO = 'web-search';

export async function runWebSearchScenario() {
  throw notImplemented('runWebSearchScenario');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e web-search.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
