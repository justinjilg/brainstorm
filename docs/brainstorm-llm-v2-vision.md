# BrainstormLLM v2: The Orchestration Model

> The first AI model trained not just to write code, but to orchestrate an entire software engineering team — spec, design, implement, review, test, refactor, deploy, and document — across multiple AI models, with cost awareness.

---

## The Insight

Every AI coding tool today answers one question: **"What code should I write next?"**

BrainstormLLM v2 answers a different question: **"How should this entire feature be built?"**

The difference is the same as between a developer and a CTO. One writes code. The other knows which engineer should handle which part, when to bring in a reviewer, when to skip the design phase because it's a simple fix, and when to escalate to the most experienced person on the team.

---

## How It Works

### The Training Signal

BrainstormLLM v1 trained on 400K+ routing datapoints from RouterBench — "given this prompt, which model performs best?" That produced a binary tier classifier with 93% accuracy, deployed in BrainstormRouter via ONNX at sub-2ms inference.

BrainstormLLM v2 trains on **orchestration trajectories** — complete records of 9-phase software development pipelines:

```
User Request: "Add user authentication to the API"
    ↓
Phase 1: PM Agent → spec (Sonnet, $0.01, 3s)
Phase 2: Architect Agent → design (Opus, $0.08, 12s)
Phase 3: Coder Agent → implementation (Sonnet, $0.15, 25s)
Phase 4: 3 Reviewers → security + code + style (parallel, $0.06, 8s)
Phase 5: Build Verifier → tests pass ✓
Phase 6: Refactorer → 3 improvements ($0.04, 6s)
Phase 7: Docs Agent → changelog + API docs ($0.02, 4s)
Phase 8: Reporter → execution summary ($0.01, 2s)
    ↓
Outcome: Build ✓, Tests ✓, 0 critical findings, $0.37 total, 3 files changed
```

Each trajectory captures:

- Which agent handled each phase
- Which model BrainstormRouter selected (automatically, based on task complexity)
- What tools were used and how many steps taken
- The cost and duration per phase
- The quality outcome (build pass, test pass, review findings, feedback loops)

After 1,000+ trajectories across diverse real-world projects, the model learns:

| For This Kind of Request... | The Model Predicts...                                              |
| --------------------------- | ------------------------------------------------------------------ |
| Simple bug fix              | Skip spec + architecture, go straight to code + verify             |
| New feature                 | Full pipeline, Opus for architecture, parallel review              |
| Refactoring                 | Skip spec, lightweight design, heavy review, skip deploy           |
| Security fix                | Skip spec, code + security review only, verify, deploy immediately |
| Documentation               | Skip implementation, go straight to docs agent                     |

### The Architecture

```
                    ┌─────────────────────────────┐
                    │      BrainstormLLM v2        │
                    │   (Orchestration Model)      │
                    │                              │
                    │  Input: request + context     │
                    │  Output: phase plan           │
                    │    - which phases to run      │
                    │    - agent per phase          │
                    │    - expected cost/duration   │
                    │    - tools needed             │
                    │    - parallelization plan     │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │     BrainstormRouter         │
                    │   (Model Selection)          │
                    │                              │
                    │  Per-phase model routing      │
                    │  Thompson sampling            │
                    │  Cost/quality optimization    │
                    │  357 models, 7 providers     │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
     │ Phase Agent 1  │ │ Phase Agent 2 │ │ Phase Agent N │
     │ (PM, Architect,│ │ (Coder,      │ │ (Reviewer,   │
     │  Writer, etc.) │ │  Refactorer) │ │  Verifier)   │
     └───────────────┘ └──────────────┘ └──────────────┘
```

**BrainstormLLM v2** decides the orchestration strategy.
**BrainstormRouter** picks the optimal model for each phase.
**Role Agents** execute the work with the right tools and constraints.

Three layers, fully automatic. The user just says what to build.

---

## The Data Flywheel

