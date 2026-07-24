import { randomBytes } from "node:crypto";
import type { AccountBudgetUsage, AccountHealth, AccountObservation, AccountRecord, BudgetWindow, CreateAccountInput, UpdateAccountInput } from "./types.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";

interface AccountRow {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  daily_point_limit: number;
  monthly_point_limit: number;
  auth_directory: string;
  health_status: AccountHealth;
  last_error_code: string | null;
  subject_hash: string | null;
  points_balance: number | null;
  total_balance: number | null;
  max_concurrency: number | null;
  last_checked_at: number | null;
  last_selected_at: number | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = `
  id, name, enabled, priority, daily_point_limit, monthly_point_limit,
  auth_directory, health_status, last_error_code, subject_hash, points_balance,
  total_balance, max_concurrency, last_checked_at, last_selected_at, created_at,
  updated_at
`;

const ACCOUNT_HEALTH: ReadonlySet<AccountHealth> = new Set([
  "unknown",
  "ready",
  "needs_login",
  "unhealthy"
]);

function accountFromRow(row: AccountRow): AccountRecord {
  if (row.enabled !== 0 && row.enabled !== 1) {
    throw new Error(`Account ${row.id} has an invalid enabled value`);
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    dailyPointLimit: row.daily_point_limit,
    monthlyPointLimit: row.monthly_point_limit,
    authDirectory: row.auth_directory,
    healthStatus: row.health_status,
    lastErrorCode: row.last_error_code,
    subjectHash: row.subject_hash,
    pointsBalance: row.points_balance,
    totalBalance: row.total_balance,
    maxConcurrency: row.max_concurrency,
    lastCheckedAt: row.last_checked_at,
    lastSelectedAt: row.last_selected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assertName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Account name must be a non-empty string");
  }
}

function assertPriority(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Account priority must be a non-negative safe integer");
  }
}

function assertPointLimit(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError("Account enabled must be a boolean");
  }
}

function assertAccountHealth(value: unknown): asserts value is AccountHealth {
  if (typeof value !== "string" || !ACCOUNT_HEALTH.has(value as AccountHealth)) {
    throw new TypeError("Account health status is invalid");
  }
}

