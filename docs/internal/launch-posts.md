# Launch Posts — Review and Post

## 1. Hacker News (Show HN)

**Title:** Show HN: Brainstorm – Open-source AI coding assistant that routes tasks to the optimal model

**Text:**

I built an open-source CLI coding assistant that routes every task to the best model for the job.

Architecture review? Goes to Opus 4.6. Implementing a function? Sonnet 4.6 — 5x cheaper, equally capable for coding. Quick edit? Haiku — 19x cheaper, instant. Hit your budget? Falls back to local Ollama models.

The routing uses Thompson sampling — it learns from actual outcomes which models work best for YOUR codebase and task types. After a few sessions, it's making better routing decisions than you would manually.

**What makes it different from Claude Code / Cursor / Aider:**

- Multi-model routing across 10+ models and 8 providers (including local)
- 6 routing strategies (quality-first, cost-first, Thompson sampling, etc.)
- Cost tracking with daily budgets — see exactly what every task costs
- 9-phase orchestration pipeline (spec → architecture → implementation → review → verify → ...)
- Encrypted vault (AES-256-GCM + Argon2id) with 1Password bridge
- 42 built-in tools with checkpoint/undo and Docker sandboxing

23 TypeScript packages in a Turborepo monorepo. Apache 2.0.

Install: `npm install -g @brainst0rm/cli && storm chat`

GitHub: https://github.com/justinjilg/brainstorm
Website: https://brainstorm.co

The routing intelligence comes from BrainstormRouter (https://brainstormrouter.com), a multi-tenant AI gateway with 362 models across 30+ providers. The CLI is fully open-source; BrainstormRouter is the SaaS layer on top.

Happy to answer any questions about the architecture, routing strategies, or the Thompson sampling implementation.

---

## 2. Reddit — r/LocalLLaMA

**Title:** I built an AI coding assistant that routes between Ollama, Claude, GPT, Gemini, and DeepSeek — automatically picks the best model for each task

**Text:**

I've been working on **Brainstorm**, an open-source CLI coding assistant that does something I haven't seen elsewhere: intelligent multi-model routing.

Instead of picking one model for everything, it routes each task to the optimal model:

- Architecture decisions → Opus (best reasoning)
- Code generation → Sonnet or GPT-5.4 (fast, capable)
- Quick edits → Haiku or local models (cheap/free)
- Over budget → auto-falls back to your Ollama/LM Studio/llama.cpp models

**For LocalLLaMA folks specifically:**

- Auto-discovers Ollama (localhost:11434), LM Studio (:1234), llama.cpp (:8080) on startup
- Local models participate in the routing pool alongside cloud models
- Thompson sampling learns that your local models are great for certain tasks → routes more to them over time
- When your daily budget runs out, it seamlessly falls back to local-only
- You can set `cost-first` strategy to prefer local models for everything

It has 42 built-in tools (filesystem, git, shell, web, planning), a 5-mode terminal dashboard, and a 9-phase orchestration pipeline. All open-source (Apache 2.0).

```
npm install -g @brainst0rm/cli
storm chat
```

GitHub: https://github.com/justinjilg/brainstorm

Happy to answer questions. The Thompson sampling implementation is in `packages/router/src/strategies/learned.ts` if anyone wants to dig in.

---

## 3. Reddit — r/programming

**Title:** Open-source AI coding assistant with Thompson sampling for multi-model routing — routes tasks to optimal models automatically

**Text:**

Sharing **Brainstorm**, an open-source CLI AI coding assistant I've been building. The main idea: instead of being locked into one LLM, route each coding task to the model that's actually best for it.

The interesting technical bit is the routing layer — it uses Thompson sampling (a multi-armed bandit algorithm) to learn from actual outcomes which models work best for which task types. After enough samples, the system makes measurably better routing decisions than static assignments.

**Architecture:**

- 23 TypeScript packages in a Turborepo monorepo
- 6 routing strategies: quality-first, cost-first, combined, capability-based, Thompson sampling, rule-based
- 42 built-in tools with checkpoint/undo and Docker sandboxing
- 10+ models across 8 providers (Anthropic, OpenAI, Google, DeepSeek, Moonshot + local via Ollama/LM Studio)
- Encrypted vault (AES-256-GCM + Argon2id) for API key management
- MCP client with OAuth for tool extensibility

Apache 2.0: https://github.com/justinjilg/brainstorm

The CLI is fully open-source. The routing intelligence integrates with BrainstormRouter, an AI gateway that tracks model performance across the fleet.

---

## 4. Twitter/X Thread

**Tweet 1:**
I just shipped Brainstorm — an open-source AI coding assistant that routes every task to the optimal model.

Architecture → Opus ($15/M)
Code → Sonnet ($3/M)
Quick edit → Haiku ($0.80/M)
Over budget → your local Ollama models ($0)

It learns from outcomes. Thompson sampling.

npm install -g @brainst0rm/cli

**Tweet 2:**
What makes it different:

→ 10+ models, 8 providers, local support
→ 6 routing strategies (including Thompson sampling)
→ Cost tracking with daily budgets
→ 42 tools with checkpoint/undo
→ 9-phase orchestration pipeline
→ Encrypted vault (AES-256-GCM)
→ Plugin SDK + MCP

23 packages. Apache 2.0.

**Tweet 3:**
The routing learns which models work best for YOUR codebase.

After a few sessions, it knows:

- Sonnet is better than Opus for your Go code reviews
- Haiku handles your test generation fine
- DeepSeek is great for your refactoring tasks

Better code. Lower cost. Automatically.

**Tweet 4:**
And we're doing something nobody has done before:

The Living Case Study — 10 named AI agents building Wiz + CrowdStrike + SentinelOne from scratch. Live. 24/7. Every artifact traces to Brainstorm.

Come watch AI agents build an entire security platform in public.

github.com/justinjilg/brainstorm-security-stack

**Tweet 5:**
GitHub: github.com/justinjilg/brainstorm
Website: brainstorm.co
Install: npm install -g @brainst0rm/cli

Apache 2.0. Built by one person + Claude.

The code is real. The routing works. The Thompson sampling learns. Ship it and see.
