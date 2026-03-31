# Developer Tools Inventory — Brainstorm Workspace

> Complete catalog of every developer tool, service, and productivity platform used across all 14+ projects in the Brainstorm workspace (`~/Projects/`).
>
> Last updated: 2026-03-31

---

## Summary

- **~130+ distinct tools/services** across 14 projects
- Heaviest tool density: **brainstormrouter** (most modern stack), **brainstormmsp** (most complex)
- Primary patterns: TypeScript + Python polyglot, Turborepo monorepos, DO App Platform + Vercel hosting

---

## 1. Package Managers & Build Systems

| Tool                      | Used In                                                                                                     | Purpose                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **npm** (v10.x)           | brainstorm, brainstormmsp, peer10, eventflow, brainstormhive, cramtime, ourbooknook, brainstormVM/dashboard | Primary JS package manager                   |
| **pnpm** (v10.23)         | brainstormrouter, saguaro-blossom-yoga                                                                      | Workspace-aware package manager              |
| **uv**                    | mirofish, brainstormLLM                                                                                     | Fast Python package manager (replaces pip)   |
| **pip**                   | brainstormmsp, brainstorm-gtm                                                                               | Python packages (legacy)                     |
| **Go modules**            | brainstormmsp/edge, brainstormVM, brainstorm-security-stack                                                 | Go dependency management                     |
| **Swift Package Manager** | peer10, eventflow (iOS apps)                                                                                | Swift dependencies                           |
| **Turborepo**             | brainstorm, peer10, eventflow, platform-gold                                                                | Monorepo task orchestration + remote caching |
| **tsup**                  | brainstorm (all packages)                                                                                   | TypeScript library bundler                   |
| **tsdown**                | brainstormrouter                                                                                            | Next-gen bundler (replaces tsup)             |
| **Vite**                  | brainstormrouter/dashboard, mirofish/frontend, brainstormmsp/edge/desktop                                   | Dev server + frontend bundler                |
| **Rolldown** (rc)         | brainstormrouter                                                                                            | Rust-based bundler (devDep)                  |
| **Buf CLI**               | brainstormVM                                                                                                | Protobuf schema management                   |
| **tsx**                   | Most JS/TS projects                                                                                         | Runtime TypeScript execution                 |
| **concurrently**          | mirofish                                                                                                    | Parallel process runner                      |

---

## 2. CI/CD & Deployment

### CI Platforms

| Tool               | Used In                                      | Purpose         |
| ------------------ | -------------------------------------------- | --------------- |
| **GitHub Actions** | brainstormmsp, BrainstormOps, brainstorm-gtm | CI/CD pipelines |

### Hosting & Deployment

| Tool                          | Used In                                          | Purpose                  |
| ----------------------------- | ------------------------------------------------ | ------------------------ |
| **DigitalOcean App Platform** | brainstormmsp, peer10, eventflow, brainstorm-gtm | Primary hosting (4 apps) |
| **Vercel**                    | brainstormrouter, brainstormhive, cramtime       | Frontend/SaaS hosting    |
| **Fly.io**                    | brainstormrouter                                 | Edge-deployed API        |
| **Render**                    | brainstormrouter                                 | Backup deployment target |
| **DO Droplet**                | openclaw (167.99.12.153)                         | Dedicated server         |
| **GHCR**                      | brainstorm-gtm                                   | Container registry       |

### Infrastructure as Code

| Tool          | Used In                      | Purpose                     |
| ------------- | ---------------------------- | --------------------------- |
| **Terraform** | BrainstormOps                | IaC for DO, Cloudflare, AWS |
| **doctl**     | BrainstormOps, brainstormmsp | DigitalOcean CLI            |

### Containers

| Tool                        | Used In                                                                                               | Purpose            |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------ |
| **Docker / Docker Compose** | brainstormrouter, peer10, eventflow, mirofish, brainstorm-gtm, openclaw, platform-gold, brainstormmsp | Containerization   |
| **Podman**                  | brainstormrouter                                                                                      | Docker alternative |

