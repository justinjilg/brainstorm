---
version: 1
name: brainstorm
type: cli
language: typescript
framework: none
runtime: node
deploy: none (build/test only in CI)
build_command: "npm run build"
test_command: "npx vitest run"
entry_points:
  [
    "apps/desktop/electron/main.ts",
    "apps/desktop/electron/notarize.cjs",
    "apps/desktop/electron/preload.ts",
    "apps/desktop/playwright.config.ts",
    "apps/desktop/postcss.config.js",
  ]
routing:
  typical_complexity: expert
  budget_tier: premium
---

# brainstorm

## Stack

- **Language:** TypeScript
- **Frameworks:** Turborepo
- **Testing:** Vitest
- **Build:** Turborepo
- **Size:** 600 files, 91,048 lines, 93 modules

## Conventions

- **Naming:** variables=camelCase, files=kebab-case or camelCase, exports=named
- **Error handling:** Errors are handled gracefully with retries and fallbacks (e.g., spawning backend falls back to npx fallback). File system and IPC errors are logged but often don't crash the process. Errors are often caught silently and retried or logged for diagnostics. Complex tooling glues include safe reading and fallback attempts before reporting errors to the user.
- **Testing:** Testing is comprehensive with multiple levels, including integration and smoke tests. Tests are organized per package and per domain with dedicated **tests** folders and playwright end-to-end tests for desktop UI. There are various focused test files for agents, skills, workflows, CLI commands, and integration. Some tests include property-based testing using fast-check. Tests are run via turborepo pipelining with filters to exclude heavier packages.
- **Imports:** ESModule syntax with 'import' statements, often using named imports. Some legacy code or build scripts use CommonJS require. Imports often destructure from packages. Node.js native modules imported with full paths e.g., 'node:child_process'. Packages generally use explicit imports from sibling directories or scoped packages.
- **State management:** Frontend React components (desktop and CLI) use React state hooks (useState, useEffect) and functional components. State updates use setState pattern and exposure of state setter callbacks is controlled. Some CLI input and interactive terminal UI leverage ink with managed internal state. Complex UI components maintain local state, including async prompts and message streams.
- **API patterns:** Products expose a uniform 3-endpoint REST API contract: GET /health, GET /api/v1/god-mode/tools, POST /api/v1/god-mode/execute. This contract is consistent across all products for capability negotiation and command execution. Electron desktop uses IPC with JSON NDJSON line-based protocol to communicate between Electron main and backend CLI child process. Electron preload bridges IPC with a safe exposed API for renderer.
- Strict separation of frontend and backend with IPC in desktop app to isolate native module issues.
- Use of common prompt segment caching in system prompt building for AI prompt efficiency.
- All shell commands and file operations are mediated with sandbox and safety checks.
- CLI and AI tools always verify changes with build or syntax checks post-edit.
- Agent middleware and tool sequence detection enforce safety rules for tool chaining.
- Comprehensive logging with fallback to console if file logging fails.
- Retries and alternative approaches built into tool execution and AI tool usage.

## Domain Glossary

- **AI Operator:** An LLM or agent that interacts with the Brainstorm platform via CLI or APIs to perform tasks autonomously or semi-autonomously across multiple connected products and tools.
- **Product:** A deployable subsystem or application exposing a standardized API interface with health checks and God Mode tools. Examples include BrainstormMSP, BrainstormRouter, BrainstormGTM, BrainstormVM, and BrainstormShield.
- **Tool:** Individual capabilities or operations available to AI operators under the standardized platform contract. Tools represent discrete functionalities such as shell execution, file read/write, memory access, or network fetch.
- **System Prompt Segment:** A modular piece of the prompt sent to AI models. Segments are cacheable to optimize prompt generation and reuse stable prompt parts for efficiency.
- **Middleware Tool Sequence Detection:** Safety logic that detects dangerous sequences of tool calls (e.g., reading secrets followed by network requests) within a short trust window to prevent exploits or data exfiltration.
- **IPC Protocol:** A JSON line-delimited stdio communication protocol between the Electron main process and the AI backend CLI subprocess, allowing streaming events and commands across process boundaries.
- **Sandbox Level:** Configurable security zones for shell executions and other commands that control the restrictions applied (none, docker container, etc.) and output size limits.
- **KAIROS:** An orchestration subsystem or pipeline tool that can invoke multi-phase workflows, likely driven by the AI operator inside the desktop app (Navigator UI components reference it).
- **Verification Commands:** Commands run by the AI after modifying code files to verify build success or detect errors before proceeding, ensuring edits don’t break the project.
- **God Mode:** An elevated API capability exposing full tooling and operations through the standardized product API endpoints, designed for trusted AI operators managing the platform.

## Key Files

