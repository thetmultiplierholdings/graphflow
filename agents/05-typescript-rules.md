---
snippet: "Strict TypeScript: no any/unknown/@ts-ignore, import type, ===, PascalCase.ts files."
---

# TypeScript Best Practices

## Type Annotations

- Don't add type annotations to variables, parameters, and class properties that are initialized with literal expressions
- Don't use the `any` type
- Don't use the `unknown` type
- Don't use implicit any type on variable declarations
- Don't let variables evolve into any type through reassignments
- Don't use any or unknown as type constraints

## Type Syntax

- Use `as const` instead of literal types and type annotations
- Use either `T[]` or `Array<T>` consistently
- Use `export type` for types
- Use `import type` for types
- Use function types instead of object types with call signatures

## TypeScript Features

- Don't use TypeScript namespaces
- Don't use non-null assertions with the `!` postfix operator
- Don't misuse the non-null assertion operator (!) in TypeScript files
- Don't use the TypeScript directive `@ts-ignore`
- Don't declare empty interfaces
- Don't merge interfaces and classes unsafely
- Don't use overload signatures that aren't next to each other

## Enums

- Initialize each enum member value explicitly
- Make sure all enum members are literal values

## Return Types

- Don't return a value from a function with the return type 'void'
- Make sure get methods always return a value
