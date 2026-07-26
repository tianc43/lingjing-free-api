"""Focused tests for the public Lingjing API client."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import lingjing_api
from lingjing_api import ApiClient, ApiError, ClientError, main


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(
            {
                "method": "GET",
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "idempotency": self.headers.get("Idempotency-Key"),
                "json": None,
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
        if self.path == "/v1/tasks/job_wait":
            self.server.wait_reads += 1
            status = "processing" if self.server.wait_reads == 1 else "completed"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": "job_wait", "status": status}).encode())
            return
        if self.path == "/v1/tasks/job_timeout":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"id": "job_timeout", "status": "processing"}).encode()
            )
            return
        task_outputs = {
            "/v1/tasks/job_download": "/media/output.png",
            "/v1/tasks/job_file_url": "file:///tmp/output.png",
            "/v1/tasks/job_oversized": "/media/oversized.bin",
            "/v1/tasks/job_download_failed": "/media/failure.png",
        }
        if self.path in task_outputs:
            output_url = task_outputs[self.path]
            if output_url.startswith("/"):
                output_url = (
                    f"http://127.0.0.1:{self.server.server_port}{output_url}"
                )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "id": self.path.rsplit("/", 1)[-1],
                        "status": "completed",
                        "outputs": [{"url": output_url}],
                    }
                ).encode()
            )
            return
        if self.path == "/media/output.png":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(b"fixture-png")
            return
        if self.path == "/media/oversized.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(b"x" * 32)
            return
        if self.path == "/media/failure.png":
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": [{"id": "fixture-video"}]}).encode())

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        self.server.requests.append(
            {
                "method": "POST",
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "idempotency": self.headers.get("Idempotency-Key"),
                "json": json.loads(body.decode()),
            }
        )
        if self.server.post_error_message is not None:
            self.send_response(409)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "error": {
                            "code": "idempotency_conflict",
                            "message": self.server.post_error_message,
                        }
                    }
                ).encode()
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        job_id = "job_image" if self.path == "/v1/images/generations" else "job_video"
        self.wfile.write(json.dumps({"id": job_id}).encode())

    def log_message(self, format, *args):
        pass


class ApiClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.server.requests = []
        cls.server.error_message = "Job failed"
        cls.server.post_error_message = None
        cls.server.wait_reads = 0
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
        self.server.post_error_message = None
        self.server.wait_reads = 0
        self.client = ApiClient(f"http://127.0.0.1:{self.server.server_port}/v1", "test-key")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

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
        with self.assertRaisesRegex(ClientError, "Public operation is not allowed"):
            self.client._request("GET", "/admin/api/accounts")

    def test_public_client_rejects_wrong_method_without_sending_request(self):
        with self.assertRaisesRegex(ClientError, "operation is not allowed"):
            self.client._request("GET", "/videos")
        with self.assertRaisesRegex(ClientError, "operation is not allowed"):
            self.client._request("POST", "/tasks/job_example", payload={})
        self.assertEqual(self.server.requests, [])

    def test_image_submits_once_with_idempotency(self):
        result = self.client.generate_image(
            model="fixture-image", prompt="ink dragon", response_mode="async"
        )
        self.assertEqual(result["id"], "job_image")
        submissions = [
            request
            for request in self.server.requests
            if request["path"] == "/v1/images/generations"
        ]
        self.assertEqual(len(submissions), 1)
        self.assertRegex(submissions[0]["idempotency"], r"^lingjing-skill-")

    def test_video_supports_image_to_video(self):
        self.client.generate_video(
            model="fixture-video",
            prompt="animate",
            mode="image-to-video",
            input_images=["https://example.invalid/input.png"],
        )
        body = self.server.requests[-1]["json"]
        self.assertEqual(body["mode"], "image-to-video")
        self.assertEqual(
            body["input_images"], ["https://example.invalid/input.png"]
        )

    def test_wait_polls_without_resubmission(self):
        result = self.client.wait_for_task("job_wait", interval=0, timeout=2)
        self.assertEqual(result["status"], "completed")
        self.assertFalse(
            any(request["method"] == "POST" for request in self.server.requests)
        )

    def test_wait_timeout_marks_task_state_unknown(self):
        with self.assertRaisesRegex(
            ClientError, "Task state is unknown; do not resubmit"
        ) as caught:
            self.client.wait_for_task("job_timeout", interval=0, timeout=0)
        self.assertEqual(type(caught.exception).__name__, "TaskTimeoutError")

    def test_wait_rejects_unbounded_numeric_inputs_before_request(self):
        invalid_values = (
            {"interval": -1, "timeout": 2},
            {"interval": -1, "timeout": float("nan")},
            {"interval": -1, "timeout": float("inf")},
        )
        for values in invalid_values:
            with self.subTest(values=values):
                with self.assertRaisesRegex(
                    ClientError, "finite non-negative numbers"
                ):
                    self.client.wait_for_task("job_wait", **values)
                self.assertEqual(self.server.requests, [])

    def test_download_does_not_forward_authorization(self):
        result = self.client.download_task("job_download", self.output_dir)
        self.assertEqual(len(result["files"]), 1)
        self.assertEqual(Path(result["files"][0]).name, "output-01.png")
        media_request = next(
            request
            for request in self.server.requests
            if request["path"] == "/media/output.png"
        )
        self.assertIsNone(media_request["authorization"])

    def test_download_rejects_non_http_output(self):
        with self.assertRaisesRegex(ClientError, "Unsafe output URL"):
            self.client.download_task("job_file_url", self.output_dir)
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_oversized_download_leaves_no_partial_file(self):
        with patch.object(lingjing_api, "MAX_DOWNLOAD_BYTES", 16):
            with self.assertRaisesRegex(
                ClientError, "Output exceeds download size limit"
            ):
                self.client.download_task("job_oversized", self.output_dir)
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_failed_download_leaves_no_partial_file(self):
        with self.assertRaisesRegex(ClientError, "Download failed"):
            self.client.download_task("job_download_failed", self.output_dir)
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_cli_image_parses_parameters_and_emits_json(self):
        stdout = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stdout(stdout):
            exit_code = main(
                [
                    "image",
                    "--model",
                    "fixture-image",
                    "--prompt",
                    "ink dragon",
                    "--response-mode",
                    "async",
                    "--parameters-json",
                    '{"style": "ink"}',
                ]
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["id"], "job_image")
        self.assertEqual(self.server.requests[-1]["json"]["parameters"], {"style": "ink"})

    def test_cli_video_appends_input_images(self):
        stdout = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stdout(stdout):
            exit_code = main(
                [
                    "video",
                    "--model",
                    "fixture-video",
                    "--prompt",
                    "animate",
                    "--mode",
                    "image-to-video",
                    "--input-image",
                    "https://example.invalid/first.png",
                    "--input-image",
                    "https://example.invalid/second.png",
                ]
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["id"], "job_video")
        self.assertEqual(
            self.server.requests[-1]["json"]["input_images"],
            [
                "https://example.invalid/first.png",
                "https://example.invalid/second.png",
            ],
        )

    def test_cli_wait_emits_completed_task_json(self):
        stdout = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stdout(stdout):
            exit_code = main(
                ["wait", "job_wait", "--interval", "0", "--timeout", "2"]
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["status"], "completed")

    def test_cli_download_emits_local_file_json(self):
        stdout = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stdout(stdout):
            exit_code = main(
                [
                    "download",
                    "job_download",
                    "--output-dir",
                    str(self.output_dir),
                ]
            )
        self.assertEqual(exit_code, 0)
        result = json.loads(stdout.getvalue())
        self.assertTrue(Path(result["files"][0]).is_file())

    def test_cli_rejects_non_object_parameters_as_json_error(self):
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stderr(stderr):
            exit_code = main(
                [
                    "image",
                    "--model",
                    "fixture-image",
                    "--prompt",
                    "ink dragon",
                    "--parameters-json",
                    "[]",
                ]
            )
        self.assertEqual(exit_code, 1)
        self.assertEqual(
            json.loads(stderr.getvalue()),
            {
                "ok": False,
                "error": {
                    "type": "client_error",
                    "message": "--parameters-json must be a JSON object",
                },
            },
        )

    def test_cli_redacts_environment_idempotency_key_echoed_by_server(self):
        idempotency_key = "environment-idempotency-secret"
        self.server.post_error_message = idempotency_key
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
                "LINGJING_IDEMPOTENCY_KEY": idempotency_key,
            },
        ), redirect_stderr(stderr):
            exit_code = main(
                [
                    "image",
                    "--model",
                    "fixture-image",
                    "--prompt",
                    "ink dragon",
                ]
            )
        self.assertEqual(exit_code, 1)
        self.assertNotIn(idempotency_key, stderr.getvalue())
        submissions = [
            request
            for request in self.server.requests
            if request["path"] == "/v1/images/generations"
        ]
        self.assertEqual(len(submissions), 1)

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
