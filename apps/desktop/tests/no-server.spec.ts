import { test, expect } from "@playwright/test";
import { gotoPlace, openPulse, openSettings } from "./fixtures/mocks";

/**
 * No-server tests — visit every place with NO mocks and NO server. Catches
 * crashes from undefined properties and components that assume server data.
 * Every place should render without tripping the ErrorBoundary.
 */
test.describe("No Server — every place renders without crashing", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("/api/") || url.includes("/health")) {
        route.abort("failed");
      } else {
        route.continue();
      }
    });
  });

  const places: Array<"talk" | "council" | "growth"> = [
    "talk",
    "council",
    "growth",
  ];

  for (const place of places) {
    test(`${place} place renders without crash`, async ({ page }) => {
      await page.goto("/");
      await gotoPlace(page, place);
      await page.waitForTimeout(600);
      await expect(page.locator("text=crashed")).not.toBeVisible();
      await expect(page.getByTestId("app-root")).toBeVisible();
    });
  }

  test("Pulse feed renders without crash", async ({ page }) => {
    await page.goto("/");
    await openPulse(page);
    await expect(page.getByTestId("pulse-ledger")).toBeVisible();
    await expect(page.locator("text=crashed")).not.toBeVisible();
  });

  test("Settings drawer renders without crash", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    await page.waitForTimeout(400);
    await expect(page.locator("text=crashed")).not.toBeVisible();
    await expect(page.getByTestId("app-root")).toBeVisible();
  });

  test("rapid place switching doesn't crash", async ({ page }) => {
    await page.goto("/");
    for (const place of [
      "growth",
      "council",
      "talk",
      "growth",
      "talk",
    ] as const) {
      await gotoPlace(page, place);
      await page.waitForTimeout(150);
    }
    await expect(page.getByTestId("app-root")).toBeVisible();
  });
});
