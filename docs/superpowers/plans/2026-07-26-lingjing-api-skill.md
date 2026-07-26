# Lingjing API Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, install, validate, and publish a `lingjing-api` Codex Skill for public image/video generation APIs without any administration capability.

**Architecture:** Keep a canonical Skill in `skills/lingjing-api` and install an identical copy under the user Skill root. Bundle one Python standard-library CLI with a fixed public-route allowlist, environment-only Bearer authentication, JSON I/O, no paid-request retries, task polling, and bounded unauthenticated media download.

**Tech Stack:** Codex Skill Markdown/YAML, Python 3 standard library, `unittest`, local fake HTTP server, existing Lingjing Free API Docker service, Git.

## Global Constraints

- Canonical source is `skills/lingjing-api`; installed copy is `C:\Users\tc\.codex\skills\lingjing-api`.
- Read `LINGJING_BASE_URL` and `LINGJING_API_KEY`; never accept or print the API key.
- Use only `/models`, `/images/generations`, `/videos`, and `/tasks/<id>`.
- Never call or describe `/admin/*`, Cookie import, accounts, balance, API-key management, or Docker lifecycle.
- Never retry paid image/video submissions automatically.
- Validate live behavior with read-only requests only; do not spend balance.
- Use Python standard-library modules only.

---

### Task 1: Scaffold the Skill and implement the read-only client

**Files:**
- Create: `skills/lingjing-api/SKILL.md`
- Create: `skills/lingjing-api/agents/openai.yaml`
- Create: `skills/lingjing-api/scripts/lingjing_api.py`
- Create: `skills/lingjing-api/scripts/test_lingjing_api.py`

**Interfaces:**
- Consumes: `LINGJING_BASE_URL`, `LINGJING_API_KEY`.
- Produces: `ApiClient(base_url: str, api_key: str)`, `ApiClient.models(media_type=None, mode=None)`, `ApiClient.task(job_id)`, and a `main(argv=None) -> int` CLI.

- [ ] **Step 1: Initialize the Skill scaffold**

Run:

```powershell
python -X utf8 C:\Users\tc\.codex\skills\.system\skill-creator\scripts\init_skill.py lingjing-api `
  --path skills `
  --resources scripts `
  --interface "display_name=Lingjing API" `
  --interface "short_description=Generate Lingjing images and videos through the public API" `
  --interface "default_prompt=Use $lingjing-api to discover a compatible model and create the requested image or video."
```

Expected: `skills/lingjing-api` contains `SKILL.md`, `agents/openai.yaml`, and `scripts/`.

- [ ] **Step 2: Write failing read-only and security tests**

Add a `ThreadingHTTPServer` fixture to `scripts/test_lingjing_api.py` and tests with these exact assertions:

```python
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

def test_error_does_not_expose_key(self):
    with self.assertRaises(ApiError) as caught:
        self.client.task("job_failed")
    self.assertNotIn("test-key", str(caught.exception))
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
python -X utf8 skills\lingjing-api\scripts\test_lingjing_api.py
```

Expected: FAIL because `ApiClient`, `ClientError`, and `ApiError` are not implemented.

- [ ] **Step 4: Implement configuration, allowlist, models, and task**

Implement the following boundaries in `lingjing_api.py`:

```python
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
        if not any(pattern.fullmatch(path) for pattern in PUBLIC_PATHS):
            raise ClientError("Public route is not allowed")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        if extra_headers:
            headers.update(extra_headers)
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=body, headers=headers, method=method
        )
        return decode_response(request, self.timeout)

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
```

Make `decode_response` parse public JSON errors into `ApiError` without headers, credentials, or raw response dumps.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
python -X utf8 skills\lingjing-api\scripts\test_lingjing_api.py
```

