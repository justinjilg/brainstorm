# Phase Plan: Bridge the Claude Code Parity Gap

## Vision

Brainstorm is at 63/100 parity with Claude Code. It already wins on routing (97), cost tracking, multi-provider, eval, and workflow. The gaps are in tools & execution (49), developer experience (53), extensibility (59), and advanced features (28). This plan closes the highest-impact gaps to reach ~80/100 parity.

## Current Parity Scorecard

| Category | Score | After Plan |
|----------|-------|------------|
| Intelligence & Routing | 97 | 97 |
| Context & Memory | 76 | 85 |
| Core Engine | 70 | 82 |
| Security & Permissions | 69 | 75 |
| Extensibility | 59 | 70 |
| Developer Experience | 53 | 72 |
| Tools & Execution | 49 | 68 |
| Advanced Features | 28 | 45 |
| **Overall** | **63** | **~74** |

---

## 20-PR Plan

### Phase 7: Git Safety & Integration (PRs 1-4)

#### PR #1 — Git safety protocol

**Why first:** Git operations are the highest-risk tool category. Every other CLI coding assistant has guardrails here. Without them, Brainstorm can destroy work.

**Files to create:**
- `packages/tools/src/builtin/git-safety.ts` — Safety layer wrapping all git tool executions

**Files to modify:**
- `packages/tools/src/builtin/git-commit.ts` — Integrate safety checks before commit
- `packages/tools/src/registry.ts` — Register safety hooks on git tools

**Safety rules to enforce:**
```typescript
interface GitSafetyRules {
  neverForceMain: true;        // Block git push --force to main/master
  neverSkipHooks: true;        // Block --no-verify, --no-gpg-sign
  preferNewCommits: true;      // Warn on --amend, suggest new commit
  smartStaging: true;          // Never git add -A; stage specific files
  blockSecrets: true;          // Scan staged files for credentials before commit
  confirmDestructive: true;    // Require permission for reset --hard, checkout --, clean -f
}
```

**Build:** `npx turbo run build --filter=@brainstorm/tools`

**Verify:** Attempt `git push --force origin main` via shell tool — should be blocked with explanation.

---

#### PR #2 — Smart git commit with message generation

**Why here:** Builds on PR #1 safety. Users expect the AI to write good commit messages.

**Files to modify:**
- `packages/tools/src/builtin/git-commit.ts` — Replace raw commit with smart commit flow

**Smart commit flow:**
1. `git status` — check staged vs unstaged
2. `git diff --cached` — analyze staged changes
3. `git log --oneline -5` — match existing commit message style
4. Generate commit message (what + why, not just what)
5. Scan staged files for credentials (via secret-scanner)
6. Stage specific files (never `git add -A`)
7. Commit with generated message + `Co-Authored-By` attribution

**Build:** `npx turbo run build --filter=@brainstorm/tools`

**Verify:** Stage a file change, run git-commit tool — should produce a contextual commit message matching repo style.

---

#### PR #3 — GitHub CLI integration (PR creation)

**Why here:** PR creation is the second most-used git workflow after commits. Requires gh CLI.

**Files to create:**
- `packages/tools/src/builtin/gh-pr.ts` — Tool: create/list/view PRs via gh CLI
- `packages/tools/src/builtin/gh-issue.ts` — Tool: create/list/view issues via gh CLI

**gh-pr tool flow:**
1. `git log main..HEAD` — understand all commits on branch
2. `git diff main...HEAD` — understand full change scope
3. Generate PR title (< 70 chars) + body (summary bullets + test plan)
4. `gh pr create --title "..." --body "..."`
5. Return PR URL

**Files to modify:**
- `packages/tools/src/registry.ts` — Register gh-pr and gh-issue tools
- `packages/shared/src/types.ts` — Add tool names to ToolName union

**Build:** `npx turbo run build --filter=@brainstorm/tools`

**Verify:** On a feature branch with commits, run gh-pr tool — should create a well-formatted PR.

---

#### PR #4 — Branch management tools

