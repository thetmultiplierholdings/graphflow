---
snippet: TDD, colocated tests, no any in tests, real DB for integration not mocks.
---

# Testing Best Practices

## Test Coverage and TDD (CRITICAL)

- **All code changes must have good test coverage.** Every new feature, bug fix, or refactor should include corresponding tests.
- **Use red/green TDD when implementing new functionality:**
  1. **Red:** Write a failing test that describes the expected behavior
  2. **Green:** Write the minimum code to make the test pass
  3. **Refactor:** Clean up the implementation while keeping tests green
- This workflow ensures tests are meaningful (not written after the fact to rubber-stamp existing code) and that the implementation is driven by clear requirements.

## Test Organization

- Unit tests should be colocated with the files they are testing where possible, instead of using `__test__` directories
- Make sure the assertion function, like expect, is placed inside an it() function call
- Don't nest describe() blocks too deeply in test files

## Test Quality

- Don't write tests for errors that are very simple
- In general don't write contrived or simple tests. If there are edge case tests, they should make sense
- Do not write tests for anything that can be guaranteed by the type system
- For different types of inputs, we're using Zod schemas, so there's no need to have exhaustive tests for each type of input
- Do isolate each load-bearing guard in negative tests. For code gated by `A && B && C`, test `C` by making `A` and `B` true while only `C` is false. A guard is only covered if deleting that guard would make a test fail.
- Don't rely on an earlier guard to prove a later guard. A test where `A` fails does not prove `B` or `C` work, even if the operation is correctly rejected.

## Test Execution

- Don't use focused tests (it.only, describe.only)
- Don't use disabled tests (it.skip, describe.skip) without good reason
- Don't have duplicate hooks in describe blocks

## Test Files

- Don't use export or module.exports in test files

## Async Testing

- Don't use callbacks in asynchronous tests and hooks (use async/await instead)

## Typescript and tests

- NEVER use `any` to work around type issues in tests. ALWAYS use strict typing.

## Test helpers

- Prefer to use dependency injection to set up testable services.
- A good pattern to use are spy implementations which let you provide overrides for specific methods.
- Prefer to build mock versions of sophisticated services which expose additional methods for setting up specific test scenarios.
- When a dependency is typed as a concrete class and tests need `as` casts to mock it, extract an interface from the class's public methods, have the class `implements` it, and type the dependency as the interface. Tests then create plain objects satisfying the interface with zero casts.
- Repo-wide Decimal semantic equality setup lives in `@multiplier/lib-shared-decimal-testing`. Keep Decimal-specific test infrastructure there instead of `@multiplier/lib-shared-testing`, which should stay generic.

## Mocking streaming APIs

When switching an API call from non-streaming (returns a plain object) to streaming (returns an async iterable), update the test mocks immediately. The old mock will fail with confusing Zod/schema errors rather than obvious type mismatches.

```typescript
// ✅ GOOD - Mock returns an async iterable
function mockStream(chunks: Array<{ content: string }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield { choices: [{ delta: { content: chunk.content } }] };
      }
      yield { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

mockCreate.mockResolvedValue(mockStream([{ content: 'Hello' }]));

// ❌ BAD - Plain object doesn't implement Symbol.asyncIterator
mockCreate.mockResolvedValue({
  choices: [{ message: { content: 'Hello' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
```

## Fixing Test Regressions

- **Don't revert reviewer-requested changes to fix tests.** When tests fail after a code review change, fix the test infrastructure (test setup, config, mocks) rather than reverting the reviewed code
- **Diff before fixing.** When previously-passing tests break, run `git log`/`git diff` against the last-green state before proposing a fix. The diff tells you *why* the code changed — fix the test setup if the change was intentional, or fix the code if it was a mistake
