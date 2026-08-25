# Internal release readiness

## Ready now

- SQLite single-instance API and Admin UI.
- PostgreSQL schema v3, adapters, workers, Admin API, Cookie import and Browser suite.
- T2V/I2V async jobs, persistent inputs, submitOnce, discovery, polling and reconciliation.
- Local/S3/MinIO objects, controlled asset URLs, Range, retention and audit.
- Webhook outbox, HMAC, retry/dead/replay and safe transport.
- SQLite to PostgreSQL offline migration and v2 to v3 upgrade.
- Optional Redis wakeup/rate limiting; PostgreSQL remains authoritative.

## Required before immediate real use

1. Run `npm run live:preflight`, then establish a new Lingjing session with `npm run login` or Admin Cookie import.
2. Run `npm run inspect:video-catalog` and verify at least one T2V/I2V model and sufficient points.
3. Run one controlled quote; submit only after the displayed point cost is accepted.
4. Start in SQLite + local object mode for the simplest 3–5 user deployment.
5. Back up `data/` before the first real generation.

## Current acceptance state

The automated release candidate is complete. Live acceptance is intentionally waiting for one user-supplied current Lingjing session. Do not repeatedly run Catalog or paid tests while `npm run live:preflight` reports `ready_accounts: 0`. The next useful action is exclusively Admin Cookie import or CLI login; after it reports at least one ready account, run Catalog inspection and quote-only preflight before any submission.

## Remaining release gaps

- PostgreSQL Admin Cookie Import is implemented; a current valid Lingjing Cookie is still required for real generation.
- Live T2V/I2V has not been repeated in this workspace because no current session artifact exists.
- Account Check can refresh a loaded runtime, but requires valid session files.
- Real current Seedance internal IDs and parameter IDX values must come from live Catalog, never fixtures.

## Backup and restore

Stop the service before a local backup, then run:

```bash
npm run backup:local -- ./data ./backups/pre-release
```

The backup contains SQLite, sessions and local objects plus a SHA-256 manifest. To restore, stop the service, move the current `data/` aside, copy the backup contents (except `manifest.json`) into `data/`, and start the service. Never merge two live data directories.

## Local smoke

With the service running, use:

```bash
npm run smoke:local
```

`status=ready` means the service, Admin and video Catalog are available. `status=needs_login` means the local service is healthy but no current Lingjing session can load video models; import a Cookie or run login before generation.

## Acceptance commands

```bash
npm run check
npm run build
npm run test:browser
npm audit --audit-level=moderate
# Current baseline: Vitest 718/718, Browser 15/15, npm audit 0.
```
