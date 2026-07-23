import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWritePrivateJson(targetPath: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function atomicWritePrivateJsonPair(entries: ReadonlyArray<{ targetPath: string; value: unknown }>): Promise<void> {
  const prepared: Array<{ targetPath: string; temporaryPath: string; backupPath: string }> = [];
  try {
    for (const entry of entries) {
      await mkdir(dirname(entry.targetPath), { recursive: true, mode: 0o700 });
      const temporaryPath = join(dirname(entry.targetPath), `.${basename(entry.targetPath)}.${randomUUID()}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(entry.value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      prepared.push({ targetPath: entry.targetPath, temporaryPath, backupPath: `${temporaryPath}.bak` });
    }
    for (const item of prepared) {
      await rename(item.targetPath, item.backupPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    for (const item of prepared) await rename(item.temporaryPath, item.targetPath);
    await Promise.all(prepared.map((item) => unlink(item.backupPath).catch(() => undefined)));
  } catch (error) {
    await Promise.all(prepared.map(async (item) => {
      await unlink(item.targetPath).catch(() => undefined);
      await rename(item.backupPath, item.targetPath).catch(() => undefined);
      await unlink(item.temporaryPath).catch(() => undefined);
    }));
    throw error;
  }
}
