---
snippet: Cognitive-complexity ceiling, performance patterns, parallel awaits, Map for lookups.
---

# Code Complexity and Quality

## Guiding principle

These rules serve four cleanup axes—review changed code against each. They are
quality checks, not correctness checks: they assume the code already works.

- **Reuse (DRY).** Before writing a helper, type, constant, or block of logic,
  check whether one already exists—prefer it and extend it. Extract shared logic
  instead of copy-pasting; duplicated logic is a latent bug, since the next fix
  lands in one copy and misses the others.
- **Simplification.** Remove what isn't needed—fewer branches, no dead code. See
  *Complexity* and *Unnecessary Code* below.
- **Efficiency.** Don't do redundant work—cache constructed objects, parallelize
  independent awaits, use `Map` lookups over repeated scans. See *Runtime
  Performance Patterns* below.
- **Altitude.** Keep code at the right level of abstraction—don't inline logic
  that belongs in a named helper, and don't wrap a one-line call in layers of
  indirection.

## Complexity

- Don't write functions that exceed a given Cognitive Complexity score
- Don't nest describe() blocks too deeply in test files
- Don't use nested ternary expressions
- Use single `if` statements instead of nested `if` clauses
- Use `else if` instead of nested `if` statements in `else` clauses

## Unnecessary Code

- Don't use consecutive spaces in regular expression literals
- Don't use the `arguments` object
- Don't use primitive type aliases or misleading types
- Don't use the comma operator
- Don't use empty type parameters in type aliases and interfaces
- Don't use unnecessary boolean casts
- Don't use unnecessary callbacks with flatMap
- Don't create classes that only have static members (like a static namespace)
- Don't use this and super in static contexts
- Don't use unnecessary catch clauses
- Don't use unnecessary constructors
- Don't use unnecessary continue statements
- Don't export empty modules that don't change anything
- Don't use unnecessary escape sequences in regular expression literals
- Don't use unnecessary fragments
- Don't use unnecessary labels
- Don't use unnecessary nested block statements
- Don't rename imports, exports, and destructured assignments to the same name
- Don't use unnecessary string or template literal concatenation
- Don't use String.raw in template literals when there are no escape sequences
- Don't use useless case statements in switch statements
- Don't use ternary operators when simpler alternatives exist
- Don't use useless `this` aliasing
- Don't initialize variables to undefined

## Preferred Patterns

- Use arrow functions instead of function expressions
- Use Date.now() to get milliseconds since the Unix Epoch
- Use .flatMap() instead of map().flat() when possible
- Use literal property access instead of computed property access
- Don't use parseInt() or Number.parseInt() when binary, octal, or hexadecimal literals work
- Use concise optional chaining instead of chained logical expressions
- Use regular expression literals instead of the RegExp constructor when possible
- Don't use number literal object member names that aren't base 10 or use underscore separators
- Remove redundant terms from logical expressions

## React-Specific

- Don't pass children as props

## Constructor and Class Rules

- Don't reassign const variables
- Don't use constant expressions in conditions
- Don't use `Math.min` and `Math.max` to clamp values when the result is constant
- Don't return a value from a constructor
- Don't use empty character classes in regular expression literals
- Don't use empty destructuring patterns
- Don't call global object properties as functions
- Don't declare functions and vars that are accessible outside their block
- Make sure builtins are correctly instantiated
- Don't use super() incorrectly inside classes. Also check that super() is called in classes that extend other constructors
- Don't use variables and function parameters before they're declared
- Don't use 8 and 9 escape sequences in string literals
- Don't use literal numbers that lose precision

## Runtime Performance Patterns

- Cache expensive objects (providers, HTTP clients) — construct once in the closure, call `resetMetrics()` between uses. Don't `new Provider()` on every activity invocation
- Use `Map` for lookups instead of `array.find()`, especially when matching items across two collections. Substring matching (`includes`) is fragile
- Parallelize independent awaits with `Promise.all([a(), b()])` when `a` and `b` don't depend on each other
- Add timeouts to polling loops — `while (true)` with no max duration can hang CI indefinitely
- Share constants for coordination points — if two modules must agree on a string (task queue suffixes, event names), define it in one importable location. Never duplicate magic strings
- Measure timing from before the HTTP call — capture `Date.now()` before `await client.create()`, not after
- Move server readiness/health checks to startup/initialization, not per-invocation hot paths
- Keep interfaces in sync with implementations — when adding a field to a concrete class's return type, update the interface too
