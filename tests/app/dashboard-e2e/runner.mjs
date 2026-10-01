#!/usr/bin/env node
/**
 * Dashboard E2E runner entry — design skeleton.
 *
 * Design:   docs/ui/dashboard-e2e-runner-design.md
 * Contract: docs/ui/dashboard-e2e-acceptance.md
 * Graph:    docs/dagpipe/dashboard-e2e.graph.json
 *
 * Single entry for the three acceptance commands:
 *   pnpm e2e:dashboard:web-search
 *   pnpm e2e:dashboard:local-file-search
 *   pnpm e2e:dashboard:aitest
 *
 * Owns graph nodes: web_search_execution, local_search_execution,
 * aitest_execution, attempt_failure_detect.
 *
 * Only the declared interface exists here. Behavior is implemented after the
 * design DAG passes independent review; until then every entry throws, so no
 * scenario can report a false pass.
 */

export const SCENARIOS = Object.freeze(['web-search', 'local-file-search', 'aitest']);

export function parseScenario(argv) {
  throw notImplemented('parseScenario');
}

export async function runScenario() {
  throw notImplemented('runScenario');
}

export async function main() {
  throw notImplemented('main');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e runner.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
