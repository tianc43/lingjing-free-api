import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { budgetWindows } from "../../src/accounts/budget.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import type { AdmissionInput } from "../../src/accounts/types.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const cleanupModuleUrl = pathToFileURL(join(process.cwd(), "tests", "helpers", "cleanup.ts")).href;

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-admissions-"));
  temporaryDirectories.push(directory);
  return join(directory, "jobs.sqlite");
}

function inputFor(accountId: string, suffix: string): AdmissionInput {
  return {
    accountId,
    quotedPoints: 7,
    windows: budgetWindows(Date.parse("2026-07-24T03:00:00Z")),
    kind: "image",
    sourceType: "image-generation",
    model: "fixture-model",
    apiId: "707",
    modelCode: null,
    expectedAssetScene: "image",
    requestFingerprint: suffix.repeat(64),
    idempotencyKeyHash: suffix.repeat(64),
    spaceId: 0
  };
}

function createReadyAccount(databasePath: string): string {
  const store = new SqliteStore(databasePath);
  const accounts = new SqliteAccountRepository(store);
  const account = accounts.create({
    name: "Ready",
    priority: 1,
    dailyPointLimit: 10,
    monthlyPointLimit: 0
  });
  accounts.update(account.id, { enabled: true });
  accounts.recordObservation(account.id, {
    healthStatus: "ready",
    lastErrorCode: null,
    subjectHash: null,
    pointsBalance: null,
    totalBalance: null,
    maxConcurrency: null
  });
  store.close();
  return account.id;
}

async function waitForReady(directory: string, expectedCount: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const readyCount = readdirSync(directory).filter((name) => name.startsWith("ready-")).length;
    if (readyCount === expectedCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Only some of ${String(expectedCount)} contenders reached the ready barrier`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestDirectory(directory);
  }
});

describe("budgetWindows", () => {
  it("uses Shanghai calendar day and month starts", () => {
    expect(budgetWindows(Date.parse("2026-07-24T03:00:00Z"))).toEqual({
      dayWindowStart: Date.parse("2026-07-23T16:00:00Z"),
      monthWindowStart: Date.parse("2026-06-30T16:00:00Z")
    });
  });
});

describe("SqliteAdmissionRepository", () => {
  it("allows one of two simultaneous seven-point reservations under a ten-point limit", async () => {
    const databasePath = temporaryDatabasePath();
    const directory = dirname(databasePath);
    const accountId = createReadyAccount(databasePath);
    const startMarker = join(directory, "start");
    const storeModuleUrl = pathToFileURL(join(process.cwd(), "src", "persistence", "sqlite-store.ts")).href;
    const admissionModuleUrl = pathToFileURL(join(
      process.cwd(),
      "src",
      "accounts",
      "sqlite-admission-repository.ts"
    )).href;
    const script = [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      `import { SqliteStore } from ${JSON.stringify(storeModuleUrl)};`,
      `import { SqliteAdmissionRepository } from ${JSON.stringify(admissionModuleUrl)};`,
      `import { isExpectedWalContentionCloseError } from ${JSON.stringify(cleanupModuleUrl)};`,
      "writeFileSync(process.argv[4], '', 'utf8');",
      "while (!existsSync(process.argv[3])) await delay(5);",
      "const store = new SqliteStore(process.argv[1]);",
      "const admission = new SqliteAdmissionRepository(store);",
      "try {",
      "  process.stdout.write(JSON.stringify(admission.reserveOrGet(JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')))));",
      "} finally {",
      "  try { store.close(); } catch (cause) {",
      "    if (!isExpectedWalContentionCloseError(cause)) throw cause;",
      "  }",
      "}"
    ].join("\n");
    const attempts = [inputFor(accountId, "a"), inputFor(accountId, "b")].map(async (input, index) => {
      const { stdout } = await execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        databasePath,
        Buffer.from(JSON.stringify(input)).toString("base64url"),
        startMarker,
        join(directory, `ready-${String(index)}`)
      ], { cwd: process.cwd(), windowsHide: true });
      return JSON.parse(stdout) as { outcome: string };
    });
    await waitForReady(directory, attempts.length);
    writeFileSync(startMarker, "", "utf8");
    const results = await Promise.all(attempts);
    const store = new SqliteStore(databasePath);
    const accounts = new SqliteAccountRepository(store);

    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "budget_exhausted")).toHaveLength(1);
    expect(accounts.usage(accountId, budgetWindows(Date.parse("2026-07-24T03:00:00Z"))).dayUsedPoints).toBe(7);
    store.close();
  }, 20_000);

  it("replays, releases pre-submit reservations, and preserves charged usage", () => {
    const databasePath = temporaryDatabasePath();
    const accountId = createReadyAccount(databasePath);
    const store = new SqliteStore(databasePath);
    const accounts = new SqliteAccountRepository(store);
    const admissions = new SqliteAdmissionRepository(store);
    const input = inputFor(accountId, "c");
    const first = admissions.reserveOrGet(input);
    if (first.outcome !== "created") throw new Error("Expected the initial admission to be created");
    const secondReplay = admissions.reserveOrGet(input);

    expect(secondReplay.outcome).toBe("existing");
    expect(accounts.usage(accountId, input.windows).dayUsedPoints).toBe(7);

    admissions.releasePreSubmit(first.job.id);
    expect(accounts.usage(accountId, input.windows).dayUsedPoints).toBe(0);

    const charged = admissions.reserveOrGet(inputFor(accountId, "d"));
    if (charged.outcome !== "created") throw new Error("Expected charged admission to be created");
    admissions.charge(charged.job.id);
    admissions.releasePreSubmit(charged.job.id);
    expect(accounts.usage(accountId, input.windows).dayUsedPoints).toBe(7);
    store.close();
  });
});
