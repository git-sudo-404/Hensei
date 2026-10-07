# Hensei — Bun / TypeScript

This branch implements repository graph extraction and migration ordering. A DeepSeek planning agent generates versioned tasks. Parallel workers produce candidates; an evaluator reviews them, runs required checks, and merges passing changes.

## Setup

Install [Bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/getting-started/installation/), then:

```sh
bun install
bun run graph ./examples/cyclic --out ./artifacts/cyclic
bun run graph /absolute/path/to/repository --out ./artifacts/repository
```

Hensei is TypeScript running on Bun. [Graphify](https://github.com/Graphify-Labs/graphify) is an external Python CLI dependency, pinned to `graphifyy==0.9.79`, invoked through uvx. The first extraction downloads its package dependencies. It runs `extract --code-only --no-cluster --force`, uses local AST extraction, and requires no model API key. Auto-refresh of installed assistant skills is disabled by Hensei.

To process an existing raw, directed Graphify extraction:

```sh
bun run order /path/to/graph.json --root /path/to/scanned/repository --out ./artifacts/order
```

`--root` must match the source repository used by extraction, particularly when Graphify emits absolute paths. Undirected exports are rejected because they lose dependency direction.

## Pipeline

1. Graphify emits symbol/file nodes and relationship edges.
2. Hensei maps symbols to `source_file` and projects `imports`, `imports_from`, `calls`, `inherits`, and `implements` onto file dependencies. Source is consumer; target is prerequisite. `contains` and semantic associations do not impose ordering. Same-file edges are ignored, duplicates removed, and unresolved/external targets reported.
3. Iterative Kosaraju groups strongly connected components: mutually dependent files become one atomic group, without recursion limits.
4. Batched Kahn traversal of the condensed DAG emits all dependency-ready groups as a layer, then unlocks the next layer. Every prerequisite is in an earlier layer. Traversal is O(V+E), excluding deterministic sorting.

```text
Layer 0: [base.ts] | [independent.ts]
Layer 1: [a.ts, b.ts] (cycle)
Layer 2: [app.ts]
```

Separate groups in a layer can be scheduled in parallel with respect to the extracted graph. Files inside a cyclic group must be planned together. A future scheduler could unlock individual groups when their own prerequisites finish instead of waiting at layer barriers.

## Outputs

- `graphify-out/graph.json`: untouched upstream extraction.
- `file-graph.json`: normalized files, dependencies, and warnings.
- `migration-order.json`: group IDs, files, `cyclic`, `dependsOn`, and ordered layers. This is the deterministic group order; the separate planner command generates `tasks.json`.

## Limits

Language coverage follows Graphify's extractors. Dynamic imports, reflection, generated code, and unresolved references can leave dependencies missing. Files absent from Graphify's nodes are not scheduled. This is a rough static plan, not a correctness guarantee or execution engine. Review unresolved-edge warnings before migration. Graph extraction uses no RAG or LLM calls; the separate planner uses DeepSeek.

The previous Python implementation is preserved in Git history at commit `be9c710`; `main` now contains the Bun/TypeScript implementation. Historical research and ignored run artifacts remain on disk. `.env` stays local and ignored; the graph pipeline needs no DeepSeek key.

## Verification

```sh
bun test
bun run typecheck
```

Tests cover fan-in, cycles, disconnected components, self-loops, duplicate edges, deterministic output, malformed/undirected graphs, a 15,000-file chain, and recorded real Graphify extraction of the cycle example.

## DeepSeek task planner

Put your key in the workspace `.env` (Bun loads it automatically):

```dotenv
DEEPSEEK_API_KEY=your_key_here
# Optional; CLI --model takes precedence
DEEPSEEK_MODEL=deepseek-flash
```

Generate tasks from the raw Graphify graph:

```sh
bun run plan artifacts/cyclic/graphify-out/graph.json \
  --root examples/cyclic --target Go --out artifacts/cyclic/tasks.json
```

Use the repository's actual path and your desired target language for other runs. Extraction and planning are separate steps; rerun graph extraction after changing source files.

One planning agent uses a separate DeepSeek JSON-mode call for each SCC group in layer order. It receives that group's graph neighborhood, file names, SHA-256 versions, dependency edges, and accepted prerequisite task summaries. File contents are read locally to hash and detect changes, but are not included in the API payload. The supplied Graphify metadata is sent to DeepSeek. This graph-only planner cannot infer implementation behavior that the graph does not represent.

The model writes `goal` and `prompt`; Hensei validates the echoed assigned ID and files, then attaches authoritative dependencies and layer information. Cycle groups remain indivisible. Invalid JSON/IDs/paths/hashes allow one correction attempt. API failures stop immediately without automatic request retries; each request has a 120-second deadline. Inputs over 180 KB per group fail before any request, rather than silently truncating context. Existing output is replaced atomically only after every task validates and all source versions are unchanged.

Each task contains:

```json
{
  "id": "task_0001",
  "groupId": "group_0003",
  "layer": 0,
  "goal": "Migrate the base module to Go while preserving its public interface",
  "prompt": "Translate the assigned module to Go; preserve exported names and behavior, and validate the resulting implementation.",
  "files": [{"path": "base.ts", "version": "sha256:<64 hexadecimal characters>"}],
  "dependsOn": []
}
```

This illustrative task is not a recorded model response. The plan also records target language, source root, model, graph hash, generation timestamp, and unresolved graph warnings. File versions identify the exact input contents rather than a Git branch or modification time. Generated goals/prompts require review before execution; schema validation does not establish migration correctness. Parallel workers are available through the run command below; evaluation and integration are part of the run command.

The adapter uses DeepSeek's [JSON output mode](https://api-docs.deepseek.com/guides/json_mode/) and validates the response locally.

## Source / destination command

Register the local command once from this checkout:

```sh
bun install
bun link
```

Create a destination directory with `hensei.yml`:

```yaml
# dest/hensei.yml
# Language is required; framework and language version are optional.
target:
  language: TypeScript
  framework: Next.js
  version: '5.9'
```

Quote version numbers. `version` refers to the target language version. Any language/framework name may be specified; support is a planning instruction, not a guarantee that a future migration worker supports it.

Then run, from a directory containing your `.env`:

```sh
hensei src/ dest/
# Without linking:
bun run start src/ dest/
```

The destination must already exist, contain `hensei.yml`, and be outside the source directory. Hensei reads the config, extracts the source graph with Graphify, groups cycles, computes dependency layers, and asks DeepSeek to produce versioned tasks for the configured target. It writes graph/order artifacts under `dest/.hensei/` and publishes `dest/tasks.json` only after validation. It produces the task plan; use the separate run command below to generate migration candidates. The standalone `graph`, `order`, and `plan` commands remain available.

## Parallel migration workers

Set the maximum number of concurrent worker agents in the destination config. Both `hensei.yaml` and `hensei.yml` are supported; having both is an error.

```yaml
target:
  language: Go
agents:
  workers: 5
```

After generating `dest/tasks.json`, run:

```sh
hensei run dest/
# Or: bun run run dest/
```

The dispatcher is a deterministic controller, not an extra LLM call. It validates task IDs, dependency cycles and exclusive source ownership, checks every source hash, then maintains a fixed pool of worker slots. Independent ready tasks start together up to `agents.workers` (integer 1–64). Dependents unlock as soon as their own prerequisites are evaluator-approved and integrated, rather than waiting for an entire layer. Failures block descendants; unrelated tasks continue. The limit applies to active task workers, including their model calls and one optional JSON correction attempt.

Each worker has a separate model conversation and a real Git worktree on a branch named exactly after its task ID. Unlike the graph-only planner, **migration workers send assigned source contents and prerequisite candidate code to DeepSeek**. They produce JSON containing target file paths/content and source ownership. The harness checks safe paths, coverage and current source hashes, then commits candidate code in that task’s worktree. Workers have no shell tools. The evaluator runs the user-configured build/test commands; model approval alone never permits integration. File-path validation is not a security sandbox for executing generated code.

Outputs under `dest/.hensei/runs/<run-id>/`:

- `tasks/<task-id>/candidate.json`: candidate manifest.
- `worktrees/<task-id>/`: real Git checkout containing candidate files.
- `events.jsonl`: timestamped starts/completions/failures and active-worker counts.
- `report.json`: statuses, configured limit, peak active workers, total duration and `parallelObserved`.

`parallelObserved` means overlapping worker lifetimes were measured, not that DeepSeek's internal GPU computation was observed. A narrow dependency graph may expose fewer ready tasks than the configured capacity. `SUCCEEDED` now means evaluator approval, passing required checks on the latest integration tree, and a completed merge. Crash recovery and token budgets remain future work. Candidate files are not installed into the destination application, and source files remain untouched.

Every invocation starts a new run rather than resuming an interrupted run. The terminal command exits nonzero if any task failed or was blocked. Planning remains a separate command; `hensei src/ dest/` does not automatically execute workers.


## Git worktree isolation

Each run initializes its own Git repository at `.hensei/runs/<run-id>/repo/`, with an empty `integration` baseline. It creates worktrees at `worktrees/<task-id>/` and branches named exactly `task_0001`, etc. Because each run has a separate repository, repeated task IDs in later runs do not collide. This repository is separate from the Hensei checkout and any source/destination repository; existing destination scaffolding is not copied into the baseline yet.

A task worktree starts from the current integration branch. Its dependencies must already be evaluator-approved and merged; prerequisite snapshots are checked against the integrated contents. Conflicting prerequisite files or outputs that overwrite prerequisites fail the task. The worker writes its own generated target files into the worktree root and creates a candidate commit. `tasks/<task-id>/candidate.json` records `branch`, `worktree`, `baseCommit`, and `commit`, allowing a future evaluator to inspect the exact candidate diff. `worktree.json` is written before the model call, so failed task checkouts remain inspectable too.

Shared Git mutations are serialized to avoid lock races; model calls remain concurrent under the configured worker limit. Worktrees and branches are retained for inspection. Git commits prove isolation and record changes; they do not prove code correctness. Worktrees provide checkout isolation, not a sandbox for executing arbitrary code. Only user-configured check commands run. Passing candidates merge automatically into the run’s integration branch.


## Evaluator, repair and integration

Execution requires both build and test commands in destination `hensei.yaml`/`hensei.yml`. Commands are argument arrays, not model-generated shell strings:

```yaml
target:
  language: Go
agents:
  workers: 5
evaluation:
  build: [go, build, ./...]
  test: [go, test, ./...]
  timeoutSeconds: 60
  maxAttempts: 2
```

Configure commands for the actual target project, including its module/package setup. Hensei does not auto-generate a universal test suite. An example JavaScript-to-TypeScript evaluator configuration with compilation and arithmetic behavior checks is provided at `examples/evaluation/hensei.yaml`. These checks execute locally, outside a container; worktrees are checkout isolation, not execution sandboxes. The harness omits credential-like environment variables from check processes and bounds their captured output.

A dedicated, serial evaluator conversation compares original source, target code, task requirements and dependency candidates for logical errors. It emits an explicit JSON approval/rejection with reasons. This is a model judgment, not a proof of equivalence. Approval is followed by a real Git merge into a temporary worktree based on the **latest** integration HEAD; both configured checks run on that combined tree. Dirty checkouts, changed source versions, unexpected candidate diffs, merge conflicts, failed commands and timeouts prevent promotion. Only the exact clean tested merge commit is fast-forwarded into the run’s integration branch. Failed evaluation checkouts remain for inspection.

Rejected candidates return feedback to their original worker, which retries up to `maxAttempts` (1–5, default 2). Repair resets only that task branch to its recorded base and replaces the task's output; unrelated accepted changes are untouched. After the limit, the task fails and its dependents block. Merge operations and evaluator reviews are serialized, while other migration workers remain parallel.

After each successful merge, `file-versions.json` in the run directory atomically records accepted target-file SHA-256 hashes, originating task IDs and integration commits. Original source-file hashes in `tasks.json` are unchanged: they continue to identify the migration input. Per-task `evaluation-<attempt>.json` records the model verdict, build/test output, final approval and merge commit.

Merges occur inside the isolated run repository at `.hensei/runs/<run-id>/repo/`, not in the Hensei application's main branch or the user's existing destination repository. The integrated target tree is available there; deployment into the destination root remains separate. Version metadata and Git history are retained for inspection. Interrupted-run recovery and transactional recovery from filesystem failures after a merge are not implemented yet.
