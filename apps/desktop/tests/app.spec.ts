import { test, expect } from "@playwright/test";

// ── Navigator ────────────────────────────────────────────────────────

test.describe("Navigator", () => {
  test("project selector expands and collapses", async ({ page }) => {
    await page.goto("/");
    const selector = page.getByTestId("project-selector");
    await expect(selector).toBeVisible();
    await selector.click();
    // After clicking, the dropdown should render an "Open Project Folder" button
    await expect(page.getByTestId("open-folder")).toBeVisible();
    // Click again to collapse
    await selector.click();
    await expect(page.getByTestId("open-folder")).not.toBeVisible();
  });

  test("mode tabs switch workspace", async ({ page }) => {
    await page.goto("/");
    // Switch to dashboard
    await page.getByTestId("mode-dashboard").click();
    await expect(page.getByTestId("dashboard-tab-tools")).toBeVisible();
    // Switch to models
    await page.getByTestId("mode-models").click();
    await expect(page.getByTestId("compare-toggle")).toBeVisible();
    // Switch back to chat
    await page.getByTestId("mode-chat").click();
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });

  test("add agent creates card, remove agent removes it", async ({ page }) => {
    await page.goto("/");
    const addBtn = page.getByTestId("add-agent");
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    // Role buttons should appear
    await expect(page.getByTestId("role-coder")).toBeVisible();
    // Click coder role
    await page.getByTestId("role-coder").click();
    // Agent card should appear (starts with agent-)
    const cards = page.locator("[data-testid^='agent-card-']");
    await expect(cards).toHaveCount(1);
    // Remove agent — hover to reveal remove button
    const card = cards.first();
    await card.hover();
    const removeBtn = card.locator("[data-testid^='remove-agent-']");
    await removeBtn.click();
    await expect(cards).toHaveCount(0);
  });

  test("search bar opens palette", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
  });

  test("new conversation button is clickable", async ({ page }) => {
    await page.goto("/");
    const btn = page.getByTestId("new-conversation");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test("KAIROS widget navigates to config", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("kairos-widget").click();
    // Config view should now be visible (it replaces chat)
    await expect(page.getByTestId("empty-state")).not.toBeVisible();
  });
});

// ── Status Rail ──────────────────────────────────────────────────────

test.describe("Status Rail", () => {
  test("strategy cycles through values", async ({ page }) => {
    await page.goto("/");
    const btn = page.getByTestId("status-strategy");
    await expect(btn).toBeVisible();
    const first = await btn.textContent();
    await btn.click();
    const second = await btn.textContent();
    expect(second).not.toBe(first);
  });

  test("model button opens model switcher", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("status-model").click();
    await expect(page.getByTestId("model-switcher")).toBeVisible();
  });

  test("permission mode cycles", async ({ page }) => {
    await page.goto("/");
    const btn = page.getByTestId("status-permission");
    const first = await btn.textContent();
    await btn.click();
    const second = await btn.textContent();
    expect(second).not.toBe(first);
    await btn.click();
    const third = await btn.textContent();
    expect(third).not.toBe(second);
  });

  test("cost display is visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("status-cost")).toBeVisible();
    await expect(page.getByTestId("status-cost")).toContainText("$");
  });
});

// ── Command Palette ──────────────────────────────────────────────────

test.describe("Command Palette", () => {
  test("opens on Cmd+K", async ({ page }) => {
    await page.goto("/");
    // Focus the app root for keyboard events
    await page.getByTestId("app-root").focus();
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
  });

  test("filters on typing", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-search").fill("models");
    // Should show the "Go to Models" command
    await expect(page.getByTestId("cmd-mode-models")).toBeVisible();
    // Should NOT show unrelated commands like "Toggle Sidebar"
    await expect(page.getByTestId("cmd-toggle-sidebar")).not.toBeVisible();
  });

  test("command execution switches mode", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await page.getByTestId("cmd-mode-dashboard").click();
    // Palette should close
    await expect(page.getByTestId("command-palette")).not.toBeVisible();
    // Dashboard should be visible
    await expect(page.getByTestId("dashboard-tab-tools")).toBeVisible();
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    // Focus the search input first, then press Escape
    await page.getByTestId("palette-search").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).not.toBeVisible();
  });

  test("arrow navigation and Enter execution", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    const search = page.getByTestId("palette-search");
    await search.fill("Go to");
    // Press ArrowDown a few times, then Enter
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    // Palette should close after execution
    await expect(page.getByTestId("command-palette")).not.toBeVisible();
  });

  test("model switch command exists", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await page.getByTestId("palette-search").fill("opus");
    await expect(page.getByTestId("cmd-model-opus")).toBeVisible();
  });

  test("role switch command exists", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("search-bar").click();
    await page.getByTestId("palette-search").fill("architect");
    await expect(page.getByTestId("cmd-role-architect")).toBeVisible();
  });
});

