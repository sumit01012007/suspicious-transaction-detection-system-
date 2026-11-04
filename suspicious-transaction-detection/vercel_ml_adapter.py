"""Expose the existing FastAPI ML app beneath Vercel's /api/ml function path."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "ml-service"))

from main import app as ml_app  # noqa: E402


class StripVercelPrefix:
    """Remove /api/ml before forwarding the request to the existing FastAPI app."""

    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope)
            path = scope.get("path", "")
            prefix = "/api/ml"
            if path == prefix:
                scope["path"] = "/"
            elif path.startswith(prefix + "/"):
                scope["path"] = path[len(prefix):]
            raw_path = scope.get("raw_path")
            if raw_path and raw_path.startswith(prefix.encode()):
                scope["raw_path"] = raw_path[len(prefix):] or b"/"
        await self.application(scope, receive, send)


app = StripVercelPrefix(ml_app)
