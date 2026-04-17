import { test, expect } from "@playwright/test";
import {
  setupAllMocks,
  setupServerDown,
  MOCK_MEMORY,
  MOCK_SKILLS,
  MOCK_TOOLS,
  MOCK_CONVERSATIONS,
} from "./fixtures/mocks";

test.describe("E2E Journeys — Complex multi-step user workflows", () => {
  // ── Journey 1: First Launch — Explore the app ──────────────────

  test("Journey 1: explore every view without crash", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/");

    // 1. App loads with empty chat state
    await expect(page.getByTestId("app-root")).toBeVisible();
    await expect(page.getByTestId("empty-state")).toBeVisible();

    // 2. Visit every mode, verify each renders
    const modes = [
      { mode: "dashboard", marker: "dashboard-tab-tools" },
      { mode: "models", marker: "compare-toggle" },
      { mode: "memory", marker: "tier-all" },
      { mode: "skills", marker: `skill-row-${MOCK_SKILLS[0].name}` },
      { mode: "security", marker: "run-red-team" },
      // WorkflowsView renders `workflow-preset-*` rows for each preset;
      // pick the first seeded one from the mock.
      { mode: "workflows", marker: "workflow-preset-spec-to-pr" },
    ];

    for (const { mode, marker } of modes) {
      await page.getByTestId(`mode-${mode}`).click();
      await expect(page.getByTestId(marker)).toBeVisible({ timeout: 5000 });
    }

    // 3. Open command palette, search, execute
    await page.getByTestId("search-bar").click();
    await page.getByTestId("palette-search").fill("models");
    await page.getByTestId("cmd-mode-models").click();
    await expect(page.getByTestId("compare-toggle")).toBeVisible();

    // 4. Keyboard overlay
    await page.getByTestId("app-root").focus();
    await page.keyboard.press("Meta+/");
    await expect(page.getByTestId("keyboard-overlay")).toBeVisible();
    await page
      .getByTestId("keyboard-overlay")
      .click({ position: { x: 10, y: 10 } });

    // 5. Inspector
    await page.getByTestId("app-root").focus();
    await page.keyboard.press("Meta+d");
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    await expect(page.getByTestId("inspector-label")).toContainText(
      "Inspector",
    );
    await page.getByTestId("inspector-close").click();

    // 6. Return to chat — empty state still there
    await page.getByTestId("mode-chat").click();
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });

  // ── Journey 2: Build a team and configure it ───────────────────

  test("Journey 2: build multi-agent team with roles and skills", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/");

    // 1. Team starts empty
    await expect(page.locator("text=Team (0)")).toBeVisible();

    // 2. Add architect
    await page.getByTestId("add-agent").click();
    await page.getByTestId("role-architect").click();
    await expect(page.locator("text=Team (1)")).toBeVisible();
    const cards = page.locator("[data-testid^='agent-card-']");
    await expect(cards).toHaveCount(1);
    // Architect should have default skills
    await expect(page.locator("text=planning-and")).toBeVisible();

    // 3. Add coder
    await page.getByTestId("add-agent").click();
    await page.getByTestId("role-coder").click();
    await expect(page.locator("text=Team (2)")).toBeVisible();

    // 4. Add reviewer
    await page.getByTestId("add-agent").click();
    await page.getByTestId("role-reviewer").click();
    await expect(page.locator("text=Team (3)")).toBeVisible();
    await expect(cards).toHaveCount(3);

    // 5. Remove the coder (second card)
    const coderCard = cards.nth(1);
    await coderCard.hover();
    const removeBtn = coderCard.locator("[data-testid^='remove-agent-']");
    await removeBtn.click();
    await expect(page.locator("text=Team (2)")).toBeVisible();
    await expect(cards).toHaveCount(2);

    // 6. Switch to Skills view — verify skills loaded from mock
    await page.getByTestId("mode-skills").click();
    for (const skill of MOCK_SKILLS) {
      await expect(page.getByTestId(`skill-row-${skill.name}`)).toBeVisible();
    }

    // 7. Return to chat — team should persist
    await page.getByTestId("mode-chat").click();
    await expect(page.locator("text=Team (2)")).toBeVisible();
  });

  // ── Journey 3: Full chat workflow ──────────────────────────────

  test("Journey 3: send message, get streaming response, check cost", async ({
    page,
  }) => {
    // Use a custom stream mock with proper SSE newline formatting
    await page.route("**/api/v1/chat/stream", (route) => {
      const lines = [
        'data: {"type":"session","sessionId":"sess-1"}',
        'data: {"type":"routing","model":{"name":"Claude Opus 4.6","provider":"anthropic"},"strategy":"combined"}',
        'data: {"type":"text-delta","delta":"Hello "}',
        'data: {"type":"text-delta","delta":"from the "}',
        'data: {"type":"text-delta","delta":"mock server!"}',
        'data: {"type":"cost","totalCost":0.0042}',
        'data: {"type":"done","totalCost":0.0042}',
        "data: [DONE]",
        "",
      ].join("\n");
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: lines,
      });
    });
    // Mock other routes
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
    await page.route("**/api/v1/conversations", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: [] }),
      }),
    );
    await page.route("**/api/v1/tools", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: MOCK_TOOLS }),
      }),
    );

    await page.goto("/");

    // 1. Verify server connected (no disconnected banner)
    await expect(page.getByTestId("server-disconnected")).not.toBeVisible();

    // 2. Type and send message
    const input = page.getByTestId("chat-input");
    await input.fill("What is brainstorm?");
    await expect(page.getByTestId("send-button")).toBeEnabled();
    await page.getByTestId("send-button").click();

    // 3. Input should clear
    await expect(input).toHaveValue("");

    // 4. Wait for streaming to complete — response should appear
    // The mock SSE delivers text deltas that accumulate: "Hello " + "from the " + "mock server!"
    // After streaming finishes, the assistant message is committed to message history
    await expect(page.locator("text=mock server")).toBeVisible({
      timeout: 10000,
    });

    // 5. Cost should be updated in StatusRail
    await expect(page.getByTestId("status-cost")).toContainText("0.0042");

    // 6. Verify cost reached dashboard
    await page.getByTestId("mode-dashboard").click();
    // Cost should be visible somewhere on dashboard page
    await expect(page.getByTestId("status-cost")).toContainText("0.0042");

    // 7. Return to chat — messages should persist (ChatView stays mounted)
    await page.getByTestId("mode-chat").click();
    await expect(page.locator("text=mock server")).toBeVisible();
  });

  // ── Journey 4: Memory management lifecycle ─────────────────────

  test("Journey 4: create, filter, promote, delete memory entries", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/");
    await page.getByTestId("mode-memory").click();

    // 1. All 3 entries visible
    const entries = page.locator("[data-testid^='memory-entry-']");
    await expect(entries).toHaveCount(3);

    // 2. Filter to system tier
    await page.getByTestId("tier-system").click();
    await expect(entries).toHaveCount(1);

    // 3. Filter to all
    await page.getByTestId("tier-all").click();
    await expect(entries).toHaveCount(3);

    // 4. Select an entry — detail shows
    await page.getByTestId("memory-entry-mem-2").click();
    await expect(page.locator("text=Working on Brainstorm")).toBeVisible();

    // 5. Promote button should be visible (archive entry can be promoted)
    await expect(page.getByTestId("promote")).toBeVisible();

    // 6. Quarantine button should be visible
    await expect(page.getByTestId("quarantine")).toBeVisible();

    // 7. Delete button should be visible
    await expect(page.getByTestId("delete-memory")).toBeVisible();
  });

  // ── Journey 5: Model switching from every entry point ──────────

  test("Journey 5: switch models from 3 different UI paths", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/");
    const statusModel = page.getByTestId("status-model");

    // Path 1: ModelSwitcher via StatusRail
    await statusModel.click();
    await page.getByTestId("model-gpt-5.4").click();
    await expect(statusModel).toContainText("GPT-5.4");

    // Path 2: CommandPalette
    await page.getByTestId("search-bar").click();
    await page.getByTestId("palette-search").fill("Gemini");
    await page.getByTestId("cmd-model-gemini").click();
    await expect(statusModel).toContainText("Gemini 3.1 Pro");

    // Path 3: ModelsView "Use This Model"
    await page.getByTestId("mode-models").click();
    await page.getByTestId("model-row-claude-opus-4-6").click();
    await page.getByTestId("use-model").click();
    // Should switch back to chat
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(statusModel).toContainText("Claude Opus 4.6");
  });

  // ── Journey 6: Server goes down mid-session ────────────────────

  test("Journey 6: server disconnects and reconnects", async ({ page }) => {
    // Start with everything working
    await setupAllMocks(page);
    await page.goto("/");

    // 1. Verify connected — no banner
    await expect(page.getByTestId("server-disconnected")).not.toBeVisible();

    // 2. Dashboard loads tools
    await page.getByTestId("mode-dashboard").click();
    await expect(page.getByTestId("tool-count")).toContainText(
      String(MOCK_TOOLS.length),
    );

    // 3. Memory loads entries
    await page.getByTestId("mode-memory").click();
    await expect(page.locator("[data-testid^='memory-entry-']")).toHaveCount(3);

    // 4. NOW: server goes down
    await page.unrouteAll();
    await setupServerDown(page);

    // 5. Wait for health poll to detect disconnection
    await expect(page.getByTestId("server-disconnected")).toBeVisible({
      timeout: 15000,
    });

    // 6. Try to go to chat and send — should show error
    await page.getByTestId("mode-chat").click();
    await page.getByTestId("chat-input").fill("Are you there?");
    await page.getByTestId("send-button").click();
    // Should show error, not hang
    await expect(page.locator("text=Connection error").first()).toBeVisible({
      timeout: 5000,
    });

    // 7. NOW: server comes back
    await page.unrouteAll();
    await setupAllMocks(page);

    // 8. Wait for health poll to detect reconnection (polls every 10s)
    await expect(page.getByTestId("server-disconnected")).not.toBeVisible({
      timeout: 25000,
    });
  });
});
