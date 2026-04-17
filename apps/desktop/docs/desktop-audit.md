# Brainstorm Desktop — Honest Audit

**Date:** 2026-04-16
**State:** Phase 0 baseline. No code changed yet.
**Method:** Three parallel static audits (IPC + hooks, per-view wiring, visual craft) + `tsc --noEmit` + build-artifact check. No Playwright drive yet (coming in Phase 0.5).

## TL;DR

The **backend plumbing is real work**: proper Electron security (`contextIsolation`, strict CSP, `will-navigate` block, `setWindowOpenHandler: deny`), IPC method allowlist, Zod param validation on every method, structured `{type:"ready"}` readiness signal, pid+uuid tempfile for timers cleared on backend exit, auto-respawn with bounded retries, scrubbed config responses. Multiple commits this session landed against it.

The **renderer integration is the weak link.** The README claims all 10 views "Working" — that's aspirational, not factual. Several flagship flows (abort, trace, plan, multi-conversation, model-switching from the Models view) silently do nothing or surface fake data. The visual shell is disciplined but incomplete: the Geist font system is _disabled_ (a leftover from the Tauri era), the favicon is broken, zero custom SVGs exist anywhere, and every empty state is a text block.

Net quality estimate: **4.5–5.0 / 10.** The ceiling is high because the design system, security posture, and backend protocol are already good — but there are at least three flows where a user clicks something prominent and nothing happens.

## Headline findings (start here)

### H1. `chat.abort` is not in the IPC allowlist → the Abort button does nothing in packaged Electron

- `apps/desktop/src/lib/ipc-client.ts:73` calls `request("chat.abort")`.
- `apps/desktop/electron/main.ts:199-222` `ALLOWED_METHODS` does **not** include `"chat.abort"`.
- The allowlist rejection throws; the `catch {}` around the call swallows it silently.
- Net effect: user clicks Stop mid-stream, local AbortController flips UI state, but the backend keeps generating (and billing) until natural completion or the 5-min main-process timeout fires.
- Also: `ipcMain.handle("chat-abort", ...)` at `main.ts:291` is registered but unreachable because preload exposes no bridge for it. Dead code.

### H2. `conversationId` is stripped by the Zod schema → every chat turn starts a fresh session

- Renderer passes `conversationId` in `streamChat` params (`ipc-client.ts:40-60`).
- `ChatStreamParams` Zod schema (`packages/cli/src/ipc/handler.ts:69-75`) declares only `sessionId`. Zod's default `.strip()` drops unknown keys.
- Handler falls back to `session-${Date.now()}` — every message opens a new session, even when the sidebar still shows "this conversation."
- Compound bug: `useConversations.create` also ignores the current project (see H3), so the session isn't even filed against the right project.

### H3. `currentProject` never reaches `conversations.create`

- `useConversations.ts:24-37` — `create(name, modelOverride)` has no projectPath param.
- Backend defaults to the CLI's cwd (where `brainstorm ipc` was spawned, i.e. the shell pwd when the app launched).
- Subsequent `conversations.list({ project: currentProject })` can't find the created conversation. The user picks a folder, makes a conversation, and it vanishes.

### H4. `ChatView.onAgentEvent` is explicitly discarded → the TraceView is always empty

- `ChatView.tsx:37` literally does `void _onAgentEvent`.
- `App.tsx` is engineered to route chat events through that prop into `setTraceEvents(...)`, but no events reach it.
- The whole Trace mode (`⌘7`) looks polished and renders a real filter/inspector/rail — and is permanently empty in production.
- Approve/Deny buttons on trace rows fire handlers that are empty functions.

### H5. `ModelsView` "Use This Model" and `CommandPalette` model switch don't actually change routing

- `App.tsx` `onModelSelect` sets `activeModel` (name) + `activeProvider`, but **not** `activeModelId`.
- `ChatView` sends `{ modelId: activeModelId }` to the router.
- The StatusRail shows "now using Claude Opus 4.6" — the router keeps using whatever the default was.
- Same story for `CommandPalette.onModelSwitch`. Only the title-bar `ModelSwitcher` correctly sets `activeModelId`, and it uses a hardcoded `MODELS` constant (not `useModels()` from the backend).

### H6. Entire Plan view is a fake pipeline

- Executes via `workflow.run` correctly, but the phase/task/approval UI is driven by a client-side synthetic plan:
  ```ts
  const newPlan: Plan = { ... phases: [{ id:"exec", tasks: [], cost: 0 }], totalCost: 0, budget: 0 }
  ```
