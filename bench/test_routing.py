import unittest

from bench.routing import command_for_route, environment_for_route, route_model


class RoutingTests(unittest.TestCase):
    def test_provider_prefix_becomes_explicit_profile(self):
        route = route_model("openai/gpt-4.1-mini")
        self.assertEqual((route.profile, route.model), ("openai", "gpt-4.1-mini"))
        route = route_model("anthropic/claude-sonnet-4")
        self.assertEqual((route.profile, route.model), ("anthropic", "claude-sonnet-4"))

    def test_bare_model_is_deterministic(self):
        self.assertEqual(route_model("claude-sonnet-4").profile, "anthropic")
        self.assertEqual(route_model("local-model").profile, "openai")

    def test_unknown_prefix_is_rejected_with_compatible_endpoint_guidance(self):
        with self.assertRaisesRegex(ValueError, "OPENAI_BASE_URL"):
            route_model("openrouter/some-model")

    def test_only_selected_provider_credentials_are_forwarded(self):
        source = {
            "OPENAI_API_KEY": "openai-secret",
            "OPENAI_BASE_URL": "https://openai.example/v1",
            "ANTHROPIC_API_KEY": "anthropic-secret",
            "ANTHROPIC_BASE_URL": "https://anthropic.example",
        }
        self.assertEqual(
            environment_for_route(route_model("openai/gpt-4.1-mini"), source),
            {"OPENAI_API_KEY": "openai-secret", "OPENAI_BASE_URL": "https://openai.example/v1"},
        )
        self.assertEqual(
            environment_for_route(route_model("anthropic/claude-sonnet-4"), source),
            {"ANTHROPIC_API_KEY": "anthropic-secret", "ANTHROPIC_BASE_URL": "https://anthropic.example"},
        )

    def test_selected_provider_must_be_configured(self):
        with self.assertRaisesRegex(ValueError, "OPENAI_API_KEY"):
            environment_for_route(route_model("openai/gpt-4.1-mini"), {"ANTHROPIC_API_KEY": "wrong-key"})

    def test_command_includes_explicit_route_and_quotes_instruction(self):
        command = command_for_route(route_model("openai/gpt-4.1-mini"), 12, "fix this; echo unsafe")
        self.assertIn("--profile openai --model gpt-4.1-mini --max-turns 12", command)
        self.assertIn("--allow-host-bash", command)
        self.assertTrue(command.endswith("'fix this; echo unsafe'"))


if __name__ == "__main__":
    unittest.main()
