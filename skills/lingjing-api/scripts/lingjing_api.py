"""Public-media-only Lingjing API client."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


PUBLIC_PATHS = (
    re.compile(r"^/models(?:\?.*)?$"),
    re.compile(r"^/images/generations$"),
    re.compile(r"^/videos$"),
    re.compile(r"^/tasks/job_[A-Za-z0-9]+$"),
)
JOB_ID_PATTERN = re.compile(r"^job_[A-Za-z0-9]+$")


class ClientError(Exception):
    pass


class ApiError(ClientError):
    def __init__(self, status, code, message):
        super().__init__(f"HTTP {status}: {code}: {message}")
        self.status = status
        self.code = code


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


def decode_response(request, timeout, api_key):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        code, message = _error_details(error.read())
        code = code.replace(api_key, "[REDACTED]")
        message = message.replace(api_key, "[REDACTED]")
        raise ApiError(error.code, code, message) from None
    except urllib.error.URLError as error:
        raise ClientError(f"Request failed: {error.reason}") from None
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError(status, "invalid_response", "The API returned invalid JSON") from None


class ApiClient:
    def __init__(self, base_url, api_key, timeout=30):
        parsed = urllib.parse.urlsplit(base_url.rstrip("/"))
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ClientError("LINGJING_BASE_URL must be an HTTP(S) URL")
        if not api_key:
            raise ClientError("LINGJING_API_KEY is required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _request(self, method, path, payload=None, extra_headers=None):
        if method != "GET":
            raise ClientError("Read-only method is not allowed")
        if not any(pattern.fullmatch(path) for pattern in PUBLIC_PATHS):
            raise ClientError("Public route is not allowed")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.api_key}"}
        if extra_headers:
            headers.update(extra_headers)
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=body, headers=headers, method=method
        )
        return decode_response(request, self.timeout, self.api_key)

    def models(self, media_type=None, mode=None):
        query = {}
        if media_type:
            query["type"] = media_type
        if mode:
            query["mode"] = mode
        suffix = "?" + urllib.parse.urlencode(query) if query else ""
        return self._request("GET", "/models" + suffix)

    def task(self, job_id):
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise ClientError("Invalid task identifier")
        return self._request("GET", f"/tasks/{job_id}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read public Lingjing API resources")
    commands = parser.add_subparsers(dest="command", required=True)
    models = commands.add_parser("models")
    models.add_argument("--type", dest="media_type")
    models.add_argument("--mode")
    task = commands.add_parser("task")
    task.add_argument("job_id")
    args = parser.parse_args(argv)
    try:
        client = ApiClient(os.environ.get("LINGJING_BASE_URL", ""), os.environ.get("LINGJING_API_KEY", ""))
        result = client.models(args.media_type, args.mode) if args.command == "models" else client.task(args.job_id)
    except ClientError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
