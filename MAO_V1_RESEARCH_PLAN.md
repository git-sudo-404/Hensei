# Multi-Agent Orchestration for Repository Migration: v1 Research and Implementation Plan

Prepared 6 October 2026. This is a proposed design and experiment protocol, not an implemented system or a claim of measured performance. The workspace was empty when inspected. Language pair, team size, deadline, and spending limit were not yet specified; the working recommendation is Python → Go and a 12-week route to a measured prototype. Adjust scope after the first pilot.

## 1. Recommendation and research positioning

Build a dependency-aware migration harness with a configurable pool of LLM workers, executable behavioral evaluation, and serialized Git integration. Keep graph construction, scheduling, budgets, state transitions, and merge authorization in ordinary code. Use LLMs where interpretation is useful: proposing interfaces, translating code, diagnosing failures, and reviewing semantic risks.

The research question should be: **Under a fixed model and inference budget, when does dependency-aware parallel orchestration improve the time and cost of behavior-preserving repository migration?** A second question can examine whether explicit interface contracts reduce integration failures.

The original architecture has useful ingredients, but neither multi-agent translation nor dependency-aware translation is new by itself:

| Primary work | What it establishes | Consequence for this project |
|---|---|---|
| [RepoTransBench, v2, December 2025](https://arxiv.org/abs/2412.17744v2) | A repository-level benchmark with executable tests, 1,897 samples across 13 language pairs, and an agent baseline. | Reuse suitable benchmark tasks and methodology; function-only benchmarks do not test repository orchestration. |
| [ReCodeAgent, v3, August 2026](https://arxiv.org/abs/2604.07341v3) | A multi-agent workflow for repository translation and validation. | Do not claim to be the first planner/translator/validator system. |
| [AlphaTrans, FSE 2025](https://doi.org/10.1145/3729379) | Combines program analysis, target scaffolding, dependency context, and translation validation. | Interface-first planning and static-analysis assistance also have prior art. |
| [DepWareTrans, August 2026](https://arxiv.org/abs/2608.14128v1) | Dependency-consistent batches and iterative compilation/testing for migration across co-executable languages. | DAG/SCC batching needs a related-work comparison. Its interoperable-language setting differs from Python → Go. |
| [Towards a Science of Scaling Agent Systems, v3, April 2026](https://arxiv.org/abs/2512.08296v3) | Controlled experiments show architecture benefits depend on task structure; additional coordination can hurt. | Include a strong sequential baseline and measure graph structure alongside speed. |

These papers establish substantial overlap. A defensible FYP contribution is a reproducible empirical study of parallelism, contracts, and integration reliability under bounded resources. A novel algorithmic claim would require a further targeted literature review and evidence beyond this plan. An honest negative result, such as five workers being slower on tightly coupled repositories, can still be valuable.

Suggested working title: **Dependency-Aware Parallel Agent Orchestration for Codebase Migration: A Study of Correctness, Cost, and Integration Overhead.**

## 2. What needs changing in the rough architecture

| Original assumption | Failure mode | Proposed change |
|---|---|---|
| A repository is a DAG. | Imports, types, and calls can form cycles. | Extract a directed graph; collapse strongly connected components (SCCs) into migration units. |
| One file is one migration task. | File boundaries may split mutually dependent behavior, or several files may map into one target package. | Start with module/SCC units and explicit source-to-target ownership. |
| A topologically sorted list reveals safe parallel work. | Ordering alone does not encode readiness, write conflicts, or shared interface consistency. | Store dependencies; dispatch the ready frontier subject to path/resource locks. |
| The head agent should discover the entire graph. | The model may omit or invent dependencies. | Use a parser and import resolver; let the model propose annotations with evidence. |
| A short prompt is enough task specification. | Workers independently invent names, types, errors, and package structure. | Use versioned interface contracts and structured acceptance criteria. |
| Git worktrees are isolated environments. | Worktrees share repository metadata; they do not isolate processes, credentials, or host resources. | Use worktrees for checkouts and configured containers for build/test execution. |
| A reviewer agent can decide logical correctness. | The reviewer can share the worker's misconception. | Make executable tests the acceptance gate; use LLM review as supporting evidence. |
| Passing tests on a worker branch permits a merge. | Other accepted changes can invalidate the candidate. | Revalidate the exact prospective integration tree against current HEAD. |
| A rejected worker should retry until approved. | Loops can consume unlimited time and tokens without progress. | Bound turns, repairs, time, cost, and repeated failure signatures. |
| Five workers should give fivefold speedup. | Dependency chains, API latency, build contention, and serial integration limit concurrency. | Treat worker count as an experimental variable. |

SCC contraction produces a DAG, as described in the [NetworkX condensation documentation](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.components.condensation.html). Git's own [worktree documentation](https://git-scm.com/docs/git-worktree) describes shared refs and configuration; checkout separation should not be described as a security sandbox.

## 3. A feasible v1 scope

Use one language pair. My provisional recommendation is **Python → Go**, limited to typed or easily inferred, deterministic, standard-library code. Python provides a practical AST extraction route, and Go gives an explicit target build gate. This pair also appears in the [RepoTransBench artifact](https://github.com/DeepSoftwareAnalytics/RepoTransBench). Dynamic-to-static migration is difficult in the benchmark, so scope restrictions are part of feasibility, not evidence of general migration capability.

If the team is substantially stronger in Java and C#, choosing that pair is reasonable. Make the choice once after a short feasibility spike; implementing two language adapters before a working end-to-end run is unnecessary.

Initial supported domain:

- A library or small CLI with JSON-compatible inputs and outputs.
- Approximately 10–25 source modules and 500–1,500 non-generated source lines for the first demonstration. These are planning targets, not a definition of a large codebase.
- Pure functions, small data structures, deterministic algorithms, and simple internal imports.
- Explicit treatment of integer range, division/modulo, ordering, Unicode, optional values, mutation, and error behavior.
- Source tests already pass in a frozen environment.
- One machine, one controller process, configurable worker counts of 1, 3, and 5.
- A CLI, persistent state, inspectable task graph, logs, migrated artifact, and generated metrics report.

Initially exclude reflection, dynamic imports, monkey patching, native extensions, framework migrations, databases, distributed services, nondeterministic concurrency, executable import-time behavior, mutable global initialization, and arbitrary dependency installation. Detect unsupported features during preflight and report them before generation. Do not silently skip difficult files and claim full migration.

A migration unit should usually fit into a compact context. If an SCC is too large, mark it unsupported for the first version or create a reviewed split using explicit interfaces. Do not cut a cycle arbitrarily to make the graph sortable.

The first MVP is complete when it can migrate a small multi-module fixture, show actual overlapping workers, reject an injected behavioral error, repair or terminate within budget, integrate safely, resume after a controller interruption, and report all outcomes. It need not succeed on every repository to demonstrate a working research system.

## 4. System architecture and responsibility boundaries

~~~mermaid
flowchart TD
    A[Source snapshot and passing baseline] --> B[Parser and dependency resolver]
    B --> C[SCC groups and target interface plan]
    C --> D[Validated tasks.json and frozen contracts]
    D --> E[Deterministic ready-task scheduler]
    E --> W[Bounded worker pool: 1 to N agents]
    W --> G[Candidate build and visible behavior checks]
    G -->|Repairable failure| E
    G -->|Candidate passes| I[Serialized integration queue]
    I --> J[Apply to current HEAD and revalidate]
    J -->|Integration failure| E
    J -->|Accepted commit| E
    J --> H[Final held-out evaluation and report]
    S[(SQLite task and event state)] --- E
    S --- G
    S --- I
~~~

The final held-out stage runs once the run reaches a terminal state, including partial failure. Passing some tasks does not trigger an early successful final evaluation.

| Component | Implementation | Responsibility |
|---|---|---|
| Repository analyzer | Deterministic code | Resolve imports, symbols, source paths, unsupported constructs, and graph evidence. |
| Migration planner | Code plus bounded LLM assistance | Propose target module layout and interface mapping; validate the resulting plan. |
| Scheduler | Deterministic code | Readiness, leases, ownership, backpressure, budgets, task state. |
| Translation workers | Separate LLM contexts sharing a model adapter | Inspect source, edit owned target paths, run permitted tools, submit a candidate. |
| Evaluator | Deterministic test pipeline; optional LLM reviewer | Run fresh checks and return structured diagnostic evidence. |
| Integrator | Deterministic code | Sole writer of integration branch; candidate application and current-tree validation. |
| Reporter | Deterministic code | Aggregate time, usage, tests, failures, and reproducibility metadata. |

You do not need a separate LLM agent to run an event loop. An agent is useful when deciding how to solve a task; scheduling already has explicit rules. This follows the practical workflow/agent distinction in [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). The exact architecture above is a design recommendation for this project.

## 5. Graph extraction, contracts, and incremental migration

**5.1 Extract evidence, then schedule.** For Python v1, use AST parsing plus a project-aware import resolver. Handle relative imports and package initializers. Record each discovered edge's source location and kind. Import graphs are an approximation to behavioral dependencies: shared files, global state, plugin registration, and dynamic dispatch can escape them. Restrict the supported subset and record unresolved edges; parser output is not a proof of independence.

Choose one edge convention: **dependency → consumer**. If service imports parser, use parser → service. In the task manifest, service lists parser in its depends_on array. Preserve a mapping from source nodes through SCCs to target units.

**5.2 Condense cycles.** If A imports B and B imports A, migrate {A,B} as one unit. For a Go target, keep mutually dependent declarations in the same Go package or explicitly redesign the boundary before migration; the source SCC DAG does not automatically create a valid Go package graph.

**5.3 Freeze a target contract.** Before parallel workers start, specify:

- Source symbol → target symbol and file/package mapping.
- Argument, return, and serialized data types.
- Null/optional semantics, numeric domain, mutation/aliasing rules, ordering, and errors.
- Public API and entrypoint behavior, plus forbidden fallback to source-language execution.
- Ownership of implementation files, shared types, manifests, and build configuration.

Compile a target skeleton that declares the intended interfaces. Unimplemented bodies may fail explicitly, for example with a recognizable panic stub, but no stub counts as completed behavior. The bootstrap phase owns shared types and build files; workers own disjoint implementation paths. Include bootstrap/planning effort in end-to-end timing and cost.

For a very small Go target, a single package can simplify cycles and incremental compilation. This choice must be declared in the study, because it limits the conclusions about package-level integration. Each task can still own different files in that package, while deterministic naming rules prevent private symbols from different Python modules colliding. An SCC remains an atomic migration and acceptance unit.

Keep scaffold panics inside function bodies. Test selection does not suppress Go package initialization, so a pending unit's failing initializer could otherwise break an unrelated unit's tests. The v1 restriction on import-time effects avoids this additional scheduling problem.

**5.4 Schedule a ready set, not batches separated by barriers.** A task is runnable when all dependencies are INTEGRATED at the required versions, its output paths are available, and budgets permit execution. As soon as one prerequisite integrates, release its newly ready consumers. Do not wait for every unrelated task at the same apparent graph level.

Python's [TopologicalSorter](https://docs.python.org/3/library/graphlib.html) illustrates ready/done scheduling. In this system, done means successfully integrated, not merely generated. Failed prerequisites must explicitly block descendants; otherwise a ready-loop can hang indefinitely.

**5.5 Handle plan changes explicitly.** A worker that discovers a missing dependency or wrong interface returns PLAN_CHANGE_REQUIRED with evidence. The controller pauses the affected subgraph, retires stale attempts, revises the plan/contract version, and invalidates dependent artifacts. For v1 this can require a developer review. Log intervention time and mark the run assisted; do not silently edit a shared plan during a benchmark run.

## 6. Task specification and durable state

Keep tasks.json as an immutable, schema-validated plan for a particular source revision and plan version. Store live state in SQLite. Multiple workers rewriting tasks.json creates races and makes recovery difficult.

Illustrative manifest fragment; angle-bracket values below are placeholders. Task IDs T001 and T002 would have full definitions in the complete manifest:

~~~json
{
  "schema_version": 1,
  "plan_version": "plan-1",
  "source_revision": "<source-commit-sha>",
  "source_language": "python",
  "target_language": "go",
  "contract_version": "contracts-1",
  "tasks": [
    {
      "id": "T003",
      "kind": "translate_unit",
      "source_paths": ["src/parser.py", "src/tokens.py"],
      "target_paths": ["target/parser.go", "target/tokens.go"],
      "depends_on": ["T001", "T002"],
      "write_scope": ["target/parser.go", "target/tokens.go"],
      "contract_refs": ["contracts/parser.json"],
      "visible_test_ids": ["parser.valid", "parser.invalid", "parser.unicode"],
      "acceptance_policy": "build-and-visible-behavior-v1",
      "instruction": "Implement the parser contract while preserving source behavior in the declared input domain.",
      "limits": {"max_attempts": 3, "max_model_turns_per_attempt": 12, "task_wall_seconds": 1200}
    }
  ]
}
~~~

Schema validation must be followed by semantic validation: all dependency IDs exist, all expected source units are accounted for, the condensed graph is acyclic, ownership is consistent, paths stay within the repository, and contracts/test selectors resolve. Ordered JSON alone cannot enforce these properties.

A runtime attempt record adds run_id, task_id, attempt_id, owner, lease expiry, fencing token, integration base SHA, dependency artifact hashes, candidate SHA, evaluation tree SHA, counters, timing, and errors. Bind every evaluation to its exact candidate and base.

Recommended state machine:

~~~text
PENDING → READY → RUNNING → SUBMITTED → CHECKING → INTEGRATING → INTEGRATED
                       ↘ failure           ↘ repair          ↘ repair
                         REPAIR_READY → RUNNING

Explicit alternatives: FAILED, BLOCKED_BY_DEPENDENCY,
PLAN_CHANGE_REQUIRED, CANCELLED; run-level PAUSED_BUDGET/PAUSED_AUTH.
~~~

Only INTEGRATED satisfies dependencies. The absence of ready tasks is not success: distinguish waiting for active work, permanently blocked tasks, plan errors, and a genuinely complete run.

Use one SQLite writer in the controller. Record a state transition and its event in one transaction; export JSONL afterward as a projection of the event table. This avoids an event log and database silently disagreeing. Give event records stable IDs so exports can be regenerated without duplication.

On submission, release the active worker slot and preserve its artifacts. Evaluation and repair do not require a model context to sit idle. Bound the number of outstanding submissions/worktrees so fast generation cannot outrun evaluation indefinitely.

Leases and attempt fencing prevent a timed-out worker's late submission from overwriting its replacement. Expected worker failures become task outcomes; they must not accidentally cancel unrelated work through unhandled coroutine exceptions.

## 7. Agent development and loop engineering

Use the terms precisely:

| Term | Meaning here |
|---|---|
| Agent development | Define role, tools, input/output contracts, and allowed decisions. |
| Loop engineering | Control observe → act → check → repair cycles and termination. |
| Harness engineering | Build the runtime around the model: tools, isolation, state, tests, scheduling, integration, and telemetry. |
| Context engineering | Select, organize, refresh, and bound information supplied to each model call. |

These are overlapping engineering concerns, not four frameworks to install. Research such as [SWE-agent](https://arxiv.org/abs/2405.15793) treats the agent/tool interface as a substantive part of software-engineering performance.

A worker attempt should:

1. Load a validated context packet and current budget.
2. Request a model action through the provider adapter.
3. Parse and schema-check proposed tool calls.
4. Check path ownership, expected file versions, and permitted operation.
5. Execute the action; persist its result and usage.
6. Return concise diagnostics, preserving full logs outside the prompt.
7. Continue until a valid submission, a declared blocker, or a limit.

Start with a small toolset: list_paths, read_file/read_symbol, search_code, apply_patch, run_build, run_tests, inspect_diff, and submit_candidate. Build/test tools select controller-defined commands; a model-provided test name must not become an arbitrary shell string. Use argument arrays, working-directory validation, output truncation, and subprocess timeouts.

submit_candidate proposes completion. The controller computes the real diff and records the candidate commit; it does not trust the worker's claimed test results. File-write restrictions should be enforced at tool execution and rechecked on submission, including traversal and symlink escapes.

Suggested initial pilot limits are 12 model turns per attempt, 3 attempts per task, a 20-minute cumulative task deadline, and a 120-second build/test command deadline. These are tunable starting values, not evidence-backed optima. Add explicit request output caps, total input/output usage limits, and a whole-run spending ceiling. Reserve worst-case request allowance before concurrent calls so five workers cannot all overspend the remaining budget.

Separate infrastructure retries from semantic repair:

- Transient API/network failures: bounded backoff with jitter; retain the attempt and charge any known usage. Mark unknown billing where a request may have completed after a timeout.
- Build, contract, or behavior failures: a new bounded repair opportunity with structured feedback.
- Invalid credentials or exhausted balance: pause the run with an actionable reason.
- Repeated identical diagnostics and no meaningful diff: stop or escalate, rather than ask the same question indefinitely.

Use structured failures such as failure_kind, test_id, expected, actual, source location, diagnostic digest, candidate SHA, and log path. Feedback should help locate a concrete mismatch rather than merely say that logical correctness failed.

## 8. Context engineering

Give each attempt a task-specific packet containing:

- Task/attempt IDs, source commit, integration base, and contract hashes.
- The assigned source unit and relevant original tests/examples.
- Source and accepted target interfaces of direct dependencies.
- Selected consumer call sites where they clarify usage.
- Target conventions and migration semantic rules.
- Owned output paths, immutable artifacts, and acceptance requirements.
- The previous failure summary, if repairing, and remaining budget.

Use code search and graph neighbors to retrieve more context as needed. An embedding database is optional and unnecessary for the first small repository. Keep stable instructions/contracts near the front and the immediate task/diagnostics clear. Cache packets by source and dependency versions; invalidate them when those inputs change.

Start with a modest packet budget, such as 8–16K input tokens, and measure whether it is sufficient. Do not truncate required source/interface information merely to hit a number: split a unit legitimately, retrieve selectively, or declare it too large. Reserve room for model output and subsequent tool results.

Keep full build logs on disk; send the model an exit code, failure summary, several representative errors, and a way to read the remaining log. Persist factual handoffs: implemented behavior, files changed, verified commands, outstanding errors, and next action. A conversation transcript is not the authoritative task database.

[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) motivates selective retrieval and structured memory. [Lost in the Middle](https://arxiv.org/abs/2307.03172) is older evidence that access to long context does not guarantee reliable use of it; it does not prove the same degradation magnitude for current DeepSeek models. Packet size and compaction policy should be measured in this system.

## 9. Harness, worktrees, and integration

Create a run-specific repository snapshot so benchmark trials cannot inspect the commits or artifacts of previous trials. Within that run, the controller creates a unique worktree/branch for each attempt from a known integration commit. A fresh attempt can reconstruct its context from artifacts; it need not inherit an indefinitely growing chat.

Keep Git operations in trusted controller code. The model edits through scoped tools. Run generated code in a configured container with a pinned toolchain, non-root execution, limited CPU/RAM/processes/time, no evaluation network, and only necessary mounts. Do not expose the API key, host home, Docker socket, or shared Git administrative directory. Mount trusted fixtures read-only and keep hidden fixtures outside the worker environment. Container limits must actually be configured; see [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/) and [Docker security](https://docs.docker.com/engine/security/).

Use separate limits for worker tasks, simultaneous API calls, and build/test jobs. Async scheduling overlaps network waits; it does not make five compilers cheap. Keep writable caches/output directories separate per attempt and declare any shared read-only caches in the experimental setup.

Integration protocol:

1. Check the submitted diff against path ownership and immutable artifacts.
2. Evaluate the candidate against its recorded base using a fresh runner.
3. Enter the single integration queue; read current integration HEAD.
4. Apply the candidate patch/commit to a temporary prospective integration tree. Treat conflicts as repair evidence, not permission to silently overwrite changes.
5. Run target build plus the visible tests of all completed units and their affected integrations. Run the full visible suite once every unit is implemented; unimplemented future behaviors must be explicitly tracked, not counted as passes.
6. Promote only the exact tree that passed, while the integration writer remains serialized.
7. Record the accepted SHA and unblock consumers.

An LLM reviewer cannot bypass a failing hard gate. A clean textual merge is insufficient because independently correct patches can disagree about semantics.

Git and SQLite do not share one atomic transaction. Write an integration intent with candidate/base IDs, promote the accepted commit, then record completion. On restart, reconcile actual branch state and recorded intent before doing anything again. Use commit metadata or an equivalent acceptance mapping to detect an already-integrated attempt. Claim idempotent recovery with tested reconciliation, not universal exactly-once execution.

Test this harness with deliberate failures: kill a worker, interrupt between branch promotion and database update, submit twice, return a late result after lease expiry, create a merge conflict, exceed memory/time, and fail a prerequisite. These tests establish orchestration reliability independently of model quality.

## 10. Evaluating behavior and preventing misleading success

The original source program is a useful behavioral reference within the agreed input domain. It is not an oracle for ideal software: migration normally preserves observable source behavior, including existing quirks. Any intentional bug fix or changed specification belongs in a separate experiment.

Before agent runs, build independent source/target runners with a common protocol, for example a JSON request identifying an operation and JSON arguments, and a response containing either a value or a normalized error. Human-check the adapters against small known implementations. Prefer reusable language-neutral fixtures over asking the same worker to translate both implementation and assertions.

For each fixture, run the source baseline and freeze expected outcomes. Compare values, types, ordering when specified, error categories, and any supported side effects. Define numeric bounds and floating-point tolerance before seeing results. Avoid comparing formatted text if the contract is structural JSON. Timeouts/crashes are explicit outcomes, not silently omitted cases.

Use complementary checks:

| Check | What it detects | What it cannot establish |
|---|---|---|
| Syntax/type/build | Invalid target programs and interface mismatch. | Behavioral equivalence. |
| Fixed public examples and unit cases | Known expected behavior; actionable repair feedback. | Unseen edge cases. |
| Differential cases | Source/target disagreement on the same inputs. | Correctness outside the tested domain. |
| Property-based and metamorphic cases | Boundary conditions and declared relations such as encode/decode round trips. | Validity of a badly chosen property. |
| Integration/end-to-end cases | Cross-module and entrypoint behavior. | Every production dependency/environment. |
| Optional LLM review and human audit | Plausible semantic defects and unsupported assumptions. | Proof of correctness. |

[Hypothesis](https://hypothesis.readthedocs.io/en/latest/tutorial/introduction.html) is a practical generator for input strategies and properties. Save generated cases and minimized counterexamples, not just a random seed, to support replay.

Maintain a fixed **visible development suite** used in the repair loop and a **held-out final suite** that workers cannot read or query. Run held-out evaluation only after the candidate/run is frozen; never return its detailed failures to another repair iteration in the same scored run. If you tune the system on those failures, they become development data and a new holdout is needed.

Do not let workers change canonical tests, expectations, timeout policy, grading code, or test-selection manifests. Agent-written tests may help debugging but must not inflate the fixed measurement denominator. Count unexpected skips, missing behaviors, unexecuted required cases, and target crashes as non-passes under the predefined scoring policy. A recognized infrastructure fault gets a separate label and a declared rerun rule.

Incremental validation must distinguish implemented behavior from bootstrap scaffolding. Keep a machine-readable implementation coverage map. A test for an integrated unit must not pass by relying on an unimplemented dependency stub. Final success requires every required unit and entrypoint, no reachable placeholder implementation, no source-runtime fallback, and the full fixed suite. Static stub scans alone are insufficient; combine provenance/coverage mapping with actual behavior checks.

LLM reviewers should receive code, contracts, and test evidence in a fresh context, and produce specific findings with locations and reproducible cases where possible. A separate context using the same model does not supply an independent correctness oracle. Treat its value as an ablation. The mixed-grader approach is consistent with [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## 11. DeepSeek integration

Use a thin provider adapter with one protocol for v1: async Chat Completions with tool calling and local schema validation. Keep provider-specific transcript details inside the adapter; the scheduler works with task results and usage records.

As of 6 October 2026, the official [DeepSeek changelog](https://api-docs.deepseek.com/updates/) names deepseek-flash for V4.1 Flash. Configure the model explicitly and record both the requested name and returned model metadata. Aliases can move; a name alone is not an immutable model version. Do not build the experiment around old examples using retired names.

DeepSeek's current [thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/) requires previous reasoning_content fields to be preserved in tool-enabled conversation history, including turns without tool calls. The adapter should preserve the full required assistant messages. Temperature settings have no effect in this mode, so temperature=0 is not a reproducibility guarantee. Fix mode/effort settings and repeat trials.

For context reset, start a new conversation from a validated artifact summary rather than mutilating an existing provider transcript. Protect provider continuation data and secrets; published traces can contain tool actions, diagnostics, usage, and concise progress records without exposing raw private reasoning.

[JSON output](https://api-docs.deepseek.com/guides/json_mode/) helps formatting but does not replace schema or semantic validation. Handle empty, truncated, malformed, and out-of-scope responses. Keep beta strict-tool features optional until a compatibility test confirms their behavior.

Define the adapter contract approximately as generate(messages, tools, configuration) → assistant_message, proposed_tool_calls, usage, finish_reason, provider_metadata. It should implement timeouts, a global semaphore, bounded transient retries, and safe trace redaction. Keep the key only in the controller environment.

Budget and cost accounting:

~~~text
estimated_cost = (cached_input_tokens × cached_input_rate
                + uncached_input_tokens × uncached_input_rate
                + output_tokens × output_rate) / 1,000,000
~~~

Use the [official price table](https://api-docs.deepseek.com/quick_start/pricing/) applicable to each call and snapshot it with the run. Report token counts as well as estimated actual and fixed-tariff normalized costs. Time-dependent prices and cache behavior can otherwise bias comparisons. Do not double-count reasoning tokens if they are already included in completion usage.

Include planning, review, repair, failures, and all other model calls. Run a small pilot to estimate cost before launching the full matrix. No API request or paid inference was made while preparing this plan.

## 12. Suggested implementation stack and repository layout

| Concern | Initial choice | Reason |
|---|---|---|
| Controller | Python, asyncio | Easy AST access, explicit I/O concurrency, straightforward experiment scripting. |
| Schemas | Pydantic or equivalent typed validation | Validate manifests, tools, and reports at boundaries. |
| Graphs | NetworkX plus project-aware resolver | SCCs, graph inspection, and explicit metadata. |
| Runtime store | SQLite with one writer | Persistent state on one machine without a separate service. |
| Model API | Thin async DeepSeek adapter | Keep provider quirks separate from research mechanisms. |
| Source/target checks | pytest/Hypothesis and Go toolchain | Independent behavioral fixtures and explicit builds. |
| Workspaces | Controller-managed Git worktrees | Concurrent checkouts and inspectable candidate history. |
| Execution | Pinned container image | Reproducible toolchains and resource/process boundaries. |
| User interface | CLI plus generated JSON/CSV/Markdown report | Enough to operate and demonstrate the experiment. |

LangGraph is a reasonable alternative if the team already knows it; its [Functional API documentation](https://docs.langchain.com/oss/python/langgraph/functional-api) describes persistence/replay and side-effect concerns. It still leaves graph extraction, tests, Git integration, and idempotency to you. Choose one owner for durable workflow state rather than two competing state machines. A custom state machine is recommended here because scheduling is the research subject and ablations should be transparent.

Proposed layout, not files already implemented:

~~~text
hensei/
  src/hensei/
    cli.py
    config.py
    analysis/       # parser, resolver, graph, SCC grouping
    planning/       # contracts, manifest validation
    orchestration/  # scheduler, state, leases, budgets
    agents/         # bounded worker loop, context, tool schemas
    providers/      # DeepSeek adapter
    workspace/      # Git/worktree and integration control
    evaluation/     # runners, fixtures, differential comparison
    reporting/      # event export, metrics, charts
  prompts/          # version-controlled role/tool instructions
  fixtures/         # tiny graph and migration examples
  experiments/      # pinned dataset manifests and configurations
  tests/            # scheduler, recovery, tools, and grader checks
  runs/             # ignored private run data and artifacts
~~~

Design commands around analyze, plan, run, status, resume, evaluate, and report. A plan command should be useful without invoking paid generation, and a dry run with a fake model should test scheduling independently.

Defer distributed queues, Kubernetes, vector stores, arbitrary language pairs, automatic model routing, autonomous debate, and a polished web dashboard. Add them only if measured requirements justify the engineering work.

## 13. Experiment design for the paper

**Research questions.** RQ1: How does worker count change correctness, wall time, and cost? RQ2, conditional on completing the semantic-contract ablation: Does added cross-unit behavioral guidance reduce integration failures? RQ3: How does graph structure predict useful parallelism? Keep an optional RQ4 on LLM review if budget remains. Too many independent factors will exhaust the dataset and spending budget. Only claim answers to questions whose corresponding comparisons were actually run.

**Dataset.** Start with three kinds of development fixtures: an independent fan-out graph, a narrow chain, and a cycle/diamond graph. Use them to debug scheduling and correctness. They are not a substitute for real repositories in the final study.

Audit candidate real repositories before inclusion: license, frozen source revision, clean baseline, supported language features, entrypoint protocol, available tests, and resource needs. RepoTransBench is a promising source, but individual artifacts, licenses, and runtime requirements were not audited here. Record exclusions before running the methods; do not select only repositories the proposed system successfully migrates.

Aim for 5–10 eligible real repositories for a pilot-quality FYP study and expand toward 10–20 if budget permits. Report exact source LOC, modules, tests, SCC sizes, dependency depth, and available frontier widths. Call the results exploratory if the sample is small. A later semester can add a 5–10K LOC case study if the first stage works; do not promise industrial-scale capability from a 1K LOC demo.

**Core conditions.**

| Condition | Description | Purpose |
|---|---|---|
| B0: strong single agent | One tool-using agent translates and repairs the repository under the same resource budget and visible information. | Practical baseline for the full approach. |
| B1: proposed system, k=1 | Same units, contracts, context policy, tests, and repair limits as the parallel system. | Isolate the effect of parallel execution. |
| B2: proposed system, k=3 | Identical to B1 except active worker limit. | Measure useful concurrency. |
| B3: proposed system, k=5 | Identical to B1 except active worker limit. | Find saturation or contention. |

Do not use one-shot generation as the only single-agent baseline. B0 must be able to inspect files and repair from the same public evidence. B0 comparisons combine decomposition and context effects, while B1 versus B2/B3 is the cleaner worker-count comparison. Disclose this distinction.

If feasible, add one published repository-translation baseline using its official artifact, adapted to the same model, dataset, and budget. ReCodeAgent and the RepoTransBench authors' RepoTransAgent are candidates to audit. Disclose adaptations and any features lost in the process. Without such a run, frame the paper as an internal controlled orchestration study, not a claim to outperform the state of the art. Published headline scores from different settings are not directly comparable.

Freeze a common validated plan and bootstrap artifact per repository for the worker-count comparison; otherwise different plans confound the result. Include its shared preparation cost in each method's reported total, and separately report the conditional execution phase. If a run rejects the frozen contract, record the failure instead of quietly improving the plan for just that method.

**Optional ablations, one at a time.**

- Signature-only versus semantic contracts: retain identical path layout, API names, declared types, buildable skeleton, and write ownership in both conditions; add richer behavioral guidance, representation rules, and error explanations only in the full condition. The skeleton is already an interface contract, so do not label the ablation no-contract. Removing the whole skeleton would change feasibility as well as context.
- Context selection: graph-neighbor context versus a fixed retrieval policy under the same token cap and access permissions.
- Reviewer: deterministic gates alone versus gates plus bounded LLM review, charging the reviewer budget.
- Dependency scheduling: a predeclared eager scheduler with the same tools and contracts, retaining all hard integration checks. Its blocked/rework costs count; do not weaken acceptance to make the baseline run.

**Fairness rules.** Use the same model, mode/effort, tool schemas, target toolchain, visible tests, source snapshot, input limits, and total inference budget. More workers must share the whole-run budget rather than each receiving a full sequential budget. Report consumed resources because equal caps do not guarantee equal spend. Preserve the same total CPU/RAM limits if studying concurrency on one machine; if hardware scales with workers, label that as a different experiment.

Use at least three repeated runs per repository/condition as a pilot; five or more are preferable where affordable. Use a stable tie-breaker for equally ready tasks and log actual integration order. Randomize or interleave condition order and report API timing/cache conditions. A simple core matrix of 8 repositories × 4 methods × 3 repetitions is 96 runs before ablations. Set the spending ceiling from measured pilot costs, not an assumed dollar figure.

The experimental unit is the repository, not each correlated test case. Report paired per-repository differences, individual points, medians/spread, and confidence intervals that respect repository grouping. Do not present thousands of tests from a few repositories as thousands of independent samples. With a very small sample, emphasize descriptive results and uncertainty over significance claims.

## 14. Metrics with unambiguous denominators

| Metric | Definition and reporting rule |
|---|---|
| Strict migration success | Entire required target builds, all required units/entrypoints are implemented, no forbidden source fallback remains, and all fixed held-out cases pass. Report fraction of repository-runs satisfying this. |
| Behavioral pass rate | Passed fixed held-out cases / all predeclared eligible held-out cases. Report macro-average across repositories plus per-repository values. |
| Build success | Whole-target build pass/fail per run. A secondary percentage may count predefined build targets, never arbitrary source lines. A buildable skeleton can already score 100% before translation; this is a gate/diagnostic, not migration progress. |
| Implementation coverage | Completed required source units or public operations / predeclared required units/operations. Distinguish this from test coverage and build success. |
| End-to-end wall time | From declared start through preparation, calls, repairs, integration, and final evaluation; publish phase breakdown. |
| Validated completion time | End-to-end time for a frozen terminal artifact that passes strict evaluation. Report failed runs and their actual termination times separately. Estimating first-success time would require offline evaluation of archived checkpoints, without feeding holdout results back into generation. |
| Token usage and cost | All model roles, attempts, and repairs; cached input, uncached input, output, actual estimate and normalized tariff. |
| Integration overhead | Queue wait, patch application, revalidation, conflicts, and repairs caused by integration. |
| Reliability | Infrastructure faults, resumptions, duplicate/stale submissions rejected, and manual interventions. |
| Worker utilization | Busy worker-time / (configured workers × measured execution interval), with waiting/build categories documented. |

For paired successful runs at equivalent acceptance criteria, speedup(k) = T1/Tk and efficiency(k) = speedup(k)/k. Also show unconditional success rates and timeouts; a method that fails quickly must not appear superior. A graph's critical path, ready width, serial integration, and local resource contention explain why speedup can saturate.

Measure a fixed-artifact replay separately if you want to isolate scheduler/build throughput from stochastic generation. Do not report replay speed as live migration performance.

Avoid raw test count without denominator, percentage of lines compiled, LLM correctness scores as the primary result, and BLEU/string similarity as a proxy for behavior. Passing tests supports preservation on the tested domain; it does not prove program equivalence.

Recommended plots: per-repository correctness versus cost, paired completion time by worker count, stacked time breakdown, integration failures versus contract condition, and speedup against graph depth/width. Show timeouts and failed runs explicitly.

## 15. Failure analysis and validity threats

Label failures by graph extraction, contract mismatch, language semantics, missing dependency, compile/build, behavioral mismatch, context omission, repair exhaustion, integration conflict, resource/API fault, or grading defect. Separate observed evidence from an inferred cause. Sample traces for human review and record disagreements.

[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) supplies a useful broader taxonomy covering system design, coordination, and verification. Adapt categories to your task rather than assuming that paper's failure frequencies apply to migration.

Main threats to report:

- Public repositories/benchmarks may occur in model training data; private holdout inputs reduce test leakage but cannot erase training contamination.
- One language pair, model, and small-repository subset limit generalization.
- Generated or translated tests can encode the same wrong assumption as generated code.
- Fixed source bugs, incomplete tests, and runner normalization may make the oracle imperfect.
- API updates, cache state, time-dependent tariffs, provider load, and hardware contention confound comparisons.
- Manual planning/repair effort can improve results; record it and distinguish assisted runs.
- Filtering repositories after seeing model outcomes introduces selection bias.
- Different context packets or preparation effort can confound a claim about worker count alone.

Infrastructure settings affect measured coding-agent results, as illustrated by [Quantifying infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise). Freeze and report resource limits, tool versions, environment images, retry policy, and timeouts alongside model settings.

## 16. Build sequence and semester deliverables

This is a provisional 12-week plan to a measured v1, not a promise about an unspecified team or deadline. Proceed by acceptance gates rather than finishing every feature in a calendar week.

| Weeks | Deliverable | Gate before proceeding |
|---|---|---|
| 1 | Language-pair spike; source/target runners; benchmark eligibility audit. | Source baseline passes, a hand-written target passes known fixtures, and a deliberately wrong target fails. |
| 2 | Dependency extraction, SCC grouping, target contract, validated task manifest. | Known fixture graphs and ownership rules match expected results; unsupported cases are explicit. |
| 3–4 | One bounded tool-using worker, DeepSeek adapter, builds/tests, usage records. | Complete a small migration and bounded repair using one worker; record real cost and failure modes. |
| 5–6 | Ready scheduler, worktrees, resource limits, merge queue. | Demonstrate actual overlap and safe integration on a fan-out fixture; show sequential behavior on a chain. |
| 7 | SQLite recovery, budgets, leases, duplicate detection. | Survive injected worker/controller interruptions without duplicate acceptance or lost task status. |
| 8 | End-to-end MVP demo and CLI/report. | One multi-module repository migrates through the full pipeline; other outcomes remain honestly reported. |
| 9–10 | Freeze prompts/configuration; run core baseline matrix. | Runs can be reproduced from manifests and raw metrics; holdout remains unused for tuning. |
| 11–12 | Targeted ablation, failure analysis, report/paper draft. | Results include uncertainty, resource accounting, limitations, and artifact instructions. |

For a two-semester project, use the pre-final semester for the reviewed proposal, working harness, tiny fixtures, one real migration, and pilot comparisons. Use the final semester for a larger eligible dataset, one well-controlled ablation, repeated runs, a larger case study if feasible, and the manuscript/artifact. If time is tight, preserve one worker, three workers, trusted evaluation, integration, and accounting before adding more language pairs or a UI.

Suggested work lanes, combined as necessary for team size:

- Analysis/planning: parser, dependency graph, SCCs, contract schema.
- Runtime: scheduler, persistence, Git/worktrees, recovery.
- Agent integration: model adapter, tools, worker loop, context.
- Evaluation/research: fixtures, differential runners, datasets, metrics, experiment protocol.

Agree on schemas and a tiny fixture in the first week so the lanes can integrate early. Everyone should be able to run the same one-command smoke experiment.

## 17. Demonstration and paper package

A useful demo shows the source graph, cycle grouping, task readiness, overlapping workers, one rejected behavioral error, repair feedback, serialized integration, and a final result with costs. Deliberately interrupt and resume a prepared run. Use authentic logs and visibly label any injected fault.

Deliver the source code, versioned prompts, config schemas, dataset inclusion/exclusion manifest, source revisions, container/toolchain identifiers, fixture definitions, raw metrics, aggregation scripts, and reproduction commands. Keep API credentials and private continuation data out of the release.

The paper should explain the problem and hypotheses, closest related work, architecture, dataset and protocol, results, failure analysis, validity threats, and artifact availability. Separate measured findings from hypotheses. Do not describe a runnable demo as proof that multi-agent systems outperform single agents, and do not claim universal logical correctness from a test pass rate.

## 18. Prioritized reading list

Read these in roughly this order. Engineering articles inform design; they are not substitutes for academic related work or your own controlled experiments.

1. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 19 December 2024 — workflow versus agent responsibilities.
2. [SWE-agent](https://arxiv.org/abs/2405.15793), 2024 — tools and agent/computer interfaces as part of the system.
3. [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 29 September 2025 — selecting and maintaining useful task context.
4. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), 26 November 2025 — incremental progress, explicit artifacts, and continuity.
5. [RepoTransBench v2](https://arxiv.org/abs/2412.17744v2), 16 December 2025 revision — repository-scale evaluation and relevant benchmark directions.
6. [ReCodeAgent v3](https://arxiv.org/abs/2604.07341v3), 12 August 2026 revision — close multi-agent migration prior work.
7. [DepWareTrans](https://arxiv.org/abs/2608.14128v1), 14 August 2026 — close dependency-aware batching prior work.
8. [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657), 2025 — failure taxonomy.
9. [Towards a Science of Scaling Agent Systems v3](https://arxiv.org/abs/2512.08296v3), 8 April 2026 revision — architecture/task alignment and controlled comparisons.
10. [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler), 5 February 2026 — a vendor case study of parallel coding, coordination bottlenecks, and oracle-driven work separation.
11. [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 9 January 2026 — outcome grading and repeated trials.
12. [Quantifying infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise), 5 February 2026 — resource controls as experimental variables.
13. [DeepSeek API changelog](https://api-docs.deepseek.com/updates/), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/), and [pricing](https://api-docs.deepseek.com/quick_start/pricing/) — recheck these living documents before implementation and each experiment batch.

The next concrete implementation step is a tiny repository and an independent source/target comparison runner. Once that runner can reject a deliberately wrong migration, build the one-worker loop against it, then add concurrency.
