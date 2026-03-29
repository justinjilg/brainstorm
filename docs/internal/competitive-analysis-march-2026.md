# Brainstorm Competitive Analysis — March 2026

> 14 tier-1 AI coding assistants benchmarked against Brainstorm CLI + BrainstormRouter + BrainstormLLM.

---

## Executive Summary

The AI coding assistant market has consolidated into four tiers:

1. **Platform incumbents** with massive distribution (GitHub Copilot ~100M+ users, Cursor ~1M+)
2. **CLI-first agentic tools** (Claude Code, Codex CLI)
3. **Autonomous cloud agents** (Devin, OpenHands, Codex Cloud)
4. **Open-source extensible frameworks** (Aider, Goose, Continue, Cline/Roo Code)

Brainstorm occupies a unique position as the **only tool offering intelligent multi-provider model routing** with a full orchestration layer, forensic verification, and a self-improving flywheel (CLI → Router → LLM). No competitor has replicated this because every major player has economic incentives to lock users into their own models.

---

## The 14 Competitors

### 1. Claude Code (Anthropic)

- **Status**: Market leader for agentic coding (SWE-bench SOTA 80.9%)
- **Models**: Opus 4.6 (1M context), Sonnet 4.6 — Anthropic only
- **Pricing**: Pro $20/mo, Max $100/mo, Team $25/user, Premium $150/user
- **License**: Source-available (proprietary)
- **Key Features**: Computer Use Agent (unique — desktop automation), Agent Skills (Office/PDF), Dispatch (unattended background work), voice mode (20 languages), 1M context window, MCP ecosystem, plugins
- **Unique**: Computer Use Agent can navigate desktops, click UI elements, fill spreadsheets
- **Weakness**: Locked to Anthropic models, no multi-provider routing, expensive at scale

### 2. Cursor (Anysphere)

- **Status**: Dominant IDE with ~1M+ developers
- **Models**: Claude, GPT, Gemini (BYOK)
- **Pricing**: Free (limited), Pro $20/mo, Pro+ $60/mo, Teams $40/user
- **License**: Proprietary (VS Code fork)
- **Key Features**: Background Agents (8-20 parallel cloud agents producing PRs), BugBot Autofix, MCP Apps, Team Marketplaces, JetBrains ACP, Automations (scheduled/event-triggered)
- **Unique**: 8-20 parallel cloud agents is unmatched scale
- **Weakness**: Expensive at scale, VS Code fork lock-in, opaque credit pricing

### 3. GitHub Copilot (Microsoft)

- **Status**: Largest distribution (every GitHub user)
- **Models**: GPT-5.x, Claude Opus 4, Gemini (Pro+/Enterprise)
- **Pricing**: Free (2K completions), Pro $10/mo, Pro+ $39/mo, Business $19/user, Enterprise $39/user
- **License**: Proprietary
- **Key Features**: Coding Agent GA (autonomous issue-to-PR), Agentic Code Review (auto-generates fix PRs), Spark (NL-to-app), multi-model on Pro+
- **Unique**: $10/mo lowest pro entry. Coding Agent is fully autonomous.
- **Weakness**: Agent mode burns premium requests fast, less sophisticated for complex multi-step tasks

### 4. Windsurf (Cognition/ex-Codeium)

- **Status**: Acquired by Cognition AI (~$250M). Ranked #1 LogRocket Power Rankings Feb 2026
- **Models**: OpenAI, Claude, Gemini, proprietary SWE-1.5
- **Pricing**: Free (25 credits/mo), Pro $15/mo (cheapest pro), Teams $30/user, Enterprise $60/user
- **License**: Proprietary
- **Key Features**: Cascade (deep repo context, multi-step agentic edits), cheapest pro tier
- **Unique**: Cognition acquisition brings Devin technology
- **Weakness**: Acquisition creates uncertainty, credit limits restrict heavy usage

### 5. Aider (Open Source)

- **Status**: Most popular open-source coding assistant (~42K stars)
- **Models**: 100+ (any OpenAI-compatible, Anthropic, Google, local)
- **Pricing**: Free (Apache 2.0), BYOK costs only
- **Key Features**: Git-native (every edit is a reviewable commit), Architect mode (reasoning + editing model), tree-sitter repo map, auto-lint/auto-fix
- **Unique**: Claims SWE-bench SOTA on main benchmark
- **Weakness**: CLI only, single-agent, no background agents, no orchestration, no cost tracking

### 6. Codex CLI / Codex Cloud (OpenAI)

