import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));
const tsc = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));

describe("admin production build", () => {
  let output: string | undefined;
  afterEach(async () => {
    if (output !== undefined) {
      await rm(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    output = undefined;
  });

  it("cleans only isolated frontend assets while preserving isolated admin server modules", async () => {
    output = await mkdtemp(join(projectRoot, ".admin-build-"));
    const dist = join(output, "dist");
    const adminOutput = join(dist, "admin");
    const assets = join(adminOutput, "assets");
    const staleAsset = join(assets, "old.js");
    await execFile(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", dist], { cwd: projectRoot });
    await mkdir(assets, { recursive: true });
    await writeFile(staleAsset, "stale", { encoding: "utf8", flush: true });

    await execFile(process.execPath, [vite, "build", "--config", "admin/vite.config.ts", "--outDir", adminOutput], { cwd: projectRoot });

    await access(join(adminOutput, "routes.js"));
    await execFile(process.execPath, ["-e", "import(process.argv[1])", pathToFileURL(join(dist, "app.js")).href], { cwd: projectRoot });
    await expect(readFile(staleAsset, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const index = await readFile(join(adminOutput, "index.html"), "utf8");
    expect(index).not.toMatch(/[A-Za-z]:[\\/]|file:\/\//u);
    const referencedAssets = [...index.matchAll(/\/admin\/assets\/([^"']+)/gu)].map((match) => match[1]).filter((asset): asset is string => asset !== undefined);
    expect(referencedAssets).not.toHaveLength(0);
    expect(await readdir(assets)).not.toContain("old.js");
    for (const asset of referencedAssets) await access(join(assets, asset));
  }, 60_000);
});
