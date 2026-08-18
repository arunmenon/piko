"""Compares token efficiency between a pi tb-run and a terminus tb-run.

Usage: python3 bench/compare_runs.py <pi-run-dir> <baseline-run-dir>

pi's per-task usage comes from the --usage JSON it prints to stderr (captured in
the trial pane logs); terminus reports token counts in each trial's results.json.
"""

import json
import re
import sys
from pathlib import Path

USAGE_RE = re.compile(r'"usage":(\{[^{}]*\})')
REQUESTS_RE = re.compile(r'"requests":(\d+)')


def trial_dirs(run_dir: Path):
    for task_dir in sorted(run_dir.iterdir()):
        if not task_dir.is_dir():
            continue
        for trial in sorted(task_dir.iterdir()):
            if (trial / "results.json").exists():
                yield task_dir.name, trial


def pi_tokens(trial: Path):
    """Last usage JSON in the trial's captured panes/logs; cache reads count as input."""
    usage = None
    requests = None
    for candidate in list(trial.glob("panes/*.txt")) + list(trial.glob("sessions/*.log")):
        text = candidate.read_text(errors="replace")
        for match in USAGE_RE.finditer(text):
            try:
                usage = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
        requests_matches = REQUESTS_RE.findall(text)
        if requests_matches:
            requests = int(requests_matches[-1])
    if not usage:
        return None
    total_in = usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"]
    return {"input": total_in, "output": usage["outputTokens"], "requests": requests}


def terminus_tokens(trial: Path):
    data = json.loads((trial / "results.json").read_text())
    for in_key, out_key in [
        ("total_input_tokens", "total_output_tokens"),
        ("n_input_tokens", "n_output_tokens"),
    ]:
        if data.get(in_key) is not None:
            return {"input": data[in_key], "output": data[out_key], "requests": None}
    return None


def resolved(trial: Path):
    data = json.loads((trial / "results.json").read_text())
    return bool(data.get("is_resolved"))


def collect(run_dir: Path, extractor):
    rows = {}
    for task, trial in trial_dirs(run_dir):
        rows[task] = {"resolved": resolved(trial), "tokens": extractor(trial)}
    return rows


def summarize(name: str, rows: dict):
    tokens = [r["tokens"] for r in rows.values() if r["tokens"]]
    solved = sum(1 for r in rows.values() if r["resolved"])
    total_in = sum(t["input"] for t in tokens)
    total_out = sum(t["output"] for t in tokens)
    print(f"\n{name}: {solved}/{len(rows)} solved")
    print(f"  total tokens: {total_in:,} in / {total_out:,} out (over {len(tokens)} tasks with data)")
    if tokens:
        print(f"  mean per task: {total_in // len(tokens):,} in / {total_out // len(tokens):,} out")
    return {"solved": solved, "n": len(rows), "in": total_in, "out": total_out, "with_data": len(tokens)}


def main():
    pi_dir, base_dir = Path(sys.argv[1]), Path(sys.argv[2])
    pi_rows = collect(pi_dir, pi_tokens)
    base_rows = collect(base_dir, terminus_tokens)

    print(f"{'task':32} {'pi':>22} {'baseline':>22}")
    for task in sorted(set(pi_rows) | set(base_rows)):
        cells = []
        for rows in (pi_rows, base_rows):
            row = rows.get(task)
            if not row:
                cells.append(f"{'—':>22}")
            elif row["tokens"]:
                mark = "✓" if row["resolved"] else "✗"
                cells.append(f"{mark} {row['tokens']['input']:>9,}in {row['tokens']['output']:>6,}out")
            else:
                mark = "✓" if row["resolved"] else "✗"
                cells.append(f"{mark} {'no token data':>19}")
        print(f"{task:32} {cells[0]} {cells[1]}")

    pi_summary = summarize("pi", pi_rows)
    base_summary = summarize("baseline", base_rows)
    if pi_summary["in"] and base_summary["in"] and pi_summary["with_data"] and base_summary["with_data"]:
        ratio = (base_summary["in"] / base_summary["with_data"]) / (pi_summary["in"] / pi_summary["with_data"])
        print(f"\nbaseline sends {ratio:.1f}x the input tokens of pi per task (mean)")


if __name__ == "__main__":
    main()
