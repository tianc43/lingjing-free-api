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
let server: Server | undefined;
let accounts: Account[] = [];
let nextId = 1;
let expireNext = false;
let failSettings = false;
let failHealth = false;
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
    if (url.pathname === "/admin/api/settings" && failSettings) {
      json(
        response,
        {
          error: {
            code: "settings_unavailable",
            message: "Settings unavailable",
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
  failSettings = false;
  failHealth = false;
  nextId = 1;
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
            name: next === "overview" ? "Overview" : "Tasks",
          })
          .click();
      else await page.getByLabel("Navigate").selectOption(next);
    };
    await page.setViewportSize(viewport);
    await page.goto("http://127.0.0.1:4174/admin/");
    await expect(
      page.getByRole("heading", { name: "Admin sign in" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("login.png"),
      fullPage: true,
    });
    await page.getByLabel("Administrator password").fill("incorrect");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect password")).toBeVisible();
    await expect(page.getByLabel("Administrator password")).toHaveAttribute("aria-describedby", "login-password-error");
    await page
      .getByLabel("Administrator password")
      .fill("fixture-admin-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    const seedCheck = page.getByRole("button", {
      name: "Refresh balance Seed account",
    });
    await seedCheck.click();
    await expect(
      page.getByText("Balance refreshed for Seed account"),
    ).toBeVisible();
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "Disable Seed account" }).click();
    await expect(
      page.getByRole("button", { name: "Disable Seed account" }),
    ).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Disable Seed account" }).click();
    await expect(
      page.getByRole("button", { name: "Enable Seed account" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Account name").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("dialog")).toContainText("Add account");
    await expect(
      page.evaluate(() => document.activeElement?.closest("dialog") !== null),
    ).resolves.toBe(true);
    await page.keyboard.press("Tab");
    await expect(
      page.evaluate(() => document.activeElement?.closest("dialog") !== null),
    ).resolves.toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add account" })).toBeFocused();
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("link", { name: "Open Lingjing login" })).toHaveAttribute("href", "https://lingjing.jdcloud.com/");
    await expect(page.getByText("Opening Lingjing does not import cookies automatically.")).toBeVisible();
    await page.getByLabel("Priority").fill("-1");
    await page.getByLabel("Daily point limit").fill("1.5");
    await page.getByLabel("Monthly point limit").fill("-2");
    await page.getByRole("button", { name: "Validate and add" }).click();
    for (const field of ["Account name", "Priority", "Daily point limit", "Monthly point limit"]) await expect(page.getByLabel(field)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Account name")).toBeFocused();
    await page.getByLabel("Account name").fill(`Browser ${viewport.name}`);
    await page.getByLabel("Priority").fill("7");
    await page.getByLabel("Daily point limit").fill("10");
    await page.getByLabel("Monthly point limit").fill("100");
    await page.getByLabel("Cookie format").selectOption("header");
    await page.getByLabel("Lingjing cookies").fill("csrfToken=fixture-csrf; pin=fixture-pin; thor=fixture-auth");
    await page.getByRole("button", { name: "Validate and add" }).click();
    await expect(page.getByText("Premium")).toBeVisible();
    await expect(page.getByText("Total balance 150")).toBeVisible();
    await expect(page.getByText("npm run login -- --account-id")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Disable Browser ${viewport.name}` }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Refresh balance Browser ${viewport.name}` })
      .click();
    await expect(
      page.getByText(`Balance refreshed for Browser ${viewport.name}`),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Edit Browser ${viewport.name}` })
      .click();
    await page.getByLabel("Priority").fill("3");
    await page.getByLabel("Daily point limit").fill("25");
    await page.getByLabel("Monthly point limit").fill("250");
    await page.getByRole("button", { name: "Save account" }).click();
    await expect(page.getByText("Charged 0 · Reserved 0").last()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("accounts.png"),
      fullPage: true,
    });
    await navigate("overview");
    await expect(page.getByText("Budget exhausted")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("overview.png"),
      fullPage: true,
    });
    await navigate("tasks");
    await expect(page.getByText("Reserved")).toBeVisible();
    if (viewport.name === "mobile") {
      const kind = page.locator("td[data-label='Kind']");
      await expect(kind).toBeVisible();
      await expect(kind).toHaveText("image");
      await expect(page.getByRole("columnheader", { name: "Kind" })).toHaveCount(1);
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
      .getByLabel("Account filter")
      .selectOption({ label: `Browser ${viewport.name}` });
    await page.getByLabel("Kind filter").selectOption("image");
    await page.getByLabel("Status filter").selectOption("queued");
    await expect(page.getByText("No tasks match these filters")).toBeVisible();
    await expect(
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).resolves.toBe(true);
  });

test("keeps initial session 401 signed out but expires an established session", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/admin/");
  await expect(
    page.getByRole("heading", { name: "Admin sign in" }),
  ).toBeVisible();
  await page
    .getByLabel("Administrator password")
    .fill("fixture-admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  expireNext = true;
  await page.getByRole("button", { name: "Refresh balance Seed account" }).click();
  await expect(
    page.getByRole("heading", { name: "Admin sign in" }),
  ).toBeVisible();
  await expect(
    page.getByText("Session expired"),
  ).toBeVisible();
});

test("keeps accounts usable when settings load fails", async ({ page }) => {
  failSettings = true;
  await page.goto("http://127.0.0.1:4174/admin/");
  await page
    .getByLabel("Administrator password")
    .fill("fixture-admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Seed account")).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Settings unavailable")).toBeVisible();
  await page.getByRole("link", { name: "Accounts" }).click();
  await expect(page.getByText("Seed account")).toBeVisible();
});

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
  await page.getByLabel("Administrator password").fill("fixture-admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  const daily = page.getByRole("progressbar", { name: "Daily budget" }).first();
  await expect(daily).toHaveAttribute("aria-valuenow", "10");
  await expect(daily).toHaveAttribute(
    "aria-valuetext",
    "Charged 12, reserved 3, limit 10",
  );
  await page.getByRole("link", { name: "Settings" }).click();
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
  await page.getByLabel("Administrator password").fill("fixture-admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  failHealth = true;
  await page.getByRole("button", { name: "Refresh balance Seed account" }).click();
  await expect(page.getByText("Health unavailable")).toBeVisible();
  await page.evaluate(() => { history.pushState({}, "", "/admin/settings"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByText("Health unavailable")).toHaveCount(0);
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Refresh balance Seed account" }).click();
  await expect(page.getByText("Health unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Admin sign in" })).toBeVisible();
  await expect(page.getByText("Health unavailable")).toHaveCount(0);
  await expect(page.getByLabel("Administrator password")).toHaveAttribute("aria-invalid", "false");
});
