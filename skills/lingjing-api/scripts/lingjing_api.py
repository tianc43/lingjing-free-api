"""Public-media-only Lingjing API client."""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


PUBLIC_OPERATIONS = {
    "GET": (
        re.compile(r"^/models$"),
        re.compile(r"^/tasks/job_[A-Za-z0-9_]+$"),
    ),
    "POST": (
        re.compile(r"^/images/generations$"),
        re.compile(r"^/videos$"),
    ),
}
JOB_ID_PATTERN = re.compile(r"^job_[A-Za-z0-9_]+$")
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024


class ClientError(Exception):
    pass


class TaskTimeoutError(ClientError):
    pass


class RequestTimeoutError(ClientError):
    pass


class TaskFailedError(ClientError):
    pass


class ApiError(ClientError):
    def __init__(self, status, code, message):
        super().__init__(f"HTTP {status}: {code}: {message}")
        self.status = status
        self.code = code


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ClientError(f"Argument error: {message}")


class _RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    def _reject(self, request, response, code, message, headers):
        raise urllib.error.HTTPError(
            request.full_url,
            code,
            "Redirects are not allowed",
            headers,
            response,
        )

    http_error_301 = _reject
    http_error_302 = _reject
    http_error_303 = _reject
    http_error_307 = _reject
    http_error_308 = _reject


_NO_REDIRECT_OPENER = urllib.request.build_opener(
    _RejectRedirectHandler()
)


def _open_without_redirects(request, timeout):
    return _NO_REDIRECT_OPENER.open(request, timeout=timeout)


def _error_details(body):
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "invalid_response", "The API returned an invalid JSON error response"
    error = payload.get("error", payload) if isinstance(payload, dict) else {}
    if not isinstance(error, dict):
        return "api_error", "The API returned an error"
    return (
        str(error.get("code") or "api_error"),
        str(error.get("message") or "The API returned an error"),
    )


def _redact(value, secrets):
    for secret in secrets:
        if isinstance(secret, str) and secret:
            value = value.replace(secret, "[REDACTED]")
    return value


def decode_response(request, timeout, api_key, additional_secrets=()):
    secrets = (api_key, *additional_secrets)
    try:
        with _open_without_redirects(request, timeout) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            error.close()
            raise ApiError(
                error.code,
                "redirect_not_allowed",
                "Authenticated API redirects are not allowed",
            ) from None
        code, message = _error_details(error.read())
        code = _redact(code, secrets)
        message = _redact(message, secrets)
        raise ApiError(error.code, code, message) from None
    except TimeoutError:
        raise RequestTimeoutError("Request timed out") from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise RequestTimeoutError("Request timed out") from None
        raise ClientError("Request failed") from None
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError(status, "invalid_response", "The API returned invalid JSON") from None


def _validated_auth_header(value, field_name):
    if not isinstance(value, str):
        raise ClientError(
            f"{field_name} contains invalid HTTP header characters"
        )
    invalid_character = any(
        ord(character) < 0x20 or ord(character) == 0x7F
        for character in value
    )
    try:
        value.encode("latin-1")
    except UnicodeEncodeError:
        invalid_character = True
    if invalid_character:
        raise ClientError(
            f"{field_name} contains invalid HTTP header characters"
        )
    return value


def _submission_headers(idempotency_key=None):
    value = (
        idempotency_key
        or os.environ.get("LINGJING_IDEMPOTENCY_KEY")
        or f"lingjing-skill-{uuid.uuid4()}"
    )
    return {
        "Idempotency-Key": _validated_auth_header(
            value, "LINGJING_IDEMPOTENCY_KEY"
        )
    }


def _validated_output_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
    except (TypeError, ValueError):
        raise ClientError("Unsafe output URL") from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ClientError("Unsafe output URL")
    return parsed


