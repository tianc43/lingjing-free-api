import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));
const tsc = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));

describe("admin production build", () => {
  it("cleans only stale frontend assets while preserving admin server modules", async () => {
    const adminOutput = join(projectRoot, "dist", "admin");
    const assets = join(adminOutput, "assets");
    const staleAsset = join(assets, "old.js");
    await execFile(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: projectRoot });
    await mkdir(assets, { recursive: true });
    await writeFile(staleAsset, "stale", { encoding: "utf8", flush: true });

    await execFile(process.execPath, [vite, "build", "--config", "admin/vite.config.ts"], { cwd: projectRoot });

    await access(join(adminOutput, "routes.js"));
    await execFile(process.execPath, ["-e", "import('./dist/app.js')"], { cwd: projectRoot });
    await expect(readFile(staleAsset, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const index = await readFile(join(adminOutput, "index.html"), "utf8");
    expect(index).not.toMatch(/[A-Za-z]:[\\/]|file:\/\//u);
    const referencedAssets = [...index.matchAll(/\/admin\/assets\/([^"']+)/gu)]
      .map((match) => match[1])
      .filter((asset): asset is string => asset !== undefined);
    expect(referencedAssets).not.toHaveLength(0);
    expect(await readdir(assets)).not.toContain("old.js");
    for (const asset of referencedAssets) await access(join(assets, asset));
  }, 30_000);
});