**Files to create:**
- `packages/tools/src/builtin/git-branch.ts` — Tool: create/switch/delete branches
- `packages/tools/src/builtin/git-stash.ts` — Tool: stash/pop/list

**Files to modify:**
- `packages/tools/src/registry.ts` — Register new tools

**Safety integration:**
- Branch delete: require confirmation, never delete main/master
- Branch switch: warn if uncommitted changes, suggest stash

**Build:** `npx turbo run build --filter=@brainstorm/tools`

**Verify:** Create a branch, switch to it, make changes, stash, switch back — all via tools.

---

### Phase 8: Developer Experience (PRs 5-9)

#### PR #5 — Built-in slash commands

**Why here:** Slash commands are the primary DX differentiator. Users expect /model, /clear, /help.

**Files to create:**
- `packages/cli/src/commands/slash.ts` — Slash command registry and dispatcher

**Commands to implement:**
```
/model [name]    — Switch model (e.g., /model opus, /model sonnet, /model ollama:qwen2.5)
/fast            — Toggle cost-first routing
/clear           — Clear conversation history
/compact         — Trigger context compaction now
/help            — Show available commands
/cost            — Show session cost so far
/mode [auto|confirm|plan] — Switch permission mode
/budget          — Show remaining budget
```

**Files to modify:**
- `packages/cli/src/components/ChatApp.tsx` — Detect `/` prefix in input, route to slash handler
- `packages/core/src/agent/loop.ts` — Export mode/model switching functions

**Build:** `npx turbo run build --filter=@brainstorm/cli`

**Verify:** In chat, type `/model sonnet` — should switch model and confirm. Type `/cost` — should show session spend.

---

#### PR #6 — TUI status bar

**Why here:** Users lose track of what model they're on, how much they've spent, and what mode they're in.

**Files to create:**
- `packages/cli/src/components/StatusBar.tsx` — Ink component: `[mode] | model | tokens | cost | session`

**Display format:**
```
 auto │ claude-sonnet-4.6 │ 12.4k tokens │ $0.03 │ session-abc
```

**Files to modify:**
- `packages/cli/src/components/ChatApp.tsx` — Render StatusBar at bottom of TUI
- `packages/core/src/agent/loop.ts` — Emit token/cost events for StatusBar consumption

**Build:** `npx turbo run build --filter=@brainstorm/cli`

**Verify:** Start chat, send a message — status bar shows model name, token count updates in real-time, cost accumulates.

---

#### PR #7 — Keybinding system

**Files to create:**
- `packages/cli/src/keybindings.ts` — Keybinding registry with defaults

**Default keybindings:**
```
Ctrl+C     — Interrupt current operation (abort)
Ctrl+D     — Exit Brainstorm
Shift+Tab  — Cycle permission mode (auto → confirm → plan)
Ctrl+L     — Clear screen
Ctrl+K     — Clear conversation (/clear)
Up/Down    — Input history navigation
```

**Files to modify:**
- `packages/cli/src/components/ChatApp.tsx` — Wire keybindings to Ink useInput hook

**Build:** `npx turbo run build --filter=@brainstorm/cli`

**Verify:** Press Shift+Tab — mode cycles in status bar. Press Ctrl+L — screen clears.

---

#### PR #8 — Output style modes

**Files to create:**
- `packages/core/src/agent/output-styles.ts` — Style definitions and system prompt segments

**Styles:**
```typescript
type OutputStyle = 'concise' | 'detailed' | 'learning';

// concise: Default. Short answers, no explanations unless asked.
// detailed: Longer explanations, reasoning shown.
// learning: Includes ★ Insight annotations, explains trade-offs.
```

**Files to modify:**
- `packages/core/src/agent/context.ts` — Inject style instructions into system prompt
- `packages/config/src/schema.ts` — Add `outputStyle` to config schema
- `packages/cli/src/commands/slash.ts` — Add `/style [name]` slash command

**Build:** `npx turbo run build --filter=@brainstorm/core --filter=@brainstorm/cli`

**Verify:** `/style learning` then ask a coding question — response should include ★ Insight annotations.

---

#### PR #9 — Input history and markdown rendering