### Mobile Deployment

| Tool                  | Used In       | Purpose                          |
| --------------------- | ------------- | -------------------------------- |
| **Fastlane**          | peer10 mobile | iOS build/test/deploy automation |
| **App Store Connect** | peer10 mobile | iOS distribution                 |

---

## 3. Testing

### JS/TS

| Tool                    | Used In                                                                                             | Purpose                         |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Vitest**              | brainstorm, brainstormrouter (6 configs), peer10, eventflow, platform-gold, brainstorm-gtm/frontend | Primary test runner             |
| **Jest** (v29)          | brainstormmsp/frontend                                                                              | Legacy test runner              |
| **Playwright**          | brainstormmsp, peer10, eventflow, platform-gold, peer10-web                                         | E2E browser testing             |
| **@vitest/coverage-v8** | Most TS projects                                                                                    | Code coverage                   |
| **Storybook 8**         | peer10, eventflow, platform-gold                                                                    | Component visual testing + docs |
| **axe-core/playwright** | peer10, eventflow, platform-gold                                                                    | Accessibility testing           |

### Python

| Tool               | Used In                                               | Purpose                |
| ------------------ | ----------------------------------------------------- | ---------------------- |
| **pytest**         | brainstormmsp (6500+ tests), brainstorm-gtm, mirofish | Python test runner     |
| **pytest-asyncio** | brainstormmsp, brainstorm-gtm, mirofish               | Async test support     |
| **pytest-cov**     | brainstormmsp                                         | Coverage               |
| **Hypothesis**     | brainstormmsp                                         | Property-based testing |
| **mutmut**         | brainstormmsp                                         | Mutation testing       |

### Go

| Tool        | Used In                          | Purpose             |
| ----------- | -------------------------------- | ------------------- |
| **go test** | brainstormmsp/edge, brainstormVM | Standard Go testing |

### Coverage Reporting

| Tool        | Used In       | Purpose                               |
| ----------- | ------------- | ------------------------------------- |
| **Codecov** | brainstormmsp | Coverage aggregation (via GH Actions) |

---

## 4. Linting, Formatting & Code Quality

### JS/TS

| Tool                    | Used In                                                                 | Purpose                 |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------- |
| **oxlint** (type-aware) | brainstormrouter                                                        | Rust-based JS/TS linter |
| **oxfmt**               | brainstormrouter                                                        | Rust-based formatter    |
| **ESLint** (v8/v9)      | brainstormmsp, peer10, eventflow, brainstormhive, cramtime, ourbooknook | JS/TS linting           |
| **Prettier**            | brainstorm, peer10, eventflow, platform-gold                            | Code formatting         |

### Python

| Tool       | Used In       | Purpose                        |
| ---------- | ------------- | ------------------------------ |
| **Ruff**   | brainstormLLM | Fast Python linter + formatter |
| **Black**  | brainstormCLI | Python formatter               |
| **isort**  | brainstormCLI | Import sorting                 |
| **flake8** | brainstormCLI | Python linter                  |
| **mypy**   | brainstormCLI | Static type checking           |

### Swift

| Tool            | Used In       | Purpose          |
| --------------- | ------------- | ---------------- |
| **SwiftLint**   | peer10 mobile | Swift linting    |
| **SwiftFormat** | peer10 mobile | Swift formatting |

### Other

| Tool                  | Used In          | Purpose                   |
| --------------------- | ---------------- | ------------------------- |
| **ShellCheck**        | brainstormrouter | Shell script linting      |
| **actionlint**        | brainstormrouter | GitHub Actions validation |
| **zizmor**            | brainstormrouter | GH Actions security audit |
| **markdownlint-cli2** | brainstormrouter | Docs linting              |

### Git Hooks

