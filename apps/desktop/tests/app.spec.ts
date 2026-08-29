import { test, expect } from "@playwright/test";
import {
  gotoPlace,
  openPulse,
  openSettings,
  setupAllMocks,
} from "./fixtures/mocks";

// The 5×5 entity×verb grid was deleted in the UX reshape. The app is now a calm
// Talk canvas + a slim rail (Talk / Council / Growth) + an openable Pulse feed +
// a Settings drawer. These tests assert that new shell.

test.describe("Shell", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("renders and opens on Talk by default", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("rail")).toBeVisible();
    // Talk is the default canvas — its chat empty-state is present.
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("rail navigates between canvas places (click)", async ({ page }) => {
    await page.goto("/");
    await gotoPlace(page, "growth");
    await expect(page.getByTestId("tier-all")).toBeVisible();
    await gotoPlace(page, "council");
    await expect(
      page.getByText("Council", { exact: false }).first(),
    ).toBeVisible();
    await gotoPlace(page, "talk");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("rail navigates via Cmd+1/2/3", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Meta+3");
    await expect(page.getByTestId("tier-all")).toBeVisible();
    await page.keyboard.press("Meta+1");
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("Pulse feed opens from the rail-heart and closes on Escape", async ({
    page,
  }) => {
    await page.goto("/");
    await openPulse(page);
    await expect(page.getByTestId("pulse-ledger")).toBeVisible();
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pulse-feed")).not.toBeVisible();
  });

  test("Pulse toggles with Cmd+0", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Meta+0");
    await expect(page.getByTestId("pulse-feed")).toBeVisible();
    await page.keyboard.press("Meta+0");
    await expect(page.getByTestId("pulse-feed")).not.toBeVisible();
  });

  test("Settings drawer opens from the rail gear and closes on Escape", async ({
    page,
  }) => {
    await page.goto("/");
    await openSettings(page);
    await expect(page.getByTestId("models-view")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-drawer")).not.toBeVisible();
  });
});

test.describe("Status Rail", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("strategy is displayed", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("status-strategy")).toContainText("combined");
  });

  test("permission mode is displayed", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("status-permission")).toContainText(
      "confirm",
    );
  });

  test("cost display is visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("status-cost")).toBeVisible();
  });

  test("model button opens the model switcher", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("status-model").click();
    await expect(page.getByTestId("model-switcher")).toBeVisible();
  });
});

test.describe("Overlays", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("Command palette opens on Cmd+K and closes on Escape", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-search").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).not.toBeVisible();
  });

  test("ModelSwitcher: open, filter, select", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("status-model").click();
    await expect(page.getByTestId("model-switcher")).toBeVisible();
    await page.getByTestId("model-search").fill("opus");
    await expect(page.getByTestId("model-claude-opus-4-6")).toBeVisible();
    await page.getByTestId("model-claude-opus-4-6").click();
    await expect(page.getByTestId("model-switcher")).not.toBeVisible();
  });

  test("KeyboardOverlay opens on Cmd+/", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("app-shell").focus();
    await page.keyboard.press("Meta+/");
    await expect(page.getByTestId("keyboard-overlay")).toBeVisible();
  });
});

test.describe("Chat (Talk)", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("empty state renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });

  test("input accepts text and send enables", async ({ page }) => {
    await page.goto("/");
    const input = page.getByTestId("chat-input");
    await input.fill("Hello, world!");
    await expect(input).toHaveValue("Hello, world!");
    await expect(page.getByTestId("send-button")).toBeEnabled();
  });

  test("send button disabled when empty", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("send-button")).toBeDisabled();
  });

  test("new thread button is present", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("new-thread")).toBeVisible();
  });
});

test.describe("Growth", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("memory tier filters render", async ({ page }) => {
    await page.goto("/");
    await gotoPlace(page, "growth");
    await expect(page.getByTestId("tier-all")).toBeVisible();
    await expect(page.getByTestId("tier-system")).toBeVisible();
    await expect(page.getByTestId("tier-quarantine")).toBeVisible();
  });

  test("skills tab renders skill rows", async ({ page }) => {
    await page.goto("/");
    await gotoPlace(page, "growth");
    await page.getByRole("button", { name: "Skills" }).click();
    await expect(
      page.getByTestId("skill-row-code-review-and-quality"),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Settings drawer", () => {
  test.beforeEach(async ({ page }) => {
    await setupAllMocks(page);
  });

  test("models tab lists models and can select one", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    const firstModel = page.locator("[data-testid^='model-row-']").first();
    await expect(firstModel).toBeVisible({ timeout: 5000 });
    await firstModel.click();
    await expect(page.getByTestId("use-model")).toBeVisible();
  });
});
