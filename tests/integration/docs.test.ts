import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function projectFile(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("operator documentation", () => {
  it("documents every public route and the no-retry guarantee", async () => {
    const readme = await projectFile("README.md");
    for (const route of [
      "/healthz",
      "/v1/session",
      "/v1/account",
      "/v1/models",
      "/v1/images/generations",
      "/v1/videos/generations",
      "/v1/tasks/:id",
      "/v1/chat/completions"
    ]) {
      expect(readme).toContain(route);
    }
    expect(readme).toContain("不会自动重放生成请求");
  });

  it("documents local and Docker operation without overstating the project boundary", async () => {
    const readme = await projectFile("README.md");
    for (const phrase of [
      "订阅不等于官方 API",
      "Node.js",
      "20.19.3",
      "npx playwright install chromium",
      "npm run login",
      "docker compose up -d --wait",
      "multipart/form-data",
      "text/event-stream",
      "Idempotency-Key",
      "unknown",
      "`LIVE_TEST=1`",
      "`LIVE_VIDEO_TEST=1`",
      "单用户"
    ]) {
      expect(readme).toContain(phrase);
    }
    expect(readme).toContain("docs/protocol.md");
    expect(readme).toContain("docs/security.md");
    expect(readme).toContain("docs/troubleshooting.md");
  });

  it("loads the documented .env file for the login command", async () => {
    const packageJson = JSON.parse(await projectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.login).toContain("--env-file=.env");
  });

  it("keeps the production compose file free of credential values", async () => {
    const compose = await projectFile("docker-compose.yml");
    expect(compose).not.toMatch(/pt_key|csrfToken|storageState/);
    expect(compose).toContain("./data:/app/data");
    expect(compose).toContain("127.0.0.1:8000:8000");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toMatch(/cap_drop:\s*\n\s*-\s*ALL/u);
  });

  it("uses only fake read-only auth and a disposable database in the smoke override", async () => {
    const override = await projectFile("docker-compose.test.yml");
    const storageState = await projectFile(
      "tests/fixtures/docker-auth/storage-state.json"
    );
    const sessionProfile = await projectFile(
      "tests/fixtures/docker-auth/session-profile.json"
    );

    expect(override).toContain("fixture-docker-api-key-0024");
    expect(override).toContain("read_only: true");
    expect(override).toContain("source: lingjing-smoke-data");
    expect(override).toContain("target: /app/data");
    expect(override).toContain("DB_PATH: /app/data/lingjing.db");
    expect(override).not.toContain("http");
    expect(storageState).toContain("fixture-");
    expect(storageState).not.toMatch(/pt_key|pt_pin|thor|pin=/u);
    expect(sessionProfile).not.toMatch(/https?:\/\//u);
  });

  it("labels reverse-engineered protocol details as changeable and documents safe operations", async () => {
    const protocol = await projectFile("docs/protocol.md");
    const security = await projectFile("docs/security.md");
    const troubleshooting = await projectFile("docs/troubleshooting.md");

    expect(protocol).toContain("逆向验证");
    expect(protocol).toContain("可能变化");
    expect(protocol).toContain("csrfToken");
    expect(protocol).toContain("x-csrf-token");
    expect(protocol).toContain("/joycreator/");
    expect(security).toContain("SSRF");
    expect(security).toContain("127.0.0.1");
    expect(security).toContain("/app/data");
    expect(security).toContain("轮换");
    expect(troubleshooting).toContain("session_expired");
    expect(troubleshooting).toContain("catalog_changed");
    expect(troubleshooting).toContain("unknown");
    expect(troubleshooting).not.toMatch(
      /(?:Get-Content|cat|type)\s+.*(?:cookie|storage-state|session-profile)/iu
    );
  });

  it("never expands Compose configuration into operator output", async () => {
    const documents = await Promise.all([
      projectFile("README.md"),
      projectFile("docs/protocol.md"),
      projectFile("docs/security.md"),
      projectFile("docs/troubleshooting.md")
    ]);

    for (const document of documents) {
      for (const line of document.split(/\r?\n/u)) {
        if (/^\s*docker compose(?:\s+-f\s+\S+)*\s+config\b/u.test(line)) {
          expect(line).toContain("--quiet");
        }
      }
    }
  });
});
