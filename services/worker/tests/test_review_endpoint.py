"""HTTP-level proof (via FastAPI TestClient) that `POST /internal/review`
fails LOUDLY and explicitly, and now accepts only the structured Work Unit 8
contract: pages/sections plus a judgment provider config. No real provider
network call is ever reachable from this file unless a test deliberately uses
the real dependency path for configuration/error handling.
"""
from __future__ import annotations

import importlib
import json
import os
import unittest
from typing import Any, cast

from fastapi.testclient import TestClient


class FakeLLMProvider:
    def __init__(self, response_text: str | None = None, *, error: Exception | None = None):
        self.response_text = response_text or json.dumps({"findings": []})
        self.error = error
        self.calls: list[dict] = []

    def complete(self, *, system_blocks, user_text: str, max_tokens: int = 2048):
        from app.providers.llm_provider import CompletionResult

        self.calls.append({"system_blocks": system_blocks, "user_text": user_text})
        if self.error is not None:
            raise self.error
        return CompletionResult(text=self.response_text, cache_read_tokens=0, cache_write_tokens=5)


class ReviewEndpointTest(unittest.TestCase):
    def setUp(self):
        self.main = importlib.import_module("app.main")
        self.client = TestClient(self.main.create_app())
        self._previous_api_key = os.environ.pop("ANTHROPIC_API_KEY", None)
        self._previous_deepseek_api_key = os.environ.pop("DEEPSEEK_API_KEY", None)

    def tearDown(self):
        if self._previous_api_key is not None:
            os.environ["ANTHROPIC_API_KEY"] = self._previous_api_key
        if self._previous_deepseek_api_key is not None:
            os.environ["DEEPSEEK_API_KEY"] = self._previous_deepseek_api_key

    def _review_payload(
        self,
        *,
        provider_name: str = "claude",
        api_key: str | None = "sk-test",
        model_id: str = "claude-test",
    ):
        return {
            "pages": [
                {
                    "page_number": 1,
                    "section_title": "CAPÍTULO 1",
                    "text": "Live endpoint grounded excerpt.",
                }
            ],
            "sections": [
                {
                    "index": 0,
                    "section_type": "chapter",
                    "title": "CAPÍTULO 1",
                    "start_page_number": 1,
                    "end_page_number": 1,
                    "is_location_uncertain": False,
                }
            ],
            "judgment_provider": {
                "provider_name": provider_name,
                "api_key": api_key,
                "model_id": model_id,
            },
            "triage_provider": None,
        }

    def test_internal_review_accepts_structured_pages_sections_and_returns_findings_list_with_stats(self):
        fake_provider = FakeLLMProvider(
            json.dumps(
                {
                    "findings": [
                        {
                            "title": "Grounded endpoint finding",
                            "explanation": "Explanation.",
                            "recommendation": "Recommendation.",
                            "evidence_text": "Live endpoint grounded excerpt.",
                            "page_number": 1,
                            "section_index": 0,
                            "normative_source_ref": "lineamientos_ingenieria_sistemas.txt",
                            "severity": "medium",
                            "confidence": 0.9,
                        }
                    ]
                }
            )
        )
        app = cast(Any, self.client.app)
        app.dependency_overrides[self.main.get_judgment_provider] = lambda: fake_provider
        try:
            response = self.client.post("/internal/review", json=self._review_payload())
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("findings", body)
        self.assertIn("stats", body)
        self.assertEqual(len(body["findings"]), 1)
        self.assertEqual(body["findings"][0]["section_index"], 0)
        self.assertEqual(body["stats"]["chunks"], 1)
        self.assertEqual(len(fake_provider.calls), 1)

    def test_old_style_request_with_only_thesis_text_is_rejected_by_the_new_contract(self):
        response = self.client.post(
            "/internal/review", json={"thesis_text": "Old-style caller."}
        )

        self.assertEqual(response.status_code, 422)

    def test_missing_judgment_credentials_returns_explicit_configuration_error_never_silent(self):
        payload = self._review_payload(api_key=None)
        response = self.client.post("/internal/review", json=payload)

        self.assertEqual(response.status_code, 500)
        self.assertIn("configuration_error", response.json()["detail"])

    def test_deepseek_judgment_provider_missing_credentials_returns_configuration_error_never_falls_back_to_claude(self):
        response = self.client.post(
            "/internal/review",
            json=self._review_payload(
                provider_name="deepseek",
                api_key=None,
                model_id="deepseek-chat",
            ),
        )

        self.assertEqual(response.status_code, 500)
        detail = response.json()["detail"]
        self.assertIn("configuration_error", detail)
        self.assertIn("deepseek", detail.lower())

    def test_groq_judgment_provider_returns_explicit_not_implemented_never_falls_back_to_claude(self):
        response = self.client.post(
            "/internal/review",
            json=self._review_payload(
                provider_name="groq",
                api_key="sk-groq-must-never-leak",
                model_id="llama-3.3-70b",
            ),
        )

        self.assertEqual(response.status_code, 501)
        detail = response.json()["detail"]
        self.assertIn("not_implemented", detail)
        self.assertIn("groq", detail.lower())
        self.assertNotIn("sk-groq-must-never-leak", detail)

    def test_internal_review_accepts_absent_triage_provider_without_erroring(self):
        fake_provider = FakeLLMProvider(json.dumps({"findings": []}))
        app = cast(Any, self.client.app)
        app.dependency_overrides[self.main.get_judgment_provider] = lambda: fake_provider
        try:
            payload = self._review_payload()
            payload.pop("triage_provider")
            response = self.client.post("/internal/review", json=payload)
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["findings"], [])

    def test_triage_provider_error_fails_open_without_leaking_triage_key(self):
        secret = "sk-triage-secret-must-not-leak"
        judgment_provider = FakeLLMProvider(
            json.dumps(
                {
                    "findings": [
                        {
                            "title": "Judgment still runs",
                            "explanation": "Explanation.",
                            "recommendation": "Recommendation.",
                            "evidence_text": "Live endpoint grounded excerpt.",
                            "page_number": 1,
                            "section_index": 0,
                            "normative_source_ref": "lineamientos_ingenieria_sistemas.txt",
                            "severity": "medium",
                            "confidence": 0.9,
                        }
                    ]
                }
            )
        )
        triage_provider = FakeLLMProvider(error=RuntimeError(f"triage failed {secret}"))
        app = cast(Any, self.client.app)
        main_module = cast(Any, self.main)
        original_select = main_module.select_llm_provider

        def select_spy(provider_name, api_key, model_id):
            if provider_name == "deepseek":
                self.assertEqual(api_key, secret)
                return triage_provider
            return original_select(provider_name, api_key, model_id)

        app.dependency_overrides[main_module.get_judgment_provider] = lambda: judgment_provider
        main_module.select_llm_provider = select_spy
        try:
            payload = self._review_payload()
            payload["triage_provider"] = {
                "provider_name": "deepseek",
                "api_key": secret,
                "model_id": "deepseek-chat",
            }
            response = self.client.post("/internal/review", json=payload)
        finally:
            app.dependency_overrides.clear()
            main_module.select_llm_provider = original_select

        self.assertEqual(response.status_code, 200)
        body_text = response.text
        self.assertNotIn(secret, body_text)
        body = response.json()
        self.assertEqual(body["findings"][0]["title"], "Judgment still runs")
        self.assertEqual(body["stats"]["triage_errors"], 1)
        self.assertEqual(len(judgment_provider.calls), 1)

    def test_internal_rules_never_calls_llm_provider_selection(self):
        main = cast(Any, importlib.import_module("app.main"))

        def _spy(*_args, **_kwargs):
            raise AssertionError(
                "select_llm_provider must never be called by /internal/rules"
            )

        original = main.select_llm_provider
        main.select_llm_provider = _spy
        try:
            response = self.client.post(
                "/internal/rules",
                json={
                    "pages": [
                        {
                            "page_number": 1,
                            "section_title": None,
                            "text": "Es decir que el resultadoo fue positivo.",
                        }
                    ],
                    "sections": [],
                },
            )
        finally:
            main.select_llm_provider = original

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("findings", body)
        self.assertIsInstance(body["findings"], list)
        self.assertTrue(len(body["findings"]) > 0)
        self.assertTrue(
            all(f["producer_type"] == "deterministic_rule" for f in body["findings"])
        )

    def test_internal_rules_handles_empty_pages_and_sections_without_crashing(self):
        response = self.client.post("/internal/rules", json={"pages": [], "sections": []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"findings": []})


if __name__ == "__main__":
    unittest.main()
