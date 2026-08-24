"""Compare repeated legacy Terminal-Bench runs without dropping trials.

Usage:
    python3 bench/compare_runs.py <pi-run-dir> <baseline-run-dir> [--json <path>]

pi usage is read from captured pane/session logs. Baseline usage is read from
each trial's results.json. Every trial remains an independent observation;
earlier versions accidentally overwrote repeats with the same task name.
"""

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TypedDict

class Tokens(TypedDict):
    input: int
    output: int
    requests: int | None
    cost_usd: float | None
    # Cache split, where the source reports it. "input" stays the combined
    # total (raw + cache read + cache write) for continuity, but cached reads
    # are billed at a fraction of list rate, so pricing analysis must use the
    # split. Terminus results.json reports no split; these stay None there.
    input_uncached: int | None
    cache_read: int | None
    cache_write: int | None


class Trial(TypedDict):
    trial: str
    resolved: bool
    tokens: Tokens | None


def trial_dirs(run_dir: Path):
    if not run_dir.is_dir():
        raise ValueError(f"run directory does not exist: {run_dir}")
    for task_dir in sorted(run_dir.iterdir()):
        if not task_dir.is_dir():
            continue
        for trial in sorted(task_dir.iterdir()):
            if (trial / "results.json").is_file():
                yield task_dir.name, trial


def pi_tokens(trial: Path) -> Tokens | None:
    """Last typed terminal usage row; all counters come from that one record."""
    summary = None
    # Session logs first: they carry unwrapped lines, while tmux pane captures
    # truncate at terminal width and can cut a usage row mid-JSON. Panes remain
    # as fallback for older runs that captured no session logs.
    candidates = sorted(trial.glob("sessions/*.log")) + sorted(trial.glob("panes/*.txt"))
    for candidate in candidates:
        text = candidate.read_text(errors="replace")
        for line in text.splitlines():
            try:
                value = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict) or value.get("v") != 1 or value.get("type") != "usage_summary":
                continue
            usage = value.get("usage")
            requests = value.get("requests")
            if not isinstance(usage, dict) or type(requests) is not int or requests < 0:
                continue
            if not all(
                type(usage.get(key)) is int and usage[key] >= 0
                for key in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")
            ):
                continue
            summary = value
    if not summary:
        return None
    usage = summary["usage"]
    total_in = usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"]
    cost = summary.get("cost")
    cost_usd = None
    if isinstance(cost, dict) and cost.get("complete") is True:
        raw_cost = cost.get("usd")
        if type(raw_cost) not in (int, float) or not 0 <= raw_cost < float("inf"):
            return None
        cost_usd = float(raw_cost)
    return {
        "input": total_in,
        "output": usage["outputTokens"],
        "requests": summary["requests"],
        "cost_usd": cost_usd,
        "input_uncached": usage["inputTokens"],
        "cache_read": usage["cacheReadTokens"],
        "cache_write": usage["cacheWriteTokens"],
    }


def terminus_tokens(trial: Path) -> Tokens | None:
    data = json.loads((trial / "results.json").read_text())
    for in_key, out_key in [
        ("total_input_tokens", "total_output_tokens"),
        ("n_input_tokens", "n_output_tokens"),
    ]:
        if data.get(in_key) is not None and data.get(out_key) is not None:
            input_tokens, output_tokens = int(data[in_key]), int(data[out_key])
            if input_tokens < 0 or output_tokens < 0:
                raise ValueError(f"negative token count in {trial / 'results.json'}")
            return {
                "input": input_tokens,
                "output": output_tokens,
                "requests": None,
                "cost_usd": None,
                "input_uncached": None,
                "cache_read": None,
                "cache_write": None,
            }
    return None


def resolved(trial: Path) -> bool:
    data = json.loads((trial / "results.json").read_text())
    return bool(data.get("is_resolved"))


def collect(run_dir: Path, extractor: Callable[[Path], Tokens | None]) -> dict[str, list[Trial]]:
    rows: dict[str, list[Trial]] = defaultdict(list)
    for task, trial in trial_dirs(run_dir):
        rows[task].append(
            {
                "trial": str(trial.relative_to(run_dir)),
                "resolved": resolved(trial),
                "tokens": extractor(trial),
            }
        )
    return dict(rows)


def task_aggregate(trials: list[Trial]) -> dict[str, int | float | None]:
    tokens = [trial["tokens"] for trial in trials if trial["tokens"] is not None]
    return {
        "resolved": sum(1 for trial in trials if trial["resolved"]),
        "trials": len(trials),
        "with_token_data": len(tokens),
        "mean_input": sum(token["input"] for token in tokens) / len(tokens) if tokens else None,
        "mean_output": sum(token["output"] for token in tokens) / len(tokens) if tokens else None,
        "mean_cost_usd": (
            sum(token["cost_usd"] for token in tokens if token["cost_usd"] is not None)
            / len([token for token in tokens if token["cost_usd"] is not None])
            if any(token["cost_usd"] is not None for token in tokens)
            else None
        ),
    }


