import { Pool } from "pg";
import { PostgresSignInRepository } from "../../src/accounts/sign-in-repositories.js";
import {
  corePostgresMigrations,
  migratePostgres
} from "../../src/persistence/postgres-migrations.js";
import { seedPostgresDefaults } from "../../src/persistence/postgres-seed.js";

const pool = new Pool({
  connectionString: process.env["DATABASE_URL"]
    ?? "postgres://lingjing:fixture-postgres@127.0.0.1:15432/lingjing"
});

try {
  await migratePostgres(pool, corePostgresMigrations);
  await seedPostgresDefaults(pool);
  const repository = new PostgresSignInRepository(pool, () => 1_800_000_000_000);

  if (!await repository.claim("legacy", "ACT1", "2026-08-27")) {
    throw new Error("first sign-in attempt was not claimed");
  }
  if (await repository.claim("legacy", "ACT1", "2026-08-27")) {
    throw new Error("duplicate sign-in attempt was claimed");
  }
  await repository.beginRun(["legacy"], 1_799_999_900_000);
  await repository.recordCheck({
    accountId: "legacy",
    status: "already_signed",
    currentFrequency: 2,
    checkedAt: 1_799_999_901_000
  });
  await repository.finishRun(1_799_999_901_000);
  const status = await repository.status();
  if (
    status.running
    || status.lastRunFinishedAt !== 1_799_999_901_000
    || status.accounts[0]?.status !== "already_signed"
  ) {
    throw new Error("shared sign-in status did not round-trip");
  }
  console.log("postgres sign-in integration passed");
} finally {
  await pool.end();
}