function assertNullableString(value: unknown, name: string): void {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${name} must be a string or null`);
  }
}

function assertNullableFiniteNumber(value: unknown, name: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`${name} must be a finite number or null`);
  }
}

function assertNullableConcurrency(value: unknown): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("maxConcurrency must be a non-negative safe integer or null");
  }
}

export class SqliteAccountRepository {
  constructor(private readonly store: SqliteStore) {}

  ensureLegacyAccount(authDirectory: string): AccountRecord {
    if (typeof authDirectory !== "string" || authDirectory === "") {
      throw new TypeError("Legacy auth directory must be a non-empty string");
    }
    return this.store.immediate((database) => {
      const existing = this.findRow(database, "legacy");
      if (existing !== undefined) return accountFromRow(existing);
      const now = Date.now();
      database.prepare(`
        INSERT INTO accounts (
          id, name, enabled, priority, daily_point_limit, monthly_point_limit,
          auth_directory, health_status, created_at, updated_at
        ) VALUES ('legacy', 'Legacy account', 1, 0, 0, 0, ?, 'unknown', ?, ?)
      `).run(authDirectory, now, now);
      const inserted = this.findRow(database, "legacy");
      if (inserted === undefined) throw new Error("Legacy account could not be read");
      return accountFromRow(inserted);
    });
  }

  create(input: CreateAccountInput): AccountRecord {
    assertName(input.name);
    assertPriority(input.priority);
    assertPointLimit(input.dailyPointLimit, "dailyPointLimit");
    assertPointLimit(input.monthlyPointLimit, "monthlyPointLimit");
    return this.store.immediate((database) => {
      const id = `acct_${randomBytes(12).toString("hex")}`;
      const now = Date.now();
      database.prepare(`
        INSERT INTO accounts (
          id, name, enabled, priority, daily_point_limit, monthly_point_limit,
          auth_directory, health_status, created_at, updated_at
        ) VALUES (
          @id, @name, 0, @priority, @dailyPointLimit, @monthlyPointLimit,
          @authDirectory, 'unknown', @now, @now
        )
      `).run({
        id,
        name: input.name,
        priority: input.priority,
        dailyPointLimit: input.dailyPointLimit,
        monthlyPointLimit: input.monthlyPointLimit,
        authDirectory: `data/accounts/${id}`,
        now
      });
      const inserted = this.findRow(database, id);
      if (inserted === undefined) throw new Error("Created account could not be read");
      return accountFromRow(inserted);
    });
  }

  update(id: string, patch: UpdateAccountInput): AccountRecord {
    if (patch.name !== undefined) assertName(patch.name);
    if (patch.enabled !== undefined) assertBoolean(patch.enabled);
    if (patch.priority !== undefined) assertPriority(patch.priority);
    if (patch.dailyPointLimit !== undefined) {
      assertPointLimit(patch.dailyPointLimit, "dailyPointLimit");
    }
    if (patch.monthlyPointLimit !== undefined) {
      assertPointLimit(patch.monthlyPointLimit, "monthlyPointLimit");
    }
    return this.store.immediate((database) => {
      const current = this.findRow(database, id);
      if (current === undefined) throw new Error(`Account ${id} does not exist`);
      const now = Date.now();
      database.prepare(`
        UPDATE accounts
        SET name = @name,
            enabled = @enabled,
            priority = @priority,
            daily_point_limit = @dailyPointLimit,
            monthly_point_limit = @monthlyPointLimit,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id,
        name: patch.name ?? current.name,
        enabled: patch.enabled === undefined ? current.enabled : Number(patch.enabled),
        priority: patch.priority ?? current.priority,
        dailyPointLimit: patch.dailyPointLimit ?? current.daily_point_limit,
        monthlyPointLimit: patch.monthlyPointLimit ?? current.monthly_point_limit,
        updatedAt: now
      });
      const updated = this.findRow(database, id);
      if (updated === undefined) throw new Error("Updated account could not be read");
      return accountFromRow(updated);
    });
  }

  findById(id: string): AccountRecord | null {
    return this.store.read((database) => {
      const row = this.findRow(database, id);
      return row === undefined ? null : accountFromRow(row);
    });
  }

  list(): AccountRecord[] {
    return this.store.read((database) => (database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM accounts
      ORDER BY priority ASC, created_at ASC, rowid ASC
    `).all() as AccountRow[]).map(accountFromRow));
  }

  recordObservation(id: string, observation: AccountObservation): AccountRecord {
    assertAccountHealth(observation.healthStatus);
    assertNullableString(observation.lastErrorCode, "lastErrorCode");
    assertNullableString(observation.subjectHash, "subjectHash");
    assertNullableFiniteNumber(observation.pointsBalance, "pointsBalance");
    assertNullableFiniteNumber(observation.totalBalance, "totalBalance");
    assertNullableConcurrency(observation.maxConcurrency);
    if (observation.checkedAt !== undefined && !Number.isFinite(observation.checkedAt)) {
      throw new TypeError("checkedAt must be finite");
    }
    return this.store.immediate((database) => {
      if (this.findRow(database, id) === undefined) {
        throw new Error(`Account ${id} does not exist`);
      }
      const now = Date.now();
      database.prepare(`
        UPDATE accounts
        SET health_status = @healthStatus,
            last_error_code = @lastErrorCode,
            subject_hash = @subjectHash,
            points_balance = @pointsBalance,
            total_balance = @totalBalance,
            max_concurrency = @maxConcurrency,
            last_checked_at = @lastCheckedAt,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id,
        healthStatus: observation.healthStatus,
        lastErrorCode: observation.lastErrorCode,
        subjectHash: observation.subjectHash,
        pointsBalance: observation.pointsBalance,
        totalBalance: observation.totalBalance,
        maxConcurrency: observation.maxConcurrency,
        lastCheckedAt: observation.checkedAt ?? now,
        updatedAt: now
      });
      const updated = this.findRow(database, id);
      if (updated === undefined) throw new Error("Observed account could not be read");
      return accountFromRow(updated);
    });
  }

  usage(id: string, windows: BudgetWindow): AccountBudgetUsage {
    if (!Number.isFinite(windows.dayWindowStart) || !Number.isFinite(windows.monthWindowStart)) {
      throw new TypeError("Budget windows must be finite");
    }
    return this.store.read((database) => {
      const row = database.prepare(`
      SELECT
        COALESCE(SUM(CASE
          WHEN day_window_start = @dayWindowStart AND state IN ('reserved', 'charged')
          THEN quoted_points ELSE 0 END), 0) AS day_used_points,
        COALESCE(SUM(CASE
          WHEN month_window_start = @monthWindowStart AND state IN ('reserved', 'charged')
          THEN quoted_points ELSE 0 END), 0) AS month_used_points
      FROM budget_entries
      WHERE account_id = @id
      `).get({ id, ...windows }) as {
        day_used_points: number;
        month_used_points: number;
      };
      return {
        dayUsedPoints: row.day_used_points,
        monthUsedPoints: row.month_used_points
      };
    });
  }

  private findRow(database: import("better-sqlite3").Database, id: string): AccountRow | undefined {
    return database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM accounts
      WHERE id = ?
    `).get(id) as AccountRow | undefined;
  }
}
