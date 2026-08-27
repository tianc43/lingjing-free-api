import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { expect, test } from "playwright/test";

type Account = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  daily_point_limit: number;
  monthly_point_limit: number;
  daily_used_points: number;
  monthly_used_points: number;
  daily_reserved_points: number;
  monthly_reserved_points: number;
  health_status: "ready";
  last_error_code: null;
  has_session: boolean;
  membership: string | null;
  points_balance: number;
  total_balance: number;
  active_jobs: number;
  last_checked_at: number | null;
  updated_at: number;
};
type ApiKey = {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  enabled: boolean;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};
let server: Server | undefined;
let accounts: Account[] = [];
let apiKeys: ApiKey[] = [];
let nextId = 1;
let expireNext = false;
let fail运行环境 = false;
let failHealth = false;
let failModels = false;
const output = resolve(process.cwd(), "dist", "admin");

function overview() {
  return {
    accounts: {
      total: accounts.length,
      enabled: accounts.filter((item) => item.enabled).length,
      ready: accounts.filter((item) => item.health_status === "ready").length,
      unhealthy: accounts.filter((item) => item.health_status !== "ready")
        .length,
      budget_exhausted: accounts.filter(
        (item) =>
          item.daily_used_points + item.daily_reserved_points >=
            item.daily_point_limit && item.daily_point_limit > 0,
      ).length,
    },
    usage: {
      daily_used_points: 7,
      monthly_used_points: 7,
      daily_reserved_points: 3,
      monthly_reserved_points: 3,
    },
    jobs: { active: 1, queued: 1 },
    balance: {
      available_points: accounts
        .filter((item) => item.enabled && item.health_status === "ready")
        .reduce((sum, item) => sum + item.total_balance, 0),
    },
    recent_failures: [],
  };
}
function json(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });

  response.end(JSON.stringify(payload));
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let value = "";
  for await (const part of request) value += String(part);
  return value ? (JSON.parse(value) as Record<string, unknown>) : {};
}
function safeAsset(pathname: string): string | null {
  const relative = pathname.replace(/^\/admin\/assets\//, "");
  const filename = normalize(join(output, "assets", relative));
  return filename.startsWith(join(output, "assets")) ? filename : null;
}

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:4174");
    const hasSession =
      request.headers.cookie?.includes("admin=fixture-session") === true;
    if (url.pathname === "/v1/models" && request.method === "GET") {
      if(failModels){json(response,{error:{message:"Lingjing login required",code:"lingjing_session_expired"}},503);return;}
      const type = url.searchParams.get("type");
      json(response, {
        object: "list",
        data: type === "image"
          ? [{ id: "browser-image-model" }]
          : [{ id: "browser-video-model" }]
      });
      return;
    }
    if (
      ["/v1/images/generations", "/v1/videos"].includes(url.pathname)
      && request.method === "POST"
    ) {
      const input = await body(request);
      json(response, { accepted_model: input.model });
      return;
    }
    if (url.pathname === "/admin/api/login" && request.method === "POST") {
      if ((await body(request)).password !== "fixture-admin-password") {
        json(response, { error: { code: "invalid_password", message: "Incorrect password" } }, 401);
        return;
      }
      response.setHeader(
        "Set-Cookie",
        "admin=fixture-session; Path=/admin; HttpOnly; SameSite=Strict",
      );
      json(
        response,
        {
          authenticated: true,
          csrf_token: "fixture-csrf",
          expires_at: 9_999_999_999_999,
        },
        200,
      );
      return;
    }
    if (url.pathname === "/admin/api/session") {
      if (!hasSession) {
        json(response, { error: { code: "unauthorized" } }, 401);
        return;
      }
      json(response, {
        authenticated: true,
        csrf_token: "fixture-csrf",
        expires_at: 9_999_999_999_999,
      });
      return;
    }
    if (url.pathname.startsWith("/admin/api/")) {
      if (!hasSession || expireNext) {
        expireNext = false;
        json(
          response,
          { error: { code: "unauthorized", message: "Session expired" } },
          401,
        );
        return;
      }
      if (
        !["GET", "HEAD"].includes(request.method ?? "GET") &&
        request.headers["x-csrf-token"] !== "fixture-csrf"
      ) {
        json(response, { error: { code: "csrf" } }, 403);
        return;
      }
    }
    if (url.pathname === "/admin/api/accounts" && request.method === "GET") {
      json(response, { accounts });
      return;
    }
    if (url.pathname === "/admin/api/sign-in-status" && request.method === "GET") {
      json(response, {
        enabled: true,
        interval_ms: 60 * 60_000,
        running: false,
        next_check_at: Date.now() + 60 * 60_000,
        last_run_started_at: Date.now() - 1_000,
        last_run_finished_at: Date.now(),
        accounts: [{
          account_id: "seed",
          status: "already_signed",
          current_frequency: 2,
          checked_at: Date.now()
        }]
      });
      return;
    }
    if (url.pathname === "/admin/api/overview") {
      json(response, overview());
      return;
    }
    if (url.pathname === "/admin/api/jobs") {
      json(response, {
        jobs: [
          {
            id: "job-browser-1",
            account_id: "seed",
            account_name: "Seed account",
            kind: "image",
            status: "queued",
            budget_state: "reserved",
            quoted_points: 3,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_001_000,
          },
        ],
      });
      return;
    }
    if (url.pathname === "/admin/api/playground/models" && request.method === "GET") {
      if (failModels) {
        json(response, { error: { message: "Lingjing login required", code: "lingjing_session_expired" } }, 503);
        return;
      }
      const kind = url.searchParams.get("type");
      const mode = url.searchParams.get("mode") ?? "text-to-video";
      if (kind === "image") {
        json(response, { models: [{
          id: "browser-image-model",
          display_name: "Browser Image",
          type: "image",
          capabilities: { text: true, input_images: false },
          parameters: [],
          pricing: { points: 2 }
        }] });
        return;
      }
      json(response, { models: [{
        id: mode === "image-to-video" ? "browser-i2v-mini" : "browser-t2v-mini",
        display_name: mode === "image-to-video" ? "Seedance Mini I2V" : "Seedance Mini T2V",
        type: "video",
        mode,
        capabilities: { text: true, input_images: mode === "image-to-video" },
        parameters: [
          { key: "duration", display_name: "时长", required: true, type: "enum", default: "4", options: ["4", "5"] },
          { key: "mode", display_name: "清晰度", required: true, type: "enum", default: "480p", options: ["480p", "720p"] },
          { key: "aspect_ratio", display_name: "画幅", required: true, type: "enum", default: "16:9", options: ["16:9", "9:16"] }
        ],
        pricing: null
      }] });
      return;
    }
    if (url.pathname === "/admin/api/playground/quote" && request.method === "POST") {
      const input = await body(request);
      const parameters = input.parameters as Record<string, unknown> | undefined;
      json(response, {
        points: parameters?.duration === "5" ? 115 : 92,
        source: "live"
      });
      return;
    }
    if (url.pathname === "/admin/api/settings" && fail运行环境) {
      json(
        response,
        {
          error: {
            code: "settings_unavailable",
            message: "运行环境 unavailable",
          },
        },
        503,
      );
      return;
    }
    if (url.pathname === "/admin/api/settings") {
      json(response, {
        max_concurrency: 5,
        max_queued_requests: 20,
        unknown_capacity_hold_ms: 900000,
        image_wait_timeout_ms: 300000,
        video_wait_timeout_ms: 900000,
        docs_enabled: false,
        shared_api_key_configured: true,
        legacy_api_key_configured: true,
        api_base_url: "http://127.0.0.1:4174/v1",
      });
      return;
    }
    if (url.pathname === "/admin/api/api-keys" && request.method === "GET") {
      json(response, { api_keys: apiKeys });
      return;
    }
    if (url.pathname === "/admin/api/api-keys" && request.method === "POST") {
      const input = await body(request);
      const now = Date.now();
      const key: ApiKey = {
        id: `key-browser-${nextId++}`,
        user_id: String(input.user_id ?? "usr_legacy"),
        project_id: String(input.project_id ?? "prj_legacy"),
        name: String(input.name),
        key_prefix: "ljk_browser_",
        scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : ["video:create"],
        enabled: true,
        expires_at: null,
        created_at: now,
        updated_at: now,
        last_used_at: null,
        revoked_at: null,
      };
      apiKeys = [...apiKeys, key];
      json(response, { key, api_key: ["ljk_", "fixture-secret-shown-once"].join("") }, 201);
      return;
    }
    const apiKeyToggle = /^\/admin\/api\/api-keys\/([^/]+)\/(enable|disable)$/.exec(url.pathname);
    if (apiKeyToggle !== null && request.method === "POST") {
      apiKeys = apiKeys.map((key) => key.id === apiKeyToggle[1]
        ? { ...key, enabled: apiKeyToggle[2] === "enable", updated_at: Date.now() }
        : key);
      json(response, { key: apiKeys.find((key) => key.id === apiKeyToggle[1]) });
      return;
    }
    const apiKeyRevoke = /^\/admin\/api\/api-keys\/([^/]+)$/.exec(url.pathname);
    if (apiKeyRevoke !== null && request.method === "DELETE") {
      apiKeys = apiKeys.map((key) => key.id === apiKeyRevoke[1]
        ? { ...key, revoked_at: Date.now(), updated_at: Date.now() }
        : key);
      json(response, { key: apiKeys.find((key) => key.id === apiKeyRevoke[1]) });
      return;
    }
    if (url.pathname === "/admin/api/logout" && request.method === "POST") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/admin/api/accounts" && request.method === "POST") {
      const input = await body(request);
      const account: Account = {
        id: `browser-${nextId++}`,
        name: String(input.name),
        enabled: false,
        priority: Number(input.priority),
        daily_point_limit: Number(input.daily_point_limit),
        monthly_point_limit: Number(input.monthly_point_limit),
        daily_used_points: 0,
        monthly_used_points: 0,
        daily_reserved_points: 0,
        monthly_reserved_points: 0,
        health_status: "ready",
        last_error_code: null,
        has_session: false,
        membership: null,
        points_balance: 120,
        total_balance: 120,
        active_jobs: 0,
        last_checked_at: null,
        updated_at: Date.now(),
      };
      accounts = [...accounts, account];
      json(
        response,
        {
          account,
          login_command: `npm run login -- --account-id ${account.id}`,
        },
        201,
      );
      return;
    }
    if (url.pathname === "/admin/api/accounts/import" && request.method === "POST") {
      const input = await body(request);
      const account: Account = {
        id: `browser-${nextId++}`,
        name: String(input.name),
        enabled: true,
        priority: Number(input.priority),
        daily_point_limit: Number(input.daily_point_limit),
        monthly_point_limit: Number(input.monthly_point_limit),
        daily_used_points: 0,
        monthly_used_points: 0,
        daily_reserved_points: 0,
        monthly_reserved_points: 0,
        health_status: "ready",
        last_error_code: null,
        has_session: true,
        membership: "Premium",
        points_balance: 120,
        total_balance: 150,
        active_jobs: 0,
        last_checked_at: Date.now(),
        updated_at: Date.now(),
      };
      accounts = [...accounts, account];
      json(response, { account }, 201);
      return;
    }
    const check = /^\/admin\/api\/accounts\/([^/]+)\/check$/.exec(url.pathname);
    if (check !== null && request.method === "POST") {
      if (failHealth) {
        json(response, { error: { code: "health_unavailable", message: "Health unavailable" } }, 503);
        return;
      }
      const account = accounts.find((item) => item.id === check[1]);
      json(response, { account });
      return;
    }
    const match = /^\/admin\/api\/accounts\/([^/]+)\/(enable|disable)$/.exec(
      url.pathname,
    );
    if (match !== null && request.method === "POST") {
      accounts = accounts.map((account) =>
        account.id === match[1]
          ? { ...account, enabled: match[2] === "enable" }
          : account,
      );
      json(response, {
        account: accounts.find((account) => account.id === match[1]),
      });
      return;
    }
    const edit = /^\/admin\/api\/accounts\/([^/]+)$/.exec(url.pathname);
    if (edit !== null && request.method === "PATCH") {
      const input = await body(request);
      accounts = accounts.map((account) =>
        account.id === edit[1]
          ? {
              ...account,
              name: String(input.name),
              priority: Number(input.priority),
              daily_point_limit: Number(input.daily_point_limit),
              monthly_point_limit: Number(input.monthly_point_limit),
            }
          : account,
      );
      json(response, {
        account: accounts.find((account) => account.id === edit[1]),
      });
      return;
    }
    if (url.pathname.startsWith("/admin/assets/")) {
      const file = safeAsset(url.pathname);
      if (file !== null) {
        try {
          response.writeHead(200, {
            "Content-Type": file.endsWith(".css")
              ? "text/css"
              : "application/javascript",
          });
          response.end(await readFile(file));
          return;
        } catch {
          json(response, { error: "not_found" }, 404);
          return;
        }
      }
    }
    if (
      [
        "/admin",
        "/admin/",
        "/admin/accounts",
        "/admin/tasks",
        "/admin/playground",
        "/admin/api-access",
        "/admin/settings",
      ].includes(url.pathname)
    ) {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      response.end(await readFile(join(output, "index.html")));
      return;
    }
    json(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((resolveServer) =>
    server!.listen(4174, "127.0.0.1", resolveServer),
  );
});
test.afterAll(
  async () =>
    await new Promise<void>((resolveServer) =>
      server?.close(() => resolveServer()),
    ),
);
test.beforeEach(() => {
  expireNext = false;
  fail运行环境 = false;
  failHealth = false;
  failModels = false;
  nextId = 1;
  apiKeys = [];
  accounts = [
    {
      id: "seed",
      name: "Seed account",
      enabled: true,
      priority: 1,
      daily_point_limit: 10,
      monthly_point_limit: 100,
      daily_used_points: 7,
      monthly_used_points: 7,
      daily_reserved_points: 3,
      monthly_reserved_points: 3,
      health_status: "ready",
      last_error_code: null,
      has_session: true,
      membership: "Premium",
      points_balance: 120,
      total_balance: 120,
      active_jobs: 1,
      last_checked_at: Date.now(),
      updated_at: Date.now(),
    },
  ];
});

