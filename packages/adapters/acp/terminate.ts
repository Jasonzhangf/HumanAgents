/**
 * Terminating a spawned runtime process.
 *
 * `SIGTERM` is a request, not a result. A caller that reports a session as
 * closed while the process is still alive can commit a stopped checkpoint for
 * a runtime that is still running, so this resolves only after the process has
 * actually exited, and escalates to `SIGKILL` after a grace period.
 */
import type { ChildProcessLike } from 'node:child_process';

const DEFAULT_GRACE_MS = 5000;

export async function terminateProcess(process: ChildProcessLike, graceMs = DEFAULT_GRACE_MS): Promise<void> {
  if (hasExited(process)) return;
  process.kill('SIGTERM');
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const forcedKill = new Promise<void>((resolve) => {
    killTimer = setTimeout(() => {
      process.kill('SIGKILL');
      resolve();
    }, graceMs);
  });
  try {
    await Promise.race([exited(process), forcedKill]);
  } finally {
    // `Promise.race` does not cancel the loser, so the grace timer must be
    // cleared explicitly: otherwise a clean exit still holds the event loop
    // for the whole grace period after the caller has already moved on.
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
}

function hasExited(process: ChildProcessLike): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function exited(process: ChildProcessLike): Promise<void> {
  return new Promise((resolve) => {
    process.once('exit', () => resolve());
  });
}
