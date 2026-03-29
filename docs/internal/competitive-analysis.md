# Competitive Analysis — AI Coding Assistants (March 2026)

## Feature Matrix

| Feature               | Brainstorm                                              | Aider           | Claude Code         | Codex CLI      | Cline            | OpenHands      | Goose            | Cursor            | Amp                |
| --------------------- | ------------------------------------------------------- | --------------- | ------------------- | -------------- | ---------------- | -------------- | ---------------- | ----------------- | ------------------ |
| **Stars**             | New                                                     | 42K             | N/A                 | 68K            | 60K              | 70K            | 34K              | N/A               | New                |
| **License**           | Apache 2.0                                              | Apache 2.0      | MIT                 | MIT            | Apache 2.0       | MIT            | Apache 2.0       | Closed            | Closed             |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **Multi-model**       | 10+ models, 8 providers                                 | Multi           | Claude only         | OpenAI-focused | Multi            | Multi          | 25+ providers    | Multi             | Multi              |
| **Auto routing**      | 6 strategies + Thompson                                 | No              | No                  | No             | No               | No             | No               | Basic "auto"      | 3 manual modes     |
| **Cost optimization** | Yes (cost-first, combined)                              | No              | No                  | No             | No               | No             | No               | No                | No                 |
| **Learned routing**   | Thompson sampling from outcomes                         | No              | No                  | No             | No               | No             | No               | No                | No                 |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **Interface**         | CLI + 5-mode TUI                                        | CLI             | CLI                 | CLI            | VS Code          | CLI + Web      | CLI + Desktop    | IDE               | CLI + VS Code      |
| **TUI dashboard**     | Yes (5 modes)                                           | No              | No                  | No             | No               | No             | No               | No                | No                 |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **File edit**         | Yes (42+ tools)                                         | Yes             | Yes                 | Yes            | Yes              | Yes            | Yes              | Yes               | Yes                |
| **Shell exec**        | Yes + sandbox                                           | No              | Yes + sandbox       | Yes + sandbox  | Yes              | Yes + Docker   | Yes              | Yes               | Yes                |
| **Git tools**         | 7 tools + safety                                        | Auto-commit     | Yes                 | Yes            | Yes              | Yes            | Yes              | Yes               | Yes                |
| **Browser**           | Web fetch/search                                        | No              | Computer Use        | No             | Yes              | Yes            | No               | No                | No                 |
| **GitHub API**        | Yes (issue + PR)                                        | No              | No                  | No             | No               | Yes            | Yes              | No                | Yes (Toolbox)      |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **Orchestration**     | 9-phase pipeline                                        | No              | Subagents           | No             | Plan/Act         | Agent arch     | Recipes          | Background agents | Librarian subagent |
| **Multi-phase**       | spec→arch→impl→review→verify→refactor→deploy→doc→report | No              | No                  | No             | No               | No             | No               | No                | No                 |
| **Subagents**         | 7 types, 11 built-in roles                              | No              | 5 types             | No             | No               | Yes            | No               | Yes (background)  | Yes (Librarian)    |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **Plugin SDK**        | Dedicated package                                       | No              | MCP+skills+hooks    | Hooks+SDK      | MCP              | Agent SDK      | MCP (1700+)      | VS Code compat    | Toolbox+Skills     |
| **MCP support**       | Yes (OAuth, SSE, stdio)                                 | No              | Yes                 | No             | Pioneer          | No             | Native (1700+)   | No                | Likely             |
| **Hooks**             | 10 lifecycle events                                     | No              | Yes                 | Yes            | No               | No             | No               | No                | No                 |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **Cost tracking**     | Budget + forecast + per-model                           | Basic estimates | /cost command       | No             | Per-request      | No             | No               | Credits           | No                 |
| **Budget limits**     | Daily + monthly + session + hard/soft                   | No              | No                  | No             | No               | No             | No               | Monthly credits   | No                 |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **OS sandbox**        | Docker container mode                                   | No              | Seatbelt/Bubblewrap | OS-level       | No               | Docker         | No               | No                | No                 |
| **Permission system** | auto/confirm/plan + per-tool                            | No              | 4 levels            | 3 modes        | Per-action       | No             | No               | No                | No                 |
| **Credential mgmt**   | Encrypted vault + 1Password                             | No              | Env vars only       | No             | No               | No             | No               | No                | No                 |
| **Secret scanning**   | 19 patterns, post-write middleware                      | No              | No                  | No             | No               | No             | No               | No                | No                 |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **Learning**          | Thompson + style + patterns + memory                    | No              | CLAUDE.md memory    | No             | No               | No             | No               | No                | Shared threads     |
| **Style learning**    | Code + prose patterns                                   | No              | No                  | No             | No               | No             | No               | No                | No                 |
| **Semantic search**   | TF-IDF + git history                                    | Codebase map    | No                  | No             | No               | No             | No               | Codebase search   | Sourcegraph        |
|                       |                                                         |                 |                     |                |                  |                |                  |                   |                    |
| **SWE-bench**         | Not benchmarked                                         | Top CLI scores  | N/A                 | N/A            | N/A              | SOTA (70K)     | N/A              | N/A               | N/A                |
| **Enterprise**        | Open-core                                               | OSS only        | Enterprise plan     | Enterprise     | Enterprise (SSO) | Cloud platform | Linux Foundation | Business plan     | Enterprise         |

