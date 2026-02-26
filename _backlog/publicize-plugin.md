# Publicize vitest-affected

Get the plugin in front of the Vitest community. Work through items sequentially.

## Prerequisites

- [ ] Publish to npm (blocked on 2FA setup)
- [ ] Confirm README is polished and has clear install/usage instructions

---

## 1. GitHub repo topics

**Effort:** 5 min
**Why:** Improves discoverability in GitHub search.

Add topics to the repo: `vitest`, `vitest-plugin`, `test-selection`, `test-impact-analysis`, `dependency-graph`, `typescript`, `developer-tools`.

```bash
gh repo edit --add-topic vitest,vitest-plugin,test-selection,test-impact-analysis,dependency-graph,typescript,developer-tools
```

---

## 2. Vitest GitHub Discussion

**Effort:** 30 min
**Why:** Highest-signal channel. Vitest maintainers monitor discussions. Could lead to ecosystem page listing.

Post in [vitest-dev/vitest Discussions](https://github.com/vitest-dev/vitest/discussions) under "Show and Tell" category.

**Draft angle:**
- Title: "vitest-affected — intelligent test selection plugin using importDurations"
- Lead with the problem: large test suites waste CI time running unaffected tests
- Show the result: 2,771 tests → 22 tests (98% reduction) on a real Next.js project
- Highlight that it uses Vitest's own `importDurations` API (runtime-first, not static analysis)
- Link to repo, mention it's open source MIT
- Ask: would this be a good fit for the Vitest ecosystem page?

**Key talking points:**
- Zero config beyond adding the plugin
- First run = full suite (populates dependency cache from runtime data)
- Subsequent runs = BFS on cached reverse dependency graph, ~5ms overhead
- Works with `configureVitest` hook (Vitest 3.2+)
- Handles deleted files, config changes, setup file changes (safety fallbacks)

---

## 3. Reddit posts

**Effort:** 20 min
**Why:** r/javascript and r/typescript have high developer traffic. Concrete numbers get upvoted.

**Subreddits:**
- r/javascript
- r/typescript
- r/webdev (optional)

**Draft angle:**
- Title: "I built a Vitest plugin that runs only tests affected by your changes — 98% test reduction on a 2,771-test project"
- Short post: problem, solution, real numbers, link to repo
- Don't be salesy — focus on the technical approach and results

---

## 4. Twitter/X post

**Effort:** 15 min
**Why:** Direct reach to Vitest maintainers and JS ecosystem.

**Tag:**
- @viboer (Vladimir, Vitest creator)
- @ArnaudBarre (Vitest maintainer)
- @sheremet_va (Vlad Sheremet, Vitest core)

**Draft:**
> Built a Vitest plugin for intelligent test selection — uses importDurations from Vitest 3.2 to build a dependency graph, then BFS-selects only affected tests.
>
> On a 2,771-test Next.js app: 98% reduction (22 tests instead of full suite).
>
> Open source: [link]

---

## 5. Dev.to / blog post

**Effort:** 1-2 hours
**Why:** Long-form content ranks in Google, establishes credibility, explains the technical approach.

**Draft outline:**
1. The problem: large test suites in CI
2. Existing approaches (Jest --changedSince, nx affected) and their limitations
3. The approach: runtime dependency graph from Vitest's importDurations
4. Architecture: configureVitest hook → cache → delta parse → BFS → selective include
5. Real-world results on body-compass-app
6. How to use it (install + config)
7. What's next

---

## 6. awesome-vitest / ecosystem listings

**Effort:** 30 min
**Why:** Curated lists are high-trust discovery channels.

- Search for `awesome-vitest` on GitHub — submit PR if it exists
- Check Vitest docs for an ecosystem/community page — request listing
- Check if there's a Vite ecosystem page that includes test plugins

---

## 7. npm README optimization

**Effort:** 15 min
**Why:** npm search results show the first ~200 chars of the README description.

Ensure the npm page (after publish) has:
- Clear one-line description
- Badge for npm version, license
- Quick install + config snippet visible above the fold
- The 98% reduction stat in the first paragraph

---

## Tracking

| # | Item | Status | Date |
|---|------|--------|------|
| 0 | Publish to npm | pending | |
| 1 | GitHub repo topics | pending | |
| 2 | Vitest GitHub Discussion | pending | |
| 3 | Reddit posts | pending | |
| 4 | Twitter/X post | pending | |
| 5 | Dev.to blog post | pending | |
| 6 | Ecosystem listings | pending | |
| 7 | npm README optimization | pending | |