def summarize(name: str, rows: dict[str, list[Trial]], *, emit: bool = True) -> dict[str, int | float]:
    trials = [trial for task_trials in rows.values() for trial in task_trials]
    tokens = [trial["tokens"] for trial in trials if trial["tokens"] is not None]
    solved = sum(1 for trial in trials if trial["resolved"])
    solved_tasks = sum(1 for task_trials in rows.values() if any(trial["resolved"] for trial in task_trials))
    total_in = sum(token["input"] for token in tokens)
    total_out = sum(token["output"] for token in tokens)
    cache_rows = [token["cache_read"] for token in tokens if token.get("cache_read") is not None]
    total_cache_read = sum(cache_rows)
    cost_rows = [token["cost_usd"] for token in tokens if token["cost_usd"] is not None]
    summary: dict[str, int | float] = {
        "solved_trials": solved,
        "trials": len(trials),
        "solved_tasks": solved_tasks,
        "tasks": len(rows),
        "input_tokens": total_in,
        "output_tokens": total_out,
        "cache_read_tokens": total_cache_read if cache_rows else None,
        "trials_with_token_data": len(tokens),
        "mean_input_per_measured_trial": total_in / len(tokens) if tokens else 0,
        "mean_output_per_measured_trial": total_out / len(tokens) if tokens else 0,
        "cost_usd": sum(cost_rows),
        "trials_with_cost_data": len(cost_rows),
        "cost_per_solved_trial_usd": sum(cost_rows) / solved if cost_rows and solved else 0,
    }
    if emit:
        print(f"\n{name}: {solved}/{len(trials)} trials solved across {solved_tasks}/{len(rows)} tasks")
        cache_note = f" (cache reads {total_cache_read:,} of the input; bill them at the cached rate)" if cache_rows else ""
        print(f"  total tokens: {total_in:,} in / {total_out:,} out ({len(tokens)}/{len(trials)} trials have data){cache_note}")
        if tokens:
            print(f"  mean per measured trial: {total_in / len(tokens):,.0f} in / {total_out / len(tokens):,.0f} out")
        if cost_rows:
            print(f"  cost: ${sum(cost_rows):.6f} ({len(cost_rows)}/{len(trials)} trials priced)")
    return summary


def format_task(trials: list[Trial] | None) -> str:
    if not trials:
        return "—"
    aggregate = task_aggregate(trials)
    score = f"{aggregate['resolved']}/{aggregate['trials']}"
    if aggregate["mean_input"] is None:
        return f"{score} no token data"
    return f"{score} {aggregate['mean_input']:,.0f}in {aggregate['mean_output']:,.0f}out"


def paired_task_ratio(pi_rows: dict[str, list[Trial]], base_rows: dict[str, list[Trial]]) -> tuple[float, int] | None:
    pi_means: list[float] = []
    base_means: list[float] = []
    for task in sorted(set(pi_rows) & set(base_rows)):
        pi = task_aggregate(pi_rows[task])
        base = task_aggregate(base_rows[task])
        if pi["mean_input"] is not None and base["mean_input"] is not None:
            pi_means.append(float(pi["mean_input"]))
            base_means.append(float(base["mean_input"]))
    if not pi_means or sum(pi_means) == 0:
        return None
    return (sum(base_means) / len(base_means)) / (sum(pi_means) / len(pi_means)), len(pi_means)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pi_run_dir", type=Path)
    parser.add_argument("baseline_run_dir", type=Path)
    parser.add_argument("--json", type=Path, dest="json_path", help="write a machine-readable comparison artifact")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        pi_rows = collect(args.pi_run_dir, pi_tokens)
        base_rows = collect(args.baseline_run_dir, terminus_tokens)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"compare-runs: {error}") from error
    if not pi_rows or not base_rows:
        raise SystemExit("compare-runs: both directories must contain at least one results.json trial")

    print(f"{'task':32} {'pi repeats / mean tokens':>31} {'baseline repeats / mean tokens':>31}")
    for task in sorted(set(pi_rows) | set(base_rows)):
        print(f"{task:32} {format_task(pi_rows.get(task)):>31} {format_task(base_rows.get(task)):>31}")

    pi_summary = summarize("pi", pi_rows)
    base_summary = summarize("baseline", base_rows)
    ratio = paired_task_ratio(pi_rows, base_rows)
    if ratio:
        value, tasks = ratio
        print(f"\nbaseline sends {value:.2f}x pi's input tokens (mean of {tasks} matched task means)")

    if args.json_path:
        artifact = {
            "schemaVersion": 1,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "inputs": {
                "pi": str(args.pi_run_dir.resolve()),
                "baseline": str(args.baseline_run_dir.resolve()),
            },
            "summary": {"pi": pi_summary, "baseline": base_summary},
            "pairedTaskInputRatio": (
                {"baselineOverPi": ratio[0], "matchedTasks": ratio[1]} if ratio else None
            ),
            "tasks": {
                task: {
                    "pi": pi_rows.get(task, []),
                    "baseline": base_rows.get(task, []),
                }
                for task in sorted(set(pi_rows) | set(base_rows))
            },
        }
        args.json_path.parent.mkdir(parents=True, exist_ok=True)
        args.json_path.write_text(json.dumps(artifact, indent=2) + "\n")
        print(f"comparison artifact: {args.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