## Brainstorm's Unique Position

**What only Brainstorm has (no competitor offers all of these):**

1. Intelligent multi-model routing with 6 strategies (quality, cost, combined, capability, learned, rule-based)
2. Thompson sampling that learns from execution outcomes
3. 5-mode TUI terminal dashboard with live mission control
4. 9-phase orchestration pipeline (spec through report)
5. Budget forecasting with daily/monthly/session limits
6. Encrypted credential vault with 1Password bridge
7. Post-write secret scanning middleware (19 patterns)
8. Style learning (code + prose patterns)
9. 11 built-in role agents (.agent.md format)

**What competitors have that Brainstorm doesn't:**

1. OS-level sandboxing (Claude Code, Codex CLI)
2. Browser automation (Claude Code Computer Use, Cline, OpenHands)
3. Cloud-scale parallel agents (OpenHands)
4. IDE integration (Cline, Cursor, Windsurf, Continue, Roo Code)
5. SWE-bench benchmarking
6. Massive MCP ecosystem (Goose: 1,700+ extensions)
7. Enterprise SSO/audit (Cline Enterprise, Cursor Business)
8. Adoption/stars (all established competitors: 30K-70K stars)

## Plan to Surpass

### Phase 1: Close Critical Gaps (Q2 2026)

These are table-stakes features where Brainstorm's absence is a dealbreaker for adoption.

**1.1 SWE-bench Benchmarking** (1 week)

- Run Brainstorm against SWE-bench Verified (300 instances)
- Publish results. Even mid-pack results establish credibility.
- If results are poor, identifies what to fix in the agent loop.
- _Why:_ Every serious competitor publishes SWE-bench scores. No score = assumed bad.

**1.2 OS-Level Sandboxing** (2 weeks)

- Add macOS Seatbelt profile (like Claude Code)
- Add Linux seccomp/Bubblewrap profile (like Codex CLI)
- Default to restricted sandbox — network disabled, writes limited to workspace
- _Why:_ Codex CLI and Claude Code both ship this. Brainstorm's Docker-only sandbox is heavy.

**1.3 npm Publish** (1 day)

- Publish `@brainstorm/cli` to npm
- Enable `npx brainstorm` and `npm install -g @brainstorm/cli`
- _Why:_ Can't compete without distribution. Zero-friction install is table stakes.

### Phase 2: Exploit Unique Advantages (Q2-Q3 2026)

Double down on what only Brainstorm does.

**2.1 Routing Intelligence Marketing** (ongoing)

- Publish blog post: "How Brainstorm's Thompson sampling saves 40% vs single-model"
- Build a public routing leaderboard showing model performance by task type
- Add `storm benchmark` command that measures model performance locally
- _Why:_ This is Brainstorm's #1 differentiator. Nobody else does it. Make it visible.

**2.2 Cost Intelligence Dashboard** (1 week)

- Add `/cost compare` — show what the same session would have cost on single-model
- Add cost-savings badge to README (e.g., "avg 43% savings vs Opus-only")
- Export session cost reports for teams
- _Why:_ Enterprise buyers care about cost. Show real savings numbers.

**2.3 BrainstormLLM v2 — Learned Orchestration** (Q3 2026)

- Ship the sequential phase predictor (plan cache → sequential predictor → RL)
- Each pipeline run trains the model. Flywheel gets smarter over time.
- _Why:_ No competitor has an orchestration model that learns. This is the moat.

### Phase 3: Capture Adjacent Markets (Q3-Q4 2026)

**3.1 VS Code Extension** (4 weeks)

- Ship `@brainstorm/vscode` — chat sidebar, inline edit, model selection palette
- Keep CLI as primary, VS Code as companion (not replacement)
- _Why:_ 60%+ of developers use VS Code. CLI-only limits TAM.

**3.2 MCP Ecosystem Growth** (ongoing)

- Publish 10 first-party MCP servers (Slack, Linear, Jira, Notion, Datadog, Vercel, AWS, GCP, Supabase, Stripe)
- Create MCP server template for community contributions
- _Why:_ Goose has 1,700+ MCP extensions. Brainstorm has the client but no ecosystem.

**3.3 Team/Enterprise Features** (Q4 2026)

- Shared routing intelligence across team members (via BrainstormRouter)
- Team cost dashboards and budget allocation
- SSO via BrainstormRouter OAuth
- Audit trail for all agent actions
- _Why:_ Enterprise is where revenue lives. Cursor charges $40/user/mo. BR can do the same.

### Phase 4: Win on Benchmarks (Q4 2026)

**4.1 SWE-bench Top 3**

- Use the 9-phase pipeline with BrainstormLLM v2 routing
- Heterogeneous routing (different model per phase) should outperform single-model
- Target: top 3 on SWE-bench Verified
- _Why:_ OpenHands leads at 70K stars partly because of SOTA scores. Benchmarks drive adoption.

**4.2 Cost-Performance Frontier**

- Publish a cost-vs-quality Pareto frontier showing Brainstorm vs competitors
- Position: "90% of Claude Code quality at 40% of the cost"
- _Why:_ Aider markets token efficiency. Brainstorm should market cost efficiency.

## Key Metrics to Track

| Metric                       | Current          | Q2 Target      | Q4 Target                    |
| ---------------------------- | ---------------- | -------------- | ---------------------------- |
| GitHub stars                 | ~0               | 1,000          | 5,000                        |
| npm weekly downloads         | 0                | 500            | 5,000                        |
| SWE-bench score              | Not tested       | Top 10         | Top 3                        |
| BrainstormRouter users       | ~1               | 100            | 1,000                        |
| MCP extensions               | 0 first-party    | 10             | 50                           |
| VS Code installs             | 0                | 0              | 1,000                        |
| Cost savings vs single-model | ~40% (estimated) | 40% (measured) | 50%+ (with BrainstormLLM v2) |

## Competitive Moats (Long-term)

1. **Routing intelligence** — Thompson sampling + BrainstormLLM v2. Gets better with every user. Network effect: more users → more outcome data → better routing → more users.
2. **BrainstormRouter SaaS** — Open-core revenue model. Free CLI + paid cloud routing. Competitors are either all-free (no revenue) or all-paid (no adoption).
3. **Cost transparency** — Only tool that shows exactly what you spend, where, and what you'd save. Enterprise procurement loves this.
4. **Orchestration pipeline** — 9 phases with learned phase selection. Nobody else has this. Multi-model per-phase routing is architecturally impossible for single-provider tools.
