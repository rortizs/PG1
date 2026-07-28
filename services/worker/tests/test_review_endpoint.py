"""HTTP-level proof (via FastAPI TestClient) that `POST /internal/review`
fails LOUDLY and explicitly — never silently, never falling back to Claude,
never crashing unhandled — for both the pre-existing "no credentials at all"
case and the new DeepSeek/Groq "registered but not implemented" case
(llm-provider-admin Work Units 5-6). No real Claude/DeepSeek/Groq network
call is ever reachable from this file.
"""
from __future__ import annotations

import importlib
import os
import unittest

from fastapi.testclient import TestClient


class ReviewEndpointTest(unittest.TestCase):
    def setUp(self):
        main = importlib.import_module("app.main")
        self.client = TestClient(main.create_app())
        self._previous_api_key = os.environ.pop("ANTHROPIC_API_KEY", None)

    def tearDown(self):
        if self._previous_api_key is not None:
            os.environ["ANTHROPIC_API_KEY"] = self._previous_api_key

    def test_missing_credentials_returns_explicit_configuration_error_never_silent(self):
        response = self.client.post(
            "/internal/review", json={"thesis_text": "Some thesis excerpt."}
        )

        self.assertEqual(response.status_code, 500)
        self.assertIn("configuration_error", response.json()["detail"])

    def test_deepseek_provider_returns_explicit_not_implemented_never_falls_back_to_claude(self):
        response = self.client.post(
            "/internal/review",
            json={
                "thesis_text": "Some thesis excerpt.",
                "provider_name": "deepseek",
                "api_key": "sk-deepseek-must-never-leak",
                "model_id": "deepseek-chat",
            },
        )

        self.assertEqual(response.status_code, 501)
        detail = response.json()["detail"]
        self.assertIn("not_implemented", detail)
        self.assertIn("deepseek", detail.lower())
        self.assertNotIn("sk-deepseek-must-never-leak", detail)

    def test_groq_provider_returns_explicit_not_implemented_never_falls_back_to_claude(self):
        response = self.client.post(
            "/internal/review",
            json={
                "thesis_text": "Some thesis excerpt.",
                "provider_name": "groq",
                "api_key": "sk-groq-must-never-leak",
                "model_id": "llama-3.3-70b",
            },
        )

        self.assertEqual(response.status_code, 501)
        detail = response.json()["detail"]
        self.assertIn("not_implemented", detail)
        self.assertIn("groq", detail.lower())
        self.assertNotIn("sk-groq-must-never-leak", detail)

    def test_old_style_request_with_only_thesis_text_still_validates(self):
        """Backward compatibility: a caller that has not been updated to send
        provider fields (the pre-llm-provider-admin shape) must still be
        accepted by the request schema — it just resolves to the Claude/env
        fallback path, proven by the 500 configuration_error above with no
        `ANTHROPIC_API_KEY` set."""
        response = self.client.post(
            "/internal/review", json={"thesis_text": "Old-style caller."}
        )

        # 500 (missing config), never 422 (schema rejection) — the new
        # fields are genuinely optional.
        self.assertEqual(response.status_code, 500)


if __name__ == "__main__":
    unittest.main()
