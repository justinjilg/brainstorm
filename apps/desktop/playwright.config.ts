import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:1420",
    browserName: "webkit",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --port 1420",
    port: 1420,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
