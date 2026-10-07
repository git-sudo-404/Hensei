# Hensei

Bun/TypeScript orchestration for graph-guided code migration using DeepSeek. It generates one-source-file tasks, runs isolated Git candidates with a bounded worker pool, independently reviews them, and checks the final integration tree.

Install Bun and uv, then run `bun install`. Graphify is the external Python CLI dependency, pinned to `graphifyy==0.9.79`; Hensei's implementation is TypeScript. Graph extraction uses local AST parsing (`extract --code-only --no-cluster --force`), without an LLM or API key.

## Run

Put the key in this checkout's ignored `.env`. Bun loads it when commands run from this directory:

```dotenv
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-flash
```

Create `dest/hensei.yaml` (or `.yml`, exactly one):

```yaml
target:
  language: TypeScript
  # framework: Next.js
  # version: '5.9'
agents:
  workers: 5
  maxRetries: 3 # repair RETURNS; initial submission + 3 returns = 4 attempts
evaluation:
  build: [bun, run, build]
  test: [bun, test]
  timeoutSeconds: 60
  # finalBuild / finalTest optionally run a different complete-project suite
orchestration:
  maxRounds: 2 # bounded replacement/coverage/final-repair rounds
runtime:
  maxCalls: 200
  maxInputBytes: 180000
  maxOutputTokens: 8192
  maxTotalTokens: 500000
  maxRetries: 2 # transient HTTP retries, distinct from worker repair returns
  maxTurns: 32 # context reads/chunk writes/final answer per agent invocation
coverage:
  exclude: [] # intentional exclusions appear in the final report
```

Commands must match the generated project's build system and tests. The run repository starts empty; existing destination scaffolding is not imported. Setup files must be explicitly owned by a planned task. Tests that only become runnable after complete migration belong in `finalTest`; incremental checks must be suitable for dependency-ready partial trees. Hensei cannot manufacture a universal equivalence test suite from command names.

```sh
bun link
hensei src/ dest/              # extract graph and publish the plan
hensei run dest/               # execute, evaluate, merge and audit
hensei resume dest/ <run-id>   # recover this run's durable state
```

Source and destination must be separate directories. Run from the directory containing `.env`, or set the environment variables explicitly. `bun src/cli.ts ...` works without linking. Legacy plans without one-file ownership and `outputPaths` must be regenerated.

## What the agents do

1. **Graph harness:** project Graphify symbols onto directed file dependencies. Iterative Kosaraju condenses dependency cycles; batched Kahn traversal computes dependency-ready layers. Missing/external edges are reported.
2. **Global planner:** receives the complete graph when it fits, otherwise a reference with bounded graph-page reads. Produces a superficial architecture/contract/validation strategy.
3. **Task breakdown agent:** recursively partitions SCC tasks until every leaf owns exactly one versioned source file. Host validation rejects invented files/hashes, omissions, duplicate ownership and non-progressing splits. Every leaf declares its exact allowed target paths and implementation substeps.
4. **Deterministic dispatcher:** owns dependency admission and a fixed pool of `agents.workers` worker actors. A submitted candidate releases its actor. This allows a cycle larger than the worker pool to finish generating without deadlock. Dependencies unlock only after approval and integration.
5. **Migration workers:** read assigned source and related context, generate scoped code, and commit in real worktrees on branches named after task IDs. Workers can read pages and append target-code chunks, but cannot execute shell commands. All assigned source pages must be supplied before a final answer is accepted.
6. **Evaluator:** checks scope, source versions, target preimages, exact candidate commits and logical/semantic contracts. Any integration change since a candidate's context snapshot invalidates it, even without an import relation. Feedback contains changed paths, a bounded actual diff, and accepted change summaries. Workers refresh from integration and submit a new revision.
7. **Integration harness:** serially merges a complete SCC bundle into a disposable checkout of the latest integration HEAD. Both configured checks must pass, and the tree/HEAD must remain unchanged. Only that exact tested commit is promoted. Target SHA-256 versions are published after acceptance.
8. **Completion orchestrator:** compares an independent whole-source inventory with accepted output mappings, verifies current target hashes, then runs complete-project checks. Gaps and failures produce one-file replacement/repair tasks with fresh IDs/worktrees and smaller substeps. An exhausted worker stops receiving work. A one-file task is decomposed into implementation substeps, not fractional file owners.

Graphify includes semantic associations in planning context where available; these do not create ordering edges. Conservative invalidation on any integration change catches possible semantic coupling outside the graph, at the cost of additional retries. LLM review is a judgment, not proof of behavioral equivalence. There is no vector database/RAG service and no GitHub PR creation: submissions are local Git candidates with recorded revisions.

