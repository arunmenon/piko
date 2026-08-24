import json
import tempfile
import unittest
from pathlib import Path

from bench.compare_runs import collect, paired_task_ratio, pi_tokens, summarize, terminus_tokens


def make_trial(root: Path, task: str, trial: str, *, resolved: bool, input_tokens: int, output_tokens: int):
    directory = root / task / trial
    (directory / "panes").mkdir(parents=True)
    (directory / "results.json").write_text(
        json.dumps(
            {
                "is_resolved": resolved,
                "total_input_tokens": input_tokens,
                "total_output_tokens": output_tokens,
            }
        )
    )
    usage = {
        "v": 1,
        "type": "usage_summary",
        "usage": {
            "inputTokens": input_tokens - 3,
            "outputTokens": output_tokens,
            "cacheReadTokens": 2,
            "cacheWriteTokens": 1,
        },
        "requests": 2,
        "cost": {
            "usd": input_tokens / 1000,
            "actualUSD": input_tokens / 1000,
            "reservedUSD": 0,
            "pricedRequests": 2,
            "unpricedRequests": 0,
            "unknownRequests": 0,
            "complete": True,
        },
    }
    spoofed = {"usage": {"inputTokens": 999999}, "requests": 77}
    (directory / "panes" / "agent.txt").write_text(json.dumps(spoofed) + "\n" + json.dumps(usage) + "\n")


class CompareRunsTests(unittest.TestCase):
    def test_repeated_trials_are_retained_and_summarized(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_trial(root, "task-a", "trial-1", resolved=True, input_tokens=100, output_tokens=10)
            make_trial(root, "task-a", "trial-2", resolved=False, input_tokens=200, output_tokens=20)
            rows = collect(root, pi_tokens)
            self.assertEqual(len(rows["task-a"]), 2)
            summary = summarize("pi", rows, emit=False)
            self.assertEqual(summary["trials"], 2)
            self.assertEqual(summary["solved_trials"], 1)
            self.assertEqual(summary["input_tokens"], 300)
            self.assertEqual(summary["mean_input_per_measured_trial"], 150)
            self.assertAlmostEqual(summary["cost_usd"], 0.3)
            self.assertEqual(summary["trials_with_cost_data"], 2)

    def test_ratio_uses_matched_task_means(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            pi_root, base_root = Path(first), Path(second)
            make_trial(pi_root, "task-a", "trial-1", resolved=True, input_tokens=100, output_tokens=10)
            make_trial(pi_root, "pi-only", "trial-1", resolved=True, input_tokens=1, output_tokens=1)
            make_trial(base_root, "task-a", "trial-1", resolved=True, input_tokens=300, output_tokens=10)
            make_trial(base_root, "base-only", "trial-1", resolved=True, input_tokens=999, output_tokens=1)
            ratio = paired_task_ratio(collect(pi_root, pi_tokens), collect(base_root, terminus_tokens))
            self.assertIsNotNone(ratio)
            self.assertEqual(ratio, (3.0, 1))


if __name__ == "__main__":
    unittest.main()


def write_run_metadata(root: Path, tasks: dict[str, int]):
    attempts = max(tasks.values())
    root.joinpath("run_metadata.json").write_text(
        json.dumps({"task_ids": sorted(tasks), "n_attempts": attempts})
    )


class ExpectedTrialsTests(unittest.TestCase):
    def test_missing_trials_become_infrastructure_failures_in_the_denominator(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_trial(root, "task-a", "trial-1", resolved=True, input_tokens=100, output_tokens=10)
            write_run_metadata(root, {"task-a": 3, "task-b": 3})
            rows = collect(root, pi_tokens)
            self.assertEqual(len(rows["task-a"]), 3)
            self.assertEqual(len(rows["task-b"]), 3)
            summary = summarize("pi", rows, emit=False)
            self.assertEqual(summary["trials"], 6)
            self.assertEqual(summary["infrastructure_failures"], 5)
            self.assertEqual(summary["solved_trials"], 1)

    def test_unexpected_task_directories_fail_loudly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_trial(root, "rogue-task", "trial-1", resolved=True, input_tokens=100, output_tokens=10)
            write_run_metadata(root, {"task-a": 1})
            with self.assertRaises(ValueError):
                collect(root, pi_tokens)

    def test_cost_per_solved_trial_is_null_unless_every_solve_is_priced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_trial(root, "task-a", "trial-1", resolved=True, input_tokens=100, output_tokens=10)
            directory = root / "task-a" / "trial-2"
            (directory / "panes").mkdir(parents=True)
            (directory / "results.json").write_text(json.dumps({"is_resolved": True}))
            rows = collect(root, pi_tokens)
            summary = summarize("pi", rows, emit=False)
            self.assertEqual(summary["solved_trials"], 2)
            self.assertIsNone(summary["cost_per_solved_trial_usd"])