| Tool                              | Used In                                      | Purpose                   |
| --------------------------------- | -------------------------------------------- | ------------------------- |
| **Husky**                         | brainstorm, peer10, eventflow, platform-gold | Git hook manager          |
| **lint-staged**                   | brainstorm, peer10, eventflow, platform-gold | Pre-commit file linting   |
| **pre-commit** (Python framework) | brainstormrouter, brainstormCLI              | Multi-language pre-commit |
| **detect-secrets** (Yelp)         | brainstormrouter                             | Secret leak prevention    |

---

## 5. Databases & Data Layer

### Databases

| Tool                        | Used In                                 | Purpose                     |
| --------------------------- | --------------------------------------- | --------------------------- |
| **PostgreSQL** (DO Managed) | All major projects                      | Primary relational database |
| **SQLite**                  | brainstorm (local), brainstormmsp (dev) | Local/embedded database     |
| **Redis**                   | brainstormrouter                        | Caching + job queues        |
| **Neo4j**                   | mirofish                                | Graph database              |
| **Neon** (serverless PG)    | cramtime, ourbooknook                   | Serverless Postgres         |
| **Supabase**                | peer10, eventflow, brainstormmsp        | Auth only (not data)        |

### ORMs & Query Builders

| Tool                          | Used In                                                    | Purpose                      |
| ----------------------------- | ---------------------------------------------------------- | ---------------------------- |
| **Drizzle ORM + drizzle-kit** | brainstormrouter, peer10, eventflow, cramtime, ourbooknook | TS ORM + migrations + Studio |
| **SQLAlchemy + Alembic**      | brainstorm-gtm                                             | Python ORM + migrations      |
| **better-sqlite3**            | brainstorm                                                 | SQLite driver                |

### Vector Search

| Tool           | Used In                                                  | Purpose              |
| -------------- | -------------------------------------------------------- | -------------------- |
| **pgvector**   | brainstormmsp, brainstorm-gtm, brainstorm-security-stack | PG vector extension  |
| **sqlite-vec** | brainstormrouter                                         | SQLite vector search |

### Admin

| Tool               | Used In              | Purpose           |
| ------------------ | -------------------- | ----------------- |
| **Drizzle Studio** | All Drizzle projects | Visual DB browser |

---

## 6. Secret Management & Security

| Tool                       | Used In                          | Purpose                                 |
| -------------------------- | -------------------------------- | --------------------------------------- |
| **1Password CLI (`op`)**   | All projects                     | Primary secret store — vault "Dev Keys" |
| **GitHub Secrets**         | All CI/CD                        | CI secret injection                     |
| **detect-secrets** (Yelp)  | brainstormrouter                 | Baseline secret scanning                |
| **AES-256-GCM + Argon2id** | brainstorm/vault                 | Local encrypted key store               |
| **pqcrypto (ML-DSA-65)**   | brainstormmsp                    | Post-quantum crypto                     |
| **Open Policy Agent**      | brainstormmsp/edge, brainstormVM | Policy enforcement                      |
| **pikepdf**                | brainstormmsp                    | AES-256 PDF encryption                  |

---

## 7. AI / ML SDKs & Infrastructure

### Provider SDKs

| Tool                     | Used In                                                       | Purpose                                      |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------- |
| **Vercel AI SDK v6**     | brainstorm                                                    | Core AI framework (streamText, Agent, tools) |
| **Anthropic SDK**        | peer10, eventflow, brainstormmsp, brainstorm-gtm, ourbooknook | Claude API                                   |
| **OpenAI SDK**           | brainstormmsp, brainstorm-gtm, mirofish, cramtime             | GPT/o-series API                             |
| **Google Generative AI** | brainstormmsp, brainstorm-gtm                                 | Gemini API                                   |
| **ElevenLabs**           | brainstormhive                                                | Voice synthesis                              |
| **Deepgram**             | brainstormrouter                                              | Speech-to-text                               |

### Local Inference

