# Strict TDD

Red-green-refactor. No exceptions for "simple" changes.

## Cycle

1. **Red**: Write a failing test that describes the expected behavior. Run it. Confirm it fails for the right reason.
2. **Green**: Write the minimum code to make the test pass. No more.
3. **Refactor**: Clean up — remove duplication, improve names, extract functions. Tests must stay green.

## Rules

- Never write production code without a failing test first.
- One behavior per test. If a test name contains "and", split it.
- Test behavior, not implementation. Tests should survive refactors.
- When fixing a bug: write a test that reproduces it first, then fix.
- When a test is hard to write, the design is telling you something. Listen.

## Anti-patterns to avoid

- Writing tests after the code (that's verification, not TDD).
- Skipping the refactor step (tech debt accumulates silently).
- Testing private methods directly (test the public interface).
- Mocking everything (integration points need real tests too).
