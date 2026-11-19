import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".playwright-browsers");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30000,
  outputDir: ".test-results",
  reporter: [["list"], ["json", { outputFile: ".test-results/results.json" }]],
  use: {
  trace: "off",
  screenshot: "off",
  video: "off",
  launchOptions: {
    slowMo: 1500,
  },
},
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
