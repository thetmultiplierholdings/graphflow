---
snippet: British English in corp-* user copy, American in code; equality, em-dash style.
---

# Style and Consistency

## Language Standards (Corporate Apps)

For `corp-*` applications (corporate-frontend, corporate-backend, etc.):

- **User-facing copy**: Use **British English** (e.g., "organisation", "colour", "authorise", "centre")
- **Codebase**: Use **American English** (e.g., variable names, comments, documentation)

This applies to all UI text, error messages, notifications, and any content visible to end users in corporate applications.

## Control Flow

- Don't use global `eval()`
- Don't use negation in `if` statements that have `else` clauses
- Don't use `else` blocks when the `if` block breaks early
- Follow curly brace conventions
- Include a `default` clause in switch statements
- Make sure default clauses in switch statements come last
- Make sure for-in loops include an if statement

## Variable Declarations

- Use `const` declarations for variables that are only assigned once
- Don't use var
- Don't initialize variables to undefined

## String and Template Handling

- Use `String.slice()` instead of `String.substr()` and `String.substring()`
- Don't use template literals if you don't need interpolation or special-character handling
- Use template literals over string concatenation
- Use `String.trimStart()` and `String.trimEnd()` over `String.trimLeft()` and `String.trimRight()`
- Don't use template literal placeholder syntax in regular strings

## Operators and Expressions

- Don't use yoda expressions
- Use the `**` operator instead of `Math.pow`
- Use assignment operator shorthand where possible
- Use `===` and `!==`
- Don't assign values in expressions
- Don't compare against -0
- Don't compare things where both sides are exactly the same

## Arrays and Iteration

- Don't use Array constructors
- Use `at()` instead of integer index access
- Prefer functional programming methods like `map`, `flatMap`, `filter` over for-loops and mutation.
- Use Array.isArray() instead of instanceof Array
- Don't use sparse arrays (arrays with holes)
- Prefer to use `Promise.all` plus a `map` function instead of loops to process multiple async requests

## Built-ins and Standard Library

- Use `new` for all builtins except `String`, `Number`, and `Boolean`
- Use `node:assert/strict` over `node:assert`
- Use the `node:` protocol for Node.js builtin modules
- Use Number properties instead of global ones
- Use Number.isFinite instead of global isFinite
- Use Number.isNaN instead of global isNaN
- Use standard constants instead of approximated literals

## Error Handling

- Use `new` when throwing an error
- Don't throw non-Error values
- Make sure to pass a message value when creating a built-in error

## Function Parameters and Signatures

- Put default function parameters and optional function parameters last
- Use consistent accessibility modifiers on class properties and methods

## Naming and Organization

- Don't use constants whose value is the upper-case version of their name
- Don't use labels that share a name with a variable
- Don't let identifiers shadow restricted names

## Prohibited Features

- Don't use callbacks in asynchronous tests and hooks
- This rule lets you specify global variable names you don't want to use in your application
- Don't use specified modules when loaded by import or require
- Don't use console
- Don't use debugger
- Don't use the then property
- Don't use with statements in non-strict contexts
- Don't use labeled statements that aren't loops
- Don't use void type outside of generic or return types

## Duplicates

- Don't use duplicate case labels
- Don't use duplicate class members
- Don't use duplicate conditions in if-else-if chains
- Don't use two keys with the same name inside objects
- Don't use duplicate function parameter names
- Don't redeclare variables, functions, classes, and types in the same scope

## Web-Specific

- Don't assign directly to document.cookie
- Use a recommended display strategy with Google Fonts
- Don't use control characters and escape sequences that match control characters in regular expression literals
- Don't use characters made with multiple code points in character class syntax
- Don't use irregular whitespace characters

## Safety and Security

- Don't use unsafe negation
- Make sure to use new and constructor properly
- Don't use octal escape sequences in string literals
- Don't use Object.prototype builtins directly
- Make sure to use the digits argument with Number#toFixed()
- Make sure to use the "use strict" directive in script files.
- Include only a single "use strict" directive per file.

## Empty Constructs

- Don't use empty block statements and static blocks
- Don't use empty character classes in regular expression literals
- Don't use empty destructuring patterns
