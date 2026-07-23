import { stat } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { CookieFileProvider } from "./cookie-file-provider.js";
import { StorageStateProvider } from "./storage-state-provider.js";
import type { SessionProvider } from "./types.js";

async function requireRegularFile(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error("Lingjing login required: run npm run login");
  }
}

export async function createSessionProvider(config: Pick<AppConfig, "sessionMode" | "storageStatePath" | "cookieFilePath" | "sessionProfilePath">): Promise<SessionProvider> {
  const sourcePath = config.sessionMode === "browser-state" ? config.storageStatePath : config.cookieFilePath;
  await Promise.all([requireRegularFile(sourcePath), requireRegularFile(config.sessionProfilePath)]);
  return config.sessionMode === "browser-state"
    ? new StorageStateProvider(sourcePath, config.sessionProfilePath)
    : new CookieFileProvider(sourcePath, config.sessionProfilePath);
}