// ── Chat ─────────────────────────────────────────────────────────────

test.describe("Chat", () => {
  test("empty state renders with action cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("action-new-chat")).toBeVisible();
    await expect(page.getByTestId("action-models")).toBeVisible();
    await expect(page.getByTestId("action-commands")).toBeVisible();
  });

  test("action card Models switches mode", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("action-models").click();
    // Should switch to models view
    await expect(page.getByTestId("compare-toggle")).toBeVisible();
    await expect(page.getByTestId("empty-state")).not.toBeVisible();
  });

  test("action card Commands opens palette", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("action-commands").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
  });

  test("input accepts text", async ({ page }) => {
    await page.goto("/");
    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();
    await input.fill("Hello, world!");
    await expect(input).toHaveValue("Hello, world!");
  });

  test("send button disabled when empty, enabled with text", async ({
    page,
  }) => {
    await page.goto("/");
    const sendBtn = page.getByTestId("send-button");
    // Should be disabled when empty
    await expect(sendBtn).toBeDisabled();
    // Type text
    await page.getByTestId("chat-input").fill("test");
    // Should be enabled
    await expect(sendBtn).toBeEnabled();
  });
});

// ── Overlays ─────────────────────────────────────────────────────────

test.describe("Overlays", () => {
  test("ModelSwitcher: open, filter, select", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("status-model").click();
    await expect(page.getByTestId("model-switcher")).toBeVisible();
    // Filter
    await page.getByTestId("model-search").fill("opus");
    // Should still show Opus
    await expect(page.getByTestId("model-claude-opus-4-6")).toBeVisible();
    // Select it
    await page.getByTestId("model-claude-opus-4-6").click();
    await expect(page.getByTestId("model-switcher")).not.toBeVisible();
  });

  test("KeyboardOverlay: open and close", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("app-root").focus();
    // Cmd+/ or Cmd+? should open the overlay
    await page.keyboard.press("Meta+/");
    await expect(page.getByTestId("keyboard-overlay")).toBeVisible();
    // Click the outer overlay container (which has onClick={onClose})
    // Use force: true because the content panel intercepts clicks on the backdrop
    await page
      .getByTestId("keyboard-overlay")
      .click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("keyboard-overlay")).not.toBeVisible();
  });
});

// ── Dashboard ────────────────────────────────────────────────────────

test.describe("Dashboard", () => {
  test("tab switching works", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-dashboard").click();
    // Tools tab active by default
    await expect(page.getByTestId("dashboard-tab-tools")).toBeVisible();
    // Switch to routing
    await page.getByTestId("dashboard-tab-routing").click();
    // Switch to cost
    await page.getByTestId("dashboard-tab-cost").click();
    // Switch back to tools
    await page.getByTestId("dashboard-tab-tools").click();
  });

  test("tool count displays", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-dashboard").click();
    await expect(page.getByTestId("tool-count")).toBeVisible();
  });
});

// ── Models ───────────────────────────────────────────────────────────