- **Status**: 67K GitHub stars, cloud sandbox GA
- **Models**: GPT-5.x only
- **Pricing**: CLI free (Apache 2.0, BYOK); Cloud with ChatGPT Plus/Team/Enterprise
- **Key Features**: Cloud sandbox (isolated container per task, internet disabled), real-time steering, GPT-5.3-Codex leads SWE-Bench Pro at 56.8%
- **Unique**: Isolated sandboxed execution environment
- **Weakness**: OpenAI models only, sandbox disables internet during execution

### 7. Continue (Open Source)

- **Status**: True IDE integration (VS Code + JetBrains, not a fork)
- **Pricing**: Free (Apache 2.0)
- **Key Features**: CI/CD background agents, source-controlled AI checks
- **Weakness**: Less powerful agent, smaller feature set

### 8. Cline / Roo Code (Open Source)

- **Status**: Active community, Roo Code fork with enterprise features
- **Pricing**: Free (Apache 2.0); Roo Cloud for teams
- **Key Features**: MCP Marketplace (curated, one-click install), Custom Modes (security expert, perf optimizer, doc writer, QA engineer), SOC 2 on Roo
- **Weakness**: VS Code only, no background agents

### 9. Amazon Q Developer

- **Status**: Deep AWS integration, compliance focus
- **Pricing**: Free (50 chats/mo), Pro $19/user/mo (unlimited)
- **Key Features**: Autonomous agents, security scanning with auto-fix, HIPAA/PCI/SOC compliance, IP indemnity
- **Weakness**: AWS-centric, proprietary models

### 10. Devin (Cognition AI)

- **Status**: Most autonomous agent (issue-to-PR)
- **Pricing**: Starter $20/mo + $2.25/ACU, Team $500/mo (250 ACUs)
- **SWE-bench**: 13.86% (7x over prior SOTA at launch)
- **Key Features**: Truly hands-off, parallel instances, cloud IDE, Windsurf integration
- **Weakness**: ACU pricing expensive at volume, benchmark scores lower than model-native tools

### 11. OpenHands (Open Source)

- **Status**: Leading open-source agent (72% SWE-bench Verified)
- **Pricing**: Free (MIT); enterprise self-hosted or managed cloud
- **Key Features**: Composable Python SDK, sandboxed runtimes, Kubernetes self-hosted
- **Weakness**: Requires Docker/K8s, Python-only SDK, no IDE integration

### 12. Goose (Block / Linux Foundation)

- **Status**: Linux Foundation governance (AAIF alongside MCP, AGENTS.md)
- **Pricing**: Free (Apache 2.0)
- **Key Features**: MCP-native architecture, Linux Foundation longevity guarantee
- **Weakness**: Smaller community, relies entirely on MCP ecosystem

### 13. Amp (Sourcegraph)

- **Status**: Evolved from Cody, cross-repo intelligence
- **Pricing**: Free tier; Enterprise $59/user/mo
- **Key Features**: Sourcegraph code search (best cross-repo understanding), unconstrained token usage, 200K fixed context, team threads and leaderboards
- **Weakness**: Enterprise pricing steep, depends on Sourcegraph infrastructure

### 14. Augment Code

- **Status**: First ISO/IEC 42001 certified AI coding assistant
- **Pricing**: Indie $20/mo, Developer $50/mo, Standard $60/mo, Enterprise custom
- **Key Features**: 400K+ file context engine (largest documented), 40% fewer hallucinations, semantic dependency analysis, SOC 2 Type II, Proof-of-Possession architecture
- **Weakness**: Expensive for teams, no CLI, no background agents

---

## Feature Comparison Matrix

