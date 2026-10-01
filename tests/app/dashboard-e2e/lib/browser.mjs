/**
 * Real browser session and serve lifecycle — design skeleton.
 *
 * Owns graph node: browser_session (in every per-command graph).
 *
 * Starts the attempt's own `humanagent serve` instance on the isolated control
 * root and workspace, waits for the runtime to report ready, launches a real
 * headless browser against the served Dashboard, and exposes the page helpers
 * the scenarios use: type into the new-task form, wait for the visible draft,
 * confirm it, wait for the task to enter the run queue, open the task detail,
 * read the DOM assertions, and capture the human-observation screenshots.
 *
 * The attempt's serve PID and port are registered here and are the exact
 * resources the cleanup closure stops and verifies.
 *
 * Behavior is implemented only after the design DAG passes independent review;
 * until then every entry throws, so no scenario can report a false pass.
 */

export async function startServeForAttempt() {
  throw notImplemented('startServeForAttempt');
}

export async function launchBrowserSession() {
  throw notImplemented('launchBrowserSession');
}

export async function submitDirectiveAndConfirmDraft() {
  throw notImplemented('submitDirectiveAndConfirmDraft');
}

export async function captureScreenshot() {
  throw notImplemented('captureScreenshot');
}

function notImplemented(name) {
  return new Error(
    `dashboard-e2e browser.${name} is not implemented yet; see docs/ui/dashboard-e2e-runner-design.md`,
  );
}
