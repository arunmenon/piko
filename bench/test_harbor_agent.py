import unittest

try:
    import harbor  # noqa: F401

    HARBOR_AVAILABLE = True
except ImportError:
    HARBOR_AVAILABLE = False


@unittest.skipUnless(HARBOR_AVAILABLE, "harbor is not installed in this interpreter")
class HarborAdapterTest(unittest.TestCase):
    def test_agent_name_avoids_builtin_pi_collision(self):
        from bench.harbor_agent import Piko

        self.assertEqual(Piko.name(), "piko")

    def test_adapter_is_concrete(self):
        import inspect

        from bench.harbor_agent import Piko

        self.assertFalse(inspect.isabstract(Piko))

    def test_max_turns_is_validated(self):
        from bench.harbor_agent import Piko

        with self.assertRaises(ValueError):
            Piko(logs_dir=None, max_turns=0)


if __name__ == "__main__":
    unittest.main()
