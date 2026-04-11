---
version: 1
name: brainstorm
type: cli
language: typescript
framework: none
runtime: node
deploy: npm (packages), electron (desktop application)
build_command: "npm run build"
test_command: "npx vitest run"
entry_points:
  [
    "analyze_deps.py",
    "apps/cli/src/index.ts",
    "apps/desktop/electron/main.ts",
    "apps/desktop/electron/notarize.cjs",
    "apps/desktop/electron/preload.ts",
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
- **Size:** 671 files, 103,643 lines, 110 modules

## Conventions

- **Naming:** variables=camelCase (JS/TS), snake_case (Python), SCREAMING_SNAKE_CASE (constants), files=kebab-case (JS/TS), PascalCase (React components, Electron preload/main), snake_case (Python), exports=named, default, and barrel exports are all used
- **Error handling:** Uses try...catch blocks for I/O and external calls. CLI commands (`apps/cli/src/index.ts`) use console.error and process.exit(1) for critical errors, and console.warn for non-critical issues. Desktop app uses logToFile for structured logging. Core agent logic incorporates 'Self-Correction' where tool failures trigger alternative approaches before reporting to the user.
- **Testing:** Unit and integration tests across packages use Vitest, located in `__tests__` directories. End-to-end (E2E) tests for the desktop application use Playwright (`apps/desktop/tests/app.spec.ts`). CI includes a 'Wiring smoke test' (`ci-wiring-check.mjs`) to verify core functionality.
- **Imports:** A mix of named (`import { X } from 'Y';`), namespace (`import * as Z from 'W';`), and default imports (`import pkg from 'electron-updater';`). Relative imports are used for internal modules, and absolute path imports with `@brainst0rm/` prefixes for monorepo packages.
- **State management:** Not explicitly visible within the provided snippets, but inter-process communication (IPC) via Electron's `ipcRenderer.invoke` and `ipcMain.on` is a core mechanism for data flow and action dispatch between the renderer and main processes in the desktop application.
- **API patterns:** External 'products' adhere to a standardized REST-like API contract: `GET /health`, `GET /api/v1/god-mode/tools`, `POST /api/v1/god-mode/execute`. The desktop application communicates with its backend via an RPC-like pattern over Electron IPC and uses an NDJSON stdio protocol (MCP) for communication with a spawned `brainstorm ipc` child process.
- Structured logging with `createLogger` from `@brainst0rm/shared`.
- Strict TypeScript configuration enforced via `tsconfig.base.json`.
- Turborepo (`turbo run`) is used for monorepo task orchestration (build, test, dev).
- Changesets are used for versioning and publishing packages.
- Prettier and lint-staged are configured for code formatting and linting on commit via Husky pre-commit hooks.
- System prompt segments are used for AI agent context, with cacheable segments indicated for providers like Anthropic.
- Shell tool includes explicit Git safety checks (`checkGitSafety`) and sandbox enforcement.

## Domain Glossary

- **Brainstorm:** The overarching project; a 'Governed control plane for AI-managed infrastructure' that connects AI operators to product ecosystems via a standardized protocol, ensuring safety, cost management, and audit trails. It manifests as a CLI and a desktop application.
- **AI Operators:** External AI models (e.g., Claude Code, Claude Desktop) that interact with Brainstorm's infrastructure by invoking its exposed tools and services through a governed channel.
- **MCP (Model Context Protocol):** A standardized NDJSON stdio protocol used for non-interactive communication between Brainstorm (specifically the `brainstorm ipc` subprocess) and AI operators, providing direct access to connected products and tools.
- **Tools:** Individual functionalities or actions that AI operators can invoke. These are defined within Brainstorm packages (e.g., `@brainst0rm/tools`) and exposed via the MCP or God Mode API. Examples include `shell`, `file_read`, `file_write`.
- **Products:** Specific services or applications within the Brainstorm ecosystem (e.g., BrainstormMSP, BrainstormRouter) that implement a standard API contract (`/health`, `/api/v1/god-mode/tools`, `/api/v1/god-mode/execute`) to expose their capabilities to AI operators.
- **God Mode:** A privileged set of APIs and tools offered by Brainstorm products, designed for AI operators to execute actions on the infrastructure. It signifies powerful capabilities that require careful governance and auditing.
- **Turborepo:** The monorepo management framework used to organize and optimize the development, building, testing, and deployment of multiple packages and applications within the Brainstorm project.
- **Workspace Context:** The active project directory or environment that tools and AI agents operate within. It is crucial for resolving file paths, enforcing sandboxing, and ensuring operations are confined to the intended scope.
- **Sandbox:** A security mechanism, implemented for tools like `shell`, that restricts the execution environment. It can operate at different levels ('none', 'container') to prevent unauthorized or malicious actions by AI agents.
- **System Prompt Segments:** Components of the overall system prompt provided to AI models. These segments, some of which are marked as cacheable, define the agent's core behaviors, communication style, tool usage, auto-verification, self-correction, and safety guidelines.
- **Tool Sequence Anomaly Detector:** A middleware component designed to detect and block dangerous multi-step attack patterns by analyzing sequences of tool calls. It flags patterns like sensitive data reads followed by outbound network calls, especially when the 'trust window' is compromised.
- **Build State Tracker:** A component used by AI agents to parse and track the output of build and test commands. This enables the agent to verify its code changes, read error messages, and self-correct when issues are introduced.

## Key Files

- `analyze_deps.py` — Dependency analysis for monorepo packages
- `apps/cli/src/index.ts` — Main entry point for the Brainstorm CLI
- `apps/desktop/electron/main.ts` — Electron main process for the desktop app
- `apps/desktop/electron/preload.ts` — Secure IPC bridge for Electron renderer process
- `package.json` — Root monorepo configuration and scripts
- `tsconfig.base.json` — Base TypeScript configuration for all packages
- `turbo.json` — Turborepo task runner configuration
- `.github/workflows/ci.yml` — Continuous Integration workflow definition
- `README.md` — Project overview and AI operator guide
- `packages/tools/src/builtin/shell.ts` — AI agent shell execution tool with safety features
- `packages/core/src/agent/context.ts` — System prompt generation for AI agents
- `packages/core/src/middleware/builtin/tool-sequence-detector.ts` — Security middleware for detecting tool sequence anomalies
- `apps/desktop/tests/app.spec.ts` — Playwright end-to-end tests for desktop UI

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

Brainstorm operates as a comprehensive TypeScript monorepo managed by Turborepo, structured into `apps/` for deployable applications (like `apps/cli` and `apps/desktop`) and `packages/` for reusable libraries and tools (e.g., `@brainst0rm/tools`, `@brainst0rm/core`, `@brainst0rm/shared`). This architecture establishes a clear separation of concerns, allowing core functionalities to be developed and tested independently before being consumed by various interfaces. The primary design philosophy centers on providing a secure, predictable, and auditable control plane for AI operators interacting with infrastructure.

The core data flow begins with external AI Operators (e.g., Claude Code) making requests. These requests interface with Brainstorm either through a standardized REST-like "God Mode" API for products or via the Model Context Protocol (MCP), an NDJSON stdio protocol used by the `brainstorm ipc` subprocess. The desktop application, `apps/desktop`, uses Electron's Inter-Process Communication (IPC) via `ipcRenderer.invoke` and `ipcMain.on` to facilitate data flow and action dispatch between its renderer and main processes, effectively acting as an RPC-like layer.

Key abstractions like `Tools` (e.g., `shell`, `file_read`, `file_write` defined in `packages/tools/src/builtin`) encapsulate specific infrastructure interactions, ensuring they are governed and auditable. `packages/core` provides fundamental middleware and logic, while `packages/shared` houses common utilities such as `createLogger` for structured logging. The entire system is underpinned by `tsconfig.base.json` for strict TypeScript enforcement and `turbo.json` for task orchestration, ensuring a consistent and robust development environment. This modular approach allows for rapid development of new tools and products while maintaining strict control over AI agent capabilities.

## Gotchas

1.  **Mixed Naming Conventions**: The project uses various naming conventions depending on the context. TypeScript/JavaScript variables are `camelCase`, files are `kebab-case`, but React components are `PascalCase`. Python files and variables use `snake_case`, and all constants use `SCREAMING_SNAKE_CASE`. Always check the language/framework context before naming to ensure consistency.
2.  **Diverse Error Handling**: Error handling varies significantly by application. CLI commands (`apps/cli/src/index.ts`) use `console.error` and `process.exit(1)` for critical failures. The desktop app leverages `logToFile` for structured logging. Critically, core agent logic incorporates a 'Self-Correction' mechanism: tool failures should trigger alternative approaches before immediately reporting an error. Do not exit prematurely in agent logic; explore self-correction.
3.  **Monorepo Module Imports**: For imports between packages within the monorepo, always use absolute path imports with the `@brainst0rm/` prefix (e.g., `import { X } from '@brainst0rm/core';`). Avoid relative imports (`../../packages/core/src/x`) across package boundaries, as these can break Turborepo's dependency graph and hinder refactoring. Relative imports are only for modules _within_ the same package.
4.  **Electron IPC is Primary for Desktop**: Data flow and action dispatch in the `apps/desktop` application _must_ primarily utilize Electron's `ipcRenderer.invoke` and `ipcMain.on`. Do not attempt to directly import modules or share state across the renderer and main processes outside of this established IPC pattern, as it will lead to unexpected behavior and security vulnerabilities.
5.  **Sandbox and Workspace Context**: When developing or using tools, always be mindful of the `Workspace Context` and `Sandbox` enforcement. Tools like `shell` include explicit `checkGitSafety` and can operate in different sandbox levels ('none', 'container'). Do not bypass these checks or assume unrestricted access; operations are confined to the intended scope and governed by security policies.
6.  **Tool Sequence Anomaly Detector**: Be aware that the system actively monitors and can block dangerous sequences of tool calls, such as a `file_read` on sensitive data immediately followed by an outbound network call, especially when the 'trust window' is compromised. Design tool interactions to be inherently safe and avoid patterns that might be flagged as anomalous or malicious.

## Anti-Patterns

1.  **Bypassing Governed APIs/Tools**: Directly interacting with infrastructure (e.g., making raw file system calls, executing shell commands without explicit tools) outside of the established God Mode API or defined `Tools` (like `file_read`, `shell`). _Why:_ This defeats the core purpose of Brainstorm as a "governed control plane," eliminates auditability, bypasses critical safety controls, and creates significant security vulnerabilities that AI operators could exploit. Always use the provided, audited tool ecosystem.
2.  **Ignoring Self-Correction or Localized Error Handling**: Prematurely throwing an error or reporting a failure to the user within agent logic when a self-correction mechanism is in place, or without logging contextually (e.g., `logToFile` for desktop). _Why:_ This hinders the AI agent's autonomy, prevents it from recovering from transient issues, and can lead to a less resilient system that requires more human intervention. Leverage the built-in error handling and self-correction strategies for the specific component you are working on.
3.  **Hardcoding AI System Prompts**: Embedding verbose, unstructured system prompts directly into the application code without utilizing the `System Prompt Segments` infrastructure. _Why:_ This makes prompt management cumbersome, prevents the use of cacheable segments for providers like Anthropic, and complicates global updates to agent behavior, communication style, or safety guidelines. Utilize the structured segment system for AI context management.
4.  **Undocumented or Non-Standard API Contracts for New Products**: Creating new external "products" that do not adhere to the standardized REST-like API contract (`GET /health`, `GET /api/v1/god-mode/tools`, `POST /api/v1/god-mode/execute`). _Why:_ This breaks interoperability with Brainstorm's AI operators, complicates integration, and undermines the platform's value proposition of providing a standardized protocol for AI-managed infrastructure. New products must follow the specified API contract.