| Tool               | Used In                         | Purpose               |
| ------------------ | ------------------------------- | --------------------- |
| **Ollama**         | brainstormrouter, mirofish      | Local model runner    |
| **node-llama-cpp** | brainstormrouter                | Direct GGUF inference |
| **ONNX Runtime**   | brainstormrouter, brainstormLLM | ML model execution    |
| **LiteLLM**        | brainstormLLM                   | Unified LLM interface |

### ML / Data Science

| Tool                       | Used In       | Purpose                     |
| -------------------------- | ------------- | --------------------------- |
| **scikit-learn**           | brainstormLLM | ML algorithms               |
| **pandas, numpy, scipy**   | brainstormLLM | Data manipulation           |
| **matplotlib, plotly**     | brainstormLLM | Visualization               |
| **Hugging Face Datasets**  | brainstormLLM | ML datasets                 |
| **camel-ai / camel-oasis** | mirofish      | Social simulation framework |

### Model Context Protocol (MCP)

| Tool                          | Used In          | Purpose                                                           |
| ----------------------------- | ---------------- | ----------------------------------------------------------------- |
| **@modelcontextprotocol/sdk** | brainstormrouter | MCP server/client                                                 |
| **@agentclientprotocol/sdk**  | brainstormrouter | Agent Communication Protocol                                      |
| **12+ MCP servers**           | brainstormmsp    | GitHub, Greptile, Postgres, Firecrawl, Playwright, Supabase, etc. |
| **XcodeBuildMCP**             | peer10           | Xcode build integration                                           |

---

## 8. Documentation

| Tool                                 | Used In                          | Purpose                           |
| ------------------------------------ | -------------------------------- | --------------------------------- |
| **Custom MDX site** (Mintlify-style) | brainstormrouter                 | docs.brainstormrouter.com         |
| **OpenAPI / Swagger**                | brainstormrouter                 | API documentation                 |
| **CLAUDE.md** files                  | Every project                    | AI context documents              |
| **llms.txt / llms-full.txt**         | brainstormrouter                 | AI-discoverability (MNI standard) |
| **Storybook 8**                      | peer10, eventflow, platform-gold | Component documentation           |
| **markdownlint-cli2**                | brainstormrouter                 | Docs quality                      |

---

## 9. Project Management & Communication

### Project Management

| Tool                         | Used In        | Purpose                                        |
| ---------------------------- | -------------- | ---------------------------------------------- |
| **GitHub Issues / Projects** | All projects   | Primary issue tracking                         |
| **Airtable**                 | brainstorm-gtm | Lead/campaign data (base: `appmWqaQU6vLVy9Xb`) |

### Communication

| Tool                  | Used In                       | Purpose                               |
| --------------------- | ----------------------------- | ------------------------------------- |
| **Slack** (webhooks)  | brainstorm-gtm, BrainstormOps | Alerts, lead notifications, CI alerts |
| **Discord** (bot SDK) | brainstormrouter              | Bot integration                       |
| **Telegram**          | brainstormrouter              | Channel support                       |
| **Mattermost**        | brainstormrouter              | Channel support                       |

---

## 10. Monitoring & Observability

| Tool                                  | Used In          | Purpose                      |
| ------------------------------------- | ---------------- | ---------------------------- |
| **OpenTelemetry**                     | brainstormmsp    | Distributed tracing          |
| **Prometheus**                        | brainstorm-gtm   | Metrics collection           |
| **structlog**                         | brainstorm-gtm   | Structured Python logging    |
| **tslog**                             | brainstormrouter | Structured TS logging        |
| **pino**                              | brainstorm       | Structured TS logging        |
| **Vercel Analytics + Speed Insights** | brainstormhive   | Web analytics                |
| **DO cost monitoring**                | BrainstormOps    | Budget alerts via GH Actions |

---

## 11. DNS, CDN & Networking

| Tool              | Used In           | Purpose         |
| ----------------- | ----------------- | --------------- |
| **Cloudflare**    | All domains       | DNS + CDN + WAF |
| **DO Spaces CDN** | peer10, eventflow | Media CDN       |
| **Tailscale**     | openclaw server   | Mesh VPN        |

