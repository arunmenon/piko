"""Legacy Terminal-Bench 0.2.x adapter for pi.

Usage (from the repo root, so `bench` is importable):

    PYTHONPATH=. tb run \
        --dataset terminal-bench-core \
        --agent-import-path bench.pi_agent:PiAgent \
        --model openai/gpt-4.1-mini \
        --task-id hello-world

Regenerate bench/pi-setup.sh.j2 after source changes with: bash bench/generate-setup.sh

Terminal-Bench passes models as provider/model. The adapter always forwards an
explicit --profile and only that provider's credentials; this prevents a host
with both API keys from silently routing an OpenAI model through Anthropic.
"""

import os

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand

from bench.routing import command_for_route, environment_for_route, route_model


class PiAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "pi"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._route = route_model(model_name or "openai/gpt-4.1-mini")
        self._model = self._route.model
        self._profile = self._route.profile
        self._max_turns = int(kwargs.get("max_turns", 80))
        if self._max_turns < 1:
            raise ValueError("max_turns must be >= 1")

    @property
    def _env(self) -> dict[str, str]:
        return environment_for_route(self._route, os.environ)

    @property
    def _install_agent_script_path(self):
        return self._get_templated_script_path("pi-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        return [
            TerminalCommand(
                # The benchmark already provides OS isolation. pi's host-bash
                # opt-in is therefore required for terminal tasks and remains
                # contained inside the task container.
                command=command_for_route(self._route, self._max_turns, instruction),
                max_timeout_sec=float("inf"),
                block=True,
            )
        ]