Expected: all Task 1 tests PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add skills/lingjing-api
git commit -m "feat: scaffold Lingjing API skill client"
```

---

### Task 2: Add generation, polling, and safe download

**Files:**
- Modify: `skills/lingjing-api/scripts/lingjing_api.py`
- Modify: `skills/lingjing-api/scripts/test_lingjing_api.py`

**Interfaces:**
- Consumes: `ApiClient` from Task 1.
- Produces: `generate_image`, `generate_video`, `wait_for_task`, `download_task`, and CLI commands `image`, `video`, `wait`, `download`.

- [ ] **Step 1: Write failing submission, polling, and download tests**

Add tests with these required behaviors:

```python
def test_image_submits_once_with_idempotency(self):
    result = self.client.generate_image(
        model="fixture-image", prompt="ink dragon", response_mode="async"
    )
    self.assertEqual(result["id"], "job_image")
    submissions = [r for r in self.server.requests if r["path"] == "/v1/images/generations"]
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
    self.assertEqual(body["input_images"], ["https://example.invalid/input.png"])

def test_wait_polls_without_resubmission(self):
    result = self.client.wait_for_task("job_wait", interval=0, timeout=2)
    self.assertEqual(result["status"], "completed")
    self.assertFalse(any(r["method"] == "POST" for r in self.server.requests))

def test_download_does_not_forward_authorization(self):
    result = self.client.download_task("job_download", self.output_dir)
    self.assertEqual(len(result["files"]), 1)
    media_request = next(r for r in self.server.requests if r["path"] == "/media/output.png")
    self.assertIsNone(media_request["authorization"])

def test_download_rejects_non_http_output(self):
    with self.assertRaisesRegex(ClientError, "Unsafe output URL"):
        self.client.download_task("job_file_url", self.output_dir)
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
python -X utf8 skills\lingjing-api\scripts\test_lingjing_api.py
```

Expected: FAIL because the generation, wait, and download methods do not exist.

- [ ] **Step 3: Implement paid submissions without retries**

Use one request per method:

```python
def _submission_headers(idempotency_key=None):
    return {
        "Idempotency-Key": idempotency_key
        or os.environ.get("LINGJING_IDEMPOTENCY_KEY")
        or f"lingjing-skill-{uuid.uuid4()}"
    }

def generate_image(self, model, prompt, response_mode="wait", size=None,
                   parameters=None, idempotency_key=None):
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
        "POST", "/images/generations", payload,
        _submission_headers(idempotency_key)
    )

def generate_video(self, model, prompt, mode="text-to-video",
                   input_images=None, response_mode="wait", duration=None,
                   resolution=None, ratio=None, parameters=None,
                   idempotency_key=None):
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
        "POST", "/videos", payload,
        _submission_headers(idempotency_key)
    )
```

Do not add a retry loop around either POST.

- [ ] **Step 4: Implement polling and bounded unauthenticated download**

Implement `wait_for_task` so only GET is repeated and local timeout raises
`TaskTimeoutError("Task state is unknown; do not resubmit")`.

Implement `download_task` with:

```python
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

