import { test, expect } from "@playwright/test";
import { openSettings, setupAllMocks } from "./fixtures/mocks";

test.describe("State Sync — cross-component state propagation", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("model switch in ModelSwitcher updates the StatusRail", async ({
    page,
  }) => {
    await page.goto("/");
    const statusModel = page.getByTestId("status-model");
    await statusModel.click();
    await page.getByTestId("model-gpt-5.4").click();
    await expect(statusModel).toContainText("GPT-5.4");
  });

  test("Use This Model in Settings updates the StatusRail", async ({
    page,
  }) => {
    await page.goto("/");
    await openSettings(page);
    await page.getByTestId("model-row-gpt-5.4").click();
    await page.getByTestId("use-model").click();
    await expect(page.getByTestId("status-model")).toContainText("GPT-5.4");
  });

  test("strategy is displayed (read-only)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("status-strategy")).toHaveText("combined");
  });

  test("permission mode is displayed (read-only)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("status-permission")).toHaveText("confirm");
  });
});