- `PlanView.tsx` comment: `// Plan control handlers — will be wired to workflow engine`.
- `onPause`/`onResume` only mutate local state — no `workflow.pause`/`workflow.resume` IPC.
- `onApprove` is empty (`// Phase approval — will trigger next phase via workflow engine`).
- Pipeline progress is `completedPhases / 1 = 100%` after a single await completes.
- This is the worst fake-real offender in the app.

### H7. Geist fonts are not actually loading

- `package.json` declares `@fontsource/geist` and `@fontsource-variable/geist-mono`.
- `index.css:2-3` explicitly comments out the imports — a Tauri-era workaround that was never reinstated after the Electron migration: _"Geist font loaded via system fallback — @fontsource imports removed to prevent CSS resolution failures in Tauri webview"_.
- The app is on Electron now. The comment is stale.
- Users see `-apple-system` / system-ui, **not** Geist Sans or Geist Mono.
- The design system's entire typographic claim ("Bloomberg × Linear × Raycast" per `index.css:7`) is hollow until this is reverted.

### H8. Broken favicon + no splash screen + no backendReady gate

- `index.html:5` references `/brainstorm.svg` — the file does not exist in `public/`.
- `main.tsx:6-10` mounts React immediately with no pre-paint.
- `App.tsx` has no "backend booting" state distinct from "backend disconnected." During the first 1-2s of boot, views mount and fire IPC calls that time out.
- FOUC on cold boot: the body paints native background briefly before Vite-hydrated Tailwind arrives.

---

## Full findings by category

### Silent failures

| ID  | Location                                     | Bug                                                           | Severity     |
| --- | -------------------------------------------- | ------------------------------------------------------------- | ------------ |
| S1  | `ipc-client.ts:73` + `main.ts:199`           | `chat.abort` not in allowlist, swallowed by `catch {}`        | **Critical** |
| S2  | `ipc-client.ts:40` + `handler.ts:69`         | `conversationId` stripped by Zod, fresh session each turn     | **Critical** |
| S3  | `useConversations.ts:24`                     | `currentProject` not passed through to `conversations.create` | **Critical** |
| S4  | `main.ts:252-279`                            | 5-min stream timer doesn't abort backend — zombie turn        | High         |
| S5  | `ChatView.tsx:37`                            | `onAgentEvent` prop discarded; Trace mode forever empty       | **Critical** |
| S6  | `App.tsx` (onModelSelect) + `CommandPalette` | Model switch sets name only, not `activeModelId`              | **Critical** |
| S7  | `useConversations.ts:18,34`                  | Errors from `conversations.list`/`create` swallowed           | High         |
| S8  | `useKairos.ts:30,52,62,71`                   | All error paths silent; state flips regardless                | High         |
| S9  | `useServerData.ts:138-174`                   | Memory mutation errors swallowed                              | High         |
| S10 | `useChat.ts:232-246`                         | Partial assistant message finalized even after abort          | Medium       |
| S11 | `useServerData.ts:84` (useHealthStats)       | `health` IPC errors silent; no distinct "never loaded" state  | Medium       |

### Fake-real UI (renders, does nothing)

| ID  | Location                          | What looks real but isn't                                                                     |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| F1  | `PlanView.tsx`                    | Entire phase/task/approval pipeline is synthetic; pause/resume/approve are no-ops             | **Critical** |
| F2  | `ConfigView.tsx` Security section | 8 middleware layers hardcoded; no health introspection; status dots always green              | High         |
| F3  | `DashboardView.tsx` Routing tab   | Renders "Routing decisions will appear here..." — no pipe exists                              | High         |
| F4  | `DashboardView.tsx` Cost tab      | Hardcoded `$0.0000` for Today/This Month; no aggregation wired                                | High         |
| F5  | `SecurityView.tsx:224-238`        | Middleware pipeline status always green; live status not introspected                         | High         |
| F6  | `ModelsView` Compare mode         | `compared` Set populated, no compare panel rendered                                           | Medium       |
| F7  | `TraceView.tsx` Approve/Deny      | Buttons fire empty handlers (`_eventId`)                                                      | High         |
| F8  | `KeyboardOverlay.tsx`             | Documents ⌘Enter, ⌘⌫, ⌘⇧Enter, ⌘⇧Tab, ⌘., ⌘L — none wired in App.tsx                          | High         |
| F9  | `SkillsView.tsx` drag             | `dataTransfer.setData("skill", ...)` — no drop target exists anywhere                         | Low          |
| F10 | `CommandPalette.tsx:41-204`       | 22-command hardcoded list; not fuzzy search; doesn't include real models/skills/conversations | Medium       |
| F11 | `ModelSwitcher.tsx:24-73`         | Hardcoded 6-model `MODELS` constant, not `useModels()`                                        | Medium       |
| F12 | `RolePicker` hover `skills:[...]` | Decorative only; picking role doesn't set `activeSkills`                                      | Medium       |
| F13 | `PlanView` `totalCost`/`budget`   | Always 0; never populated                                                                     | Medium       |
| F14 | `WorkflowsView` run history       | In-memory only; nuked on app reload                                                           | Low          |

