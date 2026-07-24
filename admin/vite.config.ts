import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../dist/admin"),
    emptyOutDir: true
  }
});
