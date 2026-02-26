---
argument-hint: '[version] [--beta] [--dry-run]'
disable-model-invocation: false
name: bump-release
user-invocable: true
description: Use when the user asks to "bump release", "cut a release", "tag a release", "bump version", "create a new release", or mentions release versioning, changelog updates, or version tagging workflows.
---

# Bump Release

Support for both regular and beta releases.

## Parameters

- `version`: Optional explicit version to use (e.g., `2.0.0`). When provided, skips automatic version inference
- `--beta`: Create a beta release with `-beta.X` suffix
- `--dry-run`: Preview the release without making any changes (no file modifications, commits, or tags)

## Steps

0. **Locate the package** — Look for `package.json` in the current working directory. All file paths (`CHANGELOG.md`, `package.json`) are relative to the package directory.
1. Update the `CHANGELOG.md` file with all changes since the last version release (**skip this step for beta releases**).
2. Bump the version in `package.json`:
   - **Regular release**: Follow semantic versioning (e.g., 1.2.3)
   - **Beta release**: Add `-beta.X` suffix (e.g., 1.2.3-beta.1)
3. Commit the changes with a message like "docs: release <version>"
4. Create a new git tag by running `git tag -a v<version> -m "<version>"`

**Note**: When `--dry-run` flag is provided, display what would be done without making any actual changes to files, creating commits, or tags.

## Process

1. **Check for arguments** — Determine if `version` was provided, if this is a beta release (`--beta`), and/or dry-run (`--dry-run`)
2. **Check for clean working tree** — Run `git status --porcelain` to verify there are no uncommitted changes unrelated to this release
3. **Write Changelog** — Examine diffs between the current branch and the previous tag to write Changelog. Find relevant PRs by looking at the commit history and add them to each changelog entry (when available). Only include changes within the `src/` directory and root config files — exclude test changes, CI/CD workflows, and development tooling
4. **Check version** — Get current version from `package.json`
5. **Bump version** — If `version` argument provided, use it directly. Otherwise, increment per Semantic Versioning rules:
   - **PATCH** (x.x.X) — Bug fixes, documentation updates
   - **MINOR** (x.X.x) — New features, backward-compatible changes
   - **MAJOR** (X.x.x) — Breaking changes
   - **For beta releases** (`--beta` flag):
     - If current version has no beta suffix: Add `-beta.1` to the version
     - If current version already has beta suffix: Increment beta number
     - If moving from beta to release: Remove beta suffix and use the base version

## Changelog Format

Use Keep a Changelog format. Every entry must begin with a present-tense verb in imperative mood. Categories in order: Changed, Added, Removed, Fixed.

## Version Examples

| Current Version | Release Type   | New Version     |
| --------------- | -------------- | --------------- |
| `1.2.3`         | Regular        | `1.2.4` (patch) |
| `1.2.3`         | Beta           | `1.2.4-beta.1`  |
| `1.2.3-beta.1`  | Beta           | `1.2.3-beta.2`  |
| `1.2.3-beta.5`  | Regular        | `1.2.3`         |
| `1.2.3`         | `2.0.0`        | `2.0.0`         |
| `1.2.3`         | `2.0.0` + Beta | `2.0.0-beta.1`  |