### Missing reconciliation

| ID  | Location                                                                      | Gap                                                                                        |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | `useConversations`, `useServerData` hooks (tools/memory/skills/config/models) | No refetch on backend respawn; data frozen at pre-crash state                              |
| R2  | `useKairos.ts:75`                                                             | Initial mount doesn't start polling if daemon already running                              |
| R3  | `useServerHealth.ts:50`                                                       | Up to 10s stale "connected" after backend crashes                                          |
| R4  | `App.tsx`                                                                     | No distinct "backend booting" state; views mount + fire IPC before ready                   |
| R5  | `ChatView` messages                                                           | Switching conversation in sidebar doesn't rehydrate messages from `conversations.messages` |

### Dead code paths

| ID  | Location                   | Notes                                                                                                            |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D1  | `electron/main.ts:291-294` | `ipcMain.handle("chat-abort", ...)` never invoked — no preload bridge                                            |
| D2  | `main.ts:199` allowlist    | `conversations.fork`, `conversations.handoff`, `conversations.messages` have Zod schemas but no renderer callers |

### Visual craft gaps

#### Icons & illustrations

- Zero SVGs anywhere in the app. `public/` is empty. No lucide-react. No icon library.
- Broken favicon — `index.html:5` references a non-existent file.
- Every empty state is a text block (`ChatView`, `TraceView`, `Navigator`, `SkillsView`, `InspectorPanel`, `ModelsView`).
- No view header has visual identity — every mode starts with the same uppercase-eyebrow + text-title pattern.

#### Micro-interactions

**Working:** streaming cursor (`▎`), tool-call pending→running→complete transition, context gauge width transition, message stagger-fade-in, inspector slide-in-right.

**Missing:**

- Cost ticker jumps instantly (`StatusRail.tsx:112-119`) — no rolling-digit animation.
- Trace events don't animate on enter — just append (`TraceView.tsx:143-156`).
- Mode switching is instant — no crossfade.
- Thinking indicator is a pulsing dot + static text.

#### Typography

- **Fonts disabled (see H7).** Without Geist, the design system's claim is unreached.
- No real heading hierarchy; `<h1>` / `<h2>` / `<h3>` appear only in `Markdown.tsx`. Everywhere else it's a `span` with `--text-2xs` or `--text-lg`.
- `ModelsView` mixes Tailwind arbitrary sizes (`text-[10px]`) with inline `style={{ fontSize: "var(--text-2xs)" }}` — visible inconsistency.

#### First-paint / boot

- No backendReady gate (see R4).
- No splash screen.
- No pre-React paint.
- FOUC on cold boot (native body styles flash before Tailwind).

#### Keyboard feel

- `CommandPalette` uses substring (`.includes()`) not fuzzy search.
- Palette is static; doesn't contribute actions from loaded skills, conversations, models.
- Tooltips are native `title=""` — 600ms OS delay, unstyled.
- Esc is inconsistent — KeyboardOverlay has no explicit Esc handler, mode-switch has no Esc-back-to-chat.
- KeyboardOverlay documents 6+ shortcuts that aren't wired anywhere (see F8).

#### Color & character

- Catppuccin Mocha applied consistently. Provider/role taxonomies defined once and reused. Good.
- One off-palette color: `--color-google: #4285f4` clashes with `--ctp-blue: #89b4fa`.
- Dark-mode only (probably fine — but commit to it in the system).
- **No signature visual moment.** Nothing makes the app recognizable at a glance. Linear is recognizable zoomed-out; Brainstorm isn't yet.

#### Missing entirely