| Feature                            |    Brainstorm     |  Claude Code   |      Cursor      |    Copilot     |     Aider      |   Codex CLI    |     Roo Code      |  OpenHands   |     Goose      |       Amp       |    Augment    |
| ---------------------------------- | :---------------: | :------------: | :--------------: | :------------: | :------------: | :------------: | :---------------: | :----------: | :------------: | :-------------: | :-----------: |
| **Multi-provider routing**         | **✓ 362 models**  |       —        |       BYOK       |      Pro+      |      BYOK      |       —        |       BYOK        |     BYOK     |      Any       |       Yes       |    Limited    |
| **Intelligent routing (Thompson)** |   **✓ Unique**    |       —        |        —         |       —        |       —        |       —        |         —         |      —       |       —        |        —        |       —       |
| **CLI-first**                      |         ✓         |       ✓        |        —         |    Partial     |       ✓        |       ✓        |         —         |      ✓       |       ✓        |        ✓        |       —       |
| **IDE integration**                |         —         |     Plugin     |    **Native**    |   **Native**   |      Exp.      |       —        |    **Native**     |      —       |    Desktop     |   **Native**    |  **Native**   |
| **Background agents**              |    ✓ Worktree     |   ✓ Dispatch   | **✓ 8-20 cloud** |    ✓ Agent     |       —        |    ✓ Cloud     |         —         |   ✓ Cloud    |       —        |        —        |       —       |
| **MCP support**                    |   ✓ 10 servers    |  ✓ Ecosystem   |      ✓ Apps      |    Limited     |       —        |       —        | **✓ Marketplace** |      —       |  **✓ Native**  |        —        |       —       |
| **Multi-agent/subagents**          |   **✓ 8 types**   |    ✓ Skills    |        ✓         |       ✓        |       —        |       ✓        |         —         |    ✓ SDK     |       —        |        —        |       —       |
| **Custom roles**                   |   **✓ 5 roles**   |       —        |        —         |       —        |       —        |       —        |    **✓ Modes**    |      —       |       —        |        —        |       —       |
| **Orchestration pipeline**         |   **✓ 9-phase**   |   Agent loop   |     Composer     |     Agent      |   Architect    |     Agent      |     Plan/Act      |     SDK      |    MCP flow    |      Agent      |     Agent     |
| **Cost tracking/forecast**         | **✓ CostTracker** |       —        |     Credits      |   Req count    |       —        |       —        |         —         |      —       |       —        |  Unconstrained  |    Credits    |
| **Encrypted vault**                |   **✓ AES-256**   |       —        |        —         |       —        |       —        |       —        |         —         |      —       |       —        |        —        |     SOC 2     |
| **Forensic verification**          |   **✓ Unique**    |       —        |        —         |       —        |       —        |       —        |         —         |      —       |       —        |        —        |       —       |
| **Evidence chain**                 |   **✓ Unique**    |       —        |        —         |       —        |       —        |       —        |         —         |      —       |       —        |        —        |       —       |
| **Learned routing (LLM)**          |  **✓ 0.796 F1**   |       —        |        —         |       —        |       —        |       —        |         —         |      —       |       —        |        —        |       —       |
| **Codebase ingest**                |         ✓         |       —        |        —         |       —        |    Repo map    |       —        |         —         |      —       |       —        | **Sourcegraph** | **400K ctx**  |
| **Programmatic SDK**               |         ✓         |       —        |        —         |       —        |       —        |       —        |         —         | **✓ Python** |       —        |        —        |       —       |
| **Computer use**                   |         —         |  **✓ Unique**  |        —         |       —        |       —        |       —        |         —         |      —       |       —        |        —        |       —       |
| **Open source**                    |  **Apache 2.0**   |  Source-avail  |        —         |       —        | **Apache 2.0** | **Apache 2.0** |  **Apache 2.0**   |   **MIT**    | **Apache 2.0** |        —        |       —       |
| **Enterprise (SSO/compliance)**    |         —         |     Teams      |      Teams       | **Enterprise** |       —        |   Enterprise   |     Roo Cloud     | Self-hosted  |       —        |   Enterprise    | **ISO 42001** |
| **Published benchmarks**           |         —         | **80.9% SOTA** |        —         |       —        |  Claims SOTA   |   56.8% Pro    |         —         | 72% Verified |       —        |        —        |       —       |

---

## Honest Assessment

### WHERE BRAINSTORM LEADS (Genuine Competitive Advantages)

| Advantage                              | Detail                                                                                                                                    | Competitors w/ Nothing Comparable                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Multi-provider intelligent routing** | Thompson sampling across 362 models, 30+ providers, 6 strategies. The only tool that learns which model handles which task best.          | All 14 competitors                                                     |
| **Orchestration depth**                | 14-phase SDLC pipeline with forensic verification, multi-agent consensus, evidence chains. Goes beyond any agent loop.                    | All 14 competitors                                                     |
| **Anti-hallucination framework**       | 5-layer verification: ground truth → evidence chain → forensic agent → consensus voting → human gates.                                    | All 14 (Augment has 40% fewer hallucinations but no forensic protocol) |
| **Cost intelligence**                  | CostTracker with forecasting, per-task cost prediction, budget enforcement, degradation ladder.                                           | All except Devin (ACU tracking)                                        |
| **Architecture completeness**          | 24 packages, 42+ tools, 10 MCP servers, 8 subagents, 5 roles, vault, semantic search, style learning, 4-type memory, middleware pipeline. | Most complete open-source offering                                     |
| **BrainstormLLM**                      | Trained ONNX model (0.796 F1, <2ms) for phase prediction. Entirely novel.                                                                 | All 14 competitors                                                     |
| **Encrypted vault**                    | AES-256-GCM + Argon2id + 1Password bridge for local secret management.                                                                    | All 14 competitors                                                     |

