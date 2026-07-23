import { parseConfig } from "../config.js";
import { atomicWritePrivateJson } from "../session/atomic-write.js";
import { chromium } from "playwright";

const LOGIN_URL = "https://lingjing.jdcloud.com/";

async function waitForAuthenticatedPage(page: import("playwright").Page): Promise<string> {
  for (;;) {
    try {
      const authenticated = await page.evaluate(async () => {
        const response = await fetch("/api/user/describeBaseInfo");
        const envelope: unknown = await response.json();
        if (typeof envelope !== "object" || envelope === null) {
          return false;
        }
        const value = envelope as { error?: unknown; result?: unknown };
        return !value.error && value.result !== undefined && value.result !== null;
      });
      if (authenticated) {
        const originPin = await page.evaluate(() => {
          const account = (window as Window & { JDCloud?: { account?: { originPin?: unknown } } }).JDCloud?.account;
          return typeof account?.originPin === "string" ? account.originPin : null;
        });
        if (originPin !== null && originPin.trim().length > 0) {
          return originPin;
        }
      }
      await page.waitForTimeout(1_000);
    } catch {
      if (page.isClosed()) {
        throw new Error("Login cancelled before completion.");
      }
      await page.waitForTimeout(1_000);
    }
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    console.log("请在打开的浏览器中完成灵境登录，登录成功后将自动保存会话。");
    const originPin = await waitForAuthenticatedPage(page);
    const storageState = await context.storageState();
    await atomicWritePrivateJson(config.storageStatePath, storageState);
    await atomicWritePrivateJson(config.sessionProfilePath, { originPin });
    console.log(`会话已保存至: ${config.storageStatePath}`);
    console.log(`登录配置已保存至: ${config.sessionProfilePath}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Login cancelled before completion.";
  console.error(message);
  process.exitCode = 1;
});
