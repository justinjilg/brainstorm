import { test, expect } from "@playwright/test";
import { setupServerDown, setupAllMocks } from "./fixtures/mocks";

test.describe("Error States — Graceful degradation when server is down", () => {
  test("server down: disconnected banner appears", async ({ page }) => {
    await setupServerDown(page);
    await page.goto("/");
    await expect(page.getByTestId("server-disconnected")).toBeVisible();
  });

  test("server down: chat send shows error in messages", async ({ page }) => {
    await setupServerDown(page);
    await page.goto("/");
    await page.getByTestId("chat-input").fill("Hello!");
    await page.getByTestId("send-button").click();
    // Should show a connection error message, not hang
    await expect(page.locator("text=Connection error").first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("server down: memory view shows error, not empty", async ({ page }) => {
    await setupServerDown(page);
    await page.goto("/");
    await page.getByTestId("mode-memory").click();
    // Should show error state, not "No entries"
    await expect(page.getByTestId("memory-error")).toBeVisible({
      timeout: 5000,
    });
  });

  test("server down: skills view shows error, not empty", async ({ page }) => {
    await setupServerDown(page);
    await page.goto("/");
    await page.getByTestId("mode-skills").click();
    await expect(page.getByTestId("skills-error")).toBeVisible({
      timeout: 5000,
    });
  });

  test("server down: dashboard shows error state", async ({ page }) => {
    await setupServerDown(page);
    await page.goto("/");
    await page.getByTestId("mode-dashboard").click();
    await expect(page.getByTestId("tools-error")).toBeVisible({
      timeout: 5000,
    });
  });

  test("server 500: red team shows error message", async ({ page }) => {
    await page.route("**/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            status: "healthy",
            version: "1.0.0",
            uptime_seconds: 100,
            god_mode: { connected: 0, tools: 0 },
            conversations: { active: 0 },
          },
        }),
      }),
    );
    await page.route("**/api/v1/security/red-team", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":"boom"}',
      }),
    );
    await page.goto("/");
    await page.getByTestId("mode-security").click();
    await page.getByTestId("run-red-team").click();
    await expect(page.locator("text=Red team simulation failed")).toBeVisible({
      timeout: 5000,
    });
  });

  test("connected after being disconnected: banner disappears", async ({
    page,
  }) => {
    // Start disconnected
    await setupServerDown(page);
    await page.goto("/");
    await expect(page.getByTestId("server-disconnected")).toBeVisible();

    // Now "reconnect" — change route to return health
    await page.unrouteAll();
    await setupAllMocks(page);
    // Wait for health poll (polls every 10s, but we can trigger faster by waiting)
    await expect(page.getByTestId("server-disconnected")).not.toBeVisible({
      timeout: 15000,
    });
  });
});