**Files to modify:**
- `packages/cli/src/components/ChatApp.tsx` — Add input history (up/down arrows cycle previous inputs)
- `packages/cli/src/components/MessageView.tsx` — Basic markdown rendering (bold, code blocks, headers, lists)

**Input history:**
- Store last 100 inputs in memory
- Persist to `~/.brainstorm/input-history.json` (last 500)
- Up arrow recalls previous, Down arrow goes forward

**Markdown rendering:**
- `` `code` `` → dimmed/highlighted
- `**bold**` → bold
- `# Header` → bold + underline
- ``` ```code blocks``` ``` → boxed with syntax hint
- `- list items` → indented with bullet

**Build:** `npx turbo run build --filter=@brainstorm/cli`

**Verify:** Send multiple messages, press Up — previous input appears. Model response with code blocks renders with visual distinction.

---

### Phase 9: Subagent System (PRs 10-13)

#### PR #10 — Specialized subagent types

**Why here:** Subagents are how Claude Code parallelizes complex work. Brainstorm's subagent is a thin wrapper.

**Files to modify:**
- `packages/core/src/agent/subagent.ts` — Add subagent type system

**Subagent types:**
```typescript
type SubagentType = 'explore' | 'plan' | 'code' | 'review' | 'general';

// explore: Read-only tools (glob, grep, file_read, git_log). Fast, cheap.
// plan: Read-only + task tools. Designs implementation approaches.
// code: Full tool access. Writes and verifies code.
// review: Read-only + git tools. Reviews changes for bugs.
// general: All tools. Default.
```

**Each type gets:**
- Tool filter (which tools available)
- System prompt segment (behavioral instructions for the role)
- Default model hint (explore → cheap model, code → capable model)

**Build:** `npx turbo run build --filter=@brainstorm/core`

**Verify:** Spawn an `explore` subagent — should only have read tools. Spawn a `code` subagent — should have full tools.

---

#### PR #11 — Parallel subagent execution

**Files to modify:**
- `packages/core/src/agent/subagent.ts` — Add `spawnParallel(specs[])` that runs multiple subagents concurrently

**Implementation:**
```typescript
async function spawnParallel(specs: SubagentSpec[]): Promise<SubagentResult[]> {
  return Promise.all(specs.map(spec => spawnSubagent(spec)));
}
```

**Files to modify:**
- `packages/tools/src/builtin/` — Add `subagent` tool that the model can call with type + prompt
- `packages/core/src/agent/loop.ts` — Handle parallel subagent tool calls

**Build:** `npx turbo run build --filter=@brainstorm/core --filter=@brainstorm/tools`

**Verify:** Ask "search for X in three different directories" — model spawns 3 explore subagents in parallel, results aggregated.

---

#### PR #12 — Subagent budget isolation

**Files to modify:**
- `packages/router/src/cost-tracker.ts` — Add per-subagent budget tracking
- `packages/core/src/agent/subagent.ts` — Pass budget limit to subagent context

**Budget rules:**
- Each subagent gets a budget slice (default: parent budget / 4)
- Subagent cost counted against parent session
- If subagent exceeds budget, it's terminated (not the parent)

**Build:** `npx turbo run build --filter=@brainstorm/router --filter=@brainstorm/core`

**Verify:** Spawn a subagent with $0.01 budget, give it an expensive task — should terminate at budget limit.

---

#### PR #13 — Subagent hook events

**Files to modify:**
- `packages/hooks/src/manager.ts` — Add `SubagentStop` event, `SubagentStart` event
- `packages/core/src/agent/subagent.ts` — Emit hook events on subagent lifecycle

**Events:**
```typescript
SubagentStart: { type: SubagentType, prompt: string, budget: number }
SubagentStop:  { type: SubagentType, result: string, cost: number, toolCalls: number }
```

**Build:** `npx turbo run build --filter=@brainstorm/hooks --filter=@brainstorm/core`

**Verify:** Register a PostToolUse hook on SubagentStop, spawn a subagent — hook fires with result summary.

---

### Phase 10: Advanced Context (PRs 14-17)

