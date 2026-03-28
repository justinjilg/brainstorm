# Cross-Project Coordination Plan

## The Problem

BrainstormLLM v2 requires coordinated work across 6 projects. Each has its own Claude Code session. No single session can see or modify all projects. The work must be orchestrated so each project builds on what the others produce.

## The Projects

```
brainstorm (CLI)          → The scaffold that runs the pipeline
brainstormrouter (API)    → Routes models + stores trajectories
brainstormLLM (ML)        → Trains the orchestration model
hawktalk (app)            → First real workload for trajectory generation
peer10 / eventflow (apps) → Additional workloads for training diversity
```

## The Dependency Chain

```
Step 0: brainstorm        → Wire pipeline dispatcher to REAL spawnSubagent() with runtime deps
                             (createPipelineDispatcher exists but CLI command still uses placeholder)
Step 1: brainstormrouter  → Accepts orchestration trajectories via API
Step 2: brainstorm        → Pushes trajectories to BR after each pipeline run
Step 3: hawktalk + apps   → Run through the pipeline, generating REAL trajectories
Step 4: brainstormLLM     → Trains on accumulated trajectories (local JSONL, NOT BR API)
Step 5: brainstormrouter  → Serves trained model via ONNX inference
Step 6: brainstorm        → Uses model predictions for phase planning
```

## Kill Gates (must pass before proceeding to next stage)

| Gate   | Metric               | Threshold                                                | Checked At                |
| ------ | -------------------- | -------------------------------------------------------- | ------------------------- |
| **G1** | Trajectory quality   | ≥80% of trajectories have build_passed=true              | Before training (Stage 4) |
| **G2** | Trajectory diversity | ≥3 distinct task types, ≥3 distinct projects             | Before training (Stage 4) |
| **G3** | Trajectory volume    | ≥500 trajectories with real costs and tool calls         | Before training (Stage 4) |
| **G4** | Model quality-match  | Orchestrator matches naive-full-pipeline build pass rate | After training            |
| **G5** | Cost reduction       | ≥30% lower cost than naive-full-pipeline at same quality | After training            |
| **G6** | Phase-skip accuracy  | Phase-skip predictions agree with human judgment ≥70%    | After training            |

If G1-G3 fail → generate more/better trajectories before training.
If G4-G6 fail → improve training data quality, adjust labels, retrain.

## How to Coordinate

### Option A: Manual Handoff (Current)

You open Claude Code in each project and tell it what to do:

```bash
# Session 1: brainstormrouter
cd ~/Projects/brainstormrouter
claude
> "Add POST /v1/orchestration/trajectory endpoint. Accept the schema
   defined in brainstorm/docs/br-api-spec.md. Store in a new
   orchestration_trajectories table. Include the TypeScript SDK,
   Python SDK, and MCP tool updates per the lockstep rule."

# Session 2: brainstorm
cd ~/Projects/brainstorm
claude
> "Wire the trajectory capture to push to BR's new endpoint.
   In packages/core/src/plan/trajectory-capture.ts, add a
   pushToBR() method that POSTs to /v1/orchestration/trajectory."

# Session 3: hawktalk
cd ~/Projects/hawktalk
claude
> "Run storm orchestrate pipeline 'Add reading stats page'
   to generate the first real orchestration trajectory."

# Session 4: brainstormLLM
cd ~/Projects/brainstormLLM
claude
> "Add prepare_orchestration.py that reads trajectories from
   ~/.brainstorm/trajectories/orchestration/*.jsonl and converts
   to SFT training format. Follow the pattern in prepare_training.py."
```

**Pros**: Full control, each Claude sees full project context
**Cons**: You're the bottleneck, manual context transfer, easy to miss steps

### Option B: Task Queue via OpenClaw (Automated)

Your OpenClaw agent at `~/.openclaw/claude-tasks/` already supports a pull-based task queue. You could:

1. Write task files as JSON to `~/.openclaw/claude-tasks/pending/`
2. Each project's Claude session polls for tasks
3. Results written back to `~/.openclaw/collab/messages/`

But this requires OpenClaw infrastructure to be running, which adds complexity.

### Option C: GitHub Issues as Coordination Layer (Recommended)

Create GitHub Issues in each project with dependencies tagged. Claude sessions can read issues and know what to build.

```bash
# Create coordinated issues across all projects
gh issue create --repo justinjilg/brainstormrouter \
  --title "feat: orchestration trajectory API endpoint" \
  --body "Accept POST /v1/orchestration/trajectory with schema from brainstorm/docs/br-api-spec.md.
Depends on: justinjilg/brainstorm (trajectory capture - DONE)
Blocks: justinjilg/brainstorm (BR push integration)"

gh issue create --repo justinjilg/brainstormLLM \
  --title "feat: orchestration training data pipeline" \
  --body "Add prepare_orchestration.py + train_orchestrator.py.
Depends on: trajectories generated from brainstorm pipeline runs"
```

Then in each Claude session:

