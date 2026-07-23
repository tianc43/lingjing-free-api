import eslint from "@eslint/js";
import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default tseslint.config(
  globalIgnores([
    "dist",
    "coverage",
    "data",
    "dist/**",
    "coverage/**",
    "data/**",
    "eslint.config.js"
  ]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    ignores: [
      "dist",
      "coverage",
      "data",
      "dist/**",
      "coverage/**",
      "data/**",
      "eslint.config.js"
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error"
    }
  }
);
