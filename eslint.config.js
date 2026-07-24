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
    "test-results/**",
    "tests/browser/**",
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
      "test-results/**",
      "tests/browser/**",
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
  },
  {
    files: ["admin/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-misused-promises": "off"
    }
  },
  {
    files: ["tests/integration/admin-static.test.ts"],
    rules: { "@typescript-eslint/no-unsafe-assignment": "off" }
  }
);