def _download(url, destination, timeout):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ClientError("Unsafe output URL")
    request = urllib.request.Request(url, headers={"Accept": "*/*"}, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        total = 0
        with open(destination, "xb") as target:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise ClientError("Output exceeds download size limit")
                target.write(chunk)
```

Choose file extensions from the output URL or public `Content-Type`; use
`output-01`, `output-02`, and never use server-provided path components as a
local filename.

- [ ] **Step 5: Implement argparse and JSON process contract**

Create subparsers for `models`, `image`, `video`, `task`, `wait`, and
`download`. Parse `--parameters-json` as a JSON object and `--input-image` with
`action="append"`. Emit success JSON to stdout. Catch `ClientError`, emit:

```python
{"ok": false, "error": {"type": "client_error", "message": "..."}}
```

to stderr, and return `1`. Never include environment values in the error.

- [ ] **Step 6: Run all script tests and verify GREEN**

Run:

```powershell
python -X utf8 skills\lingjing-api\scripts\test_lingjing_api.py
```

Expected: all tests PASS, including exactly-one POST and download auth isolation.

- [ ] **Step 7: Commit Task 2**

```powershell
git add skills/lingjing-api/scripts
git commit -m "feat: add Lingjing media generation commands"
```

---

### Task 3: Author the Skill workflow, install, and validate

**Files:**
- Modify: `skills/lingjing-api/SKILL.md`
- Modify: `skills/lingjing-api/agents/openai.yaml`
- Copy after validation: `C:\Users\tc\.codex\skills\lingjing-api`

**Interfaces:**
- Consumes: the CLI commands from Tasks 1 and 2.
- Produces: a globally discoverable `$lingjing-api` Skill and published repository source.

- [ ] **Step 1: Write concise Skill instructions**

Use only `name` and `description` in frontmatter:

```yaml
---
name: lingjing-api
description: Invoke a Lingjing Free API public media endpoint for model discovery, text-to-image, text-to-video, image-to-video, task polling, and output download. Use when Codex is asked to create or retrieve Lingjing-generated images or videos through LINGJING_BASE_URL and LINGJING_API_KEY. Excludes all administrator, account, Cookie, balance, deployment, and API-key management operations.
---
```

In the body, require this workflow:

1. Verify the two environment variable names without echoing their values.
2. Run `models` and select a returned compatible model.
3. Treat generation as potentially billable; confirm only when the request has
   not already authorized generation.
4. Submit once with `image` or `video`.
5. Poll returned async task IDs with `wait`; never resubmit on timeout.
6. Use `download` when a local artifact is requested.
7. Refuse `/admin/*` or management requests and state that this Skill does not
   include them.

Include short Windows and POSIX invocation examples using the absolute Skill
directory resolved at runtime, not a copied API key.

- [ ] **Step 2: Regenerate and inspect UI metadata**

Read `skill-creator/references/openai_yaml.md`, then run:

```powershell
python -X utf8 C:\Users\tc\.codex\skills\.system\skill-creator\scripts\generate_openai_yaml.py `
  skills\lingjing-api `
  --interface "display_name=Lingjing API" `
  --interface "short_description=Generate images and videos through Lingjing public APIs" `
  --interface "default_prompt=Use $lingjing-api to discover a compatible model and create the requested image or video without using administrator APIs."
```

Expected: `agents/openai.yaml` matches the final SKILL.md and contains no
credential values.

- [ ] **Step 3: Validate the canonical Skill**

Run:

```powershell
python -X utf8 C:\Users\tc\.codex\skills\.system\skill-creator\scripts\quick_validate.py `
  skills\lingjing-api
python -X utf8 skills\lingjing-api\scripts\test_lingjing_api.py
python -X utf8 -m py_compile skills\lingjing-api\scripts\lingjing_api.py
```

Expected: `Skill is valid!`, all unit tests PASS, and compilation exits `0`.

- [ ] **Step 4: Run read-only live checks**

Load the existing container's API key into the process without printing it,
configure `LINGJING_BASE_URL` with the local `/v1` URL, then run:

```powershell
python -X utf8 skills\lingjing-api\scripts\lingjing_api.py models --type image
python -X utf8 skills\lingjing-api\scripts\lingjing_api.py task job_483d460300df499d9643cb5f3ea15b76
python -X utf8 skills\lingjing-api\scripts\lingjing_api.py task job_339c61ebd7924cb09681abb7c3049330
```

Expected: model data is non-empty; both existing jobs are `completed` with one
output. No POST request is made.

- [ ] **Step 5: Install the validated Skill globally**

Resolve and verify both absolute paths, remove only an existing
`C:\Users\tc\.codex\skills\lingjing-api` directory if it is the exact intended
target, then copy the canonical Skill. Compare recursive file hashes.

Expected: source and installed copies contain the same files and SHA-256 hashes.

- [ ] **Step 6: Forward-test with a fresh subagent**

Ask a fresh agent:

```text
Use $lingjing-api at C:\Users\tc\.codex\skills\lingjing-api to list image
models and inspect the existing task job_483d460300df499d9643cb5f3ea15b76.
Do not use administrator APIs and do not submit generation.
```

Expected: the agent reads the Skill, performs only the two public read-only
operations, does not request or reveal credentials, and reports the existing
task state.

- [ ] **Step 7: Commit implementation and verification**

```powershell
git add skills/lingjing-api
git commit -m "feat: add reusable Lingjing API skill"
git diff --check
```

Expected: commit succeeds and the worktree is clean.

- [ ] **Step 8: Publish the application subtree**

Create a subtree split for `lingjing-free-api`, verify `origin/main` is its
ancestor, push the split SHA to `refs/heads/main`, fetch, and compare SHAs.

Expected: the public repository `main` equals the new split SHA.
