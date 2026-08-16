---
name: debugging
description: Root-cause debugging methodology. Use when investigating bugs, crashes, unexpected behavior, or failing tests to find the actual cause instead of patching symptoms.
---

# Debugging

Goal: find the *cause*, not a patch that makes the symptom disappear.

## 1. Reproduce reliably

- Find the minimal, deterministic steps (or input) that trigger the bug.
- If it is intermittent, narrow the nondeterminism: timing, ordering, network, cache, concurrency, locale.
- Write the repro down; it becomes the regression test later.

If you cannot reproduce it, say so and gather more evidence instead of guessing.

## 2. Gather evidence before theorizing

- Read the actual error message and stack trace top to bottom. Note file:line.
- Collect: version/commit, environment (OS, runtime, deps), recent changes (`git log`, `git diff`).
- Add temporary logging or breakpoints around the failure point — measure, don't assume.
- Check logs *before* the first error; the first error is usually the root, later ones are fallout.

## 3. Localize

- Binary search the system: is the bug in input data, this module, the dependency, or the environment?
- Bisect history (`git bisect`) when the code worked before.
- Reduce the input or the code path until removing any part makes the bug vanish.
- State explicitly: "the code does X here, but I expected Y" — then find where X is decided.

## 4. Hypothesize → test → repeat

For each hypothesis (one at a time):

1. Write down the hypothesis and what evidence would confirm or refute it.
2. Design the cheapest experiment that distinguishes them (log, breakpoint, small script).
3. Run it. Record the result. Update or discard the hypothesis.

A hypothesis that cannot be disproven by an experiment is a guess, not a hypothesis.

## 5. Common root-cause categories (checklist)

- Wrong assumptions about input shape/encoding; off-by-one; mutation of shared state
- Stale cache / stale build / stale install (rebuild, clear caches first — cheapest to check)
- Time zones, locales, string case, unicode normalization, path separators
- Async ordering: unawaited promises, race conditions, event listener leaks
- Environment differences: versions, env vars, permissions, network access
- The bug is in the caller, not the callee — verify inputs at the boundary

## 6. Fix and verify

- Fix the cause at the right layer; avoid adding special cases downstream.
- Keep the fix minimal and targeted; do not bundle refactors into a bug fix.
- Verify: the repro now passes, the full test suite is green, and related paths still work.
- Add the repro as a regression test.
- Document the cause (comment/commit message) so the next reader learns what you learned.

## Anti-patterns

- Changing code without a hypothesis, hoping something works.
- Catching/ignoring the exception to silence the symptom.
- Blaming the compiler/runtime/dependency before proving it with an isolated test.
