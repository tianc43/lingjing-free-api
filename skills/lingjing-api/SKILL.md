---
name: lingjing-api
description: Invoke a Lingjing Free API public media endpoint for model discovery, text-to-image, text-to-video, image-to-video, task polling, and output download. Use when Codex is asked to create or retrieve Lingjing-generated images or videos through LINGJING_BASE_URL and LINGJING_API_KEY. Excludes all administrator, account, Cookie, balance, deployment, and API-key management operations.
---

# Lingjing API

Use `scripts/lingjing_api.py` only with the public media API.

## Workflow

1. Check that `LINGJING_BASE_URL` and `LINGJING_API_KEY` exist in the environment without printing their values.
2. Run `models` for the requested media type and select a compatible model from the returned data. Never guess a model ID.
3. Treat `image` and `video` generation as potentially billable. Ask for confirmation only when the current user request has not already authorized generation.
4. Run exactly one `image` or `video` command. Never retry or resubmit a generation command.
5. For an asynchronous job, run `wait` with its returned task ID. A timeout means the task state is unknown; never resubmit it.
6. Run `download` when the user requests a local artifact.

## Invocation

Windows PowerShell:

```powershell
$skillDir = (Resolve-Path -LiteralPath 'C:\Users\tc\.codex\skills\lingjing-api').Path
if (-not (Test-Path Env:LINGJING_BASE_URL) -or -not (Test-Path Env:LINGJING_API_KEY)) { throw 'Set LINGJING_BASE_URL and LINGJING_API_KEY' }
python -X utf8 (Join-Path $skillDir 'scripts\lingjing_api.py') models --type image
```

POSIX:

```sh
skill_dir="$(cd "${CODEX_HOME:-$HOME/.codex}/skills/lingjing-api" && pwd -P)"
test "${LINGJING_BASE_URL+x}" && test "${LINGJING_API_KEY+x}" || { echo 'Set LINGJING_BASE_URL and LINGJING_API_KEY' >&2; exit 1; }
python3 "$skill_dir/scripts/lingjing_api.py" models --type image
```

Use the same absolute script path with `image`, `video`, `task`, `wait`, or `download`; run `--help` for arguments.

## Boundary

Refuse every `/admin/*`, administrator, account, Cookie, balance, deployment, or API-key management request. State that this Skill does not include management operations.
