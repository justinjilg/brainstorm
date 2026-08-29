import { test, expect } from "@playwright/test";
import {
  setupAllMocks,
  MOCK_SKILLS,
  gotoPlace,
  openGrowthSkills,
  openPulse,
  openSettings,
} from "./fixtures/mocks";

test.describe("E2E Journeys — multi-step user workflows in the new shell", () => {
  test("Journey 1: explore every place without crash", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/");

    // 1. Opens on Talk.
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("empty-state")).toBeVisible();

    // 2. Growth → memory then skills.
    await gotoPlace(page, "growth");
    await expect(page.getByTestId("tier-all")).toBeVisible();
    await openGrowthSkills(page);
    await expect(
      page.getByTestId(`skill-row-${MOCK_SKILLS[0].name}`),
    ).toBeVisible();

    // 3. Council renders.
    await gotoPlace(page, "council");
    await expect(
      page.getByText("Council", { exact: false }).first(),
    ).toBeVisible();

    // 4. Pulse opens and closes.
    await gotoPlace(page, "talk");
    await openPulse(page);
    await expect(page.getByTestId("pulse-ledger")).toBeVisible();
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pulse-feed")).not.toBeVisible();

    // 5. Settings opens.
    await openSettings(page);
    await expect(page.getByTestId("models-view")).toBeVisible();
    await page.keyboard.press("Escape");

    // 6. Keyboard overlay.
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Meta+/");
    await expect(page.getByTestId("keyboard-overlay")).toBeVisible();

    // Still alive.
    await expect(page.getByTestId("app-root")).toBeVisible();
  });

  test("Journey 2: pick a model then start a chat", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/");

    // Switch model via the status rail.
    await page.getByTestId("status-model").click();
    await page.getByTestId("model-search").fill("gpt");
    await page.getByTestId("model-gpt-5.4").click();
    await expect(page.getByTestId("status-model")).toContainText("GPT-5.4");

    // Type and send.
    let streamCalled = false;
    await page.route("**/api/v1/chat/stream", (route) => {
      streamCalled = true;
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          "data: " +
          JSON.stringify({ type: "text-delta", delta: "Hi" }) +
          "\ndata: [DONE]\n",
      });
    });
    await page.getByTestId("chat-input").fill("Explain the plan");
    await page.getByTestId("send-button").click();
    await page.waitForTimeout(800);
    expect(streamCalled).toBe(true);
  });
});