## Task shape

```json
{
  "id": "task_0001",
  "groupId": "group_0003",
  "layer": 0,
  "goal": "Preserve the base module API",
  "prompt": "Translate this module while preserving its contract.",
  "files": [{"path": "base.ts", "version": "sha256:<64 hex characters>"}],
  "outputPaths": ["base.ts"],
  "steps": ["Preserve exported interfaces", "Implement behavior", "Validate edge cases"],
  "semanticPeers": ["a.ts"],
  "dependsOn": []
}
```

Illustrative, not a provider response. `files` always contains one source file; several files may share a cycle `groupId` and be merged together. Target setup/test files can be included in an owner's explicit write set. Source hashes remain the original input versions; `file-versions.json` records accepted target versions. Schema version 2 also records the graph hash, target, model, timestamp and global strategy.

## Resilience and evidence

SQLite WAL records tasks, statuses, accepted integrations, inventory, config, rounds, retry attempts and usage. Critical JSON checkpoints and receipts use atomic replacement and disk sync. A destination lock prevents concurrent controllers. Receipts written before Git promotion recover a merge after a crash; multi-file cycle acceptance is one database transaction. Resume recovers orphan worktrees and missing task checkpoints, regenerates interrupted candidates within their remaining attempt budget, and skips accepted tasks. Source/config drift stops recovery. A crash during the tiny lock-claim operation leaves a fail-closed recovery marker.

HTTP 429/5xx and connection failures have bounded exponential retries; permanent provider failures stop. Calls share admission and token reservations across all roles. Failed/uncertain calls charge a conservative estimate. `maxCalls` counts harness calls; each can have at most `runtime.maxRetries + 1` transport attempts. Budgets, rounds and no-progress guards bound autonomous work. Raise call/token budgets deliberately for large repositories; the example limits are for small experiments. Stop conditions produce an incomplete report and nonzero CLI exit, never an unsupported success claim.

The run directory is `dest/.hensei/runs/<run-id>/`:

- `repo/`: accepted target integration tree; generated files are not exported into the destination root.
- `worktrees/<task-id>/`: task branch checkout.
- `tasks/<task-id>/`: checkout, candidate revisions and evaluation records.
- `state.sqlite`, `integration-receipts/`: recovery state.
- `file-versions.json`, `events.jsonl`, `audit-<round>.json`, `report.json`: versions, concurrency, coverage, checks and final result.

`complete` requires unchanged source inventory, 100% coverage of the **included** files through accepted mappings, matching target hashes, and two successful final checks. This measures accounted-for files and configured checks, not semantic equivalence or execution of every possible original test. Dependency caches, VCS metadata and `.env` files are excluded explicitly. Assets with binary/empty contents are copied byte for byte. Unknown text files get one-file follow-up tasks. Symlinks require an explicit exclusion. Failed historical tasks can remain in the report after replacement tasks finish the migration.

## Check isolation

Worktrees isolate checkouts; local commands still execute on the host. For autonomous checks, configure a prebuilt local Docker image:

```yaml
evaluation:
  build: [bun, run, build]
  test: [bun, test]
  sandbox:
    image: your-prebuilt-migration-image:tag
    cpus: 2
    memory: 2g
    pidsLimit: 128
```

The Docker harness uses no network, no forwarded host credentials, dropped capabilities, a read-only root, CPU/memory/process limits and a bounded temporary filesystem. It mounts only the candidate checkout. It never pulls an image automatically; provision the image and dependencies beforehand. Missing Docker/image/check failures stop approval. Tests must use in-container executable paths. Container argument generation is tested; a Docker daemon integration test has not been run in this environment. These controls follow the [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/).

## Verification and scale

```sh
bun test
bun run typecheck
bun scripts/benchmark.ts
```

Tests exercise scope and version rejection, partial-cycle prevention, SCCs larger than the worker pool, bounded repair returns, fresh replacements, final-suite repair, coverage gaps/assets, recovery, source drift, budget admission, timeouts, and paged large-file generation. Static ordering also tests a 15,000-file chain.

The benchmark generates 1,000 files / 1,000,000 synthetic code lines and measures source inventory plus file-graph ordering. It makes zero model calls, does not invoke Graphify, and does not measure migration correctness. Results are saved to `artifacts/scalability-report.json`.

This is a stricter experimental harness, not certification that any production app can be migrated correctly without human review. Dynamic dependencies, provider context/output limits, broad cycles, target setup, external services, inadequate tests and conservative stale-context retries can prevent completion. Million-line **end-to-end** migration needs representative application benchmarks, trusted behavioral/differential tests and measured costs before that claim is justified. See [architecture and research notes](docs/architecture.md).