test.describe("Models", () => {
  test("select model shows detail", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-models").click();
    // Click the first available model row (whatever the server returns)
    const firstModel = page.locator("[data-testid^='model-row-']").first();
    await expect(firstModel).toBeVisible({ timeout: 5000 });
    await firstModel.click();
    // Detail panel should show "Use This Model" button
    await expect(page.getByTestId("use-model")).toBeVisible();
  });

  test("Use This Model switches to chat", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-models").click();
    const firstModel = page.locator("[data-testid^='model-row-']").first();
    await expect(firstModel).toBeVisible({ timeout: 5000 });
    await firstModel.click();
    await page.getByTestId("use-model").click();
    // Should switch to chat mode
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });

  test("compare mode toggles", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-models").click();
    const compareBtn = page.getByTestId("compare-toggle");
    await expect(compareBtn).toBeVisible();
    await compareBtn.click();
    // Should now say "Compare (0)"
    await expect(compareBtn).toContainText("Compare");
  });
});

// ── Memory ───────────────────────────────────────────────────────────

test.describe("Memory", () => {
  test("tier filter buttons exist and are clickable", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-memory").click();
    await expect(page.getByTestId("tier-all")).toBeVisible();
    await expect(page.getByTestId("tier-system")).toBeVisible();
    await expect(page.getByTestId("tier-archive")).toBeVisible();
    await expect(page.getByTestId("tier-quarantine")).toBeVisible();
    // Click system tier
    await page.getByTestId("tier-system").click();
    // Click back to all
    await page.getByTestId("tier-all").click();
  });

  test("create form toggle works", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-memory").click();
    const newBtn = page.getByTestId("new-entry");
    await expect(newBtn).toBeVisible();
    await newBtn.click();
    await expect(page.getByTestId("create-form")).toBeVisible();
  });
});

// ── Skills ───────────────────────────────────────────────────────────

test.describe("Skills", () => {
  test("skills view renders without crash", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-skills").click();
    // Wait for the view — either shows skill rows or "No skills loaded"
    await page.waitForTimeout(500);
    // The view should be visible (no crash)
    const skillsContent = page.locator(
      "[data-testid^='skill-row-'], :text('No skills loaded'), :text('Loading skills...')",
    );
    await expect(skillsContent.first()).toBeVisible();
  });
});

// ── Security ─────────────────────────────────────────────────────────

test.describe("Security", () => {
  test("Run Red Team button is clickable", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-security").click();
    const btn = page.getByTestId("run-red-team");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test("middleware pipeline renders 8 layers", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-security").click();
    // Check all 8 layers exist
    for (let i = 0; i < 8; i++) {
      await expect(page.getByTestId(`pipeline-layer-${i}`)).toBeVisible();
    }
  });
});

// ── Workflows ────────────────────────────────────────────────────────

test.describe("Workflows", () => {
  test("New Workflow shows hint banner", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-workflows").click();
    await page.getByTestId("new-workflow").click();
    await expect(page.getByTestId("workflow-hint")).toBeVisible();
  });

  test("hint dismisses", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-workflows").click();
    await page.getByTestId("new-workflow").click();
    await expect(page.getByTestId("workflow-hint")).toBeVisible();
    await page.getByTestId("dismiss-hint").click();
    await expect(page.getByTestId("workflow-hint")).not.toBeVisible();
  });
});

// ── Inspector ────────────────────────────────────────────────────────

test.describe("Inspector", () => {
  test("Cmd+D toggles panel", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("app-root").focus();
    // Open inspector
    await page.keyboard.press("Meta+d");
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    await expect(page.getByTestId("inspector-label")).toBeVisible();
    // Close inspector
    await page.getByTestId("inspector-close").click();
    await expect(page.getByTestId("inspector-panel")).not.toBeVisible();
  });
});

// ── Team Builder Drag & Drop ─────────────────────────────────────────

test.describe("Drag and Drop", () => {
  test("agent card is draggable", async ({ page }) => {
    await page.goto("/");
    // Add an agent first
    await page.getByTestId("add-agent").click();
    await page.getByTestId("role-architect").click();
    const card = page.locator("[data-testid^='agent-card-']").first();
    await expect(card).toBeVisible();
    // Verify the draggable attribute
    await expect(card).toHaveAttribute("draggable", "true");
  });

  test("skill row is draggable", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mode-skills").click();
    // Wait for skills to load
    await page.waitForTimeout(1000);
    const skillRows = page.locator("[data-testid^='skill-row-']");
    const count = await skillRows.count();
    if (count > 0) {
      await expect(skillRows.first()).toHaveAttribute("draggable", "true");
    }
  });
});
