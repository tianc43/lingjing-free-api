"""Focused tests for the public Lingjing API client."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
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
        if self.path == "/v1/tasks/job_redirect":
            self.send_response(302)
            self.send_header("Location", "/redirect-target")
            self.end_headers()
            return
        if self.path == "/v1/tasks/job_slow":
            time.sleep(self.server.slow_delay)
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {"id": "job_slow", "status": "processing"}
                    ).encode()
                )
            except (
                BrokenPipeError,
                ConnectionAbortedError,
                ConnectionResetError,
            ):
                pass
            return
        malformed_tasks = {
            "/v1/tasks/job_schema_array": [],
            "/v1/tasks/job_schema_scalar": 7,
            "/v1/tasks/job_schema_missing_status": {
                "id": "job_schema_missing_status",
            },
            "/v1/tasks/job_schema_bad_outputs": {
                "id": "job_schema_bad_outputs",
                "status": "completed",
                "outputs": {},
            },
            "/v1/tasks/job_schema_bad_item": {
                "id": "job_schema_bad_item",
                "status": "completed",
                "outputs": [{}],
            },
        }
        if self.path in malformed_tasks:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(malformed_tasks[self.path]).encode())
            return
        if self.path == "/v1/tasks/job_terminal_failed":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "id": "job_terminal_failed",
                        "status": "failed",
                        "error": {"code": "server-controlled-secret"},
                    }
                ).encode()
            )
            return
        task_outputs = {
            "/v1/tasks/job_download": ["/media/output.png"],
            "/v1/tasks/job_file_url": ["file:///tmp/output.png"],
            "/v1/tasks/job_oversized": ["/media/oversized.bin"],
            "/v1/tasks/job_download_failed": ["/media/failure.png"],
            "/v1/tasks/job_redirect_download": ["/media/redirect-unsafe"],
            "/v1/tasks/job_malformed_outputs": [
                "/media/output.png",
                "http://[::1",
            ],
            "/v1/tasks/job_traversal": ["/media/../../server-name.png"],
            "/v1/tasks/job_no_extension": ["/media/no-extension"],
            "/v1/tasks/job_two_outputs": [
                "/media/output.png",
                "/media/output.png",
            ],
        }
        if self.path in task_outputs:
            output_urls = []
            for output_url in task_outputs[self.path]:
                if output_url.startswith("/"):
                    output_url = (
                        f"http://127.0.0.1:{self.server.server_port}{output_url}"
                    )
                output_urls.append(output_url)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "id": self.path.rsplit("/", 1)[-1],
                        "status": "completed",
                        "outputs": [{"url": url} for url in output_urls],
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
        if self.path == "/media/no-extension" or self.path.endswith(
            "/server-name.png"
        ):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(b"fixture-png")
            return
        if self.path == "/media/redirect-unsafe":
            self.send_response(302)
            self.send_header("Location", "file:///tmp/unsafe-output.png")
            self.end_headers()
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
        if self.path == "/redirect-target":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"redirected": True}).encode())
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
        if (
            self.path == "/v1/images/generations"
            and self.server.post_redirect
        ):
            self.send_response(302)
            self.send_header("Location", "/redirect-target")
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "error": {
                            "code": "redirect",
                            "message": self.headers.get("Idempotency-Key"),
                        }
                    }
                ).encode()
            )
            return
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
        cls.server.post_redirect = False
        cls.server.wait_reads = 0
        cls.server.slow_delay = 1.0
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
        self.server.post_redirect = False
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

    def test_base_url_rejects_ambiguous_or_non_v1_values_without_request(self):
        server_origin = f"http://127.0.0.1:{self.server.server_port}"
        invalid_values = (
            f"{server_origin}/admin/api/accounts?ignored=",
            f"{server_origin}/v1#fragment",
            f"http://user:password@127.0.0.1:{self.server.server_port}/v1",
            "http://[",
            f"{server_origin}/v1\r\n",
            f"{server_origin}/v1/../admin",
            f"{server_origin}/v1%2fadmin",
            f"{server_origin}/v1\\admin",
        )
        expected = {
            "ok": False,
            "error": {
                "type": "client_error",
                "message": "LINGJING_BASE_URL is invalid",
            },
        }
        for base_url in invalid_values:
            with self.subTest(kind=invalid_values.index(base_url)):
                stdout = StringIO()
                stderr = StringIO()
                with patch.dict(
                    os.environ,
                    {
                        "LINGJING_BASE_URL": base_url,
                        "LINGJING_API_KEY": "test-key",
                    },
                ), redirect_stdout(stdout), redirect_stderr(stderr):
                    exit_code = main(["models"])
                self.assertEqual(exit_code, 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(json.loads(stderr.getvalue()), expected)
                self.assertNotIn(base_url, stderr.getvalue())
                self.assertNotIn("traceback", stderr.getvalue().lower())
                self.assertEqual(self.server.requests, [])

    def test_base_url_single_trailing_slash_is_normalized(self):
        client = ApiClient(f"{self.client.base_url}/", "test-key")
        client.models()
        self.assertEqual(self.server.requests[-1]["path"], "/v1/models")

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

    def test_authenticated_get_rejects_redirect_without_followup(self):
        with self.assertRaises(ClientError) as caught:
            self.client.task("job_redirect")
        self.assertNotIn("redirect-target", str(caught.exception))
        self.assertEqual(
            [request["path"] for request in self.server.requests],
            ["/v1/tasks/job_redirect"],
        )

    def test_paid_post_rejects_redirect_without_followup_or_secret_leak(self):
        idempotency_key = "redirect-idempotency-secret"
        self.server.post_redirect = True
        with self.assertRaises(ClientError) as caught:
            self.client.generate_image(
                model="fixture-image",
                prompt="redirect",
                idempotency_key=idempotency_key,
            )
        self.assertNotIn(idempotency_key, str(caught.exception))
        self.assertEqual(
            [request["path"] for request in self.server.requests],
            ["/v1/images/generations"],
        )

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

    def test_wait_rejects_nan_and_infinite_timeouts_independently(self):
        for timeout in (float("nan"), float("inf")):
            with self.subTest(timeout=timeout):
                with self.assertRaisesRegex(
                    ClientError, "finite non-negative numbers"
                ):
                    self.client.wait_for_task(
                        "job_wait", interval=0, timeout=timeout
                    )
                self.assertEqual(self.server.requests, [])

    def test_wait_failed_task_raises_sanitized_task_error(self):
        with self.assertRaisesRegex(ClientError, "^Task failed$") as caught:
            self.client.wait_for_task(
                "job_terminal_failed", interval=0, timeout=2
            )
        self.assertEqual(type(caught.exception).__name__, "TaskFailedError")
        self.assertNotIn("server-controlled-secret", str(caught.exception))

    def test_wait_deadline_bounds_each_task_get(self):
        started = time.monotonic()
        with self.assertRaisesRegex(
            ClientError, "Task state is unknown; do not resubmit"
        ) as caught:
            self.client.wait_for_task("job_slow", interval=0, timeout=0.05)
        elapsed = time.monotonic() - started
        self.assertEqual(type(caught.exception).__name__, "TaskTimeoutError")
        self.assertLess(elapsed, 0.5)
        self.assertFalse(
            any(request["method"] == "POST" for request in self.server.requests)
        )

    def test_wait_deadline_socket_timeout_is_deterministically_task_timeout(self):
        with patch.object(
            lingjing_api.time,
            "monotonic",
            side_effect=(100.0, 100.0),
        ):
            with self.assertRaisesRegex(
                ClientError, "Task state is unknown; do not resubmit"
            ) as caught:
                self.client.wait_for_task(
                    "job_slow", interval=0, timeout=0.001
                )
        self.assertEqual(type(caught.exception).__name__, "TaskTimeoutError")
        self.assertFalse(
            any(request["method"] == "POST" for request in self.server.requests)
        )

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

    def test_download_rejects_unsafe_redirect_without_partial_file(self):
        with self.assertRaisesRegex(ClientError, "redirect"):
            self.client.download_task(
                "job_redirect_download", self.output_dir
            )
        self.assertEqual(list(self.output_dir.iterdir()), [])
        self.assertIsNone(
            next(
                request
                for request in self.server.requests
                if request["path"] == "/media/redirect-unsafe"
            )["authorization"]
        )

    def test_malformed_later_output_rolls_back_earlier_file(self):
        with self.assertRaisesRegex(ClientError, "Unsafe output URL"):
            self.client.download_task(
                "job_malformed_outputs", self.output_dir
            )
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_download_uses_fixed_basename_for_traversal_shaped_url(self):
        result = self.client.download_task("job_traversal", self.output_dir)
        downloaded = Path(result["files"][0])
        self.assertEqual(downloaded.name, "output-01.png")
        self.assertEqual(downloaded.parent, self.output_dir)

    def test_download_preserves_preexisting_destination(self):
        existing = self.output_dir / "output-01.png"
        existing.write_bytes(b"keep-me")
        with self.assertRaisesRegex(ClientError, "already exists"):
            self.client.download_task(
                "job_no_extension", self.output_dir
            )
        self.assertEqual(existing.read_bytes(), b"keep-me")

    def test_temp_cleanup_failure_never_removes_preexisting_destination(self):
        existing = self.output_dir / "output-01.png"
        existing.write_bytes(b"keep-me")
        real_unlink = Path.unlink

        def fail_temporary_unlink(path, missing_ok=False):
            if path.suffix == ".tmp":
                raise OSError("simulated temp cleanup failure")
            return real_unlink(path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", new=fail_temporary_unlink):
            with self.assertRaisesRegex(ClientError, "Download failed"):
                self.client.download_task(
                    "job_no_extension", self.output_dir
                )
        self.assertEqual(existing.read_bytes(), b"keep-me")

    def test_download_does_not_follow_existing_destination_symlink(self):
        external = self.output_dir / "external.bin"
        external.write_bytes(b"outside")
        destination = self.output_dir / "output-01.png"
        try:
            destination.symlink_to(external)
        except OSError as error:
            self.skipTest(f"Symlinks unavailable: {error}")
        with self.assertRaisesRegex(ClientError, "already exists"):
            self.client.download_task(
                "job_no_extension", self.output_dir
            )
        self.assertTrue(destination.is_symlink())
        self.assertEqual(external.read_bytes(), b"outside")

    def test_download_does_not_publish_final_path_until_complete(self):
        started = threading.Event()
        release = threading.Event()
        outcome = {}

        class BlockingResponse:
            def __init__(self):
                self.reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, size):
                self.reads += 1
                if self.reads == 1:
                    return b"first-"
                if self.reads == 2:
                    started.set()
                    release.wait(2)
                    return b"second"
                return b""

        def run_download():
            try:
                outcome["result"] = lingjing_api._download(
                    "http://example.invalid/output.png",
                    self.output_dir / "output-01",
                    1,
                )
            except BaseException as error:
                outcome["error"] = error

        with patch.object(
            lingjing_api,
            "_open_without_redirects",
            return_value=BlockingResponse(),
        ):
            thread = threading.Thread(target=run_download)
            thread.start()
            try:
                self.assertTrue(started.wait(1))
                self.assertFalse(
                    (self.output_dir / "output-01.png").exists()
                )
            finally:
                release.set()
                thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", outcome)
        destination = Path(outcome["result"])
        self.assertEqual(destination.read_bytes(), b"first-second")

    def test_download_interruption_rolls_back_files_published_by_this_call(self):
        real_download = lingjing_api._download
        calls = 0

        def interrupt_second_download(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise KeyboardInterrupt()
            return real_download(*args, **kwargs)

        with patch.object(
            lingjing_api,
            "_download",
            side_effect=interrupt_second_download,
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.client.download_task(
                    "job_two_outputs", self.output_dir
                )
        self.assertEqual(list(self.output_dir.iterdir()), [])

    def test_malformed_task_schema_is_sanitized_for_task_wait_and_download(self):
        task_ids = (
            "job_schema_array",
            "job_schema_scalar",
            "job_schema_missing_status",
            "job_schema_bad_outputs",
            "job_schema_bad_item",
        )
        expected = {
            "ok": False,
            "error": {
                "type": "client_error",
                "message": "The API returned an invalid task response",
            },
        }
        for command in ("task", "wait", "download"):
            for task_id in task_ids:
                with self.subTest(command=command, task_id=task_id):
                    argv = [command, task_id]
                    if command == "wait":
                        argv += ["--interval", "0", "--timeout", "1"]
                    elif command == "download":
                        argv += ["--output-dir", str(self.output_dir)]
                    stdout = StringIO()
                    stderr = StringIO()
                    with patch.dict(
                        os.environ,
                        {
                            "LINGJING_BASE_URL": self.client.base_url,
                            "LINGJING_API_KEY": "test-key",
                        },
                    ), redirect_stdout(stdout), redirect_stderr(stderr):
                        exit_code = main(argv)
                    self.assertEqual(exit_code, 1)
                    self.assertEqual(stdout.getvalue(), "")
                    self.assertEqual(json.loads(stderr.getvalue()), expected)
                    self.assertNotIn(task_id, stderr.getvalue())
                    self.assertNotIn("traceback", stderr.getvalue().lower())
                    self.server.requests.clear()

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

    def test_cli_rejects_invalid_api_key_header_as_single_json_error(self):
        invalid_key = "api-secret\r\nX-Leak: api-header-secret"
        stdout = StringIO()
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": invalid_key,
            },
        ), redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = main(["models"])
        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(self.server.requests, [])
        self.assertNotIn(invalid_key, stderr.getvalue())
        self.assertNotIn("api-header-secret", stderr.getvalue())
        self.assertNotIn("traceback", stderr.getvalue().lower())
        lines = stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(
            json.loads(lines[0])["error"]["type"], "client_error"
        )

    def test_cli_rejects_invalid_idempotency_header_as_single_json_error(self):
        invalid_key = (
            "idempotency-secret\r\nX-Leak: idempotency-header-secret"
        )
        stdout = StringIO()
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
                "LINGJING_IDEMPOTENCY_KEY": invalid_key,
            },
        ), redirect_stdout(stdout), redirect_stderr(stderr):
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
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(self.server.requests, [])
        self.assertNotIn(invalid_key, stderr.getvalue())
        self.assertNotIn("idempotency-header-secret", stderr.getvalue())
        self.assertNotIn("traceback", stderr.getvalue().lower())
        lines = stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(
            json.loads(lines[0])["error"]["type"], "client_error"
        )

    def test_cli_failed_task_emits_json_error(self):
        stdout = StringIO()
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "LINGJING_BASE_URL": self.client.base_url,
                "LINGJING_API_KEY": "test-key",
            },
        ), redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = main(
                [
                    "wait",
                    "job_terminal_failed",
                    "--interval",
                    "0",
                    "--timeout",
                    "2",
                ]
            )
        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(
            json.loads(stderr.getvalue()),
            {
                "ok": False,
                "error": {
                    "type": "client_error",
                    "message": "Task failed",
                },
            },
        )

    def test_cli_argument_errors_use_json_contract_without_usage_noise(self):
        cases = (
            ["unknown-command"],
            ["image", "--model", "fixture-image"],
            ["wait", "job_wait", "--timeout", "not-a-number"],
        )
        for argv in cases:
            with self.subTest(argv=argv):
                stdout = StringIO()
                stderr = StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    exit_code = main(argv)
                self.assertEqual(exit_code, 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertNotIn("usage:", stderr.getvalue().lower())
                error = json.loads(stderr.getvalue())
                self.assertEqual(error["ok"], False)
                self.assertEqual(
                    error["error"]["type"], "client_error"
                )

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
