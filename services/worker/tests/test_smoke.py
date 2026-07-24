import importlib
import unittest


class WorkerSmokeTest(unittest.TestCase):
    def test_worker_scaffold_exposes_fastapi_compatible_factory(self):
        module = importlib.import_module("app.main")

        self.assertTrue(callable(module.create_app))
        self.assertEqual(module.WORKER_SERVICE_NAME, "pg1-document-ai-worker")


if __name__ == "__main__":
    unittest.main()
