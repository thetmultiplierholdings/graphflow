---
snippet: TypeScript slop catalog grounding the Deslop review dimension—type-system escapes, promise misuse, catch-block slop, redundant annotations, React effect misuse, each with the clean fix.
---

# TypeScript slop catalog

AI-generated TypeScript anti-patterns and their fixes. Grounds the Deslop dimension in [REVIEW.md](../../REVIEW.md)—cite the item when flagging one of these in review. Repo-wide type rules live in [TypeScript Best Practices](05-typescript-rules.md); items here are where AI output violates them at the highest rates.

## 1. Type-system escapes: `any` and `unknown`

When types get complex, AI gives up and reaches for an escape hatch, throwing away everything TypeScript provides. This repo bans both `any` and `unknown` (see [TypeScript rules](05-typescript-rules.md)): external data gets a Zod schema at the edge, typed data flows inward.

```typescript
// SLOP
function processData(data: any): any {
  return data.value;
}

// CLEAN—constrain the generic
function processData<T extends { value: string }>(data: T): T['value'] {
  return data.value;
}

// CLEAN—external data is validated at the boundary, not typed by assertion
const payload = PayloadSchema.parse(body);
```

## 2. `.then()` chains instead of `async/await`

AI mixes paradigms or uses promise chains where async/await is cleaner.

```typescript
// SLOP
function fetchUser(id: string) {
  return fetch(`/api/users/${id}`)
    .then(res => res.json())
    .then(data => data.user)
    .catch(err => console.error(err));
}

// CLEAN
async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  return (await res.json()).user;
  // Let errors propagate—the caller should decide what to do
}
```

## 3. `console.log` debugging left in

AI adds debug logging that never gets removed.

```typescript
// SLOP
console.log("Fetching user...");
const user = await fetchUser(id);
console.log("User fetched:", user);
```

**Fix:** delete debug statements. On server paths use the request-scoped logger (`request.log`); `console.log` in production code is a Telemetry finding in its own right.

## 4. `Array.forEach` with async callbacks

`forEach` doesn't await—async callbacks fire and are silently dropped.

```typescript
// SLOP—these await calls do nothing useful
items.forEach(async (item) => {
  await processItem(item);  // Runs concurrently, forEach doesn't wait
});

// CLEAN—sequential
for (const item of items) {
  await processItem(item);
}

// CLEAN—concurrent with control
await Promise.all(items.map(item => processItem(item)));
// On external (caller-controlled) input, bound the fan-out—chunk or use a
// concurrency-limited map; unbounded Promise.all over an ingress list is the
// resource-exhaustion case in REVIEW.md.
```

## 5. Redundant null checks TypeScript already handles

With `strictNullChecks`, the compiler enforces null safety.

```typescript
// SLOP—name can't be undefined here, the type says string | null
function greet(name: string | null): string {
  if (name === null || name === undefined) {
    return "Hello, stranger";
  }
  return `Hello, ${name}`;
}

// CLEAN
function greet(name: string | null): string {
  return name ? `Hello, ${name}` : "Hello, stranger";
}
```

Lint: `@typescript-eslint/no-unnecessary-condition` catches provably true/false conditions in general, not just null checks.

## 6. `JSON.parse(JSON.stringify())` for deep cloning

```typescript
// SLOP
const cloned = JSON.parse(JSON.stringify(user));

// CLEAN—structuredClone (available in all modern runtimes)
const cloned = structuredClone(user);
```

## 7. Redundant type annotations on initialized variables

```typescript
// SLOP
const count: number = 0;
const name: string = user.name;
const users: User[] = getUsers();

// CLEAN—inference handles these
const count = 0;
const name = user.name;
const users = getUsers();  // Return type already typed

// Keep annotations on empty collections or ambiguous initializers
const empty: User[] = [];
```

## 8. Over-importing from barrel files

