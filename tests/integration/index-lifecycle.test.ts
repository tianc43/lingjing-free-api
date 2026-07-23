import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/index.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolve();
      else reject(cause);
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a test port");
  }
  return address.port;
}

describe("server lifecycle", () => {
  let runtime: RunningServer | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await runtime?.stop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts recovery before listening and closes HTTP and SQLite cleanly", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const storageStatePath = join(directory, "storage-state.json");
    const profilePath = join(directory, "session-profile.json");
    const dbPath = join(directory, "jobs.sqlite");
    writeFileSync(storageStatePath, JSON.stringify({
      cookies: [{
        name: "csrfToken",
        value: "fixture-csrf",
        domain: "lingjing.jdcloud.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      }]
    }));
    writeFileSync(profilePath, JSON.stringify({ originPin: "fixture-pin" }));

    const port = await availablePort();
    runtime = await startServer({
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      LINGJING_API_KEY: "fixture-downstream-api-key",
      SESSION_MODE: "browser-state",
      LINGJING_STORAGE_STATE: storageStatePath,
      LINGJING_SESSION_PROFILE: profilePath,
      DB_PATH: dbPath,
      LOG_LEVEL: "silent",
      DOCS_ENABLED: "false"
    });

    expect(runtime.dependencies.recovery.ready).toBe(true);
    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(await health.json()).toMatchObject({
      status: "ok",
      database: "ok"
    });
    const session = await fetch(
      `http://127.0.0.1:${String(port)}/v1/session`,
      {
        headers: {
          authorization: "Bearer fixture-downstream-api-key"
        }
      }
    );
    expect(await session.json()).toEqual({
      mode: "browser-state",
      logged_in: true,
      login_required: false
    });

    const repository = runtime.repository;
    await runtime.stop();
    expect(runtime.app.server.listening).toBe(false);
    expect(() => repository.findById("job_missing")).toThrow(
      "Job repository is closed"
    );
  });
});