def _normalized_base_url(base_url):
    invalid = ClientError("LINGJING_BASE_URL is invalid")
    if not isinstance(base_url, str) or any(
        ord(character) < 0x21 or ord(character) == 0x7F
        for character in base_url
    ):
        raise invalid
    try:
        parsed = urllib.parse.urlsplit(base_url)
        port = parsed.port
    except (TypeError, ValueError):
        raise invalid from None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"/v1", "/v1/"}
    ):
        raise invalid
    if port is not None and not 0 < port < 65536:
        raise invalid
    return urllib.parse.SplitResult(
        parsed.scheme,
        parsed.netloc,
        "/v1",
        "",
        "",
    )


def _task_response(payload, job_id):
    invalid = ClientError("The API returned an invalid task response")
    if (
        not isinstance(payload, dict)
        or payload.get("id") != job_id
        or not isinstance(payload.get("status"), str)
        or not payload["status"].strip()
    ):
        raise invalid
    if "outputs" in payload:
        outputs = payload["outputs"]
        if not isinstance(outputs, list):
            raise invalid
        for output in outputs:
            if (
                not isinstance(output, dict)
                or not isinstance(output.get("url"), str)
                or not output["url"].strip()
            ):
                raise invalid
    return payload


def _safe_extension(value):
    value = value.lower()
    return value if re.fullmatch(r"\.[a-z0-9]{1,10}", value) else ""


def _url_extension(url):
    parsed = _validated_output_url(url)
    return _safe_extension(Path(parsed.path).suffix)


def _file_identity(path):
    metadata = os.stat(path, follow_symlinks=False)
    return metadata.st_dev, metadata.st_ino


def _safe_file_identity(path):
    if path is None:
        return None
    try:
        return _file_identity(path)
    except BaseException:
        return None


def _unlink_quietly(path):
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except BaseException:
        pass


def _rollback_publication(temporary, destination, expected_identity=None):
    identity = expected_identity or _safe_file_identity(temporary)
    if (
        identity is not None
        and _safe_file_identity(destination) == identity
    ):
        _unlink_quietly(destination)
    _unlink_quietly(temporary)


def _download(url, destination_stem, timeout):
    extension = _url_extension(url)
    request = urllib.request.Request(
        url, headers={"Accept": "*/*"}, method="GET"
    )
    destination = None
    temporary = None
    descriptor = None
    try:
        with _open_without_redirects(request, timeout) as response:
            if not extension:
                guessed = (
                    mimetypes.guess_extension(
                        response.headers.get_content_type()
                    )
                    or ".bin"
                )
                extension = _safe_extension(guessed) or ".bin"
            destination = Path(f"{destination_stem}{extension}")
            try:
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".{destination.stem}-",
                    suffix=".tmp",
                    dir=destination.parent,
                )
                temporary = Path(temporary_name)
            except OSError:
                raise ClientError("Download failed") from None
            with os.fdopen(descriptor, "wb") as target:
                descriptor = None
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise ClientError("Output exceeds download size limit")
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            publication_identity = None
            try:
                try:
                    os.link(temporary, destination)
                except FileExistsError:
                    raise ClientError(
                        "Output file already exists"
                    ) from None
                except (AttributeError, NotImplementedError, OSError):
                    raise ClientError("Download failed") from None
                publication_identity = _file_identity(temporary)
                temporary.unlink()
                temporary = None
                return destination
            except BaseException:
                _rollback_publication(
                    temporary,
                    destination,
                    publication_identity,
                )
                temporary = None
                raise
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            error.close()
            raise ClientError("Download redirects are not allowed") from None
        raise ClientError("Download failed") from None
    except ClientError:
        raise
    except Exception:
        raise ClientError("Download failed") from None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except BaseException:
                pass
        if temporary is not None:
            _unlink_quietly(temporary)


def _parameters_object(value):
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        raise ClientError("--parameters-json must be a JSON object") from None
    if not isinstance(parsed, dict):
        raise ClientError("--parameters-json must be a JSON object")
    return parsed


