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

1. Establish a new Lingjing session with `npm run login` or Admin Cookie import.
2. Run `npm run inspect:video-catalog` and verify at least one T2V/I2V model and sufficient points.
3. Run one controlled quote; submit only after the displayed point cost is accepted.
4. Start in SQLite + local object mode for the simplest 3–5 user deployment.
5. Back up `data/` before the first real generation.

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

## Acceptance commands

```bash
npm run check
npm run build
npm run test:browser
npm audit --audit-level=moderate
# Current baseline: Vitest 715/715, Browser 15/15, npm audit 0.
```
