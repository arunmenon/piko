"""Pure provider/model routing helpers for the legacy Terminal-Bench adapter."""

import shlex
from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class ModelRoute:
    profile: str
    model: str
    provider: str


def route_model(model_name: str) -> ModelRoute:
    """Translate Terminal-Bench's provider/model form into explicit pi flags."""
    value = model_name.strip()
    if not value:
        raise ValueError("model_name must not be empty")

    if "/" not in value:
        # Preserve the old bare-model behavior, but make the provider deterministic.
        profile = "anthropic" if value.lower().startswith("claude") else "openai"
        return ModelRoute(profile=profile, model=value, provider=profile)

    provider, model = value.split("/", 1)
    provider = provider.lower()
    if not model:
        raise ValueError(f'model name is missing after provider prefix in "{model_name}"')
    if provider not in {"openai", "anthropic"}:
        raise ValueError(
            f'unsupported Terminal-Bench provider "{provider}"; use openai/<model> '
            "with OPENAI_BASE_URL for OpenAI-compatible endpoints"
        )
    return ModelRoute(profile=provider, model=model, provider=provider)


def environment_for_route(route: ModelRoute, source: Mapping[str, str]) -> dict[str, str]:
    """Forward only the selected provider's credentials and endpoint."""
    if route.provider == "anthropic":
        names = ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL")
    else:
        names = ("OPENAI_API_KEY", "OPENAI_BASE_URL")
    environment = {name: source[name] for name in names if source.get(name)}
    if not environment:
        key = "ANTHROPIC_API_KEY" if route.provider == "anthropic" else "OPENAI_API_KEY"
        base = "ANTHROPIC_BASE_URL" if route.provider == "anthropic" else "OPENAI_BASE_URL"
        raise ValueError(f"set {key} or an explicit {base} for the pi benchmark agent")
    return environment


# Per-trial spend ceiling. Held-out evidence: the worst failures (play-zork)
# burned ~$2.06 each at the 80-turn ceiling while the most expensive observed
# solve cost ~$0.25; $1.50 caps runaway failures with ample solve headroom.
DEFAULT_MAX_SPEND_USD = "1.50"


def command_for_route(
    route: ModelRoute, max_turns: int, instruction: str, max_spend_usd: str = DEFAULT_MAX_SPEND_USD
) -> str:
    if max_turns < 1:
        raise ValueError("max_turns must be >= 1")
    if float(max_spend_usd) <= 0:
        raise ValueError("max_spend_usd must be positive")
    return (
        "pi -p --usage --allow-host-bash "
        "--pricing /opt/pi/model-prices.json "
        f"--max-spend-usd {shlex.quote(max_spend_usd)} "
        f"--profile {shlex.quote(route.profile)} --model {shlex.quote(route.model)} "
        f"--max-turns {max_turns} {shlex.quote(instruction)}"
    )
