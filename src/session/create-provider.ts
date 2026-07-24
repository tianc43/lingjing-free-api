import { stat } from "node:fs/promises";
import { join } from "node:path";
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

export const GENERATED_ACCOUNT_ID = /^acct_[0-9a-f]{24}$/u;

export interface AccountSessionPaths {
  storageStatePath: string;
  cookieFilePath: string;
  sessionProfilePath: string;
}

export function accountSessionPaths(
  config: Pick<AppConfig, "dataDirectory">,
  accountId: string
): AccountSessionPaths {
  if (!GENERATED_ACCOUNT_ID.test(accountId)) {
    throw new Error("Invalid account ID");
  }
  return {
    storageStatePath: join(config.dataDirectory, "accounts", accountId, "storage-state.json"),
    cookieFilePath: join(config.dataDirectory, "accounts", accountId, "cookie.txt"),
    sessionProfilePath: join(config.dataDirectory, "accounts", accountId, "session-profile.json")
  };
}

export async function createSessionProvider(
  config: Pick<AppConfig, "sessionMode" | "storageStatePath" | "cookieFilePath" | "sessionProfilePath" | "dataDirectory">,
  accountId?: string
): Promise<SessionProvider> {
  const paths = accountId === undefined ? config : accountSessionPaths(config, accountId);
  const sourcePath = config.sessionMode === "browser-state" ? paths.storageStatePath : paths.cookieFilePath;
  await Promise.all([requireRegularFile(sourcePath), requireRegularFile(paths.sessionProfilePath)]);
  return config.sessionMode === "browser-state"
    ? new StorageStateProvider(sourcePath, paths.sessionProfilePath)
    : new CookieFileProvider(sourcePath, paths.sessionProfilePath);
}