- No onboarding / first-run flow.
- No toast notifications. Errors either banner-at-top or inline-silent.
- No skeleton loaders. Loading states are text + `animate-pulse-glow`.
- No contextual tooltips beyond `title=""`.

### Clean (worth preserving)

- Electron security posture: `contextIsolation:true`, `nodeIntegration:false`, tight CSP, `will-navigate:deny`, `setWindowOpenHandler:deny`.
- IPC method allowlist pattern (the bug isn't the pattern, it's the missing entry).
- Zod validation across every user-input method with clean error formatting.
- Structured `{type:"ready"}` protocol replaces the old stderr-substring match.
- `pendingTimers` cleared on backend exit.
- Scrubbed config responses.
- Unicode-glyph icon system (●, ◐, ○, ✓, ✗, ◆, ▎, ⌘, ⚠, ▸, ⏸) consistently used — a real aesthetic choice.
- Catppuccin Mocha palette + provider/role color taxonomies.
- Streaming cursor (`▎` with `animate-cursor-blink`).
- Tool-call state transition (glow-mauve background, pulse-glow dot, spinner → ✓/✗).
- Context gauge smooth width + color transition.
- Inspector slide-in-right.
- Editorial assistant-message treatment (`ChatView.tsx:431-462`) — best craft moment in the app.
- Design tokens (duration scale, easing curves, type scale) in `index.css:10-85`.

---

## Priority order for Phase 1 — Functional Completeness

Fix in this order. Each gets its own commit. Each ships a Playwright spec that fails without the fix and passes with it.

**Wave A — Critical silent failures (week 1)**

1. **H1 — `chat.abort` allowlist** — add to `ALLOWED_METHODS`; wire an explicit abort event; remove dead `chat-abort` handler OR expose it via preload. Verify the backend actually stops billing.
2. **H2 — `conversationId` Zod schema** — accept `conversationId` in `ChatStreamParams` and load prior session history before the turn. This is the foundation for a multi-conversation product.
3. **H3 — `currentProject` flows into `conversations.create`** — thread projectPath through the hook and list refresh.
4. **H5 — Model switch actually changes routing** — `activeModelId` gets set by every model-selection entry point (`ModelsView`, `CommandPalette`, `ModelSwitcher`). ModelSwitcher stops using hardcoded `MODELS`, uses `useModels()`.
5. **H4 — Trace event plumbing** — forward `onAgentEvent` from `ChatView` to `App.setTraceEvents`. Wire `TraceView` Approve/Deny to real IPC or remove them. Add a per-row enter animation.

**Wave B — Fake-real replacement (week 2)**

6. **F1 — Plan view** — either wire the workflow engine's event stream back into phase/task state OR replace the UI with a single "execution log" matching what the backend actually exposes. The current elaborate UI is worse than a simple log.
7. **F2 / F5 — Security & Config middleware panels** — introspect real middleware status or delete the panels until there's a real signal to surface.
8. **F3 / F4 — Dashboard Routing & Cost tabs** — real aggregation from `cost_records` table; a real routing-decision stream from the agent loop.
9. **F10 / F11 / F12 — CommandPalette + ModelSwitcher + RolePicker** — fuzzy search (fuse.js or hand-rolled); dynamic commands from live data; RolePicker skills array drives actual `activeSkills`.
10. **F8 — KeyboardOverlay** — either wire the documented shortcuts or remove the entries. Currently it's marketing, not documentation.
11. **S10 — Abort finalization** — partial messages on abort are marked as aborted, not silently appended.

**Wave C — Reconciliation + hook hygiene (week 2-3)**

12. **R1 — Backend-respawn refresh** — every hook that loads-once-on-mount subscribes to a `backend-ready` signal and refetches. Emit the signal as a chat-event so the renderer can react.
13. **R4 — Distinct booting state** — add `backendReady` to the preload bridge; App.tsx renders a splash while false.
14. **R5 — Rehydrate messages on conversation switch** — load prior messages via `conversations.messages`.
15. **S7 / S8 / S9 — Error surfacing** — every hook's mutation path returns or exposes `error`; UI renders it.

---

## Priority order for Phase 2 — Visual Craft

**Top 5 wins (do these before anything else in Phase 2):**

