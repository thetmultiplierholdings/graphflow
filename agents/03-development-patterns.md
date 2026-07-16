---
snippet: Boundary validation, typed Fastify/Zod handlers, MonetaryAmount, mutate-not-mutateAsync, Zod v4 specialised methods.
---

# Development Patterns

## General Patterns

- When dealing with currency amounts, use `MonetaryAmount` from `@multiplier/lib-shared-monetary` instead of built-in types
- Unit tests should be colocated with the files they are testing where possible, instead of using `__test__` directories
- Don't write tests for errors that are very simple
- In general don't write contrived or simple tests. If there are edge case tests, they should make sense
- Do NOT use `any`, always resolve a more specific type
- Do not write tests for anything that can be guaranteed by the type system
- Use ESM modules instead of CommonJS. Do not use `require` statements in your code
- For different types of inputs, we're using Zod schemas, so there's no need to have exhaustive tests for each type of input
- **NEVER use dynamic imports** (`await import()`) without explicit justification. Static imports at the top of files are required by default. If you encounter a dynamic import without justification, refactor it to use static imports
- When multiple optional dependencies only make sense together (all present or all absent), group them into a single optional config object instead of separate optional parameters — this makes the all-or-nothing constraint explicit in the type system

## Browser Automation and Playwright

- When using Playwright MCP tools for browser automation, ALWAYS use the Task tool with a general-purpose subagent to minimize context usage
- Do not use Playwright MCP tools directly in the main conversation loop
- Example: Instead of using `mcp__playwright__*` tools directly, use:
  ```
  Task tool with subagent_type: "general-purpose" and prompt: "Use Playwright to [specific task]"
  ```
- This approach prevents large Playwright responses from consuming excessive context in the main loop

## Validation Pattern

- Validate data at application boundaries (controllers, services) using Zod schemas
- Domain factory functions should accept properly typed validated data (e.g., `CreateInvoiceData`) rather than `unknown` to avoid redundant validation. This follows the principle of "validate once at the boundary, trust the data deeper in the domain"
- Think carefully about what needs to be validated for any given model. Do not make guesses based on the name or the type of a field
- Ask clarifying questions when validation requirements are ambiguous

### New platform-service controllers: prefer oRPC

**For platform-service endpoints**, when you would otherwise create a new controller (e.g. `ClientXyzController`), **consider defining an [oRPC](../../apps/platform-documentation/guides/core-technologies/services/orpc-apis-and-client-generation.md) contract instead of a hand-written Fastify controller.** oRPC is the destination for every HTTP endpoint platform-service owns: the Zod contract, the server handler, the typed client, and the OpenAPI docs all derive from one source and stay in lock-step, which eliminates client/server drift. The two styles coexist inside the same service while migration is in flight, and an oRPC procedure produces the same wire contract (URL, method, request/response body, status codes) as the Fastify-schema route it replaces.

Reach for a bespoke Fastify controller only when oRPC genuinely doesn't fit the endpoint, and note why. This guidance is platform-service-specific—other apps keep their existing conventions.

### Fastify and Zod route handlers

**Always write new HTTP endpoints with an inline handler**—`async (request, reply) => { … }` passed directly to the route registration. Do this **even when other endpoints in the same file use a different convention** (a bound method such as `this.handleCreateWidget.bind(this)`, or a separate handler typed as a generic `FastifyRequest`). Do not copy the surrounding style; match this one. The inline handler is the only shape where TypeScript connects the route's Zod schema to `request.body`, `request.params`, and `request.query`, giving you correct type inference for free.

When you **modify an existing endpoint** that follows a different convention, migrate it to the inline shape as part of your change.

For legacy Fastify-schema routes registered with `withTypeProvider<ZodTypeProvider>()`, keep the route handler inline when the route schema defines `body`, `params`, or `query`. The inline handler is where TypeScript can connect the Zod schema to `request.body`, `request.params`, and `request.query`.

Avoid passing a separate generic `FastifyRequest` handler when that method then re-parses the same schema only to recover type information:

```typescript
app.withTypeProvider<ZodTypeProvider>().post(
  '/api/widgets',
  {
    schema: {
      body: CreateWidgetRequestSchema,
      response: { 201: CreateWidgetResponseSchema },
    },
  },
  this.handleCreateWidget.bind(this)
);

protected async handleCreateWidget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = CreateWidgetRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid create widget request', 'body');
  }

  await this.createWidget(parsed.data, reply);
}
```

Prefer inferring a named input type from the Zod schema, then passing the already-validated data from an inline route handler into a typed helper:

