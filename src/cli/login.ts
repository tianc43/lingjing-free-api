import { parseConfig } from "../config.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWritePrivateJsonPair } from "../session/atomic-write.js";
import { GENERATED_ACCOUNT_ID, accountSessionPaths } from "../session/create-provider.js";
import { chromium } from "playwright";

const LOGIN_URL = "https://lingjing.jdcloud.com/";

interface LoginPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  isClosed(): boolean;
  waitForTimeout(timeout: number): Promise<void>;
}

interface LoginContext {
  newPage(): Promise<LoginPage>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

interface LoginBrowser {
  newContext(): Promise<LoginContext>;
  close(): Promise<void>;
}

export function parseLoginArguments(args: string[]): { accountId?: string } {
  if (args.length === 0) return {};
  const accountId = args[1];
  if (args.length === 2 && args[0] === "--account-id" && accountId !== undefined && GENERATED_ACCOUNT_ID.test(accountId)) {
    return { accountId };
  }
  throw new Error("Invalid account ID");
}

export async function waitForAuthenticatedPage(page: LoginPage): Promise<string> {
  for (;;) {
    try {
      const authentication = await page.evaluate(async () => {
        if (location.origin !== "https://lingjing.jdcloud.com") {
          return { authenticated: false, originPin: null };
        }
        const response = await fetch("/api/user/describeBaseInfo");
        const envelope: unknown = await response.json();
        if (typeof envelope !== "object" || envelope === null) {
          return { authenticated: false, originPin: null };
        }
        const value = envelope as { error?: unknown; result?: unknown };
        const account = (window as Window & { JDCloud?: { account?: { originPin?: unknown } } }).JDCloud?.account;
        return {
          authenticated: !value.error && value.result !== undefined && value.result !== null,
          originPin: typeof account?.originPin === "string" ? account.originPin : null
        };
      });
      if (page.isClosed()) throw new Error("Login cancelled before completion.");
      if (authentication.authenticated && authentication.originPin !== null && authentication.originPin.trim().length > 0) {
        return authentication.originPin;
      }
      await page.waitForTimeout(1_000);
    } catch (error) {
      if (error instanceof Error && error.message === "Login cancelled before completion.") throw error;
      if (page.isClosed()) {
        throw new Error("Login cancelled before completion.");
      }
      await page.waitForTimeout(1_000);
    }
  }
}

export async function runLoginCli(
  config: Pick<ReturnType<typeof parseConfig>, "storageStatePath" | "sessionProfilePath">,
  launch: () => Promise<LoginBrowser> = async () => chromium.launch({ headless: false }),
  reportError: (message: string) => void = console.error
): Promise<number> {
  let browser: LoginBrowser | undefined;
  let context: LoginContext | undefined;
  try {
    browser = await launch();
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    console.log("请在打开的浏览器中完成灵境登录，登录成功后将自动保存会话。");
    const originPin = await waitForAuthenticatedPage(page);
    const storageState = await context.storageState();
    await atomicWritePrivateJsonPair([
      { targetPath: config.storageStatePath, value: storageState },
      { targetPath: config.sessionProfilePath, value: { originPin } }
    ]);
    console.log(`会话已保存至: ${config.storageStatePath}`);
    console.log(`登录配置已保存至: ${config.sessionProfilePath}`);
    return 0;
  } catch (error) {
    reportError(error instanceof Error ? error.message : "Login cancelled before completion.");
    return 1;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith("login.ts")) {
  const config = parseConfig(process.env);
  const arguments_ = parseLoginArguments(process.argv.slice(2));
  const loginConfig = arguments_.accountId === undefined
    ? config
    : { ...config, ...accountSessionPaths(config, arguments_.accountId) };
  const prepare = arguments_.accountId === undefined
    ? Promise.resolve()
    : mkdir(dirname(loginConfig.storageStatePath), { recursive: true });
  void prepare.then(async () => await runLoginCli(loginConfig)).then((exitCode) => { process.exitCode = exitCode; });
}
