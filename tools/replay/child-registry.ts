/**
 * Live-child registry — the bridge between the deep spawn sites (exec.ts's
 * `runCommit`, analysis.ts's `spawnDisabledRerun`) and the top-level signal
 * handler in run.ts.
 *
 * THE GAP THIS CLOSES: on Ctrl-C the old handler did `rmSync(cloneDir)` then
 * `process.exit(130)` while a ~320s vitest child (spawned via execa several call
 * frames down) was still alive — deleting the clone out from under a live worker
 * pool, and orphaning the child (execa's SIGTERM to `npx vitest` does not
 * reliably cascade to its forked tinypool workers when the parent just exits).
 * The handler cannot reach that child directly, so each spawn site TRACKS its
 * subprocess here; on signal, run.ts terminates every tracked child FIRST, waits
 * (bounded), and only THEN removes the clone and exits.
 *
 * Single-threaded walk: the main loop awaits each commit sequentially, so at
 * most one child is live at a time — a Set is used anyway to stay correct under
 * any future overlap and to make tracking a no-op cost.
 */
import type { ResultPromise } from 'execa';

const active = new Set<ResultPromise>();

/**
 * Bound on how long we wait for SIGKILL'd survivors to actually be reaped before
 * returning. SIGKILL is not catchable or ignorable, so the child WILL die — this
 * only covers reap latency (the OS delivering the signal + Node settling execa's
 * promise). Kept short so teardown can never hang: a child stuck in an
 * uninterruptible syscall (D-state) could otherwise defer its exit indefinitely,
 * and blocking the caller (→ clone deletion → process exit) on that is worse than
 * proceeding after a couple of seconds.
 */
const SIGKILL_REAP_MS = 2 * 1000;

/**
 * Register an execa subprocess as live and return it unchanged (so call sites
 * can `trackChild(execa(...))` inline). Auto-unregisters when the subprocess
 * settles — success, failure, or kill — so the registry never retains dead
 * handles. Attaching this extra `.then` is harmless alongside the caller's own
 * await (promises fan out to multiple consumers).
 */
export function trackChild<T extends ResultPromise>(child: T): T {
  active.add(child);
  void Promise.resolve(child).then(
    () => {
      active.delete(child);
    },
    () => {
      active.delete(child);
    },
  );
  return child;
}

/**
 * Terminate every tracked child and, before returning, ensure none is still live
 * — so the caller can delete the clone and exit without orphaning workers.
 *
 * Guarantee on return: every child tracked at entry has either exited or been
 * SIGKILL'd AND awaited to settle (bounded by SIGKILL_REAP_MS for reap latency).
 * SIGKILL is not catchable, so a "survivor" past that bound is one wedged in an
 * uninterruptible syscall, not one that escaped the signal.
 *
 * Sequence:
 *   1. SIGTERM every child (execa self-escalates to SIGKILL after
 *      CHILD_FORCE_KILL_MS via each spawn's `forceKillAfterDelay`).
 *   2. Race their settled exits against the `graceMs` grace window.
 *   3. SIGKILL any survivor (belt-and-suspenders backstop from the handler side).
 *   4. AWAIT the survivors' settled promises — bounded by SIGKILL_REAP_MS — so a
 *      not-yet-reaped worker pool cannot still hold the clone open when the caller
 *      rmSync's it.
 * Never throws — a kill on an already-dead child is swallowed.
 */
export async function killTrackedChildren(graceMs: number): Promise<void> {
  const children = [...active];
  if (children.length === 0) return;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already exited — nothing to signal */
    }
  }
  const allExited = Promise.allSettled(
    children.map((c) => Promise.resolve(c)),
  );
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    // Do not let the grace timer keep the event loop alive on its own.
    timer.unref?.();
  });
  try {
    await Promise.race([allExited, grace]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Hard-kill anything that ignored SIGTERM within the grace window (a wedged
  // suite past its own graceful teardown). The SIGTERM→SIGKILL escalation on the
  // spawn side is configured per-spawn via `forceKillAfterDelay`
  // (CHILD_FORCE_KILL_MS); this is the belt-and-suspenders backstop from the
  // handler side so the clone can be deleted without a live worker pool.
  const survivors = [...active];
  for (const child of survivors) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
  if (survivors.length === 0) return;
  // SIGKILL is delivered asynchronously and execa's promise settles a tick later
  // still — returning here (→ caller rmSync + process.exit) the instant after
  // .kill() would race deletion against a worker pool that has not yet released
  // the clone. Await the survivors' settled exits so the doc-comment guarantee
  // holds. Bounded by SIGKILL_REAP_MS so a D-state child can't hang teardown.
  let reapTimer: NodeJS.Timeout | undefined;
  const reaped = Promise.allSettled(survivors.map((c) => Promise.resolve(c)));
  const reapGrace = new Promise<void>((resolve) => {
    reapTimer = setTimeout(resolve, SIGKILL_REAP_MS);
    // Do not let the reap timer keep the event loop alive on its own.
    reapTimer.unref?.();
  });
  try {
    await Promise.race([reaped, reapGrace]);
  } finally {
    if (reapTimer) clearTimeout(reapTimer);
  }
}
