import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const adminOutput = resolve(import.meta.dirname, "../dist/admin");
const distOutput = resolve(import.meta.dirname, "../dist");

function assertFrontendTarget(target: string): void {
  const relativeDistTarget = relative(distOutput, target);
  if (relativeDistTarget.startsWith("..") || relativeDistTarget === "") {
    throw new Error(`Refusing to clean outside dist/admin: ${target}`);
  }
  const relativeTarget = relative(adminOutput, target);
  if (relativeTarget !== "index.html" && relativeTarget !== "assets") {
    throw new Error(`Refusing to clean non-frontend admin output: ${target}`);
  }
}

function cleanFrontendOutput() {
  return {
    name: "clean-admin-frontend-output",
    apply: "build" as const,
    async buildStart() {
      for (const target of [resolve(adminOutput, "index.html"), resolve(adminOutput, "assets")]) {
        assertFrontendTarget(target);
        await rm(target, { recursive: true, force: true });
      }
    }
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/admin/",
  plugins: [cleanFrontendOutput(), react()],
  build: {
    outDir: adminOutput,
    emptyOutDir: false
  }
});
