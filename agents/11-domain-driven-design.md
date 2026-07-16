---
snippet: domain/ pure, infrastructure/ framework-aware, application/ orchestration; BaseRepository pattern.
---

# Domain-Driven Design

We prefer to use Domain-Driven-Design (DDD) concepts when designing new libraries. Many libraries use DDD concepts which should be preserved when modifying their code.

## Layers

Our three-level structure

The platform organizes code using three hierarchical levels:

1. Domains - These represent major problem spaces or spheres of knowledge. Think of them as product lines in a manufacturing company. Domains do not have a direct relationship to code—they are purely problem spaces.

2. Contexts (Bounded Contexts) - These are semantic boundaries within domains where specific models are defined consistently. They're like individual factories within a product line, each with clear interfaces to the outside world. In the platform, we use libraries and bundled applications to represent bounded contexts. Contexts may depend on one another, using clearly defined interfaces and an acyclic dependency graph.

3. Modules - These are technical, code-level groupings within contexts, similar to specific machines or components on a factory floor. An example would be a subdirectory in a library which colocates code related to a specific function.

## How we implement DDD in code

Application Layer: Contains application services and commands that orchestrate domain concepts. This layer coordinates between different parts of the system without containing business logic itself.

Domain Layer: Kept pure without side effects, containing the core business models and rules. This is where the essential business logic lives.

Modules: Used within the domain layer to group related models together in single directories, making the code more organized and maintainable.

Aggregates: While not explicitly organized in the filesystem, aggregates are important conceptual boundaries. Everything within an aggregate should only be accessed through the aggregate root, ensuring data consistency.

Repositories: Define interfaces to external services, using interfaces even for single implementations to enable easier testing through mocking.

## How we organize files in DDD projects

We prefer to use a standardized directory structure that reflects our DDD architecture. Each context is organized as a separate project with clear separation between layers:

<example>
```
  project-root/
  ├── specs/                             # Design documentation
  │   ├── spec.md                        # Domain specification
  │   ├── plan.md                        # Implementation plan
  │   └── ...                            # Other design docs (RFDs, ADRs, etc.)
  ├── src/
  │   ├── application/                   # Application layer code
  |   |   ├── {Service}Service.ts            # Application service
  │   │   └── {DataTransferObject}.ts        # Exported DTOs (e.g. InvoiceCreateRequest)
  │   ├── domain/                        # Domain code
  │   │   ├── {module}/                      # One directory per logical module (e.g. invoice)
  │   │   │   ├── {Entity}.ts                    # Entity, possibly an Aggregate Root
  │   │   │   ├── {Entity}Factory.ts             # Factory for creating entities (use sparingly)
  │   │   │   ├── {Name}Service.ts               # Domain service
  │   │   │   ├── {Dependency}Repository.ts      # Repository interface
  │   │   │   └── {ValueObject}.ts               # Value object (e.g. InvoiceLineItem)
  │   │   ├── {ValueObject}.ts               # Shared value object (Money, DateRange, etc.)
  │   │   └── {Dependency}Repository.ts      # Shared repository interface
  │   ├── infrastructure/                # External system concerns
  │   │   └── {module}/                  # Concrete repository implementations (Stripe, etc.)
  │   └── index.ts                       # Exports application services & necessary data types.
  └── package.json, tsconfig.json, etc.
```
</example>

Key filesystem conventions

Specs directory (optional): Contains all design documentation including domain specifications, implementation plans, and architectural decision records. This keeps design decisions close to the code they govern.

Application layer: Houses application services that orchestrate domain operations and data transfer objects that define the public interface of the context.

Domain modules: Each business concept gets its own directory within the domain layer. For example, an invoice module might contain Invoice.ts (entity), InvoiceFactory.ts, InvoiceService.ts (domain service), and PaymentRepository.ts (interface).

Infrastructure layer: Contains concrete implementations of repository interfaces, organized by the external systems they integrate with (Stripe, Xero, etc.).

Single entry point: The index.ts file exports a **minimal public interface** - only the application services and domain types that external callers need. Everything else is an internal implementation detail.

This structure ensures that domain logic remains pure and isolated while providing clear boundaries between different layers of the application.

## Library Public Interface Design

**Critical Rule**: Your library's `index.ts` defines its **public API contract**. Only export what external consumers need - everything else should remain private to enable refactoring without breaking changes.

### What to Export from index.ts

For DDD libraries, your main `index.ts` should export:

1. **Application Services** - The primary way consumers interact with your domain
   ```ts
   export { BillingProfileService } from './application/BillingProfileService.js';
   export { InvoiceService } from './application/InvoiceService.js';
   ```

2. **Domain Types Needed by Callers** - Entities, value objects, and DTOs
   ```ts
   export { Invoice } from './domain/invoice/Invoice.js';
   export { MonetaryAmount } from './domain/MonetaryAmount.js';
   export type { InvoiceCreateRequest } from './application/InvoiceCreateRequest.js';
   ```

