---
name: code-review
description: Systematic code review methodology. Use when reviewing a pull request, diff, or proposed changes to evaluate correctness, security, performance, and maintainability before approving.
---

# Code Review

Review changes in small, ordered passes. Do not try to judge everything at once.

## Pass 1: Understand the change

1. Read the title/description and the linked issue (if any). State the intended behavior in one sentence.
2. Look at the diff stat first: which files moved, which are new, which are tests.
3. If the diff is large, map it: list the logical units (e.g. "types", "core logic", "wiring", "tests").

If you cannot state what the change is supposed to do, ask before reviewing details.

## Pass 2: Correctness

- Trace the main happy path through the code by hand with a concrete example input.
- Check edge cases: empty input, single element, very large input, unicode/multi-byte strings, `null`/`undefined`, concurrency.
- Verify error handling: are errors caught at the right layer? Are messages actionable?
- Check invariants: are they documented and enforced (types, assertions, guards)?
- For bug fixes: is there a test that fails without the fix?

## Pass 3: Security & safety

- Untrusted input: where does data enter? Is it validated/escaped before use?
- Injection: SQL, shell, HTML/template, path traversal, regex (ReDoS).
- Secrets: no keys, tokens, or passwords in code, logs, or test fixtures.
- Filesystem/network access: are paths and URLs constrained to expected roots?
- Dependencies: new packages are justified and come from trusted registries.

## Pass 4: Design & maintainability

- Naming: do names say what things do? Would a new team member follow?
- Duplication: could this reuse an existing helper instead of copying logic?
- Abstraction: is the layer boundary right? No business logic in UI/IO code.
- Size: functions/classes doing one thing; long functions flagged with a suggestion.
- Dead code: unused exports, commented-out blocks, leftover debug logging.

## Pass 5: Tests & docs

- Tests cover the new behavior AND its failure modes, not just the happy path.
- Tests are deterministic (no sleeps, no reliance on ordering or network).
- Public API/README/changelog updated when behavior changes.

## Writing the review

- Lead with a one-line verdict: "approve", "approve with nits", or "request changes (blocking issues: ...)".
- Severity-tag every point: **[blocking]** must fix before merge; **[nit]** optional; **[question]** needs an answer.
- For each blocking issue, include a concrete suggestion or code snippet.
- Praise genuinely good decisions — reviews are teaching moments, not just gates.
- Never review style a formatter/linter should own; point at the tool instead.

## Checklist before approving

- [ ] You traced the happy path with a real example
- [ ] Edge cases and error paths are handled or explicitly out of scope
- [ ] No security regressions (input validation, injection, secrets)
- [ ] Tests exist for the change and fail without it
- [ ] You would feel comfortable debugging this code at 3am
