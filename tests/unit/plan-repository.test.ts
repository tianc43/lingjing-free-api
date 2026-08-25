import { describe, expect, it } from "vitest";
import { SqliteIdentityRepository } from "../../src/identity/sqlite-identity-repository.js";
import { SqlitePlanRepository } from "../../src/plans/sqlite-plan-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

describe("plan repository", () => {
  it("assigns and enforces video policy", () => {
    const store = new SqliteStore(":memory:");
    const identities = new SqliteIdentityRepository(store);
    const plans = new SqlitePlanRepository(store);
    const user = identities.createUser("Studio");
    const project = identities.createProject(user.id, "Project");
    const plan = plans.create({
      name: "Video 720",
      enabled: true,
      allowedModes: ["text-to-video"],
      allowedModels: ["model-a"],
      maxDurationSeconds: 5,
      allowedResolutions: ["720p"],
      dailyLimitPoints: 100,
      monthlyLimitPoints: 100,
      maxConcurrency: 2,
      maxQueuedRequests: 3
    });
    plans.assign(project.id, plan.id);
    expect(() => {
      plans.assertVideo(project.id, {
        mode: "text-to-video", model: "model-a", duration: 5, resolution: "720p"
      });
    }).not.toThrow();
    expect(() => {
      plans.assertVideo(project.id, { mode: "image-to-video", model: "model-a" });
    }).toThrow(/mode/u);
    expect(() => {
      plans.assertVideo(project.id, { mode: "text-to-video", model: "model-a", duration: 6 });
    }).toThrow(/duration/u);
    store.close();
  });
});