3. **Service Interfaces** - Repository interfaces and external service contracts
   ```ts
   export type { InvoiceRepository } from './domain/invoice/InvoiceRepository.js';
   export type { PaymentGateway } from './domain/payment/PaymentGateway.js';
   ```

4. **Browser-Safe Infrastructure** (optional) - Infrastructure that doesn't use Node.js APIs
   ```ts
   export { InMemoryInvoiceRepository } from './infrastructure/InMemoryInvoiceRepository.js';
   ```

### What NOT to Export

Do **not** export from your main `index.ts`:

- ❌ **Internal domain services** - Domain services used only within the library
- ❌ **Private value objects** - Types used only internally
- ❌ **Helper functions** - Utility functions not needed by consumers
- ❌ **Infrastructure with Node.js dependencies** - Export from `/node` instead (see below)
- ❌ **Test utilities** - Export from `/testutil` instead

### Using Service Interfaces vs Concrete Classes

**Pattern**: Export interfaces from main barrel, concrete implementations from `/node`.

This is especially important for repositories and external service adapters:

```ts
// Domain layer - define the interface
// src/domain/invoice/InvoiceRepository.ts
export interface InvoiceRepository {
  findById(id: InvoiceId): Promise<Invoice | null>;
  save(invoice: Invoice): Promise<Invoice>;
}

// Main index.ts - export the interface
export type { InvoiceRepository } from './domain/invoice/InvoiceRepository.js';

// Infrastructure layer - implement the interface
// src/infrastructure/PostgresInvoiceRepository.ts
export class PostgresInvoiceRepository implements InvoiceRepository {
  // Implementation using pg-promise, Drizzle, etc.
}

// Node.js barrel (index.node.ts) - export the implementation
export { PostgresInvoiceRepository } from './infrastructure/PostgresInvoiceRepository.js';
```

**Why this pattern?**
- Consumers depend on stable interfaces, not implementations
- When multiple implementations exist (e.g., GCS vs local OCR), inject the correct one at startup based on config — don't pass config flags into the consumer and branch at runtime
- You can swap implementations without breaking consumers
- Type annotations can use the interface without pulling in Node.js dependencies
- Easier testing - consumers can provide mock implementations

### Example: Real Library Structure

**`libs/platform/data-acquisition/src/index.ts`** (Main barrel):
```ts
// ✅ Application service interface (browser-safe)
export type { SyncTaskServiceInterface } from './application/sync-task/SyncTaskService.js';

// ✅ Domain entities and value objects
export { SyncTask } from './domain/sync-task/SyncTask.js';
export { Account } from './domain/account/Account.js';

// ✅ Repository interfaces
export type { SyncTaskRepository } from './domain/sync-task/SyncTaskRepository.js';
export type { AccountMetadataService } from './domain/account/AccountMetadataService.js';

// ✅ Browser-safe infrastructure (no Node.js imports)
export { InMemoryEntityAccountMetadataService } from './infrastructure/account/InMemoryEntityAccountMetadataService.js';

// ❌ NOT exported here: SyncTaskService (uses Node.js via repository)
// ❌ NOT exported here: FilesystemFileService (uses node:fs)
// ❌ NOT exported here: GoogleCloudStorageFileService (uses @google-cloud/storage)
```

**`libs/platform/data-acquisition/src/index.node.ts`** (Node.js-only barrel):
```ts
// ✅ Application services with Node.js dependencies
export { SyncTaskService } from '../application/sync-task/SyncTaskService.js';

// ✅ Infrastructure implementations
export { InMemorySyncTaskRepository } from './repositories/InMemorySyncTaskRepository.js';
export { FilesystemFileService } from './file/FilesystemFileService.js';
export { GoogleCloudStorageFileService } from './file/GoogleCloudStorageFileService.js';
export { XeroAccountsServiceImpl } from './account/XeroAccountsServiceImpl.js';
```

## Node.js Dependencies in Infrastructure Layer

**Rule**: Node.js built-in imports (e.g., `node:crypto`, `node:fs`, `node:path`) MUST live in the infrastructure layer, not in domain or application layers.

**Goal**: Keep domain logic pure and application services browser-compatible when possible.

### Where Node.js Imports Belong

```ts
// ✅ GOOD - Node.js import in infrastructure repository
// src/infrastructure/repositories/InMemorySyncTaskRepository.ts
import { randomUUID } from 'node:crypto';

export class InMemorySyncTaskRepository implements SyncTaskRepository {
  async generateSyncTaskId(): Promise<SyncTaskId> {
    return randomUUID() as SyncTaskId;
  }
}
```

```ts
// ❌ BAD - Node.js import in application service
// src/application/sync-task/SyncTaskService.ts
import { randomUUID } from 'node:crypto';

export class SyncTaskService {
  async createTask() {
    const id = randomUUID(); // Makes entire service Node.js-only
  }
}
```

