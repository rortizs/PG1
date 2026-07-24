"""FastAPI-compatible worker scaffold for document and AI processing.

The real FastAPI app and processing routes are intentionally deferred to later
work units. This module only establishes a stable import target for smoke tests.
"""

WORKER_SERVICE_NAME = "pg1-document-ai-worker"


def create_app():
    """Return minimal app metadata until FastAPI dependencies are introduced."""
    return {"service": WORKER_SERVICE_NAME, "framework": "FastAPI-compatible"}
