# Autonomous QA Plan — Playwright Tests for Every Desktop App Interaction

## Context

Features have been declared "working" based on code analysis (grep for empty handlers, trace prop chains) but NOT verified in the actual WebKit runtime. `alert()` doesn't work in WebKit. `process.env` crashes the webview. Font imports fail silently. Code that compiles is not code that works.

The fix: **Playwright tests that launch the Vite dev server, open a headless browser, and click every single button.** The desktop app is just a web app on localhost:1420 during development. Playwright can test all of it.

## Approach

1. Add `data-testid` attributes to every interactive element
2. Install Playwright with WebKit (matches Tauri's webview engine)
3. Write a test for EVERY interactive element — 50+ tests
4. Run headless, fix every failure
5. Only declare ✅ when Playwright has clicked it and verified the DOM changed

## Test Coverage (50+ tests across all views)

### Navigator (7 tests)

- Project selector expand/collapse
- Mode tabs switch workspace (spot check 3 modes)
- Add agent → card appears
- Remove agent → card disappears
- Search bar → palette opens
- New conversation → appears in list
- KAIROS widget → config mode

### Status Rail (4 tests)

- Strategy cycles through values
- Role picker opens
- Model switcher opens
- Permission mode cycles

### Command Palette (7 tests)

- Opens on Cmd+K
- Filters on typing
- Arrow navigation
- Command execution (mode switch)
- Model switch updates chip
- Role switch updates badge
- Closes on Escape

### Chat (5 tests)

- Empty state renders with action cards
- Action card "Models" switches mode
- Action card "Commands" opens palette
- Input accepts text
- Send button state (disabled when empty, enabled when text)

### Overlays (5 tests)

- RolePicker: open, select, close
- ModelSwitcher: open, filter, select
- KeyboardOverlay: open, close

### Dashboard (3 tests)

- Tab switching
- Tool category expand
- Real tool count from server

### Models (3 tests)

- Select model → detail shows
- Use This Model → mode switches
- Compare mode toggles

### Memory (4 tests)

- Tier filter
- Entry select
- Create form toggle
- Promote/quarantine buttons exist and are clickable

### Skills (3 tests)

- Skills load (not empty)
- Toggle checkbox
- Select shows detail

### Security (2 tests)

- Run Red Team button clickable
- Middleware pipeline renders 8 layers

### Workflows (3 tests)

- Node expand/collapse
- New Workflow shows hint banner
- Hint dismisses

### Inspector (2 tests)

- Cmd+D toggles panel
- Panel shows context label

### Drag and Drop (3 tests)

- Agent card is draggable
- Skill row is draggable
- Drop skill on agent → skill added

## Implementation Steps

### Step 1: Add data-testid attributes to every interactive element

Files to modify:

- `src/App.tsx` — mode container
- `src/components/navigator/Navigator.tsx` — project selector, mode tabs, search, KAIROS
- `src/components/navigator/TeamBuilder.tsx` — add agent button, agent cards, NL input
- `src/components/navigator/ProjectSelector.tsx` — expand button, open folder
- `src/components/chat/ChatView.tsx` — empty state cards, input, send/stop buttons
- `src/components/status-rail/StatusRail.tsx` — role, model, strategy, permission, cost, context, KAIROS
- `src/components/CommandPalette.tsx` — search input, command rows
- `src/components/RolePicker.tsx` — role buttons, clear button
- `src/components/ModelSwitcher.tsx` — search input, model rows
- `src/components/KeyboardOverlay.tsx` — backdrop
- `src/components/dashboard/DashboardView.tsx` — tabs, tool categories
- `src/components/models/ModelsView.tsx` — model rows, detail, Use This Model, compare
- `src/components/memory/MemoryView.tsx` — tier filters, entries, create form, actions
- `src/components/skills/SkillsView.tsx` — skill rows, toggles
- `src/components/security/SecurityView.tsx` — Run Red Team button, layers
- `src/components/workflows/WorkflowsView.tsx` — nodes, New Workflow, hint banner
- `src/components/inspector/InspectorPanel.tsx` — close button, context label

### Step 2: Install Playwright

```bash
cd apps/desktop
npm install -D @playwright/test
npx playwright install webkit
```

### Step 3: Configure Playwright

Create `apps/desktop/playwright.config.ts`:

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 10000,
  use: {
    baseURL: "http://localhost:1420",
    browserName: "webkit", // Matches Tauri's WebKit webview
  },
  webServer: {
    command: "npx vite --port 1420",
    port: 1420,
    reuseExistingServer: true,
  },
});
```

### Step 4: Write test suite

Create `apps/desktop/tests/app.spec.ts` with all 50+ tests.

### Step 5: Run and fix

```bash
cd apps/desktop
npx playwright test
```

Fix every failure. Re-run until 100% pass.

### Step 6: Only then declare features working

## Server Dependencies for Full Testing

Some tests require BrainstormServer on port 3100:

- Dashboard tool count
- Memory CRUD
- Skills list
- Security red team

For tests that need the server: either mock fetch responses or ensure server is running.
For tests that don't need the server: pure UI interactions work standalone.

## What This Proves

When all 50+ Playwright tests pass on WebKit:

- Every button clicks and produces visible results
- Every state change re-renders correctly
- Every overlay opens and closes
- Every form accepts input
- Every drag-drop handler fires
- Nothing silently fails in WebKit
- No `process.env`, `alert()`, or import resolution issues

This is the bar. No green checkmarks without passing tests.
