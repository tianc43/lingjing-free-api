import type { Pool, PoolClient } from "pg";

const DAILY_SIGN_IN_LOCK_KEY = 1_904_270_010;

type LockPool = Pick<Pool, "connect">;

export class PostgresDailySignInLock {
  constructor(private readonly pool: LockPool) {}

  async runExclusive<T>(work: () => Promise<T>): Promise<T | null> {
    const client: PoolClient = await this.pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [DAILY_SIGN_IN_LOCK_KEY]
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) return null;
      return await work();
    } finally {
      try {
        if (locked) {
          await client.query(
            "SELECT pg_advisory_unlock($1)",
            [DAILY_SIGN_IN_LOCK_KEY]
          );
        }
      } finally {
        client.release();
      }
    }
  }
}
