import { rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import type { ResolvedConfig } from "vite";
import { defineConfig } from "vite";

const defaultAdminOutput = resolve(import.meta.dirname, "../dist/admin");

function cleanFrontendOutput() {
  let config: ResolvedConfig | undefined;
  return {
    name: "clean-admin-frontend-output",
    apply: "build" as const,
    configResolved(resolved: ResolvedConfig) { config = resolved; },
    async buildStart() {
      if (config === undefined) throw new Error("Admin build output was not resolved");
      const projectRoot = resolve(config.root, "..");
      const adminOutput = resolve(config.build.outDir);
      const relativeOutput = relative(projectRoot, adminOutput);
      if (relativeOutput.startsWith("..") || relativeOutput === "" || basename(adminOutput) !== "admin" || basename(dirname(adminOutput)) !== "dist") throw new Error(`Refusing to clean unsafe admin output: ${adminOutput}`);
      for (const target of [resolve(adminOutput, "index.html"), resolve(adminOutput, "assets")]) {
        const relativeTarget = relative(adminOutput, target);
        if (relativeTarget !== "index.html" && relativeTarget !== "assets") throw new Error(`Refusing to clean non-frontend admin output: ${target}`);
        await rm(target, { recursive: true, force: true });
      }
    }
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/admin/",
  plugins: [cleanFrontendOutput(), react()],
  build: { outDir: defaultAdminOutput, emptyOutDir: false }
});
