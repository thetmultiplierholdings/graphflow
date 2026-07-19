# Consolidated plan: engine integrity + ledger hardening

1. We are removing `workflows.temporal_workflow_type` and `workflows.task_queue`; dispatch uses
   the `RUN_WORKFLOW_TYPE` constant and the env task queue.
   1. It closes the wedged-run hole by construction instead of detecting it: today
      `startWorkspace` (backend/src/temporal/Runtime.ts) starts the run on the catalog row's
      `task_queue`, retired rows keep stale queues (`publishCatalog` upserts, never deletes), and
      a run started on a stale queue hangs invisibly — the three recovery sweeps
      (`adoptOpenWorkflows` in Runtime.ts, `listTaskWorkflows` in backend/src/api/Deps.ts,
      `humanTaskListQuery` in backend/src/cli/Inbox.ts) all filter on the env queue, and
      supersede cannot reach it because its `snapshot` query needs a live worker on that queue.
      With dispatch reading the same env value the sweeps filter on, run and recovery agree by
      construction — no detection machinery is needed.
   2. It turns the retired-workflow failure loud: retired catalog rows persist (publish never
      deletes), so executing an old workspace still dispatches — as `GraphflowRun` on the env
      queue — and the worker fails it immediately with the non-retryable "workflow is not
      registered on this worker" error (`GraphflowRun` in backend/src/temporal/Workflows.ts).
      An instant visible error replaces a forever-hang.
   3. It removes dead flexibility: every published row holds the same constant and the same env
      queue (`publishCatalog` writes `RUN_WORKFLOW_TYPE` and its `taskQueue` parameter
      unconditionally), so the columns encode no information the env does not. Decision recorded
      for the future: the per-row pinning these columns theoretically offered (old workspaces
      keeping an old workflow type during an incompatible-engine cutover) is consciously given
      up; if such a cutover ever happens, its mechanism gets designed then.
   4. Complete impact list. Backend: the `workflows` DDL in `SCHEMA`, the `CatalogWorkflow`
      interface, `publishCatalog`'s signature (its `taskQueue` parameter goes; callers are
      Bootstrap.ts, cli/Shared.ts, ApiIntegration.test.ts) and `catalogSnapshot` (Db.ts);
      `WorkspaceStart`/`loadWorkspaceStart`/`startWorkspace` (Runtime.ts) — `startWorkspace`
      needs the queue handed in, and the `ApiDeps` wiring in Deps.ts already has `env` in scope;
      the catalog payload (`task_queue` in backend/src/api/Schemas.ts and its serialization in
      backend/src/api/routes/Catalog.ts). Frontend: the raw type and mapper in
      frontend/src/lib/api/client.ts, the `taskQueue` field in
      frontend/src/lib/graphflow/catalog.ts, and the `queue: {workflow.taskQueue}` display in
      frontend/src/app/catalog/page.tsx — all deleted. Unchanged: human-task dispatch already
      uses the env queue (`ensure_human_task` passes `deps.taskQueue`, Activities.ts).

