# CI-runner recon — BCA self-hosted runner (for B5 human gate: cache-v3 relative paths?)

**Bead:** va-yfn.5 (A3) — desk analysis only, no code/workflow changes.
**Sources:**
- `/Users/craigvanheerden/Repos/neometa/software/body-compass-app/.github/workflows/quality-gate.yml`
- Sibling workflows in the same dir (grepped for corroboration): `capacitor-check.yml`, `ios-spm-check.yml`, `claude-code-review.yml`, `claude.yml`, `modifier-integrity.yml`, `ios-release.yml`
- `/Users/craigvanheerden/Repos/neometa/software/body-compass-app/.gitignore` (line 238: `.vitest-affected/`)

## TL;DR — the two B5 questions

1. **Would a CI shadow run have a WARM plugin cache today? → No, almost certainly cold.** `.vitest-affected/` (where the plugin's cache/graph lives) is gitignored, and every workflow uses the stock `actions/checkout@v7` with no `clean: false` override — checkout's documented default (`clean: true`) runs `git clean -ffdx` before fetching, which deletes untracked/ignored paths including `.vitest-affected/`. Additionally, `quality-gate.yml` currently runs `pnpm test:all`, which explicitly sets `VITEST_AFFECTED_DISABLED=1` — so the plugin isn't even invoked in selective mode by the existing gate today.
2. **Do absolute checkout paths survive run-to-run? → Likely yes for the workspace root itself (self-hosted, fixed labels, no matrix), but irrelevant for `.vitest-affected/graph.json` because that file won't exist between runs (see #1) — nothing to compare paths against. If cache-v3 relative-path work proceeds, checkout-path stability should be confirmed on the physical runner host, not just inferred from YAML.**

## Evidence

### Runner identity
All workflows in `.github/workflows/` that touch this pipeline target the same runner label:

```
quality-gate.yml:25:    runs-on: [self-hosted, macOS]
capacitor-check.yml:27:    runs-on: [self-hosted, macOS]
ios-spm-check.yml:57:    runs-on: [self-hosted, macOS]
claude-code-review.yml:20:    runs-on: [self-hosted, macOS]
claude.yml:20:    runs-on: [self-hosted, macOS]
modifier-integrity.yml:15:    runs-on: [self-hosted, macOS]
ios-release.yml:52:    runs-on: [self-hosted, macOS]
```

`[self-hosted, macOS]` is a label pair, not a specific single-runner name — if more than one physical/VM runner is registered with both labels, GitHub Actions will schedule to whichever is idle, and the workspace path (and any local FS cache) would NOT be guaranteed to be the same machine run-to-run. **The YAML alone cannot tell us how many runners carry this label** — that's a runner-host-side fact (see "Open question" below).

### Checkout behavior
```yaml
# quality-gate.yml
- uses: actions/checkout@v7
  with:
    # Full history: vitest-affected compares against main, some tests use
    # `git grep` (e.g. zone-type-canonical), and prompt-drift diffs
    # origin/main...HEAD.
    fetch-depth: 0
```

No `clean:` input is set here (or in any sibling workflow — grepped for `actions/cache`, `rm -rf`, `clean`, `_work`, `GITHUB_WORKSPACE` across all 7 workflow files; none found beyond the checkout steps above). `actions/checkout`'s documented default is `clean: true`, meaning it runs `git clean -ffdx` in the workspace **before** fetching/checking out on every invocation. `git clean -ffdx` removes untracked AND git-ignored files/dirs — which is exactly what `.vitest-affected/` is (confirmed gitignored, see below). So even on a self-hosted runner that reuses the same on-disk workspace directory between runs (which self-hosted runners typically do — no ephemeral VM teardown the way GitHub-hosted runners have), the checkout step itself would wipe any `.vitest-affected/graph.json` / cache state left over from a prior run, before the current run's steps ever execute.

```
# .gitignore:238
.vitest-affected/
```

### Current gate doesn't run the plugin in selective mode at all
```yaml
# quality-gate.yml, "Unit + integration tests (vitest)" step
- name: Unit + integration tests (vitest)
  if: ${{ !cancelled() }}
  # Full suite (test:all sets VITEST_AFFECTED_DISABLED=1) — vitest-affected's
  # git-diff filter does NOT walk the cascade graph from __tests__/fixtures/**,
  # so affected-only mode under-runs when fixtures change. Predictable
  # full-suite runs are worth the extra minutes on the gate.
  run: pnpm test:all
```
This is a second, independent reason a "shadow run" today would see a cold/inert plugin: the gate deliberately disables affected-mode (`VITEST_AFFECTED_DISABLED=1`) by design, per the inline comment, because the git-diff filter doesn't walk the fixture-cascade graph correctly yet. Any hypothetical shadow run exercising vitest-affected in CI would be a **new, additional** step, not a repurposing of the existing gate step.

### No `actions/cache` usage anywhere
Grepped all 7 workflow files for `actions/cache`: zero matches. There is no GitHub Actions cache action wired to persist `.vitest-affected/` (or anything else) across runs. Persistence, if any, would have to come purely from the self-hosted runner's on-disk workspace being reused untouched between runs — which the `clean: true` default checkout behavior above defeats anyway.

## Answering the two questions explicitly

**Q1 — Warm cache today?** No. Three independent reasons, any one of which is sufficient on its own: (a) `.vitest-affected/` is gitignored/untracked so `actions/checkout`'s default `clean: true` (`git clean -ffdx`) deletes it before every run's steps execute; (b) no `actions/cache` step persists it explicitly either; (c) the current gate runs with `VITEST_AFFECTED_DISABLED=1`, so the plugin isn't even in the selective-mode code path today. A shadow run would start cold every time under the current workflow config.

**Q2 — Do absolute paths survive?** Partially answerable from YAML, partially not:
- What YAML confirms: self-hosted runners (unlike GitHub-hosted) don't tear down between jobs, and `runs-on: [self-hosted, macOS]` with no matrix/strategy means the workspace directory name pattern (derived from repo + workflow, GitHub Actions' standard `_work/<repo>/<repo>` layout) would be the same each time *if the same physical runner services the job*.
- What YAML cannot confirm: (i) how many runners are registered under the `[self-hosted, macOS]` label pool — if >1, the checkout path's parent (`_work` root) could differ between runners if they're on different machines/volumes; (ii) whether the runner's `_work` directory itself has ever been moved/reinstalled, changing the absolute path; (iii) whether `graph.json`'s cached absolute paths would even survive to be checked, given the answer to Q1 is "no, the dir gets wiped."
- **One-command check for a future session with runner host access:** `gh api /repos/<owner>/<repo>/actions/runners` (or, directly on the runner host, `cat ~/actions-runner/.runner` to read the configured `workFolder`) to confirm (a) exactly one runner carries the `self-hosted, macOS` label pair, and `find ~/actions-runner*/_work -maxdepth 3 -name '.vitest-affected'` after a couple of real CI runs to confirm whether it in fact persists in practice (contradicting the static clean-default analysis above would mean something overrides the default, e.g. an org-level runner group setting not visible in this repo's YAML).

## Bottom line for the B5 human gate

Given (1) no warm cache today under the current workflow, and (2) checkout-path stability is plausible but not proven for a multi-runner pool — a design that **requires** relative (not absolute) paths inside `.vitest-affected/graph.json` is the safer default for any future CI shadow-run of vitest-affected, independent of whatever the runner host turns out to do, since the cache is being rebuilt from scratch on every CI invocation regardless.
