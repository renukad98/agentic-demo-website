import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { rawJUnitReport } from "./tools/xray/playwright-junit.js";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".playwright-browsers");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30000,
  outputDir: ".test-results",
  reporter: [
    ["list"],
    ["json", { outputFile: ".test-results/results.json" }],
    [
      "junit",
      { outputFile: rawJUnitReport, embedAnnotationsAsProperties: true },
    ],
    ["./tools/xray/playwright-junit-reporter.ts"],
  ],
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      slowMo: Number(process.env.SLOWMO ?? 0),
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