#### PR #14 — Hierarchical BRAINSTORM.md loading

**Why here:** Claude Code loads CLAUDE.md from every directory in the path. This gives per-directory conventions.

**Files to modify:**
- `packages/core/src/agent/context.ts` — Walk up from cwd to project root, collect all BRAINSTORM.md files

**Loading order:**
```
~/.brainstorm/BRAINSTORM.md        (global — user preferences)
/project/BRAINSTORM.md             (project root)
/project/packages/core/BRAINSTORM.md  (package-level)
/project/packages/core/src/BRAINSTORM.md  (directory-level)
```

**Merge strategy:** Concatenate all found files, with directory-level overriding project-level on conflicts (later = higher priority).

**Build:** `npx turbo run build --filter=@brainstorm/core`

**Verify:** Create a BRAINSTORM.md in a subdirectory with "Always use arrow functions in this directory." Edit a file in that directory — model should follow the convention.

---

#### PR #15 — Structured context compression

**Files to modify:**
- `packages/core/src/session/compaction.ts` — Preserve structured content during compaction

**Preservation rules:**
1. **Always keep:** File paths mentioned, tool results that changed files, error messages, user decisions
2. **Summarize:** Explanations, reasoning, verbose tool outputs
3. **Drop:** Duplicate file reads, superseded edits, intermediate search results

**Implementation:**
```typescript
function classifyMessage(msg: Message): 'keep' | 'summarize' | 'drop' {
  if (msg.role === 'tool' && msg.toolName === 'file_edit') return 'keep';
  if (msg.role === 'tool' && msg.toolName === 'grep' && wasSuperseded(msg)) return 'drop';
  if (msg.role === 'assistant' && msg.content.length > 2000) return 'summarize';
  return 'keep';
}
```

**Build:** `npx turbo run build --filter=@brainstorm/core`

**Verify:** In a long session, trigger compaction — verify that file edit results are preserved but verbose grep outputs are dropped.

---

#### PR #16 — Extended thinking/reasoning block support

**Files to modify:**
- `packages/core/src/agent/loop.ts` — Detect and yield `reasoning` events from models that support thinking blocks
- `packages/cli/src/components/MessageView.tsx` — Render thinking blocks (collapsible, dimmed)

**AI SDK integration:**
```typescript
// In the stream handler:
if (event.type === 'reasoning') {
  yield { type: 'reasoning', content: event.content };
}
```

**TUI rendering:**
```
▸ Thinking... (click to expand)
  I need to check if the function exists first, then understand
  the parameter types before modifying the signature...
```

**Build:** `npx turbo run build --filter=@brainstorm/core --filter=@brainstorm/cli`

**Verify:** Use a model that supports thinking (Claude with extended thinking), observe reasoning blocks appear in TUI.

---

#### PR #17 — PDF parsing

**Files to modify:**
- `packages/core/src/multimodal/reader.ts` — Replace PDF stub with actual text extraction
- `package.json` (root) — Add `pdf-parse` dependency (or `pdfjs-dist`)

**Implementation:**
```typescript
async function readPdf(filePath: string, pages?: string): Promise<string> {
  const pdfParse = await import('pdf-parse');
  const buffer = readFileSync(filePath);
  const data = await pdfParse.default(buffer);
  // If pages specified, extract only those pages
  return data.text;
}
```

**Build:** `npx turbo run build --filter=@brainstorm/core`

**Verify:** `@document.pdf` in chat — should inject PDF text content into conversation.

---

### Phase 11: Security & Advanced Execution (PRs 18-20)

#### PR #18 — Persistent permission allowlists

**Files to modify:**
- `packages/core/src/permissions/manager.ts` — Persist "always allow" decisions to config file
- `packages/config/src/schema.ts` — Add `permissions.allowlist` to config schema

**Storage:**
```toml
# ~/.brainstorm/config.toml
[permissions]
allowlist = [
  "file_read",
  "glob",
  "grep",
  "git_status",
  "git_diff",
  "git_log",
]
denylist = [
  "shell:rm -rf *",
  "shell:git push --force",
]
```

