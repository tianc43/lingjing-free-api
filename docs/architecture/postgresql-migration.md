# PostgreSQL migration boundary

Current runtime uses one `SqliteStore` transaction boundary across jobs, budgets, ledger, submissions, correlations, leases, assets and webhook outbox. PostgreSQL migration must preserve those atomic groups; replacing individual repositories piecemeal would break correctness.

## Required atomic groups

1. Admission: project/account policy check + job + status history + budget reserve + ledger hold.
2. Submit outcome: budget charge/release + ledger transition.
3. Terminal: job result/status + status history + webhook outbox.
4. Correlation: unique provider/account/task binding + submission outcome.
5. Worker ownership: lease acquire/heartbeat/fenced updates.
6. Upload complete: pending upload + job asset metadata.

## Target adapter

Introduce a dialect-neutral transaction interface and PostgreSQL implementations for the complete groups above. Use `SELECT ... FOR UPDATE SKIP LOCKED` for worker claims, partial unique indexes for provider identities, and transaction-scoped advisory locks only where row locks cannot express the invariant. PostgreSQL remains the truth; Redis may notify workers but cannot own job or billing state.

## Migration phases

1. Extract repository interfaces and SQL-independent domain rows.
2. Add PostgreSQL migrations equivalent to SQLite schema v16.
3. Dual read-only verification against an exported SQLite fixture.
4. Offline migration command: stop API, copy rows and object metadata, validate counts/checksums, then switch `DATABASE_DRIVER=postgres`.
5. Never dual-write billing or submit state in production.

Until this adapter is complete, `DATABASE_DRIVER=postgres` fails fast rather than silently using SQLite.
