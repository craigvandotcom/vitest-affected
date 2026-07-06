/**
 * Shared execa resource limits for the replay harness — buffer caps, per-spawn
 * timeouts, and signal-handler grace windows. Centralized so the git wrapper,
 * the vitest spawns (exec.ts / analysis.ts), and the install spawns
 * (run.ts / walker.ts) all agree on the same finite bounds instead of each
 * silently inheriting execa's defaults.
 *
 * WHY FINITE BOUNDS: an unattended multi-hour walk must never hang forever on a
 * single wedged suite, nor silently truncate a huge `--reporter=json` capture on
 * execa's default 100MB cap (a truncated capture parses to an EMPTY outcome map,
 * which corrupts the analysis' ground truth without any error). Every long-lived
 * spawn gets an explicit cap + timeout so one bad commit is classified and the
 * walk CONTINUES.
 */

/**
 * Large finite stdout cap (256MB) for any spawn whose output we must capture
 * whole: git range output AND the vitest `--reporter=json` streams. execa's
 * default maxBuffer is 100MB (`1000 * 1000 * 100`, see
 * node_modules/execa/lib/arguments/specific.js) — a big consumer suite's JSON
 * report can exceed that, and on overflow execa terminates the child and
 * truncates stdout, so `parseOutcomes` yields an empty map and the analysis runs
 * on corrupt ground truth SILENTLY. 256MB is far above any realistic output here
 * while staying finite (an overflow still terminates rather than growing
 * unbounded). Was previously duplicated as GIT_STDOUT_MAX_BUFFER in git-cmd.ts.
 */
export const STDOUT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Per-commit vitest run timeout (30 min). A single hung suite must not stall an
 * unattended multi-hour walk forever. Generous — a full BCA suite is ~320s — so
 * only a genuinely wedged run trips it. The vitest spawns use `reject: false`
 * (a non-zero exit from FAILING tests is a valid, capturable outcome, not a
 * harness error), so on timeout execa does NOT throw — it resolves with a result
 * flagged `timedOut: true`, which the caller checks explicitly and classifies
 * BROKEN so the walk continues.
 */
export const VITEST_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Per-commit dependency-install timeout (15 min). The install spawns do NOT use
 * `reject: false`, so on timeout execa THROWS an ExecaError (`timedOut: true`),
 * which propagates into the existing install→BROKEN catch in run.ts's main loop.
 */
export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * `forceKillAfterDelay` for the vitest spawns: after a SIGTERM (from
 * `.kill()`, the `timeout`, or the signal handler) execa escalates to SIGKILL if
 * the child has not exited within this window. Gives vitest a moment to tear its
 * own worker pool down gracefully, then guarantees the direct child dies.
 */
export const CHILD_FORCE_KILL_MS = 5 * 1000;

/**
 * Bound on how long the signal handler waits for tracked children to exit after
 * SIGTERM before it force-kills survivors and proceeds to remove the clone. Kept
 * short (a few seconds) so Ctrl-C stays responsive.
 */
export const SIGNAL_CHILD_GRACE_MS = 5 * 1000;