### Refactoring Pattern: Push Node.js Dependencies Down

When an application service needs Node.js functionality, **add a method to the repository interface** and implement it in the infrastructure layer:

**Step 1**: Add method to repository interface (domain layer)
```ts
// src/domain/sync-task/SyncTaskRepository.ts
export interface SyncTaskRepository {
  generateSyncTaskId(): Promise<SyncTaskId>;  // ← New method
  create(task: SyncTask): Promise<SyncTask>;
}
```

**Step 2**: Implement in infrastructure with Node.js imports
```ts
// src/infrastructure/repositories/InMemorySyncTaskRepository.ts
import { randomUUID } from 'node:crypto';

export class InMemorySyncTaskRepository implements SyncTaskRepository {
  async generateSyncTaskId(): Promise<SyncTaskId> {
    return randomUUID() as SyncTaskId;
  }
}
```

**Step 3**: Use in application service (now browser-safe!)
```ts
// src/application/sync-task/SyncTaskService.ts
export class SyncTaskService {
  constructor(private repository: SyncTaskRepository) {}

  async createTask() {
    const id = await this.repository.generateSyncTaskId();
    const task = new SyncTask(id, ...);
  }
}
```

## When to Split Infrastructure Exports

By default, **export infrastructure implementations from the main `index.ts` barrel** alongside interfaces. However, create a separate `/node` export when:

### Decision Criteria

Create `/node` exports when **any** of these apply:

1. **Frontend Consumption**: The library is imported by frontend code (React components, Vite builds)
2. **Node.js Dependencies**: Infrastructure uses `node:crypto`, `node:fs`, `node:path`, or other Node.js built-ins
3. **Import Cycles**: Infrastructure imports create dependency cycles with frontend applications

### Default: Single Barrel

Most libraries should export everything from the main barrel:

```ts
// src/index.ts
export type { InvoiceRepository } from './domain/invoice/InvoiceRepository.js';
export { PostgresInvoiceRepository } from './infrastructure/PostgresInvoiceRepository.js';
export { InMemoryInvoiceRepository } from './infrastructure/InMemoryInvoiceRepository.js';
```

This is fine when:
- The package is only consumed by backend services
- The package is tagged `type:backend` in Nx
- No frontend code imports this library

### When to Split: Real Example

**Problem**: `lib-platform-business-analysis` was causing dashboard builds to fail

**Why**:
- `BusinessAnalysisService` (application layer) imported from Xero/Excel infrastructure
- Infrastructure services used `node:fs/promises` for file I/O
- Dashboard (frontend Vite build) tried to bundle the infrastructure → ERROR

**Solution**: Split exports

**Before** (single barrel):
```ts
// src/index.ts
export * from './application/index.js';  // Includes BusinessAnalysisService
export * from './domain/index.js';
```

**After** (split barrels):
```ts
// src/index.ts (browser-safe only)
export * from './domain/index.js';  // Domain models, interfaces, DTOs

// src/index.node.ts (Node.js-only)
export { BusinessAnalysisService } from './application/BusinessAnalysisService.js';
export { ExcelLedgerServiceBuilder } from './infrastructure/ledger/ExcelLedgerServiceBuilder.js';
export { XeroAccountingReportsService } from './infrastructure/report/XeroAccountingReportsService.js';
```

**Result**:
- Dashboard imports domain types from main barrel → ✅ Works
- Platform-service imports application services from `/node` → ✅ Works
- No Node.js code gets bundled into frontend → ✅ Fixed

### How to Configure Split Exports

**1. Add `/node` export to `package.json`:**
```json
{
  "exports": {
    ".": {
      "types": "./dist/src/index.d.ts",
      "import": "./dist/src/index.js"
    },
    "./node": {
      "types": "./dist/src/index.node.d.ts",
      "import": "./dist/src/index.node.js"
    }
  }
}
```

**2. Create `src/index.node.ts`:**
```ts
// Export Node.js-dependent infrastructure
export { SyncTaskService } from './application/sync-task/SyncTaskService.js';
export { PostgresInvoiceRepository } from './infrastructure/repositories/PostgresInvoiceRepository.js';
export { FilesystemFileService } from './infrastructure/file/FilesystemFileService.js';
```

**3. Update main `src/index.ts`:**
```ts
// Export only browser-safe code
export * from './domain/index.js';
export type { SyncTaskServiceInterface } from './application/sync-task/SyncTaskService.js';
```

**4. Update consumer imports:**
```ts
// Frontend code - domain types only
import { Invoice, type InvoiceRepository } from '@multiplier/lib-platform-billing';

// Backend code - infrastructure implementations
import { PostgresInvoiceRepository } from '@multiplier/lib-platform-billing/node';
```