test("operator manages API access keys and copies service examples", async ({ page }) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "API 密钥" }).click();
  await expect(page.getByText("http://127.0.0.1:4174/v1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "创建 API 密钥" }).click();
  await page.getByLabel("密钥名称").fill("Dify");
  await page.getByRole("button", { name: /创建密钥|创建 API 密钥/u }).last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("此密钥仅显示一次")).toBeVisible();
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByText(/^ljk_fixture_secret/u)).toHaveCount(0);
  await expect(page.getByText("Authorization: Bearer ${LINGJING_API_KEY}", { exact: true })).toBeVisible();
  const imageExample = await page.locator(".command").filter({
    has: page.getByText("生成图片", { exact: true })
  }).locator("code").innerText();
  const videoExample = await page.locator(".command").filter({
    has: page.getByText("生成视频", { exact: true })
  }).locator("code").innerText();
  const executeExample = async (
    script: string,
    expectedModel: string
  ) => {
    const urls = [...script.matchAll(/curl -sS "([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(urls).toHaveLength(1);
    const generationUrl = urls[0];
    expect(generationUrl).toBeDefined();
    const model = expectedModel;
    const generated = await page.request.post(generationUrl!, {
      headers: { authorization: "Bearer fixture-browser-key" },
      data: { model }
    });
    expect(generated.status()).toBe(200);
    expect(await generated.json()).toMatchObject({
      accepted_model: expectedModel
    });
  };
  await executeExample(imageExample, "browser-image-model");
  await executeExample(videoExample, "browser-video-model");
  expect(imageExample).not.toContain("fixture-image");
  expect(videoExample).not.toContain("fixture-video");
  expect(videoExample).toContain("/v1/videos");
  expect(videoExample).not.toContain("/videos/generations");
  await page.getByRole("button", { name: "禁用" }).click();
  await expect(page.getByRole("button", { name: "启用" })).toBeVisible();
  await page.getByRole("button", { name: "启用" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("已撤销")).toBeVisible();
  await page.getByRole("link", { name: "订阅账号" }).click();
  await expect(page.getByText(/^ljk_fixture_secret/u)).toHaveCount(0);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const)
  test(`operator manages an account without horizontal overflow (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    const navigate = async (next: "overview" | "tasks") => {
      if (viewport.name === "desktop")
        await page
          .getByRole("link", {
            name:next==="overview"?"总览":"任务",
          })
          .click();
      else await page.getByLabel("页面导航").selectOption(next);
    };
    await page.setViewportSize(viewport);
    await page.goto("http://127.0.0.1:4174/admin/");
    await expect(
      page.getByRole("heading", { name: "管理员登录" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("login.png"),
      fullPage: true,
    });
    await page.getByLabel("管理员密码").fill("incorrect");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("Incorrect password")).toBeVisible();
    await expect(page.getByLabel("管理员密码")).toHaveAttribute("aria-describedby", "login-password-error");
    await page
      .getByLabel("管理员密码")
      .fill("fixture-admin-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();
    await expect(page.getByText("已启用 · 每小时检查")).toBeVisible();
    await expect(page.getByText("签到：今日已签到")).toBeVisible();
    await expect(page.getByText("当前连续 2 天")).toBeVisible();
    const seedCheck = page.getByRole("button", {
      name: "刷新余额 Seed account",
    });
    await seedCheck.click();
    await expect(
      page.getByText("已刷新 Seed account 的余额"),
    ).toBeVisible();
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "禁用 Seed account" }).click();
    await expect(
      page.getByRole("button", { name: "禁用 Seed account" }),
    ).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "禁用 Seed account" }).click();
    await expect(
      page.getByRole("button", { name: "启用 Seed account" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "添加账号" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("账号名称").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("dialog")).toContainText("添加账号");
    await expect(
      page.evaluate(() => document.activeElement?.closest("dialog") !== null),
    ).resolves.toBe(true);
    await page.keyboard.press("Tab");
    await expect(
      page.evaluate(() => document.activeElement?.closest("dialog") !== null),
    ).resolves.toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "添加账号" })).toBeFocused();
    await page.getByRole("button", { name: "添加账号" }).click();
    await expect(page.getByRole("link", { name: "打开灵境登录页" })).toHaveAttribute("href", "https://lingjing.jdcloud.com/");
    await expect(page.getByText(/切勿发送到聊天、日志或 Git/u)).toBeVisible();
    await page.getByLabel("优先级").fill("-1");
    await page.getByLabel("每日点数限额").fill("1.5");
    await page.getByLabel("每月点数限额").fill("-2");
    await page.getByRole("button", { name: "验证并添加" }).click();
    for (const field of ["账号名称", "优先级", "每日点数限额", "每月点数限额"]) await expect(page.getByLabel(field)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("账号名称")).toBeFocused();
    await page.getByLabel("账号名称").fill(`Browser ${viewport.name}`);
    await page.getByLabel("优先级").fill("7");
    await page.getByLabel("每日点数限额").fill("10");
    await page.getByLabel("每月点数限额").fill("100");
    await page.getByLabel("Cookie 格式").selectOption("header");
    await page.getByLabel("灵境 Cookie").fill("csrfToken=fixture-csrf; pin=fixture-pin; thor=fixture-auth");
    await page.getByRole("button", { name: "验证并添加" }).click();
    const importedAccount = page.locator(".account-row").filter({
      has: page.getByText(`Browser ${viewport.name}`, { exact: true })
    });
    await expect(importedAccount).toContainText("Premium");
    await expect(importedAccount).toContainText("总余额 150");
    await expect(page.getByText("npm run login -- --account-id")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `禁用 Browser ${viewport.name}` }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `刷新余额 Browser ${viewport.name}` })
      .click();
    await expect(
      page.getByText(`已刷新 Browser ${viewport.name}`),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `编辑 Browser ${viewport.name}` })
      .click();
    await page.getByLabel("优先级").fill("3");
    await page.getByLabel("每日点数限额").fill("25");
    await page.getByLabel("每月点数限额").fill("250");
    await page.getByRole("button", { name: "保存账号" }).click();
    await expect(page.getByText("已扣除 0 · 已预留 0").last()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("accounts.png"),
      fullPage: true,
    });
    await navigate("overview");
    await expect(page.getByText("预算耗尽")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("overview.png"),
      fullPage: true,
    });
    await navigate("tasks");
    await expect(page.getByText("Reserved")).toBeVisible();
    if (viewport.name === "mobile") {
      const kind = page.locator("td[data-label='类型']");
      await expect(kind).toBeVisible();
      await expect(kind).toHaveText("image");
      await expect(page.getByRole("columnheader", { name: "类型" })).toHaveCount(1);
    }
    await expect(
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).resolves.toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("tasks.png"),
      fullPage: true,
    });
    await page
      .getByLabel("账号筛选")
      .selectOption({ label: `Browser ${viewport.name}` });
    await page.getByLabel("类型筛选").selectOption("image");
    await page.getByLabel("状态筛选").selectOption("queued");
    await expect(page.getByText("没有符合当前筛选条件的任务")).toBeVisible();
    await expect(
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).resolves.toBe(true);
  });

test("moves focus to the page heading on history navigation", async ({page})=>{await page.goto("http://127.0.0.1:4174/admin/");await page.getByLabel("管理员密码").fill("fixture-admin-password");await page.getByRole("button",{name:"登录"}).click();await page.getByRole("link",{name:"运行环境"}).click();await expect(page.getByRole("heading",{name:"设置"})).toBeFocused();await page.goBack();await expect(page.getByRole("heading",{name:"账号"})).toBeFocused();});

test("keeps initial session 401 signed out but expires an established session", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await expect(
    page.getByRole("heading", { name: "管理员登录" }),
  ).toBeVisible();
  await page
    .getByLabel("管理员密码")
    .fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();
  expireNext = true;
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(
    page.getByRole("heading", { name: "管理员登录" }),
  ).toBeVisible();
  await expect(
    page.getByText("Session expired"),
  ).toBeVisible();
});

test("keeps accounts usable when settings load fails", async ({ page }) => {
  fail运行环境 = true;
  await page.goto("http://127.0.0.1:4174/admin/");
  await page
    .getByLabel("管理员密码")
    .fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Seed account")).toBeVisible();
  await page.getByRole("link", { name: "运行环境" }).click();
  await expect(page.getByText("运行环境 unavailable")).toBeVisible();
  await page.getByRole("link", { name: "订阅账号" }).click();
  await expect(page.getByText("Seed account")).toBeVisible();
});

test("copies Agent-ready developer Markdown",async({page})=>{await page.goto("http://127.0.0.1:4174/admin/");await page.getByLabel("管理员密码").fill("fixture-admin-password");await page.getByRole("button",{name:"登录"}).click();await page.getByRole("link",{name:"开发者文档"}).click();await expect(page.getByRole("heading",{name:"开发者文档"})).toBeVisible();const markdown=page.getByLabel("Agent Markdown 开发文档");await expect(markdown).toHaveValue(/Idempotency-Key/u);await expect(markdown).toHaveValue(/unknown 绝不重提/u);await page.getByRole("button",{name:"复制 Markdown"}).click();await expect(page.getByRole("status")).toContainText(/Markdown 已复制|复制失败/u);});

test("shows login recovery guidance when 调用测试 models need a session",async({page})=>{failModels=true;await page.goto("http://127.0.0.1:4174/admin/");await page.getByLabel("管理员密码").fill("fixture-admin-password");await page.getByRole("button",{name:"登录"}).click();await page.getByRole("link",{name:"调用测试"}).click();await expect(page.getByText("请先连接灵境账号")).toBeVisible();await expect(page.getByText("npm run login",{exact:false})).toBeVisible();await expect(page.getByRole("link",{name:"打开订阅账号"})).toHaveAttribute("href","/admin/accounts");});

test("refreshes live video points when mode and parameters change",async({page})=>{await page.goto("http://127.0.0.1:4174/admin/");await page.getByLabel("管理员密码").fill("fixture-admin-password");await page.getByRole("button",{name:"登录"}).click();await page.getByRole("link",{name:"调用测试"}).click();await page.getByRole("button",{name:"视频"}).click();await expect(page.getByLabel("模型")).toHaveValue("browser-t2v-mini");await expect(page.getByText("预计 92 点",{exact:true})).toBeVisible();await page.getByLabel("时长").selectOption("5");await expect(page.getByText("预计 115 点",{exact:true})).toBeVisible();await page.getByLabel("视频模式").selectOption("image-to-video");await expect(page.getByLabel("模型")).toHaveValue("browser-i2v-mini");await expect(page.getByText("预计 92 点",{exact:true})).toBeVisible();});

test("shows executable login commands for legacy and generated accounts", async ({
  page,
}) => {
  const seed = accounts[0]!;
  accounts = [
    {
      ...seed,
      id: "legacy",
      name: "Legacy account",
      daily_used_points: 12,
      daily_reserved_points: 3,
    },
    {
      ...seed,
      id: "acct_0123456789abcdef01234567",
      name: "Generated account",
    },
  ];
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  const daily = page.getByRole("progressbar", { name: "每日预算" }).first();
  await expect(daily).toHaveAttribute("aria-valuenow", "10");
  await expect(daily).toHaveAttribute(
    "aria-valuetext",
    "已扣除 12，已预留 3，上限 10",
  );
  await page.getByRole("link", { name: "运行环境" }).click();
  await expect(page.getByText("npm run login", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "npm run login -- --account-id acct_0123456789abcdef01234567",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("--account-id legacy")).toHaveCount(0);
});

test("logout clears an app action failure before returning to sign in", async ({ page }) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  failHealth = true;
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(page.getByText("Health unavailable")).toBeVisible();
  await page.evaluate(() => { history.pushState({}, "", "/admin/settings"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByText("Health unavailable")).toHaveCount(0);
  await page.getByRole("link", { name: "订阅账号" }).click();
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(page.getByText("Health unavailable")).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await expect(page.getByText("Health unavailable")).toHaveCount(0);
  await expect(page.getByLabel("管理员密码")).toHaveAttribute("aria-invalid", "false");
});
