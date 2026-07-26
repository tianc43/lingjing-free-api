# Lingjing API Skill Design

## Goal

Create a reusable `lingjing-api` Codex Skill that invokes the public media API
of a running Lingjing Free API instance. Support model discovery, text-to-image,
text-to-video, image-to-video, task polling, and output download. Exclude every
administration capability.

## Distribution

- Keep the canonical source in `skills/lingjing-api`.
- Install the same files at `C:\Users\tc\.codex\skills\lingjing-api` for local
  Codex discovery.
- Commit and publish the canonical source with this repository.

## Interface

Bundle a Python standard-library CLI at
`skills/lingjing-api/scripts/lingjing_api.py`.

Commands:

- `models`: list models, optionally filtered by `image`, `video`, and video
  mode.
- `image`: submit text-to-image with an explicit model, prompt, optional size
  and model parameters, and `wait` or `async` response mode.
- `video`: submit text-to-video or image-to-video with an explicit model,
  prompt, optional public/data-URI input images, duration, resolution, ratio,
  model parameters, and response mode.
- `task`: read one task.
- `wait`: poll one task until completion, failure, or a local timeout.
- `download`: read a completed task and download its returned media files.

All successful commands emit JSON to stdout. Failures emit a sanitized JSON
error to stderr and return a non-zero exit code.

## Configuration and Security Boundary

- Read the API origin from `LINGJING_BASE_URL`, defaulting to
  `http://127.0.0.1:8000/v1`.
- Read the Bearer credential only from `LINGJING_API_KEY`.
- Never accept the API key as a command-line argument or print it.
- Use only the fixed public routes `/models`, `/images/generations`, `/videos`,
  and `/tasks/<id>`.
- Do not expose arbitrary HTTP paths. Never call `/admin/*`.
- Generate a unique `Idempotency-Key` for each paid submission unless the
  caller supplies a stable key through the environment.
- Do not automatically retry a paid generation submission.
- Send no Lingjing API authorization header when downloading output URLs.
- Accept output downloads only over HTTP or HTTPS and enforce a bounded file
  size.

## Skill Workflow

The Skill must direct Codex to:

1. Confirm `LINGJING_BASE_URL` and `LINGJING_API_KEY` exist without echoing the
   key.
2. Run `models` for the requested media type and choose a compatible model from
   the live result rather than guessing an identifier.
3. Explain that image/video submission can consume Lingjing balance and obtain
   user confirmation when the current request has not already authorized
   generation.
4. Submit exactly once.
5. If the API returns an asynchronous task, use `wait` instead of resubmitting.
6. Download and report local output files when the user requests artifacts.

## Error Handling

- Preserve the HTTP status and public API error code when available.
- Classify configuration, transport, malformed response, local timeout, failed
  task, and unsafe download errors without leaking credentials or response
  headers.
- Treat an asynchronous task timeout as unknown completion state; do not submit
  a replacement request.

## Validation

- Run `quick_validate.py` against the Skill.
- Run Python unit tests against a local fake HTTP server. Cover model listing,
  image submission, video submission, task polling, idempotency, error
  sanitization, download authorization isolation, and rejection of admin or
  unsafe paths.
- Run read-only live checks against the existing Docker service: list models
  and read already completed image/video tasks.
- Do not create a new paid image or video during validation.
- Forward-test the installed Skill with a fresh agent using the fake server or
  read-only live commands.

## Out of Scope

- Administrator login and sessions
- Cookie import or browser authentication
- Account, membership, balance, quota, and scheduler management
- API-key creation, disabling, revocation, or rotation
- Docker lifecycle and deployment
- Chat-completions workflows
