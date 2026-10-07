# Hensei — Bun / TypeScript

This branch implements repository graph extraction and migration ordering. A DeepSeek planning agent generates versioned tasks. Migration workers, evaluation, and merging are deferred.

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

This illustrative task is not a recorded model response. The plan also records target language, source root, model, graph hash, generation timestamp, and unresolved graph warnings. File versions identify the exact input contents rather than a Git branch or modification time. Generated goals/prompts require review before execution; schema validation does not establish migration correctness. Workers and evaluation remain deferred.

The adapter uses DeepSeek's [JSON output mode](https://api-docs.deepseek.com/guides/json_mode/) and validates the response locally.
