# Evaluation and benchmark evidence

The local `eval/` suite is a deterministic smoke test of ten small coding tasks.
It is useful for detecting regressions in headless execution and token use; it is
not evidence of broad software-engineering capability by itself.

## Local smoke suite

Use an explicit provider profile and model for publishable runs:

```bash
npm run eval -- \
  --profile openai \
  --model gpt-4.1-mini \
  --max-turns 15
```

Options include `--only <task>`, `--timeout <seconds>`, and
`--output-dir <new-directory>`. The supplied output directory must not already
exist, preventing one run from overwriting another. Without it, results go to
`artifacts/eval/<timestamp>-<random-id>/`.

A task passes only if all of the following are true:

1. The CLI process was spawned successfully and did not time out or receive a
   signal.
2. It exited with status zero and did not report an incomplete terminal state.
3. It emitted a valid `--usage` record attesting a `completed` terminal status.
4. The task's deterministic filesystem verifier passed without throwing.

This means a partial or failed agent run cannot pass merely because it happened
to leave the expected file behind.

Each run writes:

```text
manifest.json
trials/<task>/result.json
trials/<task>/stdout.txt
trials/<task>/stderr.txt
trials/<task>/session.jsonl   # when the CLI reports a readable session
```

The manifest records the commit, dirty-worktree flag, a deterministic source-tree
hash, hashes and sizes for every executed `ai`/`core`/`cli` dist file, runtime,
requested provider/model, evaluation-source and verifier-inclusive task-definition
hashes, budgets, outcomes, and artifact paths.
Each trial records process termination, verification, usage, and initial/final
workspace file hashes. Files are owner-only where the platform honors POSIX
modes.

The session and logs may contain source, prompts, paths, and model output. Review
and redact artifacts before publishing them. `artifacts/` is gitignored so a
live run is never accidentally presented as repository evidence.

## Legacy Terminal-Bench adapter

`bench/pi_agent.py` remains compatible with the legacy Terminal-Bench 0.2.x
installed-agent API. Its dependency is deliberately pinned to the published
0.2.18 release:

```bash
python3.12 -m venv .venv-bench
.venv-bench/bin/python -m pip install -r bench/requirements-legacy.txt
npm ci
bash bench/generate-setup.sh

PYTHONPATH=. .venv-bench/bin/tb run \
  --dataset terminal-bench-core \
  --agent-import-path bench.pi_agent:PiAgent \
  --model openai/gpt-4.1-mini \
  --task-id hello-world
```

The adapter converts `openai/<model>` and `anthropic/<model>` into explicit pi
profiles and forwards only the selected provider's credentials. For an
OpenAI-compatible endpoint, use `openai/<model>` plus `OPENAI_BASE_URL`. Bare
models remain supported for old scripts but prefixed models are preferred.

Terminal-Bench 2.0 and 2.1 use Harbor and a different agent API. The legacy
adapter must not be described as a Harbor or TB 2.x submission. A future Harbor
port should live beside this adapter until existing 0.2.x results have been
reproduced and archived.

## Comparing repeated runs

```bash
python3 bench/compare_runs.py runs/pi runs/baseline \
  --json artifacts/bench/comparison.json
```

The comparison retains every trial. Per-task cells report solved repeats and
mean tokens, while the input-token ratio uses only task names present in both
runs. Missing token data is reported rather than silently treated as zero.

Before making a comparative claim, verify that both arms use the same:

- Dataset name, version, task subset, and task-container revisions.
- Model ID/revision, endpoint, sampling settings, and context window.
- Attempt count, timeout, concurrency, and resource limits.
- Tool/network policy and benchmark scoring code.

Use at least five independent attempts for leaderboard-style pass-rate claims.
Publish raw trial directories and the machine-readable comparison, report
failures/timeouts separately, and include uncertainty rather than only a mean.
Populate `bench/run-manifest.example.json` for each benchmark arm. Never infer a
model-only result from a model-plus-harness experiment.