### WHERE BRAINSTORM MATCHES

| Capability        | How We Compare                                                                          |
| ----------------- | --------------------------------------------------------------------------------------- |
| Background agents | Worktree-based, comparable to Claude Code. Less than Cursor's 8-20 cloud agents.        |
| MCP support       | 10 built-in servers, solid. On par with most. Cline's Marketplace has better discovery. |
| Multi-agent       | 8 subagent types comparable to Claude Code's skills and OpenHands' SDK.                 |
| Open source       | Apache 2.0 matches Aider, Codex CLI, Continue, Cline/Roo, Goose.                        |
| CLI workflow      | Matches Claude Code, Codex CLI, Aider, Goose as CLI-first tools.                        |

### WHERE BRAINSTORM TRAILS (Honest Gaps)

| Gap                          | Severity        | Detail                                                                                                             | Path to Close                                                  |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Distribution & community** | **Critical**    | ~0 external adoption vs Codex CLI 67K stars, Cursor 1M+ devs, Copilot 100M+ users                                  | npm publish, SWE-bench results, developer content              |
| **Model quality access**     | **Critical**    | Routes to Opus 4.6 but adds complexity. When Opus is available directly via Claude Code, routing must prove value. | Publish cost savings data, multi-provider advantage            |
| **IDE integration**          | **Significant** | CLI/TUI only. 9 of 14 competitors have native IDE. VS Code extension exists but minimal.                           | Ship @brainstorm/vscode with chat sidebar, inline edits        |
| **Cloud agents at scale**    | **Moderate**    | Local worktree only. Cursor runs 8-20 cloud agents. Codex has isolated sandbox.                                    | storm cloud via BrainstormRouter (Sprint 5 planned)            |
| **Enterprise features**      | **Moderate**    | No SSO, audit logs, team management. Q has HIPAA, Augment has ISO 42001.                                           | BrainstormRouter already has evidence ledger — need team layer |
| **Published benchmarks**     | **Moderate**    | No SWE-bench scores. OpenHands publishes 72%, Claude Code 80.9%.                                                   | Run SWE-bench Verified, publish results                        |
| **Computer use**             | **Emerging**    | Claude Code's desktop automation is unique. No equivalent.                                                         | Playwright MCP is partial (web only, not desktop)              |
| **Onboarding**               | **Moderate**    | Requires BYOK multi-provider keys, building monorepo. Competitors: $20/mo and go.                                  | storm init wizard, BrainstormRouter free tier as default       |

---

## Pricing Landscape

| Tool           | Free             | Pro             | Team        | Enterprise  |
| -------------- | ---------------- | --------------- | ----------- | ----------- |
| **Brainstorm** | **OSS (BYOK)**   | BYOK costs only | N/A         | N/A         |
| Claude Code    | No               | $20-100/mo      | $25/user    | $150/user   |
| Cursor         | Limited          | $20/mo          | $40/user    | Custom      |
| GitHub Copilot | 2K completions   | **$10/mo**      | $19/user    | $39/user    |
| Windsurf       | 25 credits       | **$15/mo**      | $30/user    | $60/user    |
| Aider          | **OSS (BYOK)**   | BYOK only       | N/A         | N/A         |
| Codex CLI      | **OSS (BYOK)**   | BYOK/Plus       | Team        | Custom      |
| Devin          | No               | $20 + ACUs      | $500/mo     | Custom      |
| OpenHands      | **OSS (MIT)**    | BYOK            | Self-hosted | Self-hosted |
| Goose          | **OSS (Apache)** | N/A             | N/A         | N/A         |
| Amp            | Limited          | Free            | N/A         | $59/user    |
| Augment        | No               | $20-50/mo       | $60/mo      | Custom      |

**Brainstorm's pricing advantage**: Truly free with no limits. No credits, no premium requests, no seat licenses. The trade-off: you manage your own API keys. BrainstormRouter free tier planned to simplify this.

---

## Strategic Priorities (Recommended)

Based on this analysis, the highest-impact actions to close competitive gaps:

1. **Publish SWE-bench Verified scores** — credibility in this market requires benchmark results
2. **Simplify onboarding to one command** — `npm install -g @brainstorm/cli && storm init` should be all a developer needs
3. **Ship VS Code extension** — unlock the 80%+ of developers who never leave their IDE
4. **Publish cost savings data** — prove that routing to cheaper models for simple tasks saves 40-60% vs single-model
5. **BrainstormRouter free tier as default** — remove the BYOK key management friction

---

_Analysis conducted March 29, 2026. Market moves fast — revisit quarterly._
