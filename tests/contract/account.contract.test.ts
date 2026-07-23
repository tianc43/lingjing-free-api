import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountService } from "../../src/lingjing/account.js";

describe("account aggregation", () => {
  it("uses the private session profile for member lookup and returns only a hash", async () => {
    const calls: Array<{ path: string; method?: "GET" | "POST" }> = [];
    const account = await new AccountService({
      read: <T>(path: string, init?: { method?: "GET" | "POST" }) => { calls.push({ path, ...(init?.method === undefined ? {} : { method: init.method }) }); return Promise.resolve((path.includes("space/menu") ? [{ spaceId: 0 }] : path.includes("queryMember") ? { membership: "fixture-member", maxConcurrency: 9 } : path.includes("Coupons") ? { pointsBalance: 11, couponBalance: 12, availableAmount: 13, totalBalance: 14, resourcePackages: [{ name: "fixture-package", balance: 15 }] } : {}) as T); },
      session: { loadProfile: () => Promise.resolve({ originPin: "fixture pin/&" }) },
      config: { maxConcurrency: 8 }
    }).describe();
    expect(calls.find((call) => call.path.includes("queryMember"))?.path).toContain("pin=fixture%20pin%2F%26");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(account.subject).toBe(createHash("sha256").update("fixture pin/&").digest("hex").slice(0, 12));
    expect(account.spaceId).toBe(0);
    expect(account.maxConcurrency).toBe(5);
    expect(JSON.stringify(account)).not.toContain("fixture pin/&");
    expect(account).toMatchObject({ membership: "fixture-member", pointsBalance: 11, couponBalance: 12, availableAmount: 13, totalBalance: 14, resourcePackages: [{ name: "fixture-package", balance: 15 }] });
  });
});
