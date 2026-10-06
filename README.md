# Hensei

Hensei is a Python → Go migration research harness. It extracts static dependencies, groups cycles, schedules configurable concurrent workers, evaluates behavior, and integrates accepted changes through a serialized Git queue.

The first version includes a runnable offline demonstration and a DeepSeek tool-calling adapter. The offline demo uses **prerecorded translations**, so its results test orchestration mechanics rather than LLM translation quality.

## Quick start

Requires Python 3.11+, Git, and Go for the trusted local demo. The Python package has no runtime dependencies. Commands below run directly from this checkout; no installation is required.

```sh
PYTHONPATH=src python3 -m hensei demo --output runs/demo --workers 3 --inject-failure
PYTHONPATH=src python3 -m hensei status runs/demo
PYTHONPATH=src python3 -m hensei report runs/demo
```

The demo captures source behavior, starts independent workers concurrently, deliberately submits an incorrect translation, rejects it, repairs it, and migrates six dependency units. The final evaluation uses six visible and eleven held-out cases. Use a fresh output directory for each run.

The generated target is in `runs/demo/output/target`. Inspect `tasks.json`, `state.sqlite`, `events.jsonl`, `traces/`, `repairs/`, `report.json`, and `report.md` inside the run directory. The Git integration repository is in `repo/`; temporary worker checkouts are cleaned after evaluation.

## Plan a migration

```sh
PYTHONPATH=src python3 -m hensei plan examples/shop/source --output tasks.json
```

The source argument is a directory containing only the code to migrate. The supported subset has annotated top-level functions, static internal imports, immutable scalar constants, and empty/docstring package initializers. Types are `int`, `float`, `str`, `bool`, and one-dimensional `list[T]` of those primitives. Classes, dynamic imports, external dependencies, decorators, default/variadic parameters, import-time effects, and runtime introspection are rejected during planning.

Inputs and integer intermediate/results must fit signed int64; floats must be finite. Behavioral tests compare numbers exactly, with no implicit float tolerance. Runtime exceptions are normalized to `runtime_error`; exception class equivalence is outside this version's scoring contract. These restrictions are feasibility constraints, not a claim that arbitrary Python is safely translatable.

Plans embed the original source snapshot, so later edits to the original directory cannot silently change a run. Each SCC is one atomic migration unit. Target functions receive stable names and declared signatures in a shared Go package; workers exclusively own implementation files, while the controller owns the JSON bridge and module manifest.

## Run DeepSeek workers

Paste the key into the project-root `.env` file:

```dotenv
DEEPSEEK_API_KEY=your_actual_deepseek_api_key
```

A blank `.env` and a `.env.example` template are provided. The CLI loads `.env` from the current working directory for `run` and `resume`. Existing terminal environment variables take precedence. To select another file, place the global option before the command: `python3 -m hensei --env-file /path/to/.env run ...`.

The `.env` file is ignored by Git. The key is consumed only when explicitly running the DeepSeek provider and is excluded from worker context and generated-code environments. `demo` continues to use prerecorded translations even when a key is present.

```sh
PYTHONPATH=src python3 -m hensei run \
  --plan tasks.json \
  --cases examples/shop/visible.json \
  --holdout examples/shop/holdout.json \
  --output runs/live-001 \
  --workers 3 \
  --model deepseek-flash \
  --max-tokens 1000000
```

Docker is the default for executing the source baseline and generated target. Start your Docker daemon and provision the images before the run:

```sh
docker pull python:3.11.10-slim
docker pull golang:1.23.2-bookworm
```

Use `HENSEI_PYTHON_IMAGE` and `HENSEI_GO_IMAGE` to select images, preferably immutable digests for experiments. Containers run without network access, as an unprivileged user, with read-only source mounts and CPU/memory/process limits. A missing daemon produces an error; the harness does not fall back to local execution. Container execution needs a running daemon and locally available images; only missing-daemon handling was verified in the initial build environment.

`--runner local` explicitly runs code on your machine and should be used only with trusted code. Its subprocess environment omits controller credentials, but it is not a filesystem or process sandbox. The bundled offline demo uses this mode for its known code.

Case files are arrays of `{ "id": "unique-case", "operation": "shop.base.subtotal", "args": [2, 100] }`, using operations declared by the plan. Expected results are captured from the source implementation. Visible cases must exercise every migration unit with callable operations. Workers can query visible checks; held-out cases are evaluated only after terminal execution and never enter repair feedback.

## Scheduling, repair, and recovery

A task runs only after its dependencies are integrated. Workers use bounded file tools; they cannot modify shared build files or run arbitrary shell commands. Separate limits control workers, build jobs, model calls, attempts, output size, and execution deadlines. `--task-timeout` applies to each worker attempt; `--run-timeout` bounds each controller execution session.

Candidate checks run against a recorded base. A single integration writer applies each candidate to current HEAD, runs checks again, and promotes the exact checked tree. Failed implementations are retained under `repairs/` and restored into subsequent attempts. Failed prerequisites block their descendants rather than leaving the scheduler waiting forever.

SQLite records state transitions and their events atomically. Recovery reconciles integration commit metadata with the database before restarting interrupted attempts. It restarts the task from saved artifacts rather than restoring an unfinished model conversation. Only one controller may operate a run at a time.

```sh
PYTHONPATH=src python3 -m hensei resume runs/live-001
PYTHONPATH=src python3 -m hensei resume runs/live-001 --max-tokens 1500000
```

Scored terminal runs are frozen; start a new run for additional changes. Budget/time/infrastructure pauses do not expose held-out scores and remain resumable. Preparation failures need a new output directory after fixing the problem.

The token ceiling uses conservative UTF-8-byte input reservations plus the requested output cap and returned provider usage. Requests wait for competing reservations to finish. API timeouts may have unknown billed usage; the report does not claim an exact billing ceiling. DeepSeek retries are bounded, thinking-mode continuation fields are preserved, and private reasoning is omitted from public traces.

## Tests

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Tests cover dependency cycles, invalid plans, scoped tools, provider continuation, budget reservations, incorrect translations, Git conflicts, current-HEAD integration, recovery, scheduling, and holdout separation. Local Go integration tests require Go; no test makes a paid API call.

## Research use and current limits

The report separates implementation coverage, target buildability, visible behavior, held-out behavior, tokens, repair counts, and worker overlap. `strict_success` requires complete implementation and passing visible plus held-out checks. Without a holdout, only development success is reported. A buildable skeleton alone cannot count as migration success.

This version implements the deterministic orchestration and bounded translation-worker loop. Planning is static; the independent LLM reviewer, arbitrary command execution, dynamic plan revision, distributed execution, and multiple language pairs are future research extensions. Live DeepSeek inference and running-container validation were not performed during this build. Cost remains unpriced until an applicable provider tariff is supplied; do not treat demo timings as comparative paper results.

Read [the research plan](MAO_V1_RESEARCH_PLAN.md) for baselines, dataset selection, experiment controls, metrics, and the semester roadmap.