2. We are making the kind vocabulary a first-class business object. A workflow constitutes
   nodes and leaves; leaves are the kinds through which reality enters — uploads,
   questionnaires, email pulls — and computed kinds are born from nodes. A global `kinds` table
   classifies every kind by its birth channel; artifacts FK their `kind` to it; nodes declare
   `input_kinds` alongside `output_kind`; `produced_by_node_run` is deleted with no replacement
   column, because origin becomes derivable from the kind's class plus lineage. A `SCHEMA` edit
   plus reset. (Design: three-planner panel plus two adversarial reviewers, both reviews
   converging on this synthesis.)
   1. Why the FK target is a new `kinds` table rather than `workflow_kinds`: `workflow_kinds`'
      primary key is (workflow_id, kind), and artifacts are engagement-pool objects with no
      workflow_id — SQLite rejects the FK outright (verified empirically by the review). The
      pivot states an existing truth: both demo workflows already declare byte-identical
      seven-kind vocabularies. `workflow_kinds` slims to pure membership (workflow_id, kind),
      FK'd to `kinds`.
   2. Schema: `kinds (kind TEXT PRIMARY KEY, source TEXT CHECK (source IN
      ('upload','questionnaire','email','computed')), display_name TEXT)`;
      `node_input_kinds (workflow_id, node_id, param, kind REFERENCES kinds — NULLable, null
      means scalar arg, PK (workflow_id, node_id, param))`; `artifacts.kind` and
      `nodes.output_kind` FK to `kinds(kind)`. `produced_by_node_run`, the `DEFERRABLE
      INITIALLY DEFERRED` circular FK pair, and the MAX+1 preallocation in `recordCompletion`
      all die (`ON CONFLICT DO NOTHING` stays — it powers convergence). Naming note: `computed`
      is the panel's respelling of the original `not_a_leaf` — same semantics, names the birth
      channel uniformly; revert the word if preferred.
   3. Authority split — the arrangement in which the enum can never contradict the graph: the
      source of a leaf kind is authored (whether data arrives by upload or questionnaire is a
      business fact only a human knows), while leaf-ness itself stays derived (a kind consumed
      but never produced — `kindClasses` replacing `leafKinds` in Registry.ts), and publish
      validation reconciles the two: a `computed` kind must have a producing node or be
      explicitly declared as cross-workflow intake (attaching another workflow's output is
      legal membership, not an error); a leaf kind must have no producer. Leafness is not
      identity; it is a theorem the machine proves.
   4. Origin without a column: an `artifact_facts` view serves the derived producer under the
      existing wire key `produced_by_node_run` (MIN(node_run_id) over
      `node_runs.output_artifact_id` — earliest run wins; `artifactLineage` gains `ORDER BY
      node_run_id LIMIT 1`), plus a new derived `origin` field: `produced | upload |
      questionnaire | email | override`. Read models read the view; writers (`MEMO_LOOKUP_SQL`,
      the completion transaction) stay on base tables. The origin-divergence bug dissolves —
      nothing is stored that could diverge.
   5. Supply guard, permissive by design: `supplyArtifact` rejects kinds absent from `kinds`
      (closing the accept-any-string hole in the upload route, which today checks only
      non-emptiness) — but supplying a computed kind stays legal and serializes as
      `origin: 'override'`. The attach dialog ships an "attach intermediate as override" toggle
      and `supplyArtifact`'s own header names "hand-built value" as a supply species; the
      business capability of hand-staging a corrected intermediate survives. A cheap kind-class
      assertion inside `recordCompletion` turns the disjointness argument from by-construction
      into by-check; a strict leaf-only-supply ban stays available as policy, not schema law.
   6. `input_kinds`: `params` stays as-is (codegen and tests untouched); `defineNode` gains a
      required, total `inputKinds` map — every param maps to a kind or null-for-scalar,
      validated at definition time so a forgotten annotation cannot masquerade as a deliberate
      scalar. Published to `node_input_kinds`; enforced at runtime in `Ctx.node` before
      `encodeArgs`. What it opens: publish-time pipeline validation (every consumed kind is
      produced or declared intake), the catalog page rendering the real dataflow graph without
      executing it, per-node precision for the attach guard (item 5.3's accessor), and impact
      analysis by kind. Per the standing contracts, none of this enters memo keys or artifact
      identity.
   7. Questionnaire made real, not a proxy for upload: a questionnaire kind renders a typed
      form (text, date, integer, boolean fields) in the attach dialog — the form definition
      lives in application code, not the database (no `form_schema` column on `kinds`); answers
      are canonicalized backend-side — a `canonical_json` flag on the upload route parses and
      runs `canonicalBytes` before `supplyArtifact`, since the frontend is forbidden from
      producing canonical JSON — so a re-answered identical questionnaire converges on the same
      artifact and revives all downstream memo hits. Wire one questionnaire kind into
      tax_demo_workflow_v2 (residency answers feeding `calculate_tax`) so the channel is
      demonstrable end to end. `email` ships as a declared-forward value with no channel behind
      it yet — stated, not implied.
   8. Publish hygiene: one pure `validateCatalog(registry)` runs over the in-memory registry
      (not possibly-stale DB rows) before any write; the `workflow_kinds` mirror becomes
      delete-then-insert inside the publish transaction, so kinds removed from code stop
      lingering in the attach dialog between resets (nothing FKs the membership mirror).
   9. Compatibility map — existing consumers survive day one because no wire key changes:
      `produced_by_node_run` keeps its name (derived now), catalog kinds keep `leaf: boolean`
      (derived) and gain `source` additively — avoiding the `Boolean("not_a_leaf")` truthiness
      trap in the client mapper — so client.ts, schemas/artifact.ts, the ledger-store selector,
      `cmdShow`, the engagement Origin column, and the preview sheet all work unmodified; the
      preview sheet's fallback copy re-keys on `origin` so classification text can never flash
      wrong while lineage loads. Cleanups: dead `WorkspaceMember.produced` and the unused
      frontend `leafKinds()` helper are deleted; KindBadge gains a source-based color fallback.
      Tests: Db.test.ts seeds `kinds` in its minimal catalog; the circular-pair test becomes a
      reverse-edge lineage test; Registry's `leafKinds` tests become `kindClasses`/validation
      tests; the override-upload test asserts `origin: 'override'`.

3. We are removing `code_hash` entirely. The memo key becomes
   `memo_key = sha256(node_id ‖ ':' ‖ input_hash)`; the node's declared name is its version
   identity. A `SCHEMA` edit plus reset, threaded through the wire contracts.
   1. The decision: a sha256 of source text is byte-identity, not semantic identity — it already
      trusts the author to declare every dependency in `hashWith` (`TAX_RATE` enters
      `calculate_tax`'s hash only because tax_demo_workflow.ts declares
      `hashWith: [TAX_RATE]`; an undeclared constant changes behavior without changing the
      hash). We replace that discipline with the naming contract stated in the ground rules.
   2. The new key uses the bare `node_id`, not `workflow_id:node_id`, with an explicit separator
      (today's two ingredients are fixed-length hex, concatenated bare; a variable-length name
      needs the separator). Deliberate consequence: nodes copied unchanged into a new workflow
      file keep their names and therefore keep their memo hits — the cross-version reuse the
      code hashes provided (CodeHashes.ts shows four of six v2 nodes sharing v1 hashes today)
      survives under name identity. Engagement scoping is untouched, per the standing
      contracts.
   3. Discipline debt due in this same change: tax_demo_workflow_v2 changed `calculate_tax` and
      `build_report` behavior (25% to 24%) while keeping v1's node names — under name identity
      v2 would memo-hit v1's 25% answers. Rename both (or promote the rate to a node argument,
      which puts it in `input_hash` where config belongs). General rule replacing `hashWith`:
      every `hashWith` constant becomes a node argument or forces a rename; a changed helper
      function (`parseTransactionLines`) is a behavior change and forces a rename. So are
      `output_kind` and `executor` changes: today they sit inside the code hash (`nodeCodeHash`
      in generate-code-hashes.ts hashes `{node_id, output_kind, executor}` as its first part);
      under name identity they leave the key, and an executor flip on an unchanged name would
      serve engine answers as human-approved ones, or vice versa. Param semantics under the new
      key: adding, renaming, or removing a parameter all miss (absent params hash as explicit
      `null`; names are the hashed keys); reordering parameters is a hit, deliberately —
      canonical JSON sorts keys, nodes take named arguments only, and declaration order has no
      observable behavior.
   4. Consciously given up, recorded so it is a decision and not an oversight: the publish-time
      in-place-edit tripwire (`publishCatalog` in Db.ts compares stored vs computed hashes) dies
      with the hashes — nothing mechanical catches a forgotten rename; a forgotten rename serves
      stale memoized answers, permanently and silently, within every engagement that already ran
      the node. The naming contract in the ground rules is trusted instead. Also dissolved: the
      minted-vs-executed divergence, where the activity filed its own registry's hash while the
      workflow had minted the memo key from a possibly different build (`run_engine_node`,
      Activities.ts) — with no hash anywhere, the disagreement cannot exist.
   5. Complete removal list. Build tooling: src/generated/CodeHashes.ts and the `gen:hashes` +
      `git diff --exit-code -- src/generated` steps in backend/package.json's `check` script;
      scripts/generate-code-hashes.ts shrinks rather than dies — its `checkStemsAndManifest`
      half (every workflow id must equal its filename stem, every workflow file must be listed
      in `ALL_WORKFLOWS`) is name-discipline enforcement aligned with this plan and stays as a
      slimmed check script. Registry (Registry.ts): the
      `RegisteredNode.codeHash` field, `buildRegistry`'s `codeHashes` parameter and missing-hash
      throw, and the `hashWith`/`codeSalt`/`HashDep` machinery on `defineNode`/`defineHumanNode`.
      Key construction: `memoKey`'s first parameter becomes the node_id (Canonical.ts);
      `Ctx.node` passes `nd.nodeId` (Context.ts). Ledger and wire: `node_runs.code_hash` in
      `SCHEMA`, `CompletionInput.codeHash`, and the `recordCompletion` insert (Db.ts);
      `TaskInput.code_hash` (Workflows.ts); the `codeHash` arguments in `run_engine_node`,
      `buildTaskInput`, `record_human_completion` (Activities.ts). Catalog: `nodes.code_hash` in
      `SCHEMA`, `CatalogNodeEntry.code_hash`, and the publish tripwire (Db.ts). Serialization
      and frontend: `code_hash` in Serializers.ts and the catalog payload (Schemas.ts,
      Catalog.ts, Deps.ts); `codeHash` in frontend/src/lib/schemas/node-run.ts, the client.ts
      mappers, frontend/src/lib/graphflow/catalog.ts, and the catalog page display. Tests
      referencing hashes: Db.test.ts, ApiCrud.test.ts, Registry.test.ts.
