import { describe, expect, it } from "vitest";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { budgetWindows } from "../../src/accounts/budget.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { SqliteUsageRepository } from "../../src/usage/sqlite-usage-repository.js";

describe("usage repository", () => {
  it("filters and summarizes project ledger entries", () => {
    const store=new SqliteStore(":memory:"); const accounts=new SqliteAccountRepository(store); const account=accounts.create({name:"Ready",priority:1,dailyPointLimit:100,monthlyPointLimit:100}); accounts.update(account.id,{enabled:true}); accounts.recordObservation(account.id,{healthStatus:"ready",lastErrorCode:null,subjectHash:null,membership:null,pointsBalance:100,totalBalance:100,maxConcurrency:2});
    const admissions=new SqliteAdmissionRepository(store); const result=admissions.reserveOrGet({accountId:account.id,quotedPoints:7,windows:budgetWindows(),kind:"video",sourceType:"text-to-video",model:"m",apiId:"a",modelCode:null,expectedAssetScene:"v",requestFingerprint:"a".repeat(64),idempotencyKeyHash:null,spaceId:1}); if(result.outcome!=="created")throw new Error("admission failed"); admissions.charge(result.job.id);
    const usage=new SqliteUsageRepository(store); expect(usage.summary({projectId:"prj_legacy"})).toMatchObject({heldPoints:7,chargedPoints:7,netPoints:7,entryCount:2}); expect(usage.list({projectId:"missing",limit:10})).toEqual([]); store.close();
  });
});
