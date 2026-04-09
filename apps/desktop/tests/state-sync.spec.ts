import { test, expect } from "@playwright/test";
import { setupAllMocks } from "./fixtures/mocks";

test.describe("State Sync — Cross-component state propagation", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("model switch in ModelSwitcher updates StatusRail", async ({ page }) => {
    await page.goto("/");
    const statusModel = page.getByTestId("status-model");
    // Open model switcher
    await statusModel.click();
    // Select GPT-5.4
    await page.getByTestId("model-gpt-5.4").click();
    // StatusRail should now show GPT-5.4
    await expect(statusModel).toContainText("GPT-5.4");
  });

  test("model switch via CommandPalette updates StatusRail", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await page.getByTestId("palette-search").fill("gemini");
    await page.getByTestId("cmd-model-gemini").click();
    await expect(page.getByTestId("status-model")).toContainText(
      "Gemini 3.1 Pro",
    );
  });

  test("Use This Model in ModelsView switches to chat and updates StatusRail", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("mode-models").click();
    await page.getByTestId("model-row-gpt-5.4").click();
    await page.getByTestId("use-model").click();
    // Should switch to chat
    await expect(page.getByTestId("empty-state")).toBeVisible();
    // StatusRail should show GPT-5.4
    await expect(page.getByTestId("status-model")).toContainText("GPT-5.4");
  });

  test("strategy is displayed (read-only)", async ({ page }) => {
    await page.goto("/");
    const el = page.getByTestId("status-strategy");
    const text = await el.textContent();
    // Default strategy is "combined"
    expect(text).toBe("combined");
  });

  test("permission mode is displayed (read-only)", async ({ page }) => {
    await page.goto("/");
    const el = page.getByTestId("status-permission");
    const text = await el.textContent();
    // Default permission mode is "confirm"
    expect(text).toBe("confirm");
  });

  test("add agent updates team count header", async ({ page }) => {
    await page.goto("/");
    // Team header shows "(0)"
    await expect(page.locator("text=Team (0)")).toBeVisible();
    // Add an agent
    await page.getByTestId("add-agent").click();
    await page.getByTestId("role-architect").click();
    await expect(page.locator("text=Team (1)")).toBeVisible();
    // Add another
    await page.getByTestId("add-agent").click();
    await page.getByTestId("role-coder").click();
    await expect(page.locator("text=Team (2)")).toBeVisible();
  });

  test("mode switch renders correct view and unmounts previous", async ({
    page,
  }) => {
    await page.goto("/");
    // Chat mode
    await expect(page.getByTestId("empty-state")).toBeVisible();
    // Switch to models
    await page.getByTestId("mode-models").click();
    await expect(page.getByTestId("compare-toggle")).toBeVisible();
    await expect(page.getByTestId("empty-state")).not.toBeVisible();
    // Switch to security
    await page.getByTestId("mode-security").click();
    await expect(page.getByTestId("run-red-team")).toBeVisible();
    await expect(page.getByTestId("compare-toggle")).not.toBeVisible();
    // Switch back to chat
    await page.getByTestId("mode-chat").click();
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });
});
