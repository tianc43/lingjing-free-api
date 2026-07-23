import { afterAll, beforeAll, describe, it } from "vitest";
import {
  liveTestEnabled,
  startLiveRuntime,
  type LiveRuntime
} from "./live-helpers.js";

const live = liveTestEnabled() ? describe : describe.skip;

live("Lingjing live session", () => {
  let acceptance: LiveRuntime | undefined;

  beforeAll(async () => {
    acceptance = await startLiveRuntime();
  });

  afterAll(async () => {
    await acceptance?.close();
  });

  it("confirms the saved session against the current upstream account", async () => {
    if (acceptance === undefined) {
      throw new Error("Live runtime is unavailable");
    }
    const response = await acceptance.inject({
      method: "GET",
      url: "/v1/session"
    });
    if (response.statusCode !== 200) {
      throw new Error("Live session endpoint did not confirm login");
    }
    const session: unknown = JSON.parse(response.body);
    if (
      typeof session !== "object"
      || session === null
      || (session as { logged_in?: unknown }).logged_in !== true
      || (session as { login_required?: unknown }).login_required !== false
    ) {
      throw new Error("Live session endpoint did not confirm login");
    }

    const account = await acceptance.runtime.dependencies.transport
      .read<unknown>("/api/user/describeBaseInfo");
    if (typeof account !== "object" || account === null) {
      throw new Error("Live upstream session check failed");
    }
  });
});
