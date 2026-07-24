import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));

describe("admin production build", () => {
  let output: string | undefined;

  afterEach(async () => {
    if (output !== undefined) await rm(output, { recursive: true, force: true });
    output = undefined;
  });

  it("removes stale assets and emits portable admin URLs", async () => {
    output = await mkdtemp(join(tmpdir(), "lingjing-admin-build-"));
    const staleAsset = join(output, "assets", "stale.js");
    await mkdir(join(output, "assets"));
    await writeFile(staleAsset, "stale", { encoding: "utf8", flush: true });

    await execFile(process.execPath, [
      vite,
      "build",
      "--config",
      "admin/vite.config.ts",
      "--outDir",
      output
    ], { cwd: projectRoot });

    await expect(readFile(staleAsset, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const index = await readFile(join(output, "index.html"), "utf8");
    expect(index).not.toMatch(/[A-Za-z]:[\\/]|file:\/\//u);
    expect(index).toContain('/admin/assets/');
  });
});
