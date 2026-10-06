# Hensei — Bun / TypeScript

This branch implements repository graph extraction and migration ordering. Task-generation agents, migration workers, evaluation, and merging are deferred.

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
- `migration-order.json`: group IDs, files, `cyclic`, `dependsOn`, and ordered layers. This is input for the future planning agent, not `tasks.json`.

## Limits

Language coverage follows Graphify's extractors. Dynamic imports, reflection, generated code, and unresolved references can leave dependencies missing. Files absent from Graphify's nodes are not scheduled. This is a rough static plan, not a correctness guarantee or execution engine. Review unresolved-edge warnings before migration. No RAG or LLM calls are implemented in this phase.

The previous Python implementation is preserved on `main`. Historical research and ignored run artifacts remain on disk. `.env` stays local and ignored; the graph pipeline needs no DeepSeek key.

## Verification

```sh
bun test
bun run typecheck
```

Tests cover fan-in, cycles, disconnected components, self-loops, duplicate edges, deterministic output, malformed/undirected graphs, a 15,000-file chain, and recorded real Graphify extraction of the cycle example.