**Build:** `npx turbo run build --filter=@brainstorm/core --filter=@brainstorm/config`

**Verify:** Allow `file_read` once with "always" — restart session, `file_read` should be auto-allowed.

---

#### PR #19 — Shell sandbox mode

**Files to create:**
- `packages/tools/src/builtin/sandbox.ts` — Sandboxed shell execution environment

**Sandbox levels:**
```typescript
type SandboxLevel = 'none' | 'restricted' | 'container';

// none: Current behavior (full access)
// restricted: Block dangerous commands (rm -rf /, sudo, etc.), limit to project dir
// container: Run in Docker container (if available) — full isolation
```

**Restricted mode blocklist:**
- `rm -rf /`, `sudo`, `chmod 777`, `mkfs`, `dd if=`, `:(){ :|:& };:`
- Any command writing outside project directory
- Network access commands (curl to non-localhost, wget)

**Files to modify:**
- `packages/tools/src/builtin/shell.ts` — Check sandbox level before execution
- `packages/config/src/schema.ts` — Add `security.sandbox` to config

**Build:** `npx turbo run build --filter=@brainstorm/tools --filter=@brainstorm/config`

**Verify:** Set sandbox to `restricted`, try `rm -rf /` — should be blocked with explanation.

---

#### PR #20 — Background shell execution

**Files to modify:**
- `packages/tools/src/builtin/shell.ts` — Add `background: true` option to shell tool
- `packages/core/src/agent/loop.ts` — Handle background task completion notifications

**Implementation:**
```typescript
// In shell tool execute:
if (input.background) {
  const proc = spawn(command, { detached: true });
  backgroundTasks.set(taskId, proc);
  return { taskId, status: 'running', message: 'Running in background. You will be notified on completion.' };
}
```

**Notification system:**
- Background process completes → emit `BackgroundComplete` event
- Agent loop picks up event → injects result into conversation
- TUI shows notification: `[bg] Task abc completed (exit 0)`

**Build:** `npx turbo run build --filter=@brainstorm/tools --filter=@brainstorm/core`

**Verify:** Run `npm test` in background, continue chatting — notification appears when tests finish.

---

## Execution Order

| PR | Package(s) | Dependency | Est. Lines |
|----|-----------|------------|------------|
| 1 | tools | None | ~150 |
| 2 | tools | PR 1 | ~200 |
| 3 | tools, shared | PR 1 | ~250 |
| 4 | tools | PR 1 | ~150 |
| 5 | cli, core | None (parallel with 1-4) | ~200 |
| 6 | cli | PR 5 | ~120 |
| 7 | cli | PR 5 | ~100 |
| 8 | core, config, cli | PR 5 | ~150 |
| 9 | cli | PR 6 | ~200 |
| 10 | core | None (parallel with 5-9) | ~200 |
| 11 | core, tools | PR 10 | ~150 |
| 12 | router, core | PR 11 | ~100 |
| 13 | hooks, core | PR 10 | ~80 |
| 14 | core | None (parallel with 10-13) | ~120 |
| 15 | core | PR 14 | ~150 |
| 16 | core, cli | None | ~100 |
| 17 | core | None | ~80 |
| 18 | core, config | None | ~100 |
| 19 | tools, config | PR 1 | ~200 |
| 20 | tools, core | PR 19 | ~150 |

**Total: ~2,950 lines across 20 PRs**

**Critical path:** PRs 1→2→3 (git safety → smart commit → PR creation)
**Parallel tracks:**
- PRs 5→6→7→8→9 (DX — slash commands → status bar → keybindings → styles → history)
- PRs 10→11→12→13 (subagents — types → parallel → budget → hooks)
- PRs 14→15 (context — hierarchical → compression)
- PRs 16, 17 (standalone — thinking blocks, PDF parsing)
- PRs 18→19→20 (security — permissions → sandbox → background)

## Verification

After each PR:
1. `npx turbo run build` — all packages compile
2. `npx turbo run test` — all tests pass
3. Manual test: `node packages/cli/dist/brainstorm.js chat` — interactive session
4. PR-specific verification (listed in each PR's Verify section)
