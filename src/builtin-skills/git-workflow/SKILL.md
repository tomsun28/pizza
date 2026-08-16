---
name: git-workflow
description: Git conventions for commits, branches, and pull requests. Use when committing changes, writing commit messages, rebasing, or preparing work for review and merge.
---

# Git Workflow

## Commit messages

Format: `type(scope): imperative summary`

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `build`, `ci`
- Summary: ≤ 72 chars, imperative mood ("add", not "added"/"adds"), no trailing period
- Body (when non-trivial): wrap at 72 chars, explain *why*, not *what* (the diff shows what)
- Breaking changes: add `!` after type and a `BREAKING CHANGE:` footer

Good examples:

```
fix(scheduler): accept all-numeric cron expressions in schedule shorthand
feat(cli): add --no-builtin-extensions flag
refactor(core): extract prompt resolution into shared helper
```

## What makes a good commit

- One logical change per commit — a commit should be reviewable on its own.
- The full test suite passes at every commit (bisectable history), not just at the tip.
- Never mix refactors with behavior changes; never mix formatting noise with logic.
- If a commit needs "and also..." to explain itself, split it.

## Staging work

- Prefer `git add -p` to stage logical hunks instead of whole files.
- Check `git diff --staged` before committing — verify you are committing what you think.
- Never commit: secrets, `.env`, build output, dependency dirs, large binaries, debug leftovers.

## Branches

- Branch from the default branch; keep the branch name short and descriptive (`fix/cron-numeric`, `feat/skills-toggle`).
- Rebase onto the target branch to keep history linear unless the project uses merge commits.
- One branch = one purpose. New idea mid-work? New branch.

## Pull requests

- Title: same convention as a commit summary.
- Description: what changed, why, how to test, and any follow-ups (with issue links).
- Keep PRs small (< ~400 lines changed when possible); big PRs get shallow reviews.
- Respond to every review comment: fix it, or explain why not.

## Interactive history cleanup (before pushing / opening a PR)

- `git rebase -i` to squash "wip"/"typo"/"fix review" commits into their target commits.
- `git commit --amend` for the newest commit only, and only before it is pushed.
- Never rewrite published history others may have based work on.

## Recovery quick reference

- Undo last commit, keep changes: `git reset --soft HEAD~1`
- Stash with description: `git stash push -m "wip: <what>"`
- Find which commit introduced a bug: `git bisect start` → `git bisect bad` → `git bisect good <ref>`
- See what a branch contains vs main: `git log main..HEAD --oneline`
- Rescue a lost commit: `git reflog` → `git branch rescue <sha>`
