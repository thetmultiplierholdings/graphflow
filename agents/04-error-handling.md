---
snippet: Centralised error types and convertToStandardErrorAndThrow wrapping pattern.
---

# Error Handling

## Standard Error Types

Always use the centralized error types from `@multiplier/lib-shared-errors`:

- **ValidationError**: For input validation failures, invalid parameters, schema validation errors
- **NotFoundError**: When requested resources cannot be found (includes optional resourceType and resourceId)
- **RuntimeError**: For runtime failures, external API errors, configuration issues (includes optional context object)
- **AuthenticationError**: For authentication and authorization failures
- **BaseError**: Abstract base class - do not use directly, only for extending if absolutely necessary

These error types provide:

- Consistent error handling across the monorepo
- Proper prototype chain setup for instanceof checks
- Optional cause parameter for error chaining
- Type-specific properties (e.g., resourceType/resourceId for NotFoundError, context for RuntimeError)

## Error Handling Functions

Three error handling functions are available for different use cases:

### 1. `convertToStandardErrorAndThrow` (Recommended)

**Use this when wrapping errors in standard error types.** This is the most common pattern.

```typescript
import { convertToStandardErrorAndThrow, RuntimeError } from '@multiplier/lib-shared-errors';

try {
  await externalOperation();
} catch (error) {
  convertToStandardErrorAndThrow(error, (err) =>
    new RuntimeError("Operation failed", { context: "details" }, err)
  );
}
```

**What it does:**
- **Re-throws** any error that already extends `BaseError` unchanged
- **Converts** other values to `Error` if needed
- **Calls** your conversion function with the typed error
- **Throws** the resulting `BaseError`

**Why use it:**
- Prevents double-wrapping of standard errors
- Cleaner, more concise syntax than manual error handling
- Type-safe error conversion
- Maintains error chains and stack traces

**Important:** The callback is only invoked for non-standard errors. Standard errors (anything extending `BaseError`) are re-thrown unchanged *before* your callback runs. Don't add `instanceof` checks for standard error types in the callback—they will never match.

### 2. `throwIfStandardError`

**Use this when you need to process non-standard errors but re-throw standard errors immediately.**

```typescript
import { throwIfStandardError, ValidationError } from '@multiplier/lib-shared-errors';

try {
  const data = parseInput(input);
} catch (error) {
  const typedError = throwIfStandardError(error);
  // typedError is guaranteed to be Error (not BaseError)
  throw new ValidationError("Parse failed", undefined, typedError);
}
```

**What it does:**
- **Re-throws** any error that extends `BaseError` immediately
- **Returns** `Error` objects for further processing
- **Converts** non-Error values to `Error` objects

**Why use it:**
- Useful when you need to examine or log the error before wrapping
- Provides the typed error for additional processing
- Simpler pattern than `convertToStandardErrorAndThrow` when you need the error value

### 3. `logBrowserError`

**Use this in browser/React contexts for logging errors without throwing.**

```typescript
import { logBrowserError } from '@multiplier/lib-shared-errors';

function MyComponent() {
  const handleSubmit = async () => {
    try {
      await submitForm();
    } catch (error) {
      logBrowserError(error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
}
```

**What it does:**
- Logs errors to console in a consistent format
- Does NOT throw or re-throw
- Handles any error type safely

**Why use it:**
- For React components that need to capture and display errors
- When you want to log but continue execution
- Browser environments where throwing would break the UI

## Deprecated: `handleStandardError`

**⚠️ DEPRECATED - Migrate away from this function when modifying code.**

`handleStandardError` is a backward-compatible alias for `throwIfStandardError`. When modifying code that uses `handleStandardError`, migrate to one of the new functions:

- **Most common case**: Replace with `convertToStandardErrorAndThrow`
- **When you need the error value**: Use `throwIfStandardError`
- **Browser logging**: Use `logBrowserError`