```
1. User says "build X"
        ↓
2. BrainstormLLM v2 predicts the phase plan
        ↓
3. Orchestration pipeline executes (9 phases, 11 role agents)
        ↓
4. Trajectory captured (inputs, outputs, costs, outcomes)
        ↓
5. Trajectory pushed to HuggingFace dataset
        ↓
6. Model fine-tuned on accumulated trajectories
        ↓
7. Better orchestration predictions → back to step 1
```

Every pipeline run makes the model smarter. The flywheel accelerates as usage grows.

---

## What Makes This Unique

### vs. Poolside AI (RLCEF)

Poolside trains on code execution feedback — "did the code run correctly?" BrainstormLLM trains on **orchestration execution feedback** — "did the entire development lifecycle produce a good outcome?" Our training signal is richer because it captures the full journey from spec to ship, not just code correctness.

### vs. Magic AI (100M context)

Magic puts entire codebases in context. We put **the development process** in context. A 100M token window helps you understand code. Our model helps you understand how to _build software_.

### vs. MetaGPT / ChatDev

MetaGPT simulates a software company with hardcoded role pipelines. BrainstormLLM _learns_ the optimal pipeline from real execution data. It adapts per project, per task type, per budget constraint.

### vs. GitHub Copilot / Claude Code

Copilot and Claude Code are single-agent tools with manual model selection. BrainstormLLM orchestrates a team of specialized agents across any model, automatically. It's the difference between a developer and a development platform.

---

## The Technical Path

### Stage 1: Trajectory Capture (Weeks 1-4)

Add trajectory recording to the orchestration pipeline. Every pipeline run emits a structured JSONL record with full phase-level detail.

**Infrastructure needed:**

- `packages/core/src/plan/trajectory-capture.ts` — captures phase events
- BR Intelligence API: `POST /v1/agent/trajectory` — stores trajectories server-side
- HuggingFace dataset: `justinjilg/brainstorm-orchestration-trajectories`

**Target:** 100 trajectories from real project work (HawkTalk, Brainstorm, Peer10, EventFlow, etc.)

### Stage 2: Training Data Preparation (Weeks 3-6)

Transform raw trajectories into SFT training examples.

**Infrastructure needed:**

- `src/brainstormllm/data/prepare_orchestration.py` — trajectory JSONL → SFT pairs
- Extends existing `prepare_training.py` pattern
- Labels: per-phase decisions weighted by pipeline outcome quality

**Training format:**

```
Input: "request: Add auth middleware\nproject: typescript_monorepo\nphase: spec\nbudget: $5.00"
Label: "agent: product-manager\ntools: file_read,grep\nmax_steps: 8\nestimated_cost: $0.01\nskip: false"
```

### Stage 3: Fine-Tuning (Weeks 5-8)

Fine-tune on HuggingFace Jobs (same infrastructure as v1).

**Infrastructure needed:**

- `src/brainstormllm/train/train_orchestrator.py` — orchestration SFT script
- LoRA on Qwen2.5-1.5B (same base as v1)
- Outcome-weighted loss (successful pipelines weight 2x)
- HuggingFace Jobs submission via `submit_sft_job.py`

### Stage 4: ONNX Export & Deployment (Weeks 7-10)

Export to ONNX, deploy in BrainstormRouter.

**Infrastructure needed:**

- `src/brainstormllm/export/onnx_orchestrator.py` — export script
- BrainstormRouter: new orchestration inference endpoint
- Brainstorm CLI: replace hardcoded `PHASE_CONFIG` with model predictions

### Stage 5: Flywheel (Ongoing)

Every pipeline run generates new training data. Monthly re-training. Continuous improvement.

---

## Cross-Project Dependencies

### What Each Project Provides

