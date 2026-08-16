---
name: test-writing
description: Guidelines for writing effective unit and integration tests. Use when adding or reviewing tests to maximize regression value and keep suites fast, deterministic, and meaningful.
---

# Test Writing

## What a test must be

1. **Deterministic** — same code, same result, every run, every machine.
2. **Isolated** — passes alone (`vitest run path/to/file`) and in any order. No shared mutable state.
3. **Fast** — unit tests in milliseconds. Slow paths belong to a separate integration suite.
4. **Meaningful** — fails for the right reason. If a test cannot fail, it tests nothing.

## Structure: Arrange, Act, Assert

- **Arrange** inputs and state; use builders/factories over repeated literals.
- **Act** — call the code under test, once, clearly.
- **Assert** — verify observable outcomes, not implementation details.

One logical assertion per test; use `it("does X when Y")` names that read as specs:
`it("rejects cron weekday ranges containing Sunday (7)")`.

## Test the contract, not the implementation

- Assert on outputs, state changes, and emitted events — not on how they were computed.
- Tests coupled to internals break on every refactor and protect nothing.
- Prefer equivalence checks on parsed structures over exact string matches.

## Test the failure modes, not just the happy path

For each feature, cover:

- Happy path with a representative input
- Boundary values: empty, one, exactly-at-limit, beyond-limit
- Invalid input: wrong type, malformed encoding, hostile values
- Error propagation: what does the caller see when a dependency fails?

## Determinism rules

- No real sleeps; fake timers or poll with deadline (`await vi.waitFor(...)`).
- No network/disk/system-clock dependencies in unit tests — inject and stub them.
- No reliance on hash ordering, `Object.keys` order, or timezone unless explicitly set.
- Use fixed seeds for randomness; freeze time (`vi.setSystemTime`).

## Fixtures and cleanup

- Create fresh state per test (`beforeEach`), not `beforeAll` for mutable data.
- Use temp dirs (`mkdtemp`) for filesystem tests; remove them in `afterEach`.
- Keep fixtures minimal and inline when small; external files only for genuinely big inputs.

## What NOT to test

- Third-party libraries or the framework itself (test your usage of them, if at all)
- Trivial getters/setters/formatters with no logic
- Snapshot blobs that rot (`expect(x).toMatchSnapshot()` of huge objects)

## Reviewing tests

- Delete the code under test mentally: does this test actually fail? (mutation check)
- Does the failure message point at the broken expectation, or at incidental setup?
- Is there any test that would have caught the last real bug in this area? If not, write it.