- `apps/desktop/electron/main.ts` — Manages the Electron main process and spawns the AI backend CLI subprocess for IPC communication.
- `apps/desktop/electron/preload.ts` — Preload script exposing a safe IPC API bridge to the Electron renderer process.
- `apps/desktop/electron/notarize.cjs` — Post-build script to notarize macOS Electron app using Apple App Store Connect APIs.
- `packages/core/src/agent/context.ts` — Defines AI agent system prompt composition and core behavioral guidelines.
- `packages/core/src/middleware/builtin/tool-sequence-detector.ts` — Middleware that detects unsafe sequences of tool calls to prevent multi-step attacks.
- `packages/tools/src/builtin/shell.ts` — Shell execution tool with sandboxing, output control, and background task management.
- `apps/desktop/tests/app.spec.ts` — End-to-end Playwright tests for the desktop UI components and basic workflows.
- `packages/cli/src/components/ChatApp.tsx` — React CLI component implementing a chat interface for user and AI interaction.
- `package.json` — Defines project metadata, scripts, dependencies, and workspace structure.
- `README.md` — Project overview and introduction for users and AI operators.

## AI Team

- **architect** (architect)
- **code-reviewer** (code-reviewer)
- **api-expert** (coder)
- **qa** (qa)
- **devops** (devops)
- **security-reviewer** (security-reviewer)
- **packages-tools-src-builtin-expert** (coder)
- **apps-web-src-components-company-expert** (coder)
- **packages-core-src-middleware-builtin-expert** (coder)

## Architecture

Brainstorm’s architecture centers around a modular, layered ecosystem that standardizes interactions across multiple AI-driven products and tools. At its core, the platform abstracts capabilities into well-defined **Products**, each implementing a uniform 3-endpoint REST API (health, tools discovery, and command execution). These products collectively expose the **God Mode** API surface, allowing trusted AI operators seamless access to discrete **Tools**. The standard API contract strongly decouples clients from specific implementations and supports safe orchestration of workflows.

The codebase employs a monorepo structure managed by Turborepo. Each product and major subsystem is contained in scoped packages under `packages/` and `apps/`, facilitating isolated builds and tests. For example, tools reside in `packages/tools/src`, core middleware lives inside `packages/core/src/middleware`, and UI components are located under `apps/web/src/components`. Interactions between frontend (React-based, including Electron desktop and CLI interfaces) and backend are strictly separated using a JSON NDJSON IPC protocol implemented at `electron/preload` and CLI child process boundaries to isolate native dependencies and enhance safety.

Key abstractions include the **AI Operator** which acts as an orchestrator agent, driving workflows by invoking tools through middleware layers enforcing security, sandbox policies (defined in the `sandbox` layers), and tool sequence safety checks. Prompt generation is optimized via composable, cacheable **System Prompt Segments**, reducing redundant AI context buildup. Verification commands run post-edit ensure reliability. The orchestration pipeline subsystem KAIROS enables complex multi-phase workflows invoked through the Navigator UI. Throughout, robust error handling, logging, retries, and fallback mechanisms maintain resilience in distributed, asynchronous command execution and interprocess communication.

## Gotchas

1. **Silent retries and error swallowing:** Errors often don’t crash processes but are retried or logged silently. This can hide root causes, so always check logs carefully when debugging failed actions. Avoid assuming a command failure means process crash.

2. **Strict frontend-backend IPC isolation:** Native module issues are isolated in the Electron backend CLI subprocess. Do not try to import native Node.js modules directly into React renderer code or preload scripts beyond the safe exposed IPC API to avoid runtime crashes.

3. **Prompt segment caching:** The modular system prompt design uses caching extensively. Modifications to prompt construction logic require careful cache invalidation; otherwise, outdated or incorrect prompt segments might be used, leading to unexpected AI responses.

4. **Middleware tool sequence detection:** The platform employs security rules that detect suspicious sequences of tool calls within a short "trust window" to prevent sensitive data leaks. Designing workflows that perform sensitive reads followed immediately by network calls will trigger rejections, so separate phases must be carefully orchestrated.

5. **File and shell sandboxing:** All file and shell operations run under configurable sandbox levels with output size limits. Developers should avoid large, unbounded outputs or unrestricted shell commands, as these violate policies and may fail silently or cause truncated logs.

6. **Test filtering in Turborepo:** Heavy integration and end-to-end tests are excluded by default via test filters for performance. To run comprehensive tests, explicitly include or adjust filters to cover product-specific or critical integration test suites.

7. **Codegen and legacy imports mix:** While ESModules are standard, some legacy code, build scripts, or autogenerated files still use CommonJS require statements. Mixing these without attention to module interop can cause mysterious runtime errors.

## Anti-Patterns

1. **Direct native imports in renderer:** Importing Node native modules directly into React frontend or preload script bypasses strict IPC isolation and causes frequent crashes. Always funnel native calls through backend CLI subprocess IPC APIs.

2. **Bypassing tool sequence safety checks:** Attempting to circumvent middleware tool chaining rules or disabling sequence detection undermines security and data leakage protections. Instead, design workflows adhering to trust windows and enforced protocols.

3. **Ignoring verification commands post-edit:** Skipping build/syntax verification after code changes leads to cascading failures and unstable tool executions. Verification commands are mandatory to maintain project integrity post-modification.

4. **Logging without fallbacks or throttling:** Omitting fallback logging mechanisms and writing overly verbose logs to disk causes invisible failures or bloated log files. Use comprehensive logging with console fallback and consider throttling or log rotation.

5. **Stateful UI components leaking async state:** Complex UI components mixing multiple async prompts and message streams must avoid uncontrolled state updates or exposing setters externally, which leads to race conditions and stale UI. Encapsulate state and manage async effects carefully.
