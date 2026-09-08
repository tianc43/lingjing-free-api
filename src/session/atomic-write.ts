import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOperations {
  mkdir(
    path: string,
    options: { recursive: true; mode: number },
  ): Promise<string | undefined>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultOperations: AtomicWriteOperations = {
  mkdir,
  writeFile,
  chmod,
  rename,
  unlink,
};

export async function atomicWritePrivateJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

interface PreparedEntry {
  targetPath: string;
  temporaryPath: string;
  backupPath: string;
  backedUp: boolean;
  replaced: boolean;
}

class CommittedPairCleanupError extends Error {
  constructor(readonly backupPaths: readonly string[]) {
    super("Credential pair was committed, but backup cleanup failed.");
    this.name = "CommittedPairCleanupError";
  }
}

async function cleanupBackup(
  path: string,
  operations: AtomicWriteOperations,
): Promise<void> {
  try {
    await operations.unlink(path);
  } catch {
    await operations.unlink(path);
  }
}

function resolveOperations(
  operationsOrReplace:
    | AtomicWriteOperations
    | ((from: string, to: string) => Promise<void>)
    | undefined,
): AtomicWriteOperations {
  if (typeof operationsOrReplace === "function")
    return { ...defaultOperations, rename: operationsOrReplace };
  return operationsOrReplace ?? defaultOperations;
}

export async function atomicWritePrivateJsonPair(
  entries: ReadonlyArray<{ targetPath: string; value: unknown }>,
  operationsOrReplace?:
    AtomicWriteOperations | ((from: string, to: string) => Promise<void>),
): Promise<void> {
  await atomicWritePrivateSerializedPair(
    entries.map((entry) => ({
      targetPath: entry.targetPath,
      value: `${JSON.stringify(entry.value, null, 2)}\n`,
    })),
    operationsOrReplace,
  );
}

async function atomicWritePrivateSerializedPair(
  entries: ReadonlyArray<{ targetPath: string; value: string }>,
  operationsOrReplace?:
    AtomicWriteOperations | ((from: string, to: string) => Promise<void>),
): Promise<void> {
  const operations = resolveOperations(operationsOrReplace);
  const prepared: PreparedEntry[] = [];
  let committed = false;
  try {
    for (const entry of entries) {
      const temporaryPath = join(
        dirname(entry.targetPath),
        `.${basename(entry.targetPath)}.${randomUUID()}.tmp`,
      );
      const item: PreparedEntry = {
        targetPath: entry.targetPath,
        temporaryPath,
        backupPath: `${temporaryPath}.bak`,
        backedUp: false,
        replaced: false,
      };
      prepared.push(item);
      await operations.mkdir(dirname(entry.targetPath), {
        recursive: true,
        mode: 0o700,
      });
      await operations.writeFile(temporaryPath, entry.value, {
        encoding: "utf8",
        mode: 0o600,
      });
      await operations.chmod(temporaryPath, 0o600);
    }
    for (const item of prepared) {
      try {
        await operations.rename(item.targetPath, item.backupPath);
        item.backedUp = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const item of prepared) {
      await operations.rename(item.temporaryPath, item.targetPath);
      item.replaced = true;
    }
    committed = true;
    for (const item of prepared) {
      if (item.backedUp) await cleanupBackup(item.backupPath, operations);
    }
  } catch (error) {
    if (committed) {
      throw new CommittedPairCleanupError(
        prepared.filter((item) => item.backedUp).map((item) => item.backupPath),
      );
    }
    for (const item of [...prepared].reverse()) {
      if (item.replaced)
        await operations.unlink(item.targetPath).catch(() => undefined);
      if (item.backedUp)
        await operations
          .rename(item.backupPath, item.targetPath)
          .catch(() => undefined);
      await operations.unlink(item.temporaryPath).catch(() => undefined);
    }
    throw error;
  }
}

export class PrivateJsonPairRollbackError extends Error {
  readonly code = "credential_pair_rollback_incomplete";

  constructor() {
    super("Credential pair replacement failed and rollback was incomplete");
    this.name = "PrivateJsonPairRollbackError";
  }
}

async function previousValue(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function restorePreviousValues(
  previous: ReadonlyArray<{ targetPath: string; value: string | null }>,
): Promise<void> {
  const present = previous.filter(
    (entry): entry is { targetPath: string; value: string } =>
      entry.value !== null,
  );
  if (present.length > 0) await atomicWritePrivateSerializedPair(present);
  for (const entry of previous) {
    if (entry.value !== null) continue;
    try {
      await unlink(entry.targetPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

export async function replacePrivateJsonPair<T>(
  entries: ReadonlyArray<{ targetPath: string; value: unknown }>,
  publish: () => Promise<T>,
  restorePublishedState: () => Promise<void>,
): Promise<T> {
  const previous = await Promise.all(
    entries.map(async (entry) => ({
      targetPath: entry.targetPath,
      value: await previousValue(entry.targetPath),
    })),
  );
  try {
    await atomicWritePrivateJsonPair(entries);
  } catch (cause) {
    try {
      if (cause instanceof CommittedPairCleanupError) {
        await restorePreviousValues(previous);
        await Promise.all(
          cause.backupPaths.map((path) => unlink(path).catch(() => undefined)),
        );
      }
      await restorePublishedState();
    } catch {
      throw new PrivateJsonPairRollbackError();
    }
    if (cause instanceof CommittedPairCleanupError) {
      throw new PrivateJsonPairRollbackError();
    }
    throw cause;
  }
  try {
    return await publish();
  } catch (cause) {
    try {
      await restorePreviousValues(previous);
      await restorePublishedState();
    } catch {
      throw new PrivateJsonPairRollbackError();
    }
    throw cause;
  }
}
