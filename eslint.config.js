import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
export default ts.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".npm-cache/**",
      ".playwright-browsers/**",
      ".test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  { files: ["public/js/*.js"], languageOptions: { globals: globals.browser } },
  { files: ["**/*.ts"], languageOptions: { globals: globals.node } },
);
