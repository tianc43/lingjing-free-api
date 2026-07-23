import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../../src/lingjing/account.js";
import { LingjingClient } from "../../src/lingjing/client.js";
import { createLogger } from "../../src/logging.js";
import { MockLingjing } from "../helpers/mock-lingjing.js";

const mocks: MockLingjing[] = [];

afterEach(async () => {
  await Promise.all(
    mocks.splice(0).map((mock) => mock.dispatcher.close())
  );
});

describe("account aggregation", () => {
  it("uses four exact GET calls and keeps the private profile PIN out of responses and logs", async () => {
    const originPin = "fixture- pin/&?=中";
    const encodedPin = "fixture-+pin%2F%26%3F%3D%E4%B8%AD";
    const mock = new MockLingjing();
    mocks.push(mock);
    const session = mock.createSession("browser-state");
    session.setProfileOriginPin(originPin);
    await session.seed();
    mock.respondToPath("/api/user/describeBaseInfo", {
      originPin: "fixture-malicious-base-info-pin",
      selectedSpaceId: 999
    });
    mock.respondToPath("/joycreator/team/space/menu/list", [
      { spaceId: 999 },
      { spaceId: 0 }
    ]);
    mock.respondToPath("/joycreator/member/queryMember", {
      membership: "fixture-member",
      maxConcurrency: 99
    });
    mock.respondToPath("/api/wallet/describeAccountCoupons", {
      pointsBalance: 11,
      couponBalance: 12,
      availableAmount: 13,
      totalBalance: 14,
      resourcePackages: [
        { name: "fixture-package-a", balance: 15 },
        { name: "fixture-package-b", balance: 16 }
      ]
    });
    const client = new LingjingClient({
      baseUrl: mock.baseUrl,
      session,
      dispatcher: mock.dispatcher,
      sleep: () => Promise.resolve()
    });

    const account = await new AccountService({
      read: client.read.bind(client),
      session,
      config: { maxConcurrency: 8 }
    }).describe();

    const expectedPaths = [
      "/api/user/describeBaseInfo",
      "/joycreator/team/space/menu/list",
      "/joycreator/member/queryMember",
      "/api/wallet/describeAccountCoupons"
    ];
    for (const path of expectedPaths) {
      expect(mock.count(path), path).toBe(1);
      expect(mock.methodsFor(path), path).toEqual(["GET"]);
    }
    const memberTarget = mock.targetsFor(
      "/joycreator/member/queryMember"
    ).at(0);
    const memberUrl = new URL(memberTarget ?? "", mock.baseUrl);
    expect(memberUrl.pathname).toBe("/joycreator/member/queryMember");
    expect(memberUrl.searchParams.get("pin")).toBe(originPin);
    expect(memberUrl.searchParams.get("_t")).toMatch(/^\d+$/u);
    expect(memberTarget).toContain(`pin=${encodedPin}`);
    expect(memberTarget).not.toContain("malicious-base-info-pin");

    expect(account).toEqual({
      subject: createHash("sha256")
        .update(originPin)
        .digest("hex")
        .slice(0, 12),
      spaceId: 0,
      membership: "fixture-member",
      maxConcurrency: 5,
      pointsBalance: 11,
      couponBalance: 12,
      availableAmount: 13,
      totalBalance: 14,
      resourcePackages: [
        { name: "fixture-package-a", balance: 15 },
        { name: "fixture-package-b", balance: 16 }
      ]
    });

    const capturedLogs: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        capturedLogs.push(chunk.toString("utf8"));
        callback();
      }
    });
    createLogger("info", destination).info({
      req: {
        method: "GET",
        url: memberTarget
      },
      account
    }, "account described");
    const serializedLogs = capturedLogs.join("");
    const serializedResponse = JSON.stringify(account);
    for (const secret of [
      originPin,
      encodedPin,
      "malicious-base-info-pin"
    ]) {
      expect(serializedLogs).not.toContain(secret);
      expect(serializedResponse).not.toContain(secret);
    }
  });
});
