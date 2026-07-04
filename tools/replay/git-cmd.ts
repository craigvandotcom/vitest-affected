/**
 * Thin git wrapper shared by the replay harness modules. Uses execa (already a
 * devDependency, matching test/integration.test.ts) so the harness spawns git
 * the same way the test scaffold does.
 */
import { execa } from 'execa';

/**
 * Run a git subcommand in `cwd` and return trimmed stdout. Throws (via execa)
 * on non-zero exit — callers that want a soft outcome must catch.
 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return stdout.trim();
}