| Project                | Role                         | What It Contributes                                                       |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| **Brainstorm CLI**     | Execution scaffold           | Orchestration pipeline, 11 role agents, plan executor, subagent system    |
| **BrainstormRouter**   | Model selection + data store | Routes each phase to optimal model, stores trajectories, serves inference |
| **BrainstormLLM**      | Model training               | Fine-tunes orchestration model from trajectories, exports to ONNX         |
| **HawkTalk**           | Training workload            | Real project for generating orchestration trajectories                    |
| **Peer10 / EventFlow** | Training workloads           | Additional real projects for trajectory diversity                         |
| **BrainstormMSP**      | Training workload            | Python/FastAPI project adds language diversity                            |
| **HuggingFace**        | Model hosting + dataset      | Stores model weights, training datasets, job execution                    |
| **NVIDIA**             | Compute + ecosystem          | GPU access for training, Inception program support                        |
| **DigitalOcean**       | Infrastructure               | Hosts BrainstormRouter (API), managed databases, app platform             |

### What Each Project Needs Built

**Brainstorm CLI** (this project):

- [x] Orchestration pipeline (9 phases) — DONE
- [x] 11 role agent definitions — DONE
- [x] Plan executor — DONE
- [ ] Trajectory capture in pipeline — **NEXT**
- [ ] Pipeline wired to real `spawnSubagent()` (currently placeholder)
- [ ] HuggingFace dataset push integration

**BrainstormRouter**:

- [x] Memory API — EXISTS
- [x] Intelligence API (trajectory endpoint) — EXISTS
- [ ] Orchestration trajectory storage schema
- [ ] Orchestration inference endpoint (serves ONNX model predictions)
- [ ] Project-scoped trajectory queries

**BrainstormLLM**:

- [x] RouterBench data pipeline — DONE
- [x] SFT training on Qwen2.5-1.5B — DONE
- [x] ONNX export pipeline — DONE
- [x] Tier classifier (93% accuracy) — DONE
- [ ] `prepare_orchestration.py` — trajectory → SFT converter
- [ ] `train_orchestrator.py` — orchestration SFT script
- [ ] `onnx_orchestrator.py` — orchestration model export
- [ ] Evaluation harness for orchestration model

**HuggingFace**:

- [ ] Dataset: `justinjilg/brainstorm-orchestration-trajectories`
- [ ] Model: `justinjilg/brainstorm-orchestrator-v1`
- [ ] Training job via `submit_sft_job.py`

---

## Metrics That Matter

| Metric            | v1 (Routing)               | v2 Target (Orchestration)      |
| ----------------- | -------------------------- | ------------------------------ |
| Training data     | 400K RouterBench tasks     | 1,000+ pipeline trajectories   |
| Prediction scope  | Per-prompt model selection | Per-pipeline phase planning    |
| Accuracy          | 93% tier classification    | TBD (pipeline outcome quality) |
| Inference latency | <2ms (ONNX)                | <5ms (ONNX, more features)     |
| Cost savings      | ~20% vs best-single-model  | ~40% vs naive full-pipeline    |
| Training compute  | 1x A100, 4h                | 1x A100, 8h (est.)             |

---

## The Vision Statement

> BrainstormLLM is the first model that understands software engineering as a process, not just code generation. Trained on real orchestration trajectories — complete records of how AI agents spec, design, implement, review, test, and ship features — it learns to orchestrate the entire development lifecycle. Combined with BrainstormRouter's multi-model routing and Brainstorm CLI's agent scaffold, it creates a fully autonomous software engineering platform where the user says what to build and the system handles everything else.

---

## Timeline

| Month       | Milestone                                                                |
| ----------- | ------------------------------------------------------------------------ |
| **Month 1** | Trajectory capture live, 100 trajectories from real projects             |
| **Month 2** | 500 trajectories, prepare_orchestration.py, initial training experiments |
| **Month 3** | v2 model trained, ONNX exported, deployed in BR for testing              |
| **Month 4** | Flywheel running, monthly retraining, public dataset on HuggingFace      |
| **Month 5** | Paper / blog post: "Learning to Orchestrate Software Engineering"        |
| **Month 6** | Open-source the orchestration dataset + training pipeline                |

---

_Built with Brainstorm CLI, powered by BrainstormRouter, trained on HuggingFace, accelerated by NVIDIA._