```typescript
// ❌ Old pattern (deprecated)
try {
  await operation();
} catch (error) {
  const typedError = handleStandardError(error);
  throw new RuntimeError("Failed", {}, typedError);
}

// ✅ New pattern
try {
  await operation();
} catch (error) {
  convertToStandardErrorAndThrow(error, (err) =>
    new RuntimeError("Failed", {}, err)
  );
}
```

## Good Examples

```typescript
// ✅ Good: Use standard error types from @multiplier/lib-shared-errors
import {
  ValidationError,
  NotFoundError,
  RuntimeError,
  convertToStandardErrorAndThrow,
} from '@multiplier/lib-shared-errors';

// Throw appropriate standard errors
if (!isValid(input)) {
  throw new ValidationError("Invalid input: missing required field");
}

if (!resource) {
  throw new NotFoundError("Resource not found", "Customer", customerId);
}

// ✅ Good: Wrap errors with convertToStandardErrorAndThrow
try {
  const result = await externalApi.call();
  return result;
} catch (error) {
  convertToStandardErrorAndThrow(error, (err) =>
    new RuntimeError("External API call failed", { api: "provider" }, err)
  );
}

// ✅ Good: Use throwIfStandardError when you need the error value
try {
  const data = await parseData(input);
  return data;
} catch (error) {
  const typedError = throwIfStandardError(error);
  logger.error("Parse failed", { error: typedError.message });
  throw new ValidationError("Invalid data format", undefined, typedError);
}

// ✅ Good: Use logBrowserError in React components
function UploadForm() {
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async () => {
    try {
      await uploadFile(file);
    } catch (err) {
      logBrowserError(err);
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };
}
```

## Bad Examples

```typescript
// ❌ Bad: Direct error handling without error handler functions
try {
  await someOperation();
} catch (error) {
  throw new RuntimeError("Operation failed", {}, error); // Unsafe - error might not be Error type
}

// ❌ Bad: Using deprecated handleStandardError in new code
try {
  await someOperation();
} catch (error) {
  const typedError = handleStandardError(error); // Deprecated!
  throw new RuntimeError("Operation failed", {}, typedError);
}

// ❌ Bad: Creating custom error classes
class CustomError extends Error {}
class ProviderError extends Error {}
class DataError extends Error {}

// ❌ Bad: Redundant instanceof checks in convertToStandardErrorAndThrow callback
// The callback only receives non-BaseError, so these checks never match
try {
  await someOperation();
} catch (error) {
  convertToStandardErrorAndThrow(error, (err) => {
    if (err instanceof NotFoundError) { return err; }      // Never matches!
    if (err instanceof ValidationError) { return err; }    // Never matches!
    return new RuntimeError("Operation failed", {}, err);
  });
}
```

## Async Functions and Error Handling

When returning a Promise, prefer to use async methods because they have better error handling semantics.

```typescript
// Synchronous function that might throw.
function riskyOperation(): string {
  if (Math.random() > 0.5) {
    throw new Error("Failed!");
  }
  return "Success!";
}

// ❌ Avoid: Manual promise handling, needs explicit try/catch to reject the Promise.
function manualVersion(): Promise<string> {
  try {
    const result = riskyOperation();
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

// ✅ Good: Async version automatically catches errors and rejects the promise.
async function asyncVersion(): Promise<string> {
  return riskyOperation();
}
```

When raising errors:

- Async functions should throw errors directly
- Non-async functions returning Promises MUST return rejected promises instead of throwing, but prefer to convert the function to async instead

```typescript
// ✅ Good: Async function throws error directly.
async function foo(): Promise<Bar> {
  throw new ValidationError(...);
}

// ❌ Avoid: Non-async function returning a Promise rejects the promise instead of throwing.
// It's preferable to convert such functions to async instead.
function foo(): Promise<Bar> {
  return Promise.reject(new ValidationError(...));
}

// ❌ Bad: Non-async function returning a Promise throws instead of returning a rejected promise.
// This will break callers!
function foo(): Promise<Bar> {
  throw new ValidationError(...);
}
```
