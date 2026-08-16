---
name: refactoring
description: Safe refactoring workflow. Use when restructuring existing code without changing behavior - small steps, tests green at each step, no mixed refactors and feature changes.
---

# Refactoring

Refactoring changes structure without changing behavior. Every step keeps the tests green.

## Preconditions

1. Tests exist and pass before you start. No tests? Write characterization tests around the code first — they pin down current behavior, bugs included.
2. The build/lint/format setup is clean, so noise cannot hide real changes.
3. You can run the tests quickly; slow suites make refactors drift.

## The cycle

Repeat until done, committing between steps:

1. **Name the smell precisely.** Not "this file is bad" but "this function does parsing, IO, and retry policy".
2. **Pick the smallest step** that improves it (see catalog below).
3. **Apply the step** mechanically — no drive-by changes.
4. **Run tests.** Green → commit with `refactor:` message. Red → revert, make the step smaller.

If a step feels risky, it is too big. Split it.

## Rules of engagement

- Refactor commits contain **zero behavior change**. If you are tempted to fix a bug mid-refactor, note it and fix it in a separate commit.
- Work at the level of tests, not opinions: "tests still pass" is the definition of "same behavior".
- Keep public interfaces stable until the internal cleanup is done; change interfaces in their own steps.
- Update callers mechanically; let the compiler/type errors list your work items.
- Delete aggressively: dead code found during refactoring goes in a `refactor: remove dead code` commit.

## Step catalog (smallest → largest)

- Extract function / inline function
- Rename variable, function, type, file (naming is the highest-leverage refactor)
- Extract constant; replace magic values
- Move function/module to a better home; split mixed-responsibility file
- Replace conditional with polymorphism / lookup table
- Introduce parameter object instead of long parameter lists
- Unify duplicated logic into one helper (rule of three: duplicate twice is tolerable, three times is a smell)
- Invert dependency: have the caller pass in IO/clock/random instead of the module grabbing globals

## Verification checklist before opening the PR

- [ ] Full test suite green; no skipped tests added
- [ ] No public API changes unless that was the goal (and callers updated)
- [ ] `git diff` shows no unrelated formatting or leftover debug code
- [ ] Each commit builds and passes tests on its own
- [ ] Behavior-affecting fixes were moved to separate commits
