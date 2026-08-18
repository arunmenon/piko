"""Terminal-Bench adapter for pi.

Usage (from the repo root, so `bench` is importable):

    PYTHONPATH=. tb run \
        --dataset terminal-bench-core \
        --agent-import-path bench.pi_agent:PiAgent \
        --model openai/gpt-4.1-mini \
        --task-id hello-world

Regenerate bench/pi-setup.sh.j2 after source changes with: bash bench/generate-setup.sh
"""

import os
import shlex

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class PiAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "pi"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # tb passes provider/model (e.g. openai/gpt-4.1-mini); pi wants the bare model id
        self._model = (model_name or "gpt-4.1-mini").split("/", 1)[-1]
        self._max_turns = int(kwargs.get("max_turns", 80))

    @property
    def _env(self) -> dict[str, str]:
        env = {"PI_MODEL": self._model}
        for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY"):
            if key in os.environ:
                env[key] = os.environ[key]
        if "OPENAI_API_KEY" not in env and "ANTHROPIC_API_KEY" not in env:
            raise ValueError("set OPENAI_API_KEY or ANTHROPIC_API_KEY for the pi agent")
        return env

    @property
    def _install_agent_script_path(self):
        return self._get_templated_script_path("pi-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        escaped = shlex.quote(instruction)
        return [
            TerminalCommand(
                command=f"pi -p --usage --max-turns {self._max_turns} {escaped}",
                max_timeout_sec=float("inf"),
                block=True,
            )
        ]