---

## 12. UI / Design System

| Tool                         | Used In                                                         | Purpose                      |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------- |
| **shadcn/ui**                | brainstormVM, ourbooknook                                       | Component library            |
| **Radix UI**                 | brainstormmsp                                                   | Headless UI primitives       |
| **Tailwind CSS v4**          | brainstorm, brainstormhive, cramtime, ourbooknook, brainstormVM | Utility CSS (current)        |
| **Tailwind CSS v3**          | peer10, eventflow, platform-gold                                | Utility CSS (older projects) |
| **Framer Motion**            | peer10, eventflow, brainstormmsp                                | Animation                    |
| **Recharts**                 | brainstormmsp, brainstorm-gtm, peer10, brainstormhive           | Charts                       |
| **D3**                       | brainstormmsp                                                   | Advanced data visualization  |
| **Lucide React**             | brainstormmsp, brainstorm-gtm, brainstormVM                     | Icon library                 |
| **@xterm/xterm**             | brainstormmsp                                                   | Browser terminal emulation   |
| **TanStack Table / Virtual** | brainstormmsp                                                   | Data tables                  |
| **Ink** (React for CLI)      | brainstorm/cli                                                  | Terminal UI framework        |

---

## 13. GTM / Marketing / Sales

| Tool                                  | Used In        | Purpose              |
| ------------------------------------- | -------------- | -------------------- |
| **Instantly.ai**                      | brainstorm-gtm | Cold email sequences |
| **HeyReach**                          | brainstorm-gtm | LinkedIn automation  |
| **HubSpot CRM**                       | brainstorm-gtm | CRM                  |
| **Apollo.io**                         | brainstorm-gtm | Lead enrichment      |
| **Ahrefs**                            | brainstorm-gtm | SEO analytics        |
| **Cal.com**                           | brainstorm-gtm | Meeting scheduling   |
| **Google / Meta / LinkedIn Ads APIs** | brainstorm-gtm | Paid advertising     |
| **HeyGen**                            | brainstorm-gtm | AI video generation  |
| **Bland.ai**                          | brainstorm-gtm | AI telephony         |
| **Reddit API (asyncpraw)**            | brainstorm-gtm | Social monitoring    |

---

## 14. Payments & Email

### Payments

| Tool             | Used In                           | Purpose                  |
| ---------------- | --------------------------------- | ------------------------ |
| **Stripe**       | peer10, eventflow, brainstormhive | Payments + subscriptions |
| **LemonSqueezy** | brainstormmsp                     | (configured, disabled)   |

### Email

| Tool                     | Used In                          | Purpose                |
| ------------------------ | -------------------------------- | ---------------------- |
| **SendGrid**             | brainstormmsp, eventflow, peer10 | Transactional email    |
| **Resend + React Email** | peer10/packages/email            | Modern email templates |

---

## 15. Mobile

| Tool                              | Used In               | Purpose                    |
| --------------------------------- | --------------------- | -------------------------- |
| **Expo 54**                       | brainstormmsp/mobile  | React Native framework     |
| **Capacitor**                     | ourbooknook           | Cross-platform mobile      |
| **TCA (Composable Architecture)** | peer10, eventflow iOS | Swift architecture pattern |
| **XcodeGen**                      | peer10 mobile         | Xcode project generation   |
| **KeychainAccess**                | peer10 mobile         | iOS secure storage         |
| **Supabase Swift SDK**            | peer10 mobile         | Swift auth client          |

---

## 16. Media & Video

| Tool                   | Used In        | Purpose                        |
| ---------------------- | -------------- | ------------------------------ |
| **Remotion**           | cramtime       | Programmatic video generation  |
| **Google Veo**         | brainstormmsp  | AI video generation            |
| **OpenAI Sora**        | brainstormmsp  | AI video generation (env var)  |
| **Opus Clip, Pictory** | brainstorm-gtm | Video clipping (commented out) |

---

## 17. Cloud SDKs