```typescript
// SLOP—grabs everything, bloats bundle
import { UserService, UserModel, UserDTO, UserMapper, UserValidator } from "@multiplier/lib-foo";

// CLEAN—import only what you use (still from the package root, never subpaths)
import { UserService } from "@multiplier/lib-foo";
```

## 9. Non-null assertion as narrowing substitute

`!` tells the compiler to shut up; a guard tells it something true. AI-authored PRs use `!` and `as` at a much higher rate than human PRs (arXiv 2602.17955). This repo bans `!` outright.

```typescript
// SLOP
const user = users.find(u => u.id === id)!;
processUser(user);

// CLEAN
const user = users.find(u => u.id === id);
if (!user) throw new NotFoundError(`unknown user: ${id}`);
processUser(user);
```

## 10. Double assertion to force a type

`as unknown as T` makes any value claim any type—it erases the type system at exactly the spot most likely to be wrong.

```typescript
// SLOP
const config = JSON.parse(raw) as unknown as Config;

// CLEAN—validate at the boundary
const config = ConfigSchema.parse(JSON.parse(raw));
```

## 11. `@ts-ignore` instead of a fix

`@ts-ignore` is banned here (see [resolving-typecheck-issues](../../.claude/skills/resolving-typecheck-issues/SKILL.md)): fix the type. In the rare case a suppression is genuinely unavoidable (upstream typing bug), `@ts-expect-error` with a reason comment fails loudly once the underlying error is fixed; `@ts-ignore` silences forever.

```typescript
// SLOP
// @ts-ignore
legacyCall(data);

// TOLERABLE—only when the type cannot be fixed on our side
// @ts-expect-error legacy API typed wrong upstream (issue #123)
legacyCall(data);
```

## 12. Floating promises

Fire-and-forget async calls—rejections vanish, ordering is accidental.

```typescript
// SLOP
saveUser(user);                          // not awaited—errors disappear
items.map(async i => await process(i));  // array of dropped promises

// CLEAN
await saveUser(user);
await Promise.all(items.map(i => process(i)));  // bound the fan-out on external input (item 4)

// Intentionally fire-and-forget? Say so:
void saveUser(user);
```

Lint: `@typescript-eslint/no-floating-promises`, `no-misused-promises`.

## 13. `enum` where a union suffices

Enums imported from other languages' habits. Literal unions are erasable, serializable, and need no runtime object.

```typescript
// SLOP
enum Status { Active = "active", Inactive = "inactive" }

// CLEAN
type Status = "active" | "inactive";

// When you need the values at runtime:
const STATUSES = ["active", "inactive"] as const;
type Status = (typeof STATUSES)[number];
```

## 14. Catch-block slop

`catch (e: any)` plus log-and-rethrow: the error is logged at every level and handled at none. In this repo, errors are the centralised types from `@multiplier/lib-shared-errors`, and external errors are wrapped via `convertToStandardErrorAndThrow` (see [Error Handling](04-error-handling.md))—never custom error classes, never a bare swallow.

```typescript
// SLOP
try {
  await handler(req);
} catch (e: any) {
  console.error(e);
  throw e;
}

// CLEAN—catch only where you add value; wrap external errors
try {
  await client.send(payload);
} catch (err) {
  convertToStandardErrorAndThrow(err);
}
```

## 15. `useEffect` for derived state (React)

Effects reached for to compute values or chain fetches.

```typescript
// SLOP—derived state via effect
const [fullName, setFullName] = useState("");
useEffect(() => { setFullName(`${first} ${last}`); }, [first, last]);

// CLEAN—derive during render
const fullName = `${first} ${last}`;
```

No lint catches this (`react-hooks/exhaustive-deps` doesn't)—review by hand. See react.dev "You Might Not Need an Effect".

## Sources

- typescript-eslint `strict-type-checked` config + rule docs—ground truth for every rule named above
- Effective TypeScript, 2nd ed. (Vanderkam, 2024)—ch. 5 on narrowing `any`'s scope
- arXiv 2602.17955—empirical AI-vs-human PR comparison (`!`/`as` overuse)