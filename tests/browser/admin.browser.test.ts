import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { expect, test } from "playwright/test";
import type { CallLog } from "../../admin/src/types.js";

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
      if (failModels) {
        json(
          response,
          {
            error: {
              message: "Lingjing login required",
              code: "lingjing_session_expired",
            },
          },
          503,
        );
        return;
      }
      const type = url.searchParams.get("type");
      json(response, {
        object: "list",
        data:
          type === "image"
            ? [{ id: "browser-image-model" }]
            : [{ id: "browser-video-model" }],
      });
      return;
    }
    if (
      ["/v1/images/generations", "/v1/videos"].includes(url.pathname) &&
      request.method === "POST"
    ) {
      const input = await body(request);
      json(response, { accepted_model: input.model });
      return;
    }
    if (url.pathname === "/admin/api/login" && request.method === "POST") {
      if ((await body(request)).password !== "fixture-admin-password") {
        json(
          response,
          {
            error: { code: "invalid_password", message: "Incorrect password" },
          },
          401,
        );
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
        json(response, { error: { code: "admin_authentication_required" } }, 401);
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
          { error: { code: "admin_authentication_required", message: "Session expired" } },
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
    if (
      url.pathname === "/admin/api/sign-in-status" &&
      request.method === "GET"
    ) {
      json(response, {
        enabled: true,
        interval_ms: 60 * 60_000,
        running: false,
        next_check_at: Date.now() + 60 * 60_000,
        last_run_started_at: Date.now() - 1_000,
        last_run_finished_at: Date.now(),
        accounts: [
          {
            account_id: "seed",
            status: "already_signed",
            current_frequency: 2,
            checked_at: Date.now(),
          },
        ],
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
    if (
      url.pathname === "/admin/api/playground/models" &&
      request.method === "GET"
    ) {
      if (failModels) {
        json(
          response,
          {
            error: {
              message: "Lingjing login required",
              code: "lingjing_session_expired",
            },
          },
          503,
        );
        return;
      }
      const kind = url.searchParams.get("type");
      const mode = url.searchParams.get("mode") ?? "text-to-video";
      if (kind === "image") {
        json(response, {
          models: [
            {
              id: "browser-image-model",
              display_name: "Browser Image",
              type: "image",
              capabilities: { text: true, input_images: false },
              parameters: [],
              pricing: { points: 2 },
            },
          ],
        });
        return;
      }
      json(response, {
        models: [
          {
            id:
              mode === "image-to-video"
                ? "browser-i2v-mini"
                : "browser-t2v-mini",
            display_name:
              mode === "image-to-video"
                ? "Seedance Mini I2V"
                : "Seedance Mini T2V",
            type: "video",
            mode,
            capabilities: {
              text: true,
              input_images: mode === "image-to-video",
            },
            parameters: [
              {
                key: "duration",
                display_name: "时长",
                required: true,
                type: "enum",
                default: "4",
                options: ["4", "5"],
              },
              {
                key: "mode",
                display_name: "清晰度",
                required: true,
                type: "enum",
                default: "480p",
                options: ["480p", "720p"],
              },
              {
                key: "aspect_ratio",
                display_name: "画幅",
                required: true,
                type: "enum",
                default: "16:9",
                options: ["16:9", "9:16"],
              },
            ],
            pricing: null,
          },
        ],
      });
      return;
    }
    if (
      url.pathname === "/admin/api/playground/quote" &&
      request.method === "POST"
    ) {
      const input = await body(request);
      const parameters = input.parameters as
        Record<string, unknown> | undefined;
      json(response, {
        points: parameters?.duration === "5" ? 115 : 92,
        source: "live",
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
        scopes: Array.isArray(input.scopes)
          ? input.scopes.map(String)
          : ["video:create"],
        enabled: true,
        expires_at: null,
        created_at: now,
        updated_at: now,
        last_used_at: null,
        revoked_at: null,
      };
      apiKeys = [...apiKeys, key];
      json(
        response,
        { key, api_key: ["ljk_", "fixture-secret-shown-once"].join("") },
        201,
      );
      return;
    }
    const apiKeyToggle =
      /^\/admin\/api\/api-keys\/([^/]+)\/(enable|disable)$/.exec(url.pathname);
    if (apiKeyToggle !== null && request.method === "POST") {
      apiKeys = apiKeys.map((key) =>
        key.id === apiKeyToggle[1]
          ? {
              ...key,
              enabled: apiKeyToggle[2] === "enable",
              updated_at: Date.now(),
            }
          : key,
      );
      json(response, {
        key: apiKeys.find((key) => key.id === apiKeyToggle[1]),
      });
      return;
    }
    const apiKeyRevoke = /^\/admin\/api\/api-keys\/([^/]+)$/.exec(url.pathname);
    if (apiKeyRevoke !== null && request.method === "DELETE") {
      apiKeys = apiKeys.map((key) =>
        key.id === apiKeyRevoke[1]
          ? { ...key, revoked_at: Date.now(), updated_at: Date.now() }
          : key,
      );
      json(response, {
        key: apiKeys.find((key) => key.id === apiKeyRevoke[1]),
      });
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
          credential_update_path: `/admin/api/accounts/${account.id}/credentials`,
        },
        201,
      );
      return;
    }
    if (
      url.pathname === "/admin/api/accounts/import" &&
      request.method === "POST"
    ) {
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
    const browserLogin =
      /^\/admin\/api\/accounts\/([^/]+)\/browser-login$/.exec(url.pathname);
    if (browserLogin !== null && request.method === "POST") {
      json(response, {
        login: {
          id: "00000000-0000-4000-8000-000000000001",
          account_id: browserLogin[1],
          status: "running",
          error: null,
          login_url: "about:blank#lingjing-login",
        },
      });
      return;
    }
    const credentials = /^\/admin\/api\/accounts\/([^/]+)\/credentials$/.exec(
      url.pathname,
    );
    if (credentials !== null && request.method === "POST") {
      accounts = accounts.map((account) =>
        account.id === credentials[1]
          ? {
              ...account,
              has_session: true,
              health_status: "ready",
              last_checked_at: Date.now(),
              updated_at: Date.now(),
            }
          : account,
      );
      json(response, {
        account: accounts.find((account) => account.id === credentials[1]),
      });
      return;
    }
    const check = /^\/admin\/api\/accounts\/([^/]+)\/check$/.exec(url.pathname);
    if (check !== null && request.method === "POST") {
      if (failHealth) {
        json(
          response,
          {
            error: {
              code: "health_unavailable",
              message: "Health unavailable",
            },
          },
          503,
        );
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
          if (response.headersSent) {
            response.destroy();
            return;
          }
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
        "/admin/call-logs",
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

test("operator manages API access keys and copies service examples", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "API 密钥" }).click();
  await expect(
    page.getByText("http://127.0.0.1:4174/v1", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "创建 API 密钥" }).click();
  await page.getByLabel("密钥名称").fill("Dify");
  await page
    .getByRole("button", { name: /创建密钥|创建 API 密钥/u })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("此密钥仅显示一次")).toBeVisible();
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByText(/^ljk_fixture_secret/u)).toHaveCount(0);
  await expect(
    page.getByText("Authorization: Bearer ${LINGJING_API_KEY}", {
      exact: true,
    }),
  ).toBeVisible();
  const imageExample = await page
    .locator(".command")
    .filter({
      has: page.getByText("生成图片", { exact: true }),
    })
    .locator("code")
    .innerText();
  const videoExample = await page
    .locator(".command")
    .filter({
      has: page.getByText("生成视频", { exact: true }),
    })
    .locator("code")
    .innerText();
  const executeExample = async (script: string, expectedModel: string) => {
    const urls = [...script.matchAll(/curl -sS "([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(urls).toHaveLength(1);
    const generationUrl = urls[0];
    expect(generationUrl).toBeDefined();
    const model = expectedModel;
    const generated = await page.request.post(generationUrl!, {
      headers: { authorization: "Bearer fixture-browser-key" },
      data: { model },
    });
    expect(generated.status()).toBe(200);
    expect(await generated.json()).toMatchObject({
      accepted_model: expectedModel,
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
] as const) {
  test(`operator traces API calls and removed menus stay absent (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const seed: CallLog = {
      id: "call-inbound-1", trace_id: "trace-browser-1", parent_id: null,
      direction: "inbound", method: "POST", path: "/v1/images/generations",
      status: "success", status_code: 200, duration_ms: 1250,
      started_at: 1_700_000_000_000, finished_at: 1_700_000_001_250,
      job_id: "job-browser-1", account_id: "seed", error_code: null, error_message: null,
      request_headers: { authorization: "[REDACTED]" }, request_body: { prompt: "测试输入", model: "image-model" },
      response_headers: { "content-type": "application/json" }, response_body: { data: [{ url: "https://example.com/result.png" }] },
    };
    const upstream: CallLog = {
      ...seed, id: "call-outbound-1", parent_id: seed.id, direction: "outbound",
      path: "/api/official/generate", duration_ms: 850, status_code: 200, status: "error",
      error_code: "official_unavailable", error_message: "官方服务暂时不可用",
      upstream_status: "failed", upstream: {
        httpStatusCode: 200, businessCode: "9", message: "任务执行失败，请稍后重试", requestId: "s-browser-official-failed-request",
        taskCode: "TASK_RUN_FAILED", vendor: { code: "byteDance_seedance_video", errorCode: "500:INTERNAL", message: "获取模型服务失败" }
      },
      response_body: { error: { code: 9, message: "任务执行失败，请稍后重试" } },
    };
    const records = [seed, upstream, ...Array.from({ length: 25 }, (_, index) => ({
      ...seed, id: `call-extra-${index}`, trace_id: `trace-extra-${index}`, path: `/v1/jobs/${index}`,
    }))];
    const listQueries: URLSearchParams[] = [];
    await page.route("**/admin/api/call-logs**", async route => {
      const url = new URL(route.request().url());
      const id = url.pathname.split("/call-logs/")[1];
      if (id) {
        const record = records.find(item => item.id === id);
        await route.fulfill({ json: { record, related: record?.trace_id === seed.trace_id ? [seed, upstream] : [] } });
        return;
      }
      listQueries.push(url.searchParams);
      const filtered = records.filter(item =>
        (!url.searchParams.get("direction") || item.direction === url.searchParams.get("direction")) &&
        (!url.searchParams.get("status") || item.status === url.searchParams.get("status")) &&
        (!url.searchParams.get("search") || item.trace_id.includes(url.searchParams.get("search")!)));
      const currentPage = Number(url.searchParams.get("page") ?? 1);
      await route.fulfill({ json: {
        items: filtered.slice((currentPage - 1) * 25, currentPage * 25), total: filtered.length,
        page: currentPage, page_size: 25, retention: { days: 30, max_records: 10000, max_body_chars: 32768 },
      } });
    });
    await page.goto("http://127.0.0.1:4174/admin/");
    await page.getByLabel("管理员密码").fill("fixture-admin-password");
    await page.getByRole("button", { name: "登录" }).click();
    if (viewport.name === "desktop") {
      await expect(page.getByRole("link", { name: "用户与项目" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "套餐" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Webhook" })).toHaveCount(0);
      await page.getByRole("link", { name: "API 调用记录" }).click();
    } else {
      await expect(page.getByLabel("页面导航").locator("option")).not.toContainText(["用户与项目", "套餐", "Webhook"]);
      await page.getByLabel("页面导航").selectOption("call-logs");
    }
    await expect(page.getByRole("heading", { name: "API 调用记录" })).toBeVisible();
    await expect(page.getByText("第 1 / 2 页")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("call-logs.png"), fullPage: true });
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("第 2 / 2 页")).toBeVisible();
    expect(listQueries.at(-1)?.get("page")).toBe("2");
    await page.getByRole("button", { name: "上一页" }).click();
    await page.getByRole("button", { name: "查看调用 call-inbound-1", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("测试输入", { exact: false })).toBeVisible();
    await expect(dialog.getByText("https://example.com/result.png", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: /本服务 → 灵境/u }).click();
    await expect(dialog.getByText("官方服务暂时不可用", { exact: true })).toBeVisible();
    await expect(dialog.getByText("官方业务失败", { exact: true })).toBeVisible();
    await expect(dialog.getByText("s-browser-official-failed-request", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("官方错误详情").getByText("获取模型服务失败", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("官方错误详情").getByText("500:INTERNAL", { exact: true })).toBeVisible();
    await expect(dialog.getByText("call-inbound-1", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByLabel("调用方向").selectOption("outbound");
    await page.getByLabel("调用结果").selectOption("error");
    await page.getByLabel("搜索", { exact: true }).fill("trace-browser-1");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByText("HTTP 200", { exact: true })).toBeVisible();
    await expect(page.getByText("官方业务失败", { exact: true })).toBeVisible();
    expect(listQueries.at(-1)?.get("direction")).toBe("outbound");
    expect(listQueries.at(-1)?.get("status")).toBe("error");
    expect(listQueries.at(-1)?.get("search")).toBe("trace-browser-1");
    await page.getByLabel("搜索", { exact: true }).fill("missing-trace");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByText("暂无符合条件的调用记录。新调用完成后可刷新查看。")).toBeVisible();
    await page.getByLabel("搜索", { exact: true }).fill("");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "查看调用 call-outbound-1", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("官方服务暂时不可用", { exact: true })).toBeVisible();
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("call-detail.png") });
  });
}

test("call records distinguish failed official tasks from successful lookups and unknown submissions", async ({ page }) => {
  const record: CallLog = {
    id: "call-status-observation", trace_id: "trace-observation", parent_id: null,
    direction: "outbound", method: "GET", path: "/official/task/status",
    status: "success", status_code: 200, duration_ms: 100,
    started_at: 1_700_000_000_000, finished_at: 1_700_000_000_100,
    job_id: "job-official-failed", account_id: "seed", error_code: null, error_message: null,
    request_headers: {}, request_body: null, response_headers: {}, response_body: { result: { status: 2 } },
    upstream_status: "not_reported", upstream: { httpStatusCode: 200, taskStatus: "2", requestId: "s-task-query" }
  };
  await page.route("**/admin/api/call-logs**", route => route.fulfill({ json: route.request().url().endsWith(record.id)
    ? { record, related: [] } : { items: [record], total: 1, page: 1, page_size: 25, retention: { days: 30, max_records: 10000, max_body_chars: 32768 } } }));
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "API 调用记录" }).click();
  await expect(page.locator("tbody").getByText("成功", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("HTTP 200", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("官方任务失败", { exact: true })).toBeVisible();
  record.status_code = null;
  record.status = "error";
  record.error_code = "lingjing_submit_ambiguous";
  record.upstream_status = "unknown";
  delete record.upstream;
  record.response_body = null;
  await page.getByRole("button", { name: "刷新记录" }).click();
  await expect(page.locator("tbody").getByText("结果未知", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("HTTP 未收到", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("官方业务结果未知", { exact: true })).toBeVisible();
});

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }] as const) {
  test(`task page preserves local state and explains official failures and unavailable observations (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const base = { account_name: "Seed account", kind: "video", model: "fixture-video", quoted_points: 32, budget_state: "reserved", created_at: 1_700_000_000_000, updated_at: 1_700_000_000_100, outputs: [] };
    await page.route("**/admin/api/jobs", route => route.fulfill({ json: { jobs: [
      { ...base, id: "job-official-failed", status: "failed", error_code: "generation_submit_rejected", error_message: "获取模型服务失败", upstream_task_id: "16702988", upstream: { http_status: 200, business_code: "9", request_id: "s-real-upstream-failure-500", task_status: "2", state: "verified", checked_at: 1_700_000_000_100, vendor: { code: "byteDance_seedance_video", error_code: "500:INTERNAL", message: "获取模型服务失败" } } },
      { ...base, id: "job-waiting-output", status: "processing", error_code: null, upstream: { state: "verified", task_status: "1", checked_at: 1_700_000_000_100 } },
      { ...base, id: "job-unavailable", status: "processing", error_code: null, upstream: { state: "unavailable", checked_at: 1_700_000_000_100 } }
    ] } }));
    await page.goto("http://127.0.0.1:4174/admin/");
    await page.getByLabel("管理员密码").fill("fixture-admin-password");
    await page.getByRole("button", { name: "登录" }).click();
    if (viewport.name === "desktop") await page.getByRole("link", { name: "任务", exact: true }).click();
    else await page.getByLabel("页面导航").selectOption("tasks");
    await expect(page.getByText("获取模型服务失败", { exact: true })).toBeVisible();
    await expect(page.getByText("500:INTERNAL", { exact: true })).toBeVisible();
    await expect(page.getByText("官方请求：s-real-upstream-failure-500", { exact: true })).toBeVisible();
    await expect(page.getByText("官方任务：16702988", { exact: true })).toBeVisible();
    const waiting = page.locator("tbody tr").filter({ hasText: "job-waiting-output" });
    await expect(waiting.getByText("processing", { exact: true })).toBeVisible();
    await expect(waiting.getByText("官方已完成，等待输出", { exact: true })).toBeVisible();
    const unavailable = page.locator("tbody tr").filter({ hasText: "job-unavailable" });
    await expect(unavailable.getByText("官方状态暂不可核对", { exact: true })).toBeVisible();
    await expect(unavailable.getByText(/^核验时间：/u)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("task-official-state.png"), fullPage: true });
  });
}

test("upstream 401 does not expire the administrator session", async ({ page }) => {
  await page.route("**/admin/api/accounts/seed/check", route => route.fulfill({
    status: 401, json: { error: { code: "lingjing_session_expired", message: "上游登录已过期" } },
  }));
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(page.getByText("上游登录已过期")).toBeVisible();
  await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toHaveCount(0);
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
            name: next === "overview" ? "总览" : "任务",
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
    await expect(page.getByLabel("管理员密码")).toHaveAttribute(
      "aria-describedby",
      "login-password-error",
    );
    await page.getByLabel("管理员密码").fill("fixture-admin-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();
    await expect(page.getByText("已启用 · 每小时检查")).toBeVisible();
    await expect(page.getByText("签到：今日已签到")).toBeVisible();
    await expect(page.getByText("当前连续 2 天")).toBeVisible();
    const loginPageOpened = page.context().waitForEvent("page");
    await page.getByRole("button", { name: "登录 Seed account" }).click();
    const loginPage = await loginPageOpened;
    await expect.poll(() => loginPage.url()).toBe("about:blank#lingjing-login");
    await loginPage.close();
    await expect(
      page.getByRole("dialog", { name: "更新 Seed account 的凭据" }),
    ).toBeVisible();
    await expect(
      page.getByText(/在你自己的浏览器中完成灵境登录/u),
    ).toBeVisible();
    await page
      .getByLabel("灵境 Cookie")
      .fill(
        "csrfToken=fixture-renewed-csrf; pin=fixture-pin; thor=fixture-renewed-auth",
      );
    await page.getByRole("button", { name: "验证并更新" }).click();
    await expect(page.getByText("已更新 Seed account 的凭据")).toBeVisible();
    await expect(page.getByText("fixture-renewed-csrf")).toHaveCount(0);
    const seedCheck = page.getByRole("button", {
      name: "刷新余额 Seed account",
    });
    await seedCheck.click();
    await expect(page.getByText("已刷新 Seed account 的余额")).toBeVisible();
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
    await expect(
      page.getByRole("link", { name: "打开灵境登录页" }),
    ).toHaveAttribute("href", "https://lingjing.jdcloud.com/");
    await expect(page.getByText(/切勿发送到聊天、日志或 Git/u)).toBeVisible();
    await page.getByLabel("优先级").fill("-1");
    await page.getByLabel("每日点数限额").fill("1.5");
    await page.getByLabel("每月点数限额").fill("-2");
    await page.getByRole("button", { name: "验证并添加" }).click();
    for (const field of ["账号名称", "优先级", "每日点数限额", "每月点数限额"])
      await expect(page.getByLabel(field)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    await expect(page.getByLabel("账号名称")).toBeFocused();
    await page.getByLabel("账号名称").fill(`Browser ${viewport.name}`);
    await page.getByLabel("优先级").fill("7");
    await page.getByLabel("每日点数限额").fill("10");
    await page.getByLabel("每月点数限额").fill("100");
    await page.getByLabel("Cookie 格式").selectOption("header");
    await page
      .getByLabel("灵境 Cookie")
      .fill("csrfToken=fixture-csrf; pin=fixture-pin; thor=fixture-auth");
    await page.getByRole("button", { name: "验证并添加" }).click();
    const importedAccount = page.locator(".account-row").filter({
      has: page.getByText(`Browser ${viewport.name}`, { exact: true }),
    });
    await expect(importedAccount).toContainText("Premium");
    await expect(importedAccount).toContainText("总余额 150");
    await expect(page.getByText("npm run login -- --account-id")).toHaveCount(
      0,
    );
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
      await expect(
        page.getByRole("columnheader", { name: "类型" }),
      ).toHaveCount(1);
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

test("moves focus to the page heading on history navigation", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "运行环境" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "账号" })).toBeFocused();
});

test("keeps initial session 401 signed out but expires an established session", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();
  expireNext = true;
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await expect(page.getByText("Session expired")).toBeVisible();
});

test("keeps accounts usable when settings load fails", async ({ page }) => {
  fail运行环境 = true;
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Seed account")).toBeVisible();
  await page.getByRole("link", { name: "运行环境" }).click();
  await expect(page.getByText("运行环境 unavailable")).toBeVisible();
  await page.getByRole("link", { name: "订阅账号" }).click();
  await expect(page.getByText("Seed account")).toBeVisible();
});

test("copies Agent-ready developer Markdown", async ({ page }) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "开发者文档" }).click();
  await expect(page.getByRole("heading", { name: "开发者文档" })).toBeVisible();
  const markdown = page.getByLabel("Agent Markdown 开发文档");
  await expect(markdown).toHaveValue(/Idempotency-Key/u);
  await expect(markdown).toHaveValue(/unknown 绝不重提/u);
  await page.getByRole("button", { name: "复制 Markdown" }).click();
  await expect(page.getByRole("status")).toContainText(
    /Markdown 已复制|复制失败/u,
  );
});

test("shows remote credential recovery guidance when 调用测试 models need a session", async ({
  page,
}) => {
  failModels = true;
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "调用测试" }).click();
  await expect(page.getByText("请先连接灵境账号")).toBeVisible();
  await expect(
    page.getByText(/在自己的浏览器登录灵境后导入或更新 Cookie/u),
  ).toBeVisible();
  await expect(page.getByText("npm run login", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "打开订阅账号" }),
  ).toHaveAttribute("href", "/admin/accounts");
});

test("refreshes live video points when mode and parameters change", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "调用测试" }).click();
  await page.getByRole("button", { name: "视频" }).click();
  await expect(page.getByLabel("模型")).toHaveValue("browser-t2v-mini");
  await expect(page.getByText("预计 92 点", { exact: true })).toBeVisible();
  await page.getByLabel("时长").selectOption("5");
  await expect(page.getByText("预计 115 点", { exact: true })).toBeVisible();
  await page.getByLabel("视频模式").selectOption("image-to-video");
  await expect(page.getByLabel("模型")).toHaveValue("browser-i2v-mini");
  await expect(page.getByText("预计 92 点", { exact: true })).toBeVisible();
});

test("shows remote-safe credential guidance for legacy and generated accounts", async ({
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
  await expect(page.getByRole("heading", { name: "账号凭据" })).toBeVisible();
  await expect(
    page.getByText(/管理台会在你的本地浏览器打开灵境/u),
  ).toBeVisible();
  await expect(page.getByText("npm run login", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "打开订阅账号" }),
  ).toHaveAttribute("href", "/admin/accounts");
});

test("logout clears an app action failure before returning to sign in", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await page.getByLabel("管理员密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  failHealth = true;
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(page.getByText("Health unavailable")).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, "", "/admin/settings");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Health unavailable")).toHaveCount(0);
  await page.getByRole("link", { name: "订阅账号", exact: true }).click();
  await page.getByRole("button", { name: "刷新余额 Seed account" }).click();
  await expect(page.getByText("Health unavailable")).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await expect(page.getByText("Health unavailable")).toHaveCount(0);
  await expect(page.getByLabel("管理员密码")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
});