| Tool                                                   | Used In                                     | Purpose      |
| ------------------------------------------------------ | ------------------------------------------- | ------------ |
| **AWS SDK** (Bedrock, CloudWatch, S3, Secrets Manager) | brainstormrouter, brainstorm-security-stack | AWS services |
| **gcloud CLI**                                         | brainstormmsp                               | Google Cloud |
| **Azure Service Principal**                            | resources                                   | Azure access |

---

## 18. Scheduling & Job Queues

| Tool               | Used In                       | Purpose                  |
| ------------------ | ----------------------------- | ------------------------ |
| **BullMQ + Redis** | brainstormrouter              | Durable job queues       |
| **APScheduler**    | brainstormmsp, brainstorm-gtm | Python background jobs   |
| **Croner**         | brainstormrouter              | Node.js cron             |
| **Croniter**       | brainstormmsp                 | Cron expression parsing  |
| **launchd**        | brainstormmsp                 | macOS service management |

---

## 19. IDE & AI Coding

| Tool            | Used In          | Purpose                         |
| --------------- | ---------------- | ------------------------------- |
| **Claude Code** | All projects     | Primary AI coding assistant     |
| **VS Code**     | brainstormrouter | IDE (oxc extension recommended) |

---

## 20. Protocols & Serialization

| Tool               | Used In          | Purpose              |
| ------------------ | ---------------- | -------------------- |
| **Protobuf / Buf** | brainstormVM     | Binary serialization |
| **OpenAPI**        | brainstormrouter | REST API contracts   |

---

## 21. Web Frameworks (Backend)

| Tool                  | Used In                               | Purpose                    |
| --------------------- | ------------------------------------- | -------------------------- |
| **Next.js 16**        | brainstormhive, cramtime, ourbooknook | Full-stack React           |
| **Next.js 14**        | peer10, eventflow, platform-gold      | Full-stack React (older)   |
| **Hono**              | brainstormrouter                      | Lightweight HTTP framework |
| **Express v5**        | brainstormrouter                      | Node.js HTTP framework     |
| **FastAPI + uvicorn** | brainstormmsp, brainstorm-gtm         | Python async API           |
| **Flask**             | mirofish                              | Python web framework       |

---

## Cross-Reference: Tools by Project

| Project              | Primary Stack                  | Unique Tools                                                |
| -------------------- | ------------------------------ | ----------------------------------------------------------- |
| **brainstorm**       | TS, Turborepo, Ink, AI SDK v6  | Ink TUI, better-sqlite3, pino                               |
| **brainstormmsp**    | Python/FastAPI + Next.js + Go  | Hypothesis, mutmut, pqcrypto, OPA, Expo, pgvector, launchd  |
| **brainstormrouter** | TS/Hono + pnpm + Turbo         | oxlint, BullMQ, sqlite-vec, MCP SDK, ACP SDK, Fly.io        |
| **peer10**           | Turborepo + Next.js 14 + Swift | Fastlane, TCA, XcodeGen, Storybook, Resend                  |
| **eventflow**        | Turborepo + Next.js 14 + Swift | Platform Gold fork, TCA                                     |
| **brainstorm-gtm**   | Python/FastAPI + Next.js       | 70 agents, Instantly, HeyReach, Apollo, HubSpot, Prometheus |
| **brainstormhive**   | Next.js 16 + Tailwind v4       | ElevenLabs, 30 domains, Vercel Analytics                    |
| **openclaw**         | Node 22+ / Docker              | 5 agents, 8 security layers, Tailscale                      |
| **mirofish**         | Flask + Vue.js + Neo4j         | camel-oasis, Neo4j graph DB                                 |
| **brainstormLLM**    | Python (uv)                    | scikit-learn, ONNX, LiteLLM, HF Datasets                    |
| **brainstormVM**     | Go monorepo                    | Buf/protobuf, OPA                                           |
| **BrainstormOps**    | Terraform                      | DO/Cloudflare/AWS providers, cost monitoring                |
