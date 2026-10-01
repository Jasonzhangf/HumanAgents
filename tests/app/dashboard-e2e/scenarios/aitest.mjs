/**
 * Scenario: AItest task — design skeleton.
 *
 * Owns graph nodes: aitest_entry, aitest_capability, aitest_checker.
 *
 * Runs one bounded real task in a fresh AItest run directory under this
 * attempt's isolated location, without overwriting any existing run data, and
 * then runs the task's own checker.
 *
 * Evidence this module owns:
 *  - the AItest repo, target task and applicable checker were verified first;
 *  - the new run directory did not exist before the attempt;
 *  - the produced artifact exists at the task's required path;
 *  - the checker's raw stdout and exit code are preserved verbatim;
 *  - the human-observation record required by the task (screenshot plus
 *    conclusion about semantic/visual result) is captured.
 *
 * Checker success alone is not task acceptance, and the existence of
 * HTML/SVG/animation tags alone does not prove the task completed.
 */

export const SCENARIO = 'aitest';

export async function runAitestScenario() {
  throw notImplemented('runAitestScenario');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e aitest.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
