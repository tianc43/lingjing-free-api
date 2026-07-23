import { createHash } from "node:crypto";
import type { LingjingTransport } from "./types.js";
export interface AccountSnapshot { subject: string; spaceId: number; membership: string | null; maxConcurrency: number; pointsBalance: number; couponBalance: number; availableAmount: number; totalBalance: number; resourcePackages: Array<{ name: string; balance: number }>; }
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
export class AccountService {
  constructor(private readonly dependencies: { read: Pick<LingjingTransport, "read">["read"]; session: { loadProfile(): Promise<{ originPin: string }> }; config: { maxConcurrency: number } }) {}
  async describe(): Promise<AccountSnapshot> {
    const profile = await this.dependencies.session.loadProfile();
    const [base, spaces, member, wallet] = await Promise.all([
      this.dependencies.read<unknown>("/api/user/describeBaseInfo", { method: "GET" }),
      this.dependencies.read<unknown>("/joycreator/team/space/menu/list", { method: "GET" }),
      this.dependencies.read<unknown>(`/joycreator/member/queryMember?pin=${encodeURIComponent(profile.originPin)}`, { method: "GET" }),
      this.dependencies.read<unknown>("/api/wallet/describeAccountCoupons", { method: "GET" })
    ]);
    void base; const spaceRows = Array.isArray(spaces) ? spaces.map(object) : []; const personal = spaceRows.find((space) => number(space.spaceId) === 0);
    const account = object(wallet); const memberInfo = object(member); const packages = Array.isArray(account.resourcePackages) ? account.resourcePackages.map(object).map((item) => ({ name: typeof item.name === "string" ? item.name : "", balance: number(item.balance) })) : [];
    return { subject: createHash("sha256").update(profile.originPin).digest("hex").slice(0, 12), spaceId: personal === undefined ? 0 : number(personal.spaceId), membership: typeof memberInfo.membership === "string" ? memberInfo.membership : null, maxConcurrency: Math.min(this.dependencies.config.maxConcurrency, 5), pointsBalance: number(account.pointsBalance), couponBalance: number(account.couponBalance), availableAmount: number(account.availableAmount), totalBalance: number(account.totalBalance), resourcePackages: packages };
  }
}
