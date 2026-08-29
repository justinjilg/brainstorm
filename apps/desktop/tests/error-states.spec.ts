import { test, expect } from "@playwright/test";
import { gotoPlace, openGrowthSkills, setupServerDown } from "./fixtures/mocks";

test.describe("Error States — graceful degradation when the server is down", () => {
  test("server down: the app still renders (no blank screen)", async ({
    page,
  }) => {
    await setupServerDown(page);
    await page.goto("/");
    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("server down: memory view shows an error, not empty", async ({
    page,
  }) => {
    await setupServerDown(page);
    await page.goto("/");
    await gotoPlace(page, "growth");
    await expect(page.getByTestId("memory-error")).toBeVisible({
      timeout: 5000,
    });
  });

  test("server down: skills view shows an error, not empty", async ({
    page,
  }) => {
    await setupServerDown(page);
    await page.goto("/");
    await openGrowthSkills(page);
    await expect(page.getByTestId("skills-error")).toBeVisible({
      timeout: 5000,
    });
  });

  test("server down: chat send surfaces a connection error, not a hang", async ({
    page,
  }) => {
    await setupServerDown(page);
    await page.goto("/");
    await page.getByTestId("chat-input").fill("Hello!");
    await page.getByTestId("send-button").click();
    await expect(page.locator("text=Connection error").first()).toBeVisible({
      timeout: 5000,
    });
  });
});