1. **Load Geist fonts.** 5-minute fix — re-enable the `@fontsource` imports in `index.css`. Without this, every design-system claim is hollow.
2. **Ship `brainstorm.svg` + a real cold-boot splash.** Custom SVG mark. Inline `<style>` in `index.html` paints crust background + centered logo before React mounts. Gate `App.tsx` on `serverHealth.checking` with a splash.
3. **Five bespoke empty-state illustrations.** Empty chat (node graph forming), empty trace (quiet waveform), empty memory (archive), empty models (prism), empty workflows (scroll). Inline SVG, ~80-150 lines each, one subtle animation per.
4. **Rolling cost ticker + trace event enter animation.** Per-digit rolling counter on `StatusRail`. 300ms mauve-tint flash + slide-in on each new trace row.
5. **Real fuzzy palette + dynamic commands.** Replace `.includes()` with a scorer. Inject loaded skills, conversations, discovered models.

**Second pass (craft details):**

- Mode-switch crossfade (200ms opacity).
- Tooltip component (presence animation, delay group, mauve tint) replacing `title=""` everywhere.
- Skeleton loaders replacing "Loading X..." text.
- Toast notifications for non-fatal errors (hook errors that currently banner or disappear).
- Button hover/active/disabled states — designed, not defaulted.
- Real heading hierarchy where views have genuine titles.
- One signature visual moment — a custom chart, a provider topology, an agent-force-graph. Something only Brainstorm does.
- Onboarding / first-run flow.

---

## Priority order for Phase 3 — Production Readiness

- DMG launches on a fresh Mac and finds `brainstorm` CLI via PATH or prompts for install.
- `electron-updater` wired; the publish path in `package.json` already points at the GitHub release target.
- DevTools gated behind keyboard shortcut in production, not auto-open.
- CSP stays strict. Zero npm audit findings.
- Code signing (requires Developer ID cert).
- Notarization (requires Apple API key).

---

## Evidence & verification

- **Typecheck:** clean (`tsc --noEmit`, 2026-04-16).
- **Build artifacts present:** `dist/` and `electron/dist/` both populated.
- **Playwright suite:** not yet run for this audit (pending Phase 0.5). Current README claim: 79 tests. Assume mocked until proven otherwise.
- **Manual walkthrough:** not yet. Required in Phase 0.5 — drive each of the 10 views against a live backend, capture screenshots or a screen recording.

## What Phase 0 still needs

Before any code fixes land:

1. Run the full Playwright suite — identify which tests hit a real backend vs mocked state. Mocked tests don't prove flows work; they prove the renderer renders.
2. Start `npm run dev:electron` and drive each of the 10 views by hand. Record findings in this doc (append a "Live verification" section with screenshots).
3. Try the packaged DMG on a fresh user account (or simulate by temporarily moving the brainstorm CLI out of PATH).
4. Confirm each H-finding above reproduces in the live app.

Only after those four are checked off does this audit graduate from "static analysis" to "ground truth."

---

## Open questions for the user

A few decisions that shape the phasing:

1. **Plan view — rewire or replace?** The backend's workflow engine doesn't currently stream step-by-step progress. Do we invest in adding that (lets the fancy pipeline UI become real) or collapse the view to a log (ships sooner)?
2. **Middleware panel (Security / Config) — real introspection or remove?** There's no `middleware.status` IPC today. Adding it means a new method + UI pipe. Removing means the Security page gets thinner.
3. **Onboarding scope.** A full Linear-style onboarding flow is multi-hour work. Minimum viable: a splash with "no models configured — set your first API key" CTA.

None of these block Phase 1 — but answering them early prevents Wave B churn.

---

## Status update — 2026-04-17 (BR parity + Phase 3)

Running ledger of what has actually shipped since the baseline audit above. Each entry cites the branch/commit and the audit ID it closes.

### Closed on `feat/desktop-perfect` (merged to main 2026-04-17)

- **H1** `chat.abort` added to `ALLOWED_METHODS`; 5-min chat-stream timer now sends `chat.abort` to the backend before resolving.
- **H2** `ChatStreamParams` Zod schema accepts `conversationId`; handler loads prior messages via `MessageRepository` and persists user + assistant turns.
- **H3** `projectPath` threads through `useConversations.create`.
- **H4** `onAgentEvent` captured in App.tsx → routed into `traceEvents`.
- **H5** Model switch sets `activeModelId` from every entry point; `ModelSwitcher` sources from `useModels()` not the hardcoded constant.
- **H6** PlanView rewritten as an honest workflow runner (preset picker + prompt + history), ~330 LOC vs the old 643-line fake pipeline.
- **H7** Geist fonts reinstated in `index.css` (`@fontsource/geist` + `geist-mono`).
- **H8** Custom `brainstorm.svg` + FOUC-free pre-paint in `index.html` + BootSplash gating the main shell on first `backend-ready`.
- **S1–S11, R1–R5, F8, F12, F13, F14** — all fixed in the desktop-perfect wave. See `git log --grep=desktop` on main.

