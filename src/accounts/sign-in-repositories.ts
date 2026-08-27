import type { Pool } from "pg";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import {
  nextHourlySignInAt,
  type AccountSignInCheck,
  type DailySignInStatus
} from "./daily-sign-in-scheduler.js";

export interface SignInAttemptGate {
  claim(accountId: string, activityNo: string, shanghaiDate: string):
    Promise<boolean>;
}

export interface SignInStateStore {
  beginRun(accountIds: readonly string[], startedAt: number): Promise<void>;
  recordCheck(check: AccountSignInCheck): Promise<void>;
  finishRun(finishedAt: number): Promise<void>;
}

export interface SignInStatusReader {
  status(): DailySignInStatus | Promise<DailySignInStatus>;
}

export class SqliteSignInAttemptRepository implements SignInAttemptGate {
  constructor(
    private readonly store: SqliteStore,
    private readonly now: () => number = Date.now
  ) {}

  claim(accountId: string, activityNo: string, shanghaiDate: string):
  Promise<boolean> {
    const claimed = this.store.immediate((database) => database.prepare(`
      INSERT OR IGNORE INTO sign_in_attempts(
        account_id, activity_no, shanghai_date, claimed_at
      ) VALUES (?, ?, ?, ?)
    `).run(accountId, activityNo, shanghaiDate, this.now()).changes === 1);
    return Promise.resolve(claimed);
  }
}

interface PostgresRunRow {
  running: boolean;
  last_started_at: string | number | null;
  last_finished_at: string | number | null;
}

interface PostgresCheckRow {
  account_id: string;
  status: AccountSignInCheck["status"];
  current_frequency: number | null;
  checked_at: string | number;
}

export class PostgresSignInRepository implements
SignInAttemptGate, SignInStateStore, SignInStatusReader {
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly now: () => number = Date.now
  ) {}

  async claim(
    accountId: string,
    activityNo: string,
    shanghaiDate: string
  ): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO sign_in_attempts(
        account_id, activity_no, shanghai_date, claimed_at
      ) VALUES($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING account_id
    `, [accountId, activityNo, shanghaiDate, this.now()]);
    return (result.rowCount ?? 0) === 1;
  }

  async beginRun(accountIds: readonly string[], startedAt: number):
  Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO sign_in_run_state(
          singleton_id, running, last_started_at, last_finished_at
        ) VALUES(1, true, $1, NULL)
        ON CONFLICT(singleton_id) DO UPDATE SET
          running=true, last_started_at=EXCLUDED.last_started_at
      `, [startedAt]);
      if (accountIds.length === 0) {
        await client.query("DELETE FROM sign_in_check_state");
      } else {
        await client.query(
          "DELETE FROM sign_in_check_state WHERE NOT (account_id = ANY($1::text[]))",
          [[...accountIds]]
        );
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async recordCheck(check: AccountSignInCheck): Promise<void> {
    await this.pool.query(`
      INSERT INTO sign_in_check_state(
        account_id, status, current_frequency, checked_at
      ) VALUES($1, $2, $3, $4)
      ON CONFLICT(account_id) DO UPDATE SET
        status=EXCLUDED.status,
        current_frequency=EXCLUDED.current_frequency,
        checked_at=EXCLUDED.checked_at
    `, [
      check.accountId,
      check.status,
      check.currentFrequency,
      check.checkedAt
    ]);
  }

  async finishRun(finishedAt: number): Promise<void> {
    await this.pool.query(`
      INSERT INTO sign_in_run_state(
        singleton_id, running, last_started_at, last_finished_at
      ) VALUES(1, false, NULL, $1)
      ON CONFLICT(singleton_id) DO UPDATE SET
        running=false, last_finished_at=EXCLUDED.last_finished_at
    `, [finishedAt]);
  }

  async status(): Promise<DailySignInStatus> {
    const [runResult, checksResult] = await Promise.all([
      this.pool.query<PostgresRunRow>(`
        SELECT running, last_started_at, last_finished_at
        FROM sign_in_run_state WHERE singleton_id=1
      `),
      this.pool.query<PostgresCheckRow>(`
        SELECT account_id, status, current_frequency, checked_at
        FROM sign_in_check_state ORDER BY account_id
      `)
    ]);
    const now = this.now();
    const run = runResult.rows[0];
    const lastStartedAt = run?.last_started_at === null
      || run?.last_started_at === undefined
      ? null
      : Number(run.last_started_at);
    return {
      enabled: true,
      intervalMs: 60 * 60_000,
      running: run?.running === true
        && lastStartedAt !== null
        && lastStartedAt >= now - 2 * 60 * 60_000,
      nextCheckAt: nextHourlySignInAt(now),
      lastRunStartedAt: lastStartedAt,
      lastRunFinishedAt: run?.last_finished_at === null
        || run?.last_finished_at === undefined
        ? null
        : Number(run.last_finished_at),
      accounts: checksResult.rows.map((row) => ({
        accountId: row.account_id,
        status: row.status,
        currentFrequency: row.current_frequency,
        checkedAt: Number(row.checked_at)
      }))
    };
  }
}
