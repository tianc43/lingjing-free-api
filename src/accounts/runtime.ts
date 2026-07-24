import type { AccountRecord } from "./types.js";
import type { AccountService } from "../lingjing/account.js";
import type { LingjingTransport } from "../lingjing/types.js";
import type { CapacityManager } from "../jobs/capacity.js";
import type { DiscoveryLock } from "../jobs/discovery-lock.js";
import type { CatalogService } from "../models/catalog.js";
import type { SessionProvider } from "../session/types.js";

export interface AccountRuntime {
  record: AccountRecord;
  session: SessionProvider;
  transport: LingjingTransport;
  account: AccountService;
  catalog: CatalogService;
  capacity: CapacityManager;
  discoveryLock: DiscoveryLock;
}
