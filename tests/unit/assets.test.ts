import { describe, expect, it } from "vitest";
import { assetsFromResponse } from "../../src/jobs/assets.js";

describe("assetsFromResponse", () => {
  it("normalizes the current assetList.data wrapper and numeric asset id", () => {
    const assets = assetsFromResponse({
      assetList: {
        currentPage: 1,
        pageSize: 20,
        total: 1,
        totalPage: 1,
        data: [{
          id: 42,
          scene: "ig",
          modelCode: "fixture-model",
          url: "https://media.example/result.png",
          createTime: "2026-07-24 05:27:25",
          creationCode: "fixture-creation",
          taskId: "fixture-task",
          status: 1,
          reqParam: "{}",
          width: 1024,
          height: 1024
        }]
      }
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "42",
      scene: "ig",
      modelCode: "fixture-model",
      createTime: Date.parse("2026-07-24T05:27:25+08:00"),
      taskId: "fixture-task"
    });
  });
});