```
> "Check GitHub issues for this repo and work on the next one."
```

### Option D: Brainstorm's Own Orchestrator (The Vision)

This is what we just built. Use `storm orchestrate` to coordinate across projects:

```bash
storm orchestrate run "Add orchestration trajectory endpoint to BR API" \
  --projects brainstormrouter
```

But this requires the pipeline to be wired to real subagents first (which needs API keys in the session).

## Recommended Approach: Phased Handoff

### Week 1: BrainstormRouter (you + BR Claude)

Tell the BR Claude session:

> "Read the file at ~/Projects/brainstorm/docs/br-api-spec.md.
> Implement P2: POST /v1/agent/task-runs (scheduled task telemetry).
> Then implement: POST /v1/orchestration/trajectory — a new endpoint
> that accepts and stores orchestration pipeline trajectories.
> Schema:
>
> - tenant_id (from auth)
> - trajectory_id (UUID)
> - request (string)
> - project_path (string)
> - phases (JSONB array of phase records)
> - outcome (JSONB: success, build_passed, tests_passed, findings)
> - total_cost (numeric)
> - total_duration (integer ms)
> - created_at (timestamptz)
>   Follow the lockstep rule: update SDK-TS, SDK-PY, MCP tools."

### Week 2: Brainstorm CLI (you + this Claude)

Wire the trajectory capture to push to BR:

- Add `pushToBR()` to `TrajectoryRecorder`
- POST to `/v1/orchestration/trajectory` on `finalize()`
- Fire-and-forget (local JSONL is source of truth)

Wire the pipeline dispatcher to use real runtime:

- In `brainstorm.ts`, when `storm orchestrate pipeline` runs:
  - Load config, create registry, create router
  - Pass to `createPipelineDispatcher()`
  - Pipeline executes real work

### Week 3: Generate Trajectories (you + HawkTalk/Peer10/EventFlow Claudes)

Run the pipeline on real tasks across your projects:

```bash
cd ~/Projects/hawktalk
storm orchestrate pipeline "Add reading statistics page" --budget 2.00

cd ~/Projects/peer10
storm orchestrate pipeline "Add team invitation flow" --budget 2.00

cd ~/Projects/brainstorm
storm orchestrate pipeline "Add /agent slash command" --budget 1.00
```

Each run generates a trajectory JSONL + pushes to BR.

### Week 4: BrainstormLLM (you + LLM Claude)

Tell the BrainstormLLM Claude:

> "Read the trajectory files at ~/.brainstorm/trajectories/orchestration/.
> Also pull from BR API: GET /v1/orchestration/trajectory?limit=1000.
> Create prepare_orchestration.py following the pattern in prepare_training.py.
> Create train_orchestrator.py following train_sft_v2.py.
> Submit to HuggingFace Jobs."

## The Coordination Doc (for each Claude session)

When you open a new Claude session in any project, paste this context:

```
We are building BrainstormLLM v2 — an orchestration model trained on
pipeline trajectories. The full plan is at:
~/Projects/brainstorm/docs/brainstorm-llm-v2-vision.md

Cross-project coordination is at:
~/Projects/brainstorm/docs/cross-project-coordination.md

BR API spec is at:
~/Projects/brainstorm/docs/br-api-spec.md

Current status:
- Brainstorm CLI: pipeline + agents + trajectory capture DONE
- Brainstorm CLI: Step 0 PENDING — CLI command still uses placeholder dispatcher
- BrainstormRouter: needs trajectory storage endpoint
- BrainstormLLM: needs orchestration training pipeline (reads LOCAL JSONL, not BR API)
- Trajectory count: [check ~/.brainstorm/trajectories/orchestration/]
```

## Status Tracking

| Project          | What                                   | Status   | Blocks            |
| ---------------- | -------------------------------------- | -------- | ----------------- |
| brainstorm       | Pipeline dispatcher (factory)          | **DONE** | —                 |
| brainstorm       | CLI wired to real dispatcher           | **TODO** | Runtime deps      |
| brainstorm       | Trajectory capture                     | **DONE** | —                 |
| brainstorm       | 11 role agents                         | **DONE** | —                 |
| brainstorm       | BR trajectory push                     | TODO     | BR endpoint       |
| brainstormrouter | Trajectory storage endpoint            | TODO     | —                 |
| brainstormrouter | Orchestration inference endpoint       | TODO     | Trained model     |
| hawktalk         | Generate 50+ trajectories              | TODO     | Real dispatcher   |
| peer10           | Generate 50+ trajectories              | TODO     | Real dispatcher   |
| brainstormLLM    | prepare_orchestration.py (LOCAL JSONL) | TODO     | 100+ trajectories |
| brainstormLLM    | train_orchestrator.py                  | TODO     | Training data     |
| brainstormLLM    | ONNX export                            | TODO     | Trained model     |
| brainstormrouter | Deploy ONNX model                      | TODO     | ONNX export       |
| brainstorm       | Use model for phase planning           | TODO     | Deployed model    |