class ApiClient:
    def __init__(self, base_url, api_key, timeout=30):
        self._base_url = _normalized_base_url(base_url)
        if not api_key:
            raise ClientError("LINGJING_API_KEY is required")
        self.base_url = urllib.parse.urlunsplit(self._base_url)
        self.api_key = _validated_auth_header(
            api_key, "LINGJING_API_KEY"
        )
        self.timeout = timeout

    def _request(
        self,
        method,
        path,
        payload=None,
        extra_headers=None,
        timeout=None,
        query=None,
    ):
        patterns = PUBLIC_OPERATIONS.get(method, ())
        if not any(pattern.fullmatch(path) for pattern in patterns):
            raise ClientError("Public operation is not allowed")
        if query and (method, path) != ("GET", "/models"):
            raise ClientError("Public operation is not allowed")
        query_string = urllib.parse.urlencode(query or {})
        final_path = f"/v1{path}"
        url = urllib.parse.urlunsplit(
            (
                self._base_url.scheme,
                self._base_url.netloc,
                final_path,
                query_string,
                "",
            )
        )
        try:
            final = urllib.parse.urlsplit(url)
        except ValueError:
            raise ClientError("Public operation is not allowed") from None
        if (
            final.scheme != self._base_url.scheme
            or final.netloc != self._base_url.netloc
            or final.path != final_path
            or final.fragment
        ):
            raise ClientError("Public operation is not allowed")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.api_key}"}
        if extra_headers:
            headers.update(extra_headers)
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            url, data=body, headers=headers, method=method
        )
        additional_secrets = [self.base_url]
        if extra_headers:
            additional_secrets.extend(extra_headers.values())
        return decode_response(
            request,
            self.timeout if timeout is None else timeout,
            self.api_key,
            additional_secrets,
        )

    def models(self, media_type=None, mode=None):
        query = {}
        if media_type:
            query["type"] = media_type
        if mode:
            query["mode"] = mode
        return self._request("GET", "/models", query=query)

    def task(self, job_id, timeout=None):
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise ClientError("Invalid task identifier")
        result = self._request("GET", f"/tasks/{job_id}", timeout=timeout)
        return _task_response(result, job_id)

    def generate_image(
        self,
        model,
        prompt,
        response_mode="wait",
        size=None,
        parameters=None,
        idempotency_key=None,
    ):
        payload = {
            "model": model,
            "prompt": prompt,
            "response_mode": response_mode,
            "response_format": "url",
        }
        if size:
            payload["size"] = size
        if parameters:
            payload["parameters"] = parameters
        return self._request(
            "POST",
            "/images/generations",
            payload,
            _submission_headers(idempotency_key),
        )

    def generate_video(
        self,
        model,
        prompt,
        mode="text-to-video",
        input_images=None,
        response_mode="wait",
        duration=None,
        resolution=None,
        ratio=None,
        parameters=None,
        idempotency_key=None,
    ):
        payload = {
            "model": model,
            "prompt": prompt,
            "mode": mode,
            "response_mode": response_mode,
        }
        for key, value in {
            "input_images": input_images,
            "duration": duration,
            "resolution": resolution,
            "ratio": ratio,
            "parameters": parameters,
        }.items():
            if value is not None:
                payload[key] = value
        return self._request(
            "POST", "/videos", payload, _submission_headers(idempotency_key)
        )

    def wait_for_task(self, job_id, interval=2, timeout=300):
        try:
            valid_bounds = (
                math.isfinite(interval)
                and math.isfinite(timeout)
                and interval >= 0
                and timeout >= 0
            )
        except TypeError:
            valid_bounds = False
        if not valid_bounds:
            raise ClientError(
                "Poll interval and timeout must be finite non-negative numbers"
            )
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TaskTimeoutError(
                    "Task state is unknown; do not resubmit"
                )
            try:
                request_timeout = min(self.timeout, remaining)
                deadline_limited = remaining <= self.timeout
                result = self.task(
                    job_id, timeout=request_timeout
                )
            except RequestTimeoutError:
                if deadline_limited:
                    raise TaskTimeoutError(
                        "Task state is unknown; do not resubmit"
                    ) from None
                raise
            except ClientError:
                if time.monotonic() >= deadline:
                    raise TaskTimeoutError(
                        "Task state is unknown; do not resubmit"
                    ) from None
                raise
            if result.get("status") == "failed":
                raise TaskFailedError("Task failed")
            if result.get("status") == "completed":
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TaskTimeoutError("Task state is unknown; do not resubmit")
            time.sleep(min(interval, remaining))

    def download_task(self, job_id, output_dir):
        result = self.task(job_id)
        if result.get("status") != "completed":
            raise ClientError("Task is not completed")
        outputs = result.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            raise ClientError("Task has no downloadable outputs")

        output_path = Path(output_dir)
        try:
            output_path.mkdir(parents=True, exist_ok=True)
        except OSError:
            raise ClientError("Download failed") from None

        files = []
        try:
            for index, output in enumerate(outputs, start=1):
                if not isinstance(output, dict) or not isinstance(
                    output.get("url"), str
                ):
                    raise ClientError("Task has no downloadable outputs")
                url = output["url"]
                stem = f"output-{index:02d}"
                destination = _download(
                    url,
                    output_path / stem,
                    self.timeout,
                )
                files.append(destination)
        except BaseException as error:
            for path in files:
                path.unlink(missing_ok=True)
            if isinstance(error, ClientError):
                raise
            if isinstance(error, Exception):
                raise ClientError("Download failed") from None
            raise
        return {"files": [str(path) for path in files]}