```typescript
const CreateWidgetRequestSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1),
});

type CreateWidgetRequest = z.infer<typeof CreateWidgetRequestSchema>;

app.withTypeProvider<ZodTypeProvider>().post(
  '/api/widgets',
  {
    schema: {
      body: CreateWidgetRequestSchema,
      response: { 201: CreateWidgetResponseSchema },
    },
  },
  async (request, reply) => {
    await this.handleCreateWidget(reply, request.body);
  }
);

protected async handleCreateWidget(reply: FastifyReply, input: CreateWidgetRequest): Promise<void> {
  await this.createWidget(input.organizationId, input.name, reply);
}
```

Runtime validation happens before the handler in both shapes. The difference is TypeScript inference: a separate method typed as `FastifyRequest` loses the route-specific schema type, while the inline handler keeps it. Do not re-parse with `safeParse` just to teach TypeScript what Fastify has already validated; pass typed data into helpers instead. Keep the `FastifyRequest` parameter only when the helper still needs request-scoped concerns such as headers, logging, metrics, or auth context.

### Zod v4 Modern API

This repository uses Zod v4, which provides specialized schema methods. **ALWAYS use these instead of chained validators:**

```typescript
// ✅ CORRECT - Use specialized schema methods
z.email()            // Instead of z.string().email()
z.uuid()             // Instead of z.string().uuid()
z.url()              // Instead of z.string().url()
z.iso.datetime()     // Instead of z.string().datetime()
z.ip()               // Instead of z.string().ip()
z.e164()             // Instead of custom phone regex

// ❌ INCORRECT - Do not chain validators on z.string()
z.string().email()
z.string().uuid()
z.string().url()
```

**Why this matters:** Zod v4's specialized methods provide better type inference, clearer intent, and improved error messages.

## Frontend Mutation Patterns (React Query)

### Use `mutate()`, not `mutateAsync()`

**Always prefer `mutate()` with callbacks over `await mutateAsync()`.** The `mutateAsync` pattern leads to unhandled promise rejections and bypasses the global error handling configured in `mutationCache`.

```typescript
// ✅ CORRECT - Use mutate() with callbacks
const onSubmit = (data: FormData) => {
  addMember(data, {
    onSuccess: () => {
      toast.success('Member added');
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      setFormError('root', {
        type: 'manual',
        message: err.message || 'Failed to add member.',
      });
    },
  });
};

// ❌ AVOID - mutateAsync swallows errors or requires manual try/catch
const onSubmit = async (data: FormData) => {
  await addMemberMutation.mutateAsync(data);
  reset();
};
```

**Why `mutate()` is preferred:**
- Errors are always handled by the global `mutationCache.onError` (automatic error toasts)
- No risk of unhandled promise rejections
- `onError` callback at the call site handles component-specific error UI (e.g., form errors)
- `onSuccess`/`onError` callbacks only fire if the component is still mounted

### Mutation Hook Structure

All mutation hooks follow this pattern:

```typescript
export const useDeleteClientJob = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId: organizationId } = useOrganization();

  return useMutation({
    mutationFn: async (jobId: string) => {
      if (!organizationId) {
        throw new ValidationError('Organization ID is required');
      }
      const response = await ApiServices.clientJobs.deleteJob(organizationId, jobId);
      return response.data;
    },
    onSuccess: (_, jobId) => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.ClientJobs({ organizationId }),
      });
    },
  });
};
```

Key conventions:
- **`mutationFn`**: Make the API call, throw centralized error types (`ValidationError`, `RuntimeError`)
- **`onSuccess`**: Invalidate related queries for cache consistency
- **Do not** add `onError` in the hook — let the global `mutationCache` handle error toasts
- **Component-specific** error handling (e.g., form errors) goes in `mutate()` callbacks at the call site

### Global Error Handling

The `mutationCache` in `query-client-config.ts` automatically shows error toasts for all failed mutations. To suppress the toast for a specific mutation, set `meta.showErrorToast` to `false`:

```typescript
useMutation({
  mutationFn: async () => { /* ... */ },
  meta: { showErrorToast: false },
});
```

## Development Workflow

When validating changes, follow this order:

1. Verify type checking passes
2. Run relevant tests
3. Run lint/format

## Database Migrations

- **Never edit migration files directly.** They are generated by Drizzle and must not be manually modified.
- To create a migration, update the Drizzle schema then run:
  ```bash
  yarn nx db:generate <project>
  ```
- To apply migrations locally:
  ```bash
  yarn nx db:migrate <project>
  ```
- After generating migrations, run the integrity test to verify journal consistency:
  ```bash
  yarn nx test @multiplier/lib-shared-testing -- --run -t "MigrationJournalIntegrity"
  ```

## Communication with Users

- Stop being so defensive sometimes – if it's unclear whether a parameter might be required, ask the user