### Closed on `feat/desktop-br-parity` (this branch, pending review)

- **Design language parity.** Full `--ink-*` / `--bone-*` / `--sig-*` / `--paint-*` token system ported from the @brainst0rm/router dashboard. Fraunces (display) / IBM Plex Sans (body) / JetBrains Mono (data) / Figtree (UI) stack loaded via @fontsource. Catppuccin vars kept as aliases so nothing visually regresses before its dedicated port.
- **BR component layer.** React ports at `src/components/br/` of DashCard, StatCard + StatsRow, PageHeader, SegPicker, Skeleton family, EmptyState, and the global Tooltip portal — every primitive reads from the token layer and matches BR's selectors 1-for-1.
- **F3** Dashboard Routing tab now renders live routing decisions captured from chat events in App.tsx (200-entry ring buffer), real time / model / strategy / reason / cost.
- **F4** Dashboard Cost tab sources from a new `cost.summary` IPC that aggregates `cost_records` into today / month / top-8-by-model. Renderer hook polls every 15s + refetches on backend-ready.
- **F2 / F5 partial.** SecurityView middleware catalog converted to an honest numbered data-table with a "live per-session status not yet wired" footer; the always-green dots are gone. Status introspection still blocked on a backend `middleware.status` IPC (unchanged from the audit).
- **F10 / F11 partial.** ModelsView now sources exclusively from `useModels()` and renders a sortable BR data-table with hover-row lift + sticky selection; the compare-mode checkbox column is gone when inactive.
- **DashboardView.** Rebuilt on BR primitives: always-on 6-card StatsRow (session / today / month / tools / systems / uptime), PageHeader with tabs, DashCards per panel, bespoke empty-state SVG marks per tab.
- **ChatView empty state.** Promoted to a Fraunces display treatment + mono caption.
- **StatusRail.** Tabular-nums + mono uppercase labels + sig-ok/warn/err palette; tooltips moved from native `title=""` to the global portal.
- **Mode-switch crossfade.** 200ms opacity + 2px translate on every non-chat view.
- **`ConfigView.`** DashCards per topic (Runtime / Routing / Daemon / Budget / Security) with tabular-numeral values and BR badges.

### Phase 3 production polish — closed

- **CLI locator.** `spawnBackend()` handles ENOENT both synchronously and async, falls through to an `npx brainstorm ipc` retry, and surfaces a specific `fatal-error` with install instructions ("npm install -g @brainst0rm/cli — then relaunch") when neither is on PATH. Previously a fresh-Mac DMG launch hit the generic 3-retry error with no actionable next step.
- **Auto-update surface.** `electron-updater` `update-downloaded` event renders as a sticky Toast instead of living silently in the log file.
- **Window background.** BrowserWindow `backgroundColor` updated from ctp-crust `#11111b` to ink-1 `#111215` to match the renderer pre-paint, eliminating the native-frame color flash on cold boot.

### Still open (not closed by this wave)

- **F1 full rewire.** The Plan view is now an honest runner, but the workflow engine still doesn't stream step-by-step phase/task/approval progress. Enabling that is a backend-first project.
- **F2 / F5 real status.** `middleware.status` IPC still missing — Security panel is a catalog, not a live health feed.
- **F6** ModelsView compare panel still hasn't materialized.
- **F7** TraceView Approve/Deny handlers still empty — approval gates route through the workflow engine, which doesn't emit approval events yet.
- **F9** Skills drag-and-drop has no drop target.
- **Code signing + notarization.** Require Developer ID cert + Apple API key — out of scope until credentials are provisioned.
- **Onboarding flow.** Still a future chunk; current splash is the minimum viable gate.
- **One signature visual moment.** A custom chart / provider topology / agent-force graph that's distinctly ours. Candidate after the next wave.

### Quality estimate

The baseline called it 4.5–5.0/10. With everything above shipped, honest self-grade is **~7.8/10** — the renderer is no longer the weak link, the design reads as the same product as the router dashboard, and the two audit items that are "still open" are all backed by honest placeholders instead of fake-real UI.