def main(argv=None):
    parser = JsonArgumentParser(description="Use public Lingjing media APIs")
    commands = parser.add_subparsers(dest="command", required=True)

    models = commands.add_parser("models")
    models.add_argument("--type", dest="media_type")
    models.add_argument("--mode")

    image = commands.add_parser("image")
    image.add_argument("--model", required=True)
    image.add_argument("--prompt", required=True)
    image.add_argument("--response-mode", choices=("wait", "async"), default="wait")
    image.add_argument("--size")
    image.add_argument("--parameters-json")

    video = commands.add_parser("video")
    video.add_argument("--model", required=True)
    video.add_argument("--prompt", required=True)
    video.add_argument(
        "--mode",
        choices=("text-to-video", "image-to-video"),
        default="text-to-video",
    )
    video.add_argument("--input-image", action="append", dest="input_images")
    video.add_argument("--response-mode", choices=("wait", "async"), default="wait")
    video.add_argument("--duration", type=float)
    video.add_argument("--resolution")
    video.add_argument("--ratio")
    video.add_argument("--parameters-json")

    task = commands.add_parser("task")
    task.add_argument("job_id")

    wait = commands.add_parser("wait")
    wait.add_argument("job_id")
    wait.add_argument("--interval", type=float, default=2)
    wait.add_argument("--timeout", type=float, default=300)

    download = commands.add_parser("download")
    download.add_argument("job_id")
    download.add_argument("--output-dir", required=True)

    try:
        args = parser.parse_args(argv)
        client = ApiClient(
            os.environ.get("LINGJING_BASE_URL", ""),
            os.environ.get("LINGJING_API_KEY", ""),
        )
        if args.command == "models":
            result = client.models(args.media_type, args.mode)
        elif args.command == "image":
            result = client.generate_image(
                model=args.model,
                prompt=args.prompt,
                response_mode=args.response_mode,
                size=args.size,
                parameters=_parameters_object(args.parameters_json),
            )
        elif args.command == "video":
            result = client.generate_video(
                model=args.model,
                prompt=args.prompt,
                mode=args.mode,
                input_images=args.input_images,
                response_mode=args.response_mode,
                duration=args.duration,
                resolution=args.resolution,
                ratio=args.ratio,
                parameters=_parameters_object(args.parameters_json),
            )
        elif args.command == "task":
            result = client.task(args.job_id)
        elif args.command == "wait":
            result = client.wait_for_task(
                args.job_id, interval=args.interval, timeout=args.timeout
            )
        else:
            result = client.download_task(args.job_id, args.output_dir)
    except ClientError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "type": "client_error",
                        "message": str(error),
                    },
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
