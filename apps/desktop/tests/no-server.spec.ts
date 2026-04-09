import { test, expect } from "@playwright/test";

/**
 * No-server tests — visit every view with NO mocks and NO server.
 * This catches crashes from undefined properties, missing optional chains,
 * and components that assume server data exists.
 *
 * Every view should render without crashing, even if data is empty.
 */

test.describe("No Server — every view renders without crashing", () => {
  test.beforeEach(async ({ page }) => {
    // Abort all API calls — simulates no server at all
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("/api/") || url.includes("/health")) {
        route.abort("failed");
      } else {
        route.continue();
      }
    });
  });

  const views = [
    { mode: "chat", name: "Chat" },
    { mode: "dashboard", name: "Dashboard" },
    { mode: "models", name: "Models" },
    { mode: "memory", name: "Memory" },
    { mode: "skills", name: "Skills" },
    { mode: "workflows", name: "Workflows" },
    { mode: "security", name: "Security" },
    { mode: "config", name: "Config" },
  ];

  for (const { mode, name } of views) {
    test(`${name} view renders without crash`, async ({ page }) => {
      await page.goto("/");
      if (mode !== "chat") {
        await page.getByTestId(`mode-${mode}`).click();
      }
      // Wait a moment for async data fetches to fail
      await page.waitForTimeout(1000);
      // The view should NOT show the ErrorBoundary crash message
      const crashed = page.locator(`text=${name} crashed`);
      await expect(crashed).not.toBeVisible();
      // App root should still be visible (not blank screen)
      await expect(page.getByTestId("app-root")).toBeVisible();
    });
  }

  test("rapid mode switching doesn't crash", async ({ page }) => {
    await page.goto("/");
    const modes = [
      "dashboard",
      "models",
      "memory",
      "skills",
      "security",
      "workflows",
      "config",
      "chat",
    ];
    for (const mode of modes) {
      await page.getByTestId(`mode-${mode}`).click();
      await page.waitForTimeout(200);
    }
    // Should still be alive
    await expect(page.getByTestId("app-root")).toBeVisible();
  });
});
