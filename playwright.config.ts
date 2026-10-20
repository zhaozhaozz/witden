import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./packages/web/test",
  outputDir: ".tmp/browser-results",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:5179",
    viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -w @witden/web -- --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: !process.env.CI,
  },
});
