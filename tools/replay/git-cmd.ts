/**
 * Thin git wrapper shared by the replay harness modules. Uses execa (already a
 * devDependency, matching test/integration.test.ts) so the harness spawns git
 * the same way the test scaffold does.
 */
import { execa } from 'execa';
import { STDOUT_MAX_BUFFER } from './limits.js';

// Large finite stdout cap (256MB, shared via limits.ts). execa's default
// maxBuffer (100MB) is not something we want to rely on for a long walk: a huge
// `rev-list`/`diff` range over a big repo can produce more output than the
// default and abort the walk mid-flight. A finite bound throws a catchable error
// (soft callers can degrade) rather than risking an unbounded buffer; 256MB is
// far above any realistic git text output here. Mirrors GIT_STDOUT_MAX_BUFFER in
// src/git.ts.

/**
 * Run a git subcommand in `cwd` and return trimmed stdout. Throws (via execa)
 * on non-zero exit — callers that want a soft outcome must catch.
 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd, maxBuffer: STDOUT_MAX_BUFFER });
  return stdout.trim();
}
