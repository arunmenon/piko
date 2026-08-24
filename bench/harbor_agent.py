"""Harbor (Terminal-Bench 2.x) adapter for piko.

Usage (from the repo root, so `bench` is importable):

    bash bench/generate-setup.sh
    PYTHONPATH=. harbor run \
        --dataset terminal-bench@2.1 \
        --agent bench.harbor_agent:Piko \
        --model openai/gpt-5.5 \
        --task-id <task>

The agent name is "piko": Harbor ships a built-in "pi" adapter for the
badlogic pi-coding-agent, which this project is not.

This adapter reuses the legacy tb adapter's pieces so both benchmark paths
stay in lockstep: bench/routing.py builds the exact pi command and forwards
only the selected provider's credentials, and bench/pi-setup.sh.j2 (a plain
bash script despite the .j2 name the legacy harness requires) installs the
same pinned-Node, checksum-verified, single-file pi build with the baked
pricing table.
"""

import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from bench.routing import command_for_route, environment_for_route, route_model

_SETUP_SCRIPT = Path(__file__).parent / "pi-setup.sh.j2"
_REMOTE_SETUP_PATH = "/installed-agent/pi-setup.sh"
_DEFAULT_MAX_TURNS = 80


class Piko(BaseInstalledAgent):
    _OUTPUT_FILENAME = "piko.txt"

    def __init__(self, *args: Any, max_turns: int = _DEFAULT_MAX_TURNS, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        max_turns = int(max_turns)
        if max_turns < 1:
            raise ValueError("max_turns must be >= 1")
        self._max_turns = max_turns

    @staticmethod
    @override
    def name() -> str:
        return "piko"

    @override
    def get_version_command(self) -> str | None:
        return "pi --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not _SETUP_SCRIPT.is_file():
            raise FileNotFoundError(
                f"{_SETUP_SCRIPT} is missing; run `bash bench/generate-setup.sh` first"
            )
        await environment.upload_file(_SETUP_SCRIPT, _REMOTE_SETUP_PATH)
        await self.exec_as_root(
            environment,
            command=f"bash {shlex.quote(_REMOTE_SETUP_PATH)}",
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        if not self.model_name:
            raise ValueError("piko requires --model (e.g. openai/gpt-5.5)")
        route = route_model(self.model_name)
        command = command_for_route(route, self._max_turns, instruction)
        credential_names = ("OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL")
        env_source = {name: value for name in credential_names if (value := self._get_env(name))}
        env = environment_for_route(route, env_source)
        output_path = (self.environment_logs_dir / self._OUTPUT_FILENAME).as_posix()
        await self.exec_as_agent(
            environment,
            command=f"{command} </dev/null 2>&1 | tee {shlex.quote(output_path)}",
            env=env,
        )
