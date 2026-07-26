"""Focused tests for the public Lingjing API client."""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from lingjing_api import ApiClient, ApiError, ClientError, main


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
            }
        )
        if self.path == "/v1/tasks/job_failed":
            self.send_response(422)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"error": {"code": "job_failed", "message": self.server.error_message}}
                ).encode()
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": [{"id": "fixture-video"}]}).encode())

    def do_POST(self):
        self.server.requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
            }
        )
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        pass


class ApiClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.server.requests = []
        cls.server.error_message = "Job failed"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def setUp(self):
        self.server.requests.clear()
        self.server.error_message = "Job failed"
        self.client = ApiClient(f"http://127.0.0.1:{self.server.server_port}/v1", "test-key")

    def test_models_uses_bearer_and_expected_query(self):
        result = self.client.models("video", "text-to-video")
        self.assertEqual(result["data"][0]["id"], "fixture-video")
        request = self.server.requests[-1]
        self.assertEqual(request["path"], "/v1/models?type=video&mode=text-to-video")
        self.assertEqual(request["authorization"], "Bearer test-key")

    def test_task_rejects_non_job_identifier(self):
        with self.assertRaisesRegex(ClientError, "Invalid task identifier"):
            self.client.task("../admin/api/accounts")

    def test_public_client_rejects_admin_path(self):
        with self.assertRaisesRegex(ClientError, "Public route is not allowed"):
            self.client._request("GET", "/admin/api/accounts")

    def test_public_client_rejects_post_without_sending_request(self):
        with self.assertRaisesRegex(ClientError, "Read-only method is not allowed"):
            self.client._request("POST", "/videos", payload={"prompt": "fixture"})
        self.assertEqual(self.server.requests, [])

    def test_error_does_not_expose_key(self):
        with self.assertRaises(ApiError) as caught:
            self.client.task("job_failed")
        self.assertNotIn("test-key", str(caught.exception))

    def test_error_and_cli_output_redact_key_echoed_by_server(self):
        self.server.error_message = "test-key"
        with self.assertRaises(ApiError) as caught:
            self.client.task("job_failed")
        self.assertNotIn("test-key", str(caught.exception))

        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stderr(stderr):
            self.assertEqual(main(["task", "job_failed"]), 1)
        self.assertNotIn("test-key", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
