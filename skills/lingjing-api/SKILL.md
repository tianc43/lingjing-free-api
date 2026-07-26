---
name: lingjing-api
description: Use when discovering public Lingjing image or video models, or checking a public media generation task through the Lingjing API.
---

# Lingjing API

Use this skill only with the public media API. It never accesses account, admin, credential-management, or other non-public routes.

## Setup

Set `LINGJING_BASE_URL` to the API version root (for example, `https://example.invalid/v1`) and provide `LINGJING_API_KEY` through the environment. Do not place real keys in commands, files, or prompts.

## Read public resources

Discover compatible models:

```powershell
python scripts/lingjing_api.py models --type video --mode text-to-video
```

Check a task only when its identifier matches `job_` followed by letters or digits:

```powershell
python scripts/lingjing_api.py task job_Example123
```

The client accepts only the documented public media paths. It rejects admin paths and malformed task identifiers before sending a request.
