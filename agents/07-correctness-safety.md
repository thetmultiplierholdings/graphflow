---
snippet: Runtime safety, async/await rules, security guidelines, common pitfalls.
---

# Correctness and Safety

## Assignment and Mutation

- Don't assign a value to itself
- Don't return a value from a setter
- Don't reassign const variables
- Don't reassign function parameters
- Don't reassign exceptions in catch clauses
- Don't reassign class members
- Don't reassign function declarations
- Don't allow assignments to native objects and read-only global variables
- Don't assign to imported bindings
- Don't use shorthand assign when the variable appears on both sides

## Unreachable and Dead Code

- Don't write unreachable code
- Don't use lexical declarations in switch clauses
- Don't use variables that haven't been declared in the document
- Don't use control flow statements in finally blocks
- Don't let switch clauses fall through (unless explicitly intended)

## Function and Method Rules

- Make sure super() is called exactly once on every code path in a class constructor before this is accessed if the class has a superclass
- Don't use optional chaining where undefined values aren't allowed
- Don't have unused function parameters
- Don't have unused imports
- Don't have unused labels
- Don't have unused private class members
- Don't have unused variables
- Make sure void (self-closing) elements don't have children
- Use isNaN() when checking for NaN
- Make sure "for" loop update clauses move the counter in the right direction
- Make sure typeof expressions are compared to valid values
- Make sure generator functions contain yield

## Async and Promise Handling

- Don't use await inside loops
- Don't use expressions where the operation doesn't change the value
- Make sure Promise-like statements are handled appropriately
- Don't use async functions as Promise executors

## Module and Import Rules

- Don't use `__dirname` and `__filename` in the global scope
- Prevent import cycles
- Don't use configured elements
- Don't hardcode sensitive data like API keys and tokens
- Don't let variable declarations shadow variables from outer scopes
- Prevent duplicate polyfills from Polyfill.io
- Don't use namespace imports
- Don't access namespace imports dynamically

## Correctness Checks

- Don't use useless backreferences in regular expressions that always match empty strings
- Don't use unnecessary escapes in string literals
- Don't use useless undefined
- Make sure getters and setters for the same property are next to each other in class and object definitions
- Make sure object literals are declared consistently (defaults to explicit definitions)
- Use static Response methods instead of new Response() constructor when possible
- Make sure switch-case statements are exhaustive
- Make sure the `preconnect` attribute is used when using Google Fonts
- Use `Array#{indexOf,lastIndexOf}()` instead of `Array#{findIndex,findLastIndex}()` when looking for the index of an item
- Make sure iterable callbacks return consistent values
- Use `with { type: "json" }` for JSON module imports

## Numeric and String Handling

- Use numeric separators in numeric literals
- Use object spread instead of `Object.assign()` when constructing new objects
- Always use the radix argument when using `parseInt()`
- Make sure JSDoc comment lines start with a single asterisk, except for the first one
- Include a description parameter for `Symbol()`

## Operators and Expressions

- Don't use bitwise operators
- Don't use spread (`...`) syntax on accumulators
- Don't use the `delete` operator
- Don't compare expressions that modify string case with non-compliant values

## Code Organization

- Declare regex literals at the top level
- Don't use `target="_blank"` without `rel="noopener"`

## Refactoring Opportunities

- When refactoring or making other changes, look for opportunities to consolidate functionality into shared libraries, and for opportunities to delete dead code
