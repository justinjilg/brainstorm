---
name: Stochastic Integration Review
description: Measure how well a claude-peers mesh is integrating — not individual peer readiness, but whether they coordinate, share vocabulary, propagate directives, resolve conflicts, and maintain contracts across trust boundaries. Produces a baseline-anchored score with variance; mesh-level scoring with independent bias audit, versioned probe profiles, and auditable probe manifests. Codex-reviewed 2026-04-23 before shipping.
---

# Stochastic Integration Review

## Conflict-of-Interest Self-Disclosure

This skill was designed by the orchestrator peer (Claude Code running in `/Users/justin/Projects/brainstorm`) with input from four participating peers — dttytevx (MSP), crd4sdom (brainstorm-agent), 12xnwqbb (BrainstormRouter), 0bz7aztr (brainstormVM) — and adversarially reviewed by Codex before shipping. Because the orchestrator is **both a participant and the designer of the scoring tool**, there is structural bias risk. Mitigations:

1. **Independent bias audit.** The 11th auditor is spawned from a non-orchestrator peer's session, selected via **seeded-RNG with no orchestrator discretion** (v1.1 — see Phase 5.1).
2. **Deterministic hub weighting.** Hub (orchestrator) evidence on dimension 10 (collective responsiveness) is weighted at 0.8x; on dimension 5 (escalation) at 1.0x. **On dimension 3 (provenance hygiene) weighted at 1.0x with open question** — dttytevx flagged in post-ship review that 1.2x-1.5x may be more defensible since the hub is the primary relayer and every relayed claim is a potential provenance violation. Kept at 1.0x for v1.1 pending data from ≥3 rounds; calibration trigger: revisit after round 3 with observed hub-vs-peer provenance-violation ratios. Documented choice, not silent default.
3. **Mandatory probe manifest with payload+criteria hashing.** Every probe has a run-bound message ID, send timestamp, deadline, receipt state, result state, AND the expected `payload_hash` (v1.1 — hash over probe criteria + payload template text; contributed by dttytevx). Silent probe failures (probe never sent) are scored defects; hash-mismatched dispatches are `tampered_probe` defects.
4. **Pre-registered rule set with peer signoff.** Probe profile, scoring thresholds, hub weighting, and peer-bias audit checks are declared at run start in `profile.json`; mid-run changes invalidate the run. Additionally (v1.1), baseline promotion requires **non-hub peer signoff on the rubric+weighting** — see Phase 0.5.
5. **Triangulation-first precedence on probe conflicts** (v1.1) — peer triangulation is tried before orchestrator-fetched artifacts. Orchestrator artifact is tiebreak, not default authority.
6. **Peer-initiated run timing** (v1.1) — any peer can trigger a round via `run_request` (see Invocation). Timing is not hub-controlled.

Disclosure without independent evidence is not mitigation. The above are structural.

## Philosophy

A peer mesh can have 10/10 individual peers and still fail to integrate — two peers use the same field name to mean different things; a directive reaches 3 of 4 peers and quietly doesn't reach the 4th; a conflict is "resolved" by one peer silently deferring while the other thinks it landed. These failures don't show up in per-project reviews. They only appear at the boundaries.

**Ten independent assessors score the mesh from different integration lenses.** An 11th auditor (from a non-orchestrator peer) checks for review-level bias. The score's mean must be **monotonic with integration capability** — same invariant as stochastic-assessment, extended to integration.

## Known Limitations (acknowledged, not hidden)

- **n=5 peers is not statistical stochastic convergence.** With a single-digit peer count, any defection moves rate metrics by 20%+. "Stochastic" refers to the 10 independent assessors, not peer-level statistics. The review is calibrated for accuracy and drift-detection, not statistical significance.
- **Observer effect.** Scored peers behave differently. Treat lift as Hawthorne-real; compare drift over months, not round-over-round sentiment. (12xnwqbb)
- **Telemetry-availability bias.** Peers with richer telemetry produce more measurable signal. Peer-bias audit job 3(f) applies telemetry-normalization. (12xnwqbb)
- **Survivorship bias on surfaced conflicts.** Trip-wire probes (Phase 2) partially compensate, with manifest-backed detection of probe silent-failure.
- **Orchestrator self-evaluation is structurally awkward.** Addressed by required non-orchestrator auditor + deterministic hub weighting + pre-registered rules.
- **Time-window dependence.** Default is rolling 7-day with snapshot-on-demand. (12xnwqbb)
- **Small-n structural ceiling on dimension 10 (v1.1; contributed by dttytevx).** With n=5 peers and the orchestrator as hub, even perfect mesh discipline produces ~60% hub-touching traffic by graph topology. The 9-10 band ("<40% hub-spoke") is effectively closed in small meshes. Early rounds cap at 8 on dim 10 regardless of behavior. This is structural, not reviewable. Mitigation: the dim-10 9-10 threshold should be interpreted as "<40% hub-spoke FOR MESHES WITH n≥8"; for n<8, the threshold tightens by 5 percentage points per peer below 8 (so n=5 → "<55% hub-spoke"). Applied in synthesis Phase 4 Step 1.

## Scope

**In scope:** Integration between peers on a claude-peers mesh; cross-project contract compliance; directive propagation; provenance annotation; escalation protocol; cross-peer vocabulary alignment; conflict resolution patterns; trust-boundary discipline; end-to-end path attestation.

**Out of scope:** Individual peer readiness (see stochastic-assessment); business/market; anything assessable without reference to other peers.

## Run Identity (collision-resistant)

Every invocation generates a **run ID**:

```
<ISO-8601-UTC-with-seconds>-<orchestrator-peer-id>-<5-char-random-suffix>
Example: 2026-04-23T08-54-42Z-o7k2m-a7b3c
```

All run artifacts live at:

```
~/.brainstorm/integration-reviews/runs/<run-id>/
  profile.json          # pre-registered probe profile + rubric thresholds
  evidence/<peer-id>.md # raw self-evidence per peer
  probes/
    manifest.json       # every probe's message ID, timestamps, receipt state
    <probe-id>.md       # raw probe result per probe
  assessors/<persona-id>.md
  synthesis.md
  audit.md              # written by non-orchestrator peer
  result.json           # final scores + hub-disclosure
```

The **baseline pointer** is a separate file `baseline-pointer.json` that references the last known-good run ID. Never overwritten mid-round.

## Invocation

Invoked as `/stochastic-integration-review` from any peer's session. The invoking Claude becomes the **review orchestrator** for this round. Orchestrator role is rotatable by invocation; hub-disclosure records which peer held the role.

**Peer-initiated runs (v1.1; contributed by dttytevx).** Any peer can trigger a run in one of two ways:

1. Self-invoke the skill (becomes orchestrator for that round)
2. Send a `run_request` message to any other peer via `send_message` with payload `{ "request": "stochastic-integration-review", "reason": "<>", "from": "<peer-id>" }` — the receiving peer may accept by self-invoking and recording the requester in `profile.json`, or decline with `reason`. Timing is not hub-controlled; any peer can propose.

**Pre-flight guard (atomic lock).** Before starting Phase 1, orchestrator acquires `~/.brainstorm/integration-reviews/RUN_LOCK/` via `mkdir` (atomic on POSIX; returns EEXIST if directory exists):

- If `mkdir` succeeds: write `RUN_LOCK/owner.json` with run ID + start time + orchestrator peer ID. Proceed.
- If `mkdir` returns EEXIST: read `RUN_LOCK/owner.json`. If start time > 30 min ago, the prior run timed out — attempt to atomically rename `RUN_LOCK` → `RUN_LOCK.stale-<old-run-id>` and retry `mkdir`. Else abort: "concurrent run in progress: <run-id>".
- On Phase 6 completion OR timeout, orchestrator removes `RUN_LOCK/` via `rmdir` after emptying.

Lock is held across the entire run, including Phase 6 baseline-pointer update. Parent-hash check + atomic rename happen while lock is held.

## Protocol

### Phase 0: Profile Registration

Orchestrator writes `profile.json` containing:

```json
{
  "profile_version": "v1",
  "run_id": "<>",
  "orchestrator_peer_id": "<>",
  "probe_profile": "v1", // fixed probe set version; see Phase 2
  "rubric_version": "v1", // see Phase 3 scoring rubric
  "hub_weighting": {
    "dimension_10": 0.8,
    "dimension_3": 1.0,
    "dimension_5": 1.0,
    "default": 1.0
  },
  "peer_bias_checks": [
    // pre-registered, not mid-run editable
    "volume_vs_finding_correlation",
    "hub_traffic_ratio_disclosure",
    "direct_only_refusals_as_discipline",
    "silent_vs_loud_divergence_weighting",
    "non_response_as_failure",
    "telemetry_normalization",
    "orchestrator_halo_check",
    "recency_window_coverage"
  ],
  "window": "rolling_7d_with_snapshot",
  "parent_baseline_hash": "<sha256-of-previous-baseline-or-null>"
}
```

**Tamper-evidence.** Orchestrator computes `profile_hash = sha256(profile.json bytes as written)` and the sha256 hashes of: the embedded rubric text (see Phase 3), the probe-profile spec (this skill file's Phase 2 section), and the skill file itself. All four hashes are pinned into `profile.json` after initial write (in a `hashes` subsection) via a second atomic write. Every assessor prompt, auditor prompt, and final `result.json` MUST cite these hashes. Post-Phase-0 edits to `profile.json` invalidate the run.

Baseline comparison REQUIRES matching `probe_profile`, `rubric_version`, AND `profile_hash`. Changing any forces a profile bump and resets the baseline explicitly (documented as profile migration, not silent drift).

**Expected-probes plan.** Immediately after profile registration, orchestrator generates `probes/expected.json` containing every TW-\* probe instance that MUST run this round, with per-probe **payload hash** (v1.1, contributed by dttytevx) so dispatch-time weakening changes the hash and fails audit:

```json
{
  "run_id": "<>",
  "profile_hash": "<>",
  "expected": [
    {
      "probe_id": "TW-1-A=dttytevx-B=0bz7aztr",
      "tw": "TW-1",
      "peer_a": "dttytevx",
      "peer_b": "0bz7aztr",
      "applicable": true,
      "reason": null,
      "payload_hash": "<sha256 of probe criteria + request payload template + pass-condition text>"
    },
    {
      "probe_id": "TW-3-A=dttytevx-B=crd4sdom",
      "tw": "TW-3",
      "peer_a": "dttytevx",
      "peer_b": "crd4sdom",
      "applicable": false,
      "reason": "no god-mode dispatch path between these peers",
      "payload_hash": null
    }
  ]
}
```

This plan is written BEFORE any dispatch. The auditor reconciles `expected.json` against `manifest.json` AND verifies that each dispatched probe's recorded payload hash matches the expected hash.

**Canonical-template check (Codex v1.1 verification):** the auditor ALSO computes `sha256(canonical template from this skill's Phase 2.1 table)` per probe type and verifies `expected.json[probe].payload_hash` matches. This prevents the orchestrator from pre-registering a weakened expected.json (which would otherwise hash consistently through the rest of the pipeline). The canonical template is the text of the `Description` and `Pass criteria` columns in the Phase 2.1 probe-profile table, locked by the skill-file hash in `profile.json.hashes`.

An expected probe missing from the manifest = `silent_failure` scored defect. An `applicable: false` entry must include a reason; reason-less skips are themselves defects. A manifest entry whose payload hash doesn't match expected.json = `tampered_probe` scored defect (new state, severity equal to `silent_failure`). An expected.json entry whose payload_hash doesn't match the canonical template = `weakened_expectation` scored defect (new state, same severity).

**Dimension scorability floor (v1.1; contributed by crd4sdom).** For each dimension, count the applicable probes in `expected.json` that target it. If count < 3, the dimension is marked `INSUFFICIENT_EVIDENCE` for this round and scored as `unscored` rather than getting a low-N noisy score. Monotonicity invariant skips unscored dimensions (no regression/gain comparison when prior-round or this-round is `unscored`). Baseline remains at the prior value for those dimensions.

**Ground-truth sources (v1.1; contributed by 0bz7aztr + crd4sdom).** For probes that require ground-truth telemetry (TW-6 posture-freshness), profile.json pre-declares the source per peer:

```json
"ground_truth_sources": {
  "0bz7aztr": {"kind": "systemctl", "path": "bvm-soak.service", "verifiable_by": "auditor"},
  "12xnwqbb": {"kind": "http", "path": "https://api.brainstormrouter.com/v1/ops/status", "verifiable_by": "auditor"},
  "dttytevx": {"kind": "undefined", "reason": "no cheap ground-truth channel"},
  "crd4sdom": {"kind": "file", "path": "./status.json", "verifiable_by": "auditor"}
}
```

If `kind == "undefined"`, TW-6 for that peer has probe state `ground_truth_undefined` and is scored 0 (not FAIL) on dimension 10 for that peer-probe. The auditor — not the orchestrator — fetches and verifies the ground-truth source path during Phase 5; orchestrator-asserted ground truth is never sufficient for TW-6 alone.

### Phase 1: Mesh Enumeration + Self-Evidence Collection

**1.1 Enumerate.** `list_peers` (scope: machine). Record roster to `roster.json`.

**1.2 Broadcast self-evidence request.** For each peer, `send_message` with the checklist below. Record outbound message ID + timestamp to `probes/manifest.json` (self-evidence is treated as probe TW-0).

**1.3 Self-evidence checklist** (items A-I, contributed cross-peer — see Design Provenance). Each peer MUST mark "N/A — <reason>" for items that don't apply.

```
PEER SELF-EVIDENCE CHECKLIST
────────────────────────────
A.  PLATFORM CONTRACT SELF-REPORT
    - /health status (if applicable)
    - /api/v1/god-mode/tools count + names (or "N/A — not a god-mode peer")
    - /api/v1/god-mode/execute shape (ChangeSet-returning y/n)
    - Tools-registry schema sha256 hash

B.  CROSS-PEER REFERENCE COUNTS (this rolling 7d)
    - send_message counts per to_id
    - references to other peers' artifacts (commits, paths, issues)
    - ChangeSets or cross-project PRs touching other peers' code

C.  SHARED VOCABULARY COMPLIANCE
    - Shared field names you emit (command_id, request_id, tenant_id,
      status enum, evidence_hash, traceparent)
    - Each: exact name, type, nullable, semantics one-liner
    - Known divergences vs. other peers, with reason

D.  DIRECTIVE PROPAGATION STATE
    - Currently-durable Justin-attributed feedback-memory rules
    - Each: provenance tag + timestamp first recorded
    - Provisional-but-unsaved directives you're honoring

E.  TRUST MODEL SELF-REPORT
    - Trust model for orchestrator-relayed Justin directives
      (relay-trust / relay-with-documented-provenance / direct-only / other)
    - Refusals issued or would-issue against orchestrator instructions

F.  ESCALATION LOG
    - P2P stalls that escalated to orchestrator (with grounds)
    - Orchestrator instructions refused (with grounds)
    - Unresolved disagreements currently parked

G.  OPEN INTEGRATION DEBTS (crd4sdom)
    - Contracts promised another peer, unfulfilled
    - Divergences you know about, unreconciled
    - Evidence-chain gaps (fields emitted without known consumers)
    - Open assumptions about peer infrastructure NOT verified

H.  MEMORY-INDEX HYGIENE (dttytevx)
    - MEMORY.md entries vs. orphan files in memory/
    - Count of entries referencing other peer IDs
    - Bilateral-commitment symmetry: for each peer-referencing durable
      memory entry, does a matching entry exist on the other side?
      Mark symmetric / asymmetric / unknown

I.  POSTURE-vs-GROUND-TRUTH (0bz7aztr)
    - Your current set_summary string
    - Is it still accurate? (Telemetry-verified, not self-asserted.)
    - Any known posture drift
```

**1.4 Orchestrator self-evidence.** Orchestrator runs the same checklist on itself, tagged `ROLE: ORCHESTRATOR (HUB)` for deterministic weighting.

**1.5 Evidence storage.** Raw reply verbatim to `evidence/<peer-id>.md`. No editorializing.

**1.6 Baseline retrieval.** Read `baseline-pointer.json`. Load referenced run's `result.json`. If absent, this is round 1 and scores become baseline after successful audit.

**1.7 Non-response handling.** Peers who don't reply within 10 minutes of send timestamp (as recorded in `manifest.json`) are marked `non_responding` in `roster.json`. **Non-response scores as availability failure on dimension 10 (collective responsiveness)** AND triggers an integration-risk register entry. Non-responding peers are NOT removed from the denominator — a dark peer cannot inflate the remaining peers' scores.

### Phase 0.5: Pre-Baseline Peer Signoff Gate (v1.1; contributed by dttytevx)

**Before the first baseline run is promoted**, the orchestrator MUST obtain explicit rubric-fairness signoff from at least 2 non-hub peers. Codex validated implementation correctness; this gate validates DIMENSION + WEIGHTING fairness — whether the scoring is fair to all peer roles including the hub.

**Process:**

1. Orchestrator sends each non-hub peer a `rubric_signoff_request` with the full rubric section (Phase 3 scoring prompt), the hub-weighting values (from profile.json), and the peer-bias audit check list (Phase 5 job 3).
2. Peers respond with one of:
   - `ack_signoff` (accept)
   - `blocking_request_change` — MUST cite specific dimension number or weight value, describe why it is unfair, AND propose a concrete alternative. Requests lacking any of these three elements are non-blocking notes.
   - `note` — concern without proposed alternative; does not block.
3. Resolution:
   - If ≥2 non-hub `ack_signoff` AND 0 `blocking_request_change`: proceed, `profile.json.peer_signoffs[]` populated.
   - If any `blocking_request_change`: a revised rubric is drafted addressing the cited dimension/weight. Resubmitted to all non-hub peers.
   - **Quorum override** (v1.1 anti-veto rule, contributed by Codex verification): if after a revision round, ≥3 non-hub peers `ack_signoff` the revised rubric and ≤1 peer holds a blocking change that the others explicitly disagree with, the run promotes with that peer's objection recorded in `profile.json.objections[]`. Prevents single-peer indefinite veto.
   - **Timeout**: blocking change requests expire after 7 calendar days if not revised. After timeout, the orchestrator may submit the revised rubric to the quorum-override path.
4. Forward-carry: once a peer has `ack_signoff` on a rubric version, the signoff carries across rounds using the same `rubric_version` until bumped. Objections also carry forward.

Signoff is required only for baseline promotion — scores can still be computed without it for dry-run use.

### Phase 2: Active Cross-Peer Probes

**2.1 Probe profile v1** (pre-registered in `profile.json`; tailoring forbidden mid-run):

| Probe ID | Description                                                                                                                                                                                                                                                                                                                                                                                                                             | Pass criteria                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **TW-1** | Peer A fetches peer B's `/api/v1/god-mode/tools`; both report sha256 independently.                                                                                                                                                                                                                                                                                                                                                     | hashes match                                                                                                                 |
| **TW-2** | Peer A emits test event with shared fields (`command_id`, `tenant_id`, `status`); peer B parses and reports parsed shape back.                                                                                                                                                                                                                                                                                                          | shape round-trips without silent drops or renames                                                                            |
| **TW-3** | Peer A triggers cross-peer op needing evidence chaining (MSP→VM ChangeSet execute or equivalent); orchestrator fetches the resulting evidence chain.                                                                                                                                                                                                                                                                                    | chain is continuous (single hash chain across product boundaries)                                                            |
| **TW-4** | Orchestrator issues a **test-namespace** directive — `[TEST-PROBE run_id=<>]` — peers echo ack and record into `test-memory/<run-id>.md` (NOT durable Justin-attributed memory). Trust-model refusals count as correct behavior, not latency failure.                                                                                                                                                                                   | all peers ack within 30s; direct-only peers explicitly note refusal per their trust model with test-namespace acknowledgment |
| **TW-5** | Orchestrator sends a deliberately malformed-but-parseable request to each peer.                                                                                                                                                                                                                                                                                                                                                         | peer reports malformation; silent compliance = fail                                                                          |
| **TW-6** | **Auditor** (NOT orchestrator — v1.1 contributed by crd4sdom + dttytevx) compares peer's `set_summary` string against the peer's OWN emitted telemetry (list_peers last_seen, recent send_message activity, cwd file activity timestamps, OR the per-peer `ground_truth_sources` entry from profile.json) at probe time. Orchestrator may assist by listing the expected ground-truth-source path; it does not assert the ground truth. | summary accurate within 10 minutes of peer's own emitted telemetry; `ground_truth_undefined` state if no source declared     |

**2.2 Probe manifest (mandatory).** Every probe writes an entry to `probes/manifest.json`:

```json
{
  "probe_id": "TW-1-A=dttytevx-B=0bz7aztr",
  "peer_a": "dttytevx",
  "peer_b": "0bz7aztr",
  "dispatch_msg_id": "<from send_message return or UUID>",
  "dispatch_sent_at": "2026-04-23T08:58:12Z",
  "response_deadline": "2026-04-23T09:08:12Z",
  "peer_a_reply_msg_id": "<>",
  "peer_a_reply_received_at": "<>",
  "peer_b_reply_msg_id": "<>",
  "peer_b_reply_received_at": "<>",
  "orchestrator_fetched_artifact_path": "<>",
  "state": "pending | received_both | received_partial | timed_out | conflicting",
  "result": "pass | fail | skipped_non_participating | silent_failure"
}
```

**Probe state semantics (disjoint — no overlap):**

- `received_both` — both A and B reported within deadline → run `result` check (pass/fail)
- `received_partial` — one reported, the other timed out → scored FAIL on the tested dimension (partial attestation ≠ attestation)
- `timed_out` — neither reported within deadline → scored FAIL
- `conflicting` — both reported but reports disagree and no orchestrator artifact available → scored FAIL + flagged to integration risk register
- `skipped_non_participating` — a peer was marked non_responding in Phase 1.7 before dispatch was attempted → skipped cleanly (not a defect on its own; the non-response already scored dim 10 down)
- `silent_failure` — probe appears in `expected.json` but has NO entry in `manifest.json` after Phase 2 completes, OR has a manifest entry with `dispatch_sent_at = null` → scored defect on dimension 3 (provenance hygiene) AND on the dimension the probe was supposed to test

`silent_failure` is reserved for manifest-absent or dispatch-unrecorded probes only. `received_partial`, `timed_out`, and `conflicting` are distinct scored fail states, not silent failures.

**2.3 Ground-truth precedence, triangulation-first** (v1.1; contributed by dttytevx — hub-as-tiebreak, not hub-as-default):

1. **Triangulate across peer reports first.** If ≥3 peers independently report on the same probe outcome (including probe-adjacent peers who observed the exchange), majority report is ground truth. Minority reports are flagged to risk register but do not invalidate the majority.
2. **If only 2 peer reports exist (A and B) and they agree:** that's ground truth.
3. **If A and B disagree and no third observer:** **fall back to orchestrator-fetched artifact** (if the probe specifies one, e.g., TW-3's evidence chain). Orchestrator artifact is tiebreak, not first authority.
4. **If still unresolved (no orchestrator artifact or artifact itself disputed):** probe state = `conflicting`. Scored as fail; flagged to risk register.
5. **No-majority triangulation case (Codex v1.1 verification):** if ≥3 peers report and no majority emerges (e.g., three peers give three different observations), escalate to orchestrator-fetched artifact as tiebreak (step 3). If no artifact, state = `conflicting_no_majority`, scored fail, flagged to risk register with all peer observations preserved.
6. **Mid-probe unavailability after partial response:** state = `received_partial`. Scored as fail (incomplete attestation = not attestation).

Triangulation precedes hub tiebreak so the hub is not the default oracle when peers agree or when a third peer can corroborate.

### Phase 3: Spawn 10 Integration Assessors

Each assessor: identical aggregated evidence + profile.json + baseline + DIFFERENT lens. Parallel, isolated. MUST NOT see each other's outputs.

| #   | Persona                         | Lens                                     | Key question                                                                    |
| --- | ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | **The Translator**              | Vocabulary alignment                     | "Same word, same meaning?"                                                      |
| 2   | **The Federator**               | Contract compliance                      | "Same shape, same hash?"                                                        |
| 3   | **The Forensic Auditor**        | Evidence chain                           | "Does A's claim about B match B's self-report AND probe result?"                |
| 4   | **The Latency Critic**          | Propagation + resolution timing          | "T_propagate? T_resolve?"                                                       |
| 5   | **The Trust Boundary Enforcer** | Provenance hygiene                       | "Every durable Justin-attributed rule has provenance tag?"                      |
| 6   | **The Conflict Archivist**      | Resolution quality + synthesis emergence | "Did disagreements produce positions better than either starting stance?"       |
| 7   | **The Gap Analyst**             | Silent divergence                        | "Where do probes reveal peers think they agree but don't?"                      |
| 8   | **The Duplication Hunter**      | Overlap vs. absence                      | "Gaps (0 peers) vs. duplications (2+ incompatible)?"                            |
| 9   | **The Escalation Auditor**      | Protocol + commitment symmetry           | "Escalations follow mesh→orchestrator→Justin? Bilateral commitments symmetric?" |
| 10  | **The Mesh Chaos Monkey**       | Failure tolerance                        | "Dark peer mid-exchange? TW-5 silent-absence?"                                  |

### Assessor Prompt (verbatim, rubric v1, operationalized thresholds)

```
You are {PERSONA}. Your integration lens: {LENS}.

Score the MESH on 10 integration dimensions using aggregated evidence
(self-reports + probe manifest + probe results). Use ONLY the evidence
provided. Cite specific probe IDs or evidence sections per score.

## Scoring Rubric v1 (THRESHOLDS; do not invent your own)

### 1. PLATFORM CONTRACT COMPLIANCE
- 1-2: No shared contract; <25% peers implement
- 3-4: 25-50% of peers implement required endpoints
- 5-6: 51-85% of peers implement; optional endpoints patchy
- 7-8: ≥86% of participating peers implement; TW-1 passes on ≥N-1 pairs
- 9-10: 100% on participating peers; TW-1 passes all pairs; TW-5 malformed-request
       probes return structured refusal (not silent compliance) on all peers

### 2. VOCABULARY ALIGNMENT
- 1-2: ≥2 silent naming conflicts on core shared fields
- 3-4: Known divergences exist on ≥2 core fields, unreconciled
- 5-6: Core fields (command_id, tenant_id, status) aligned; ≥1 secondary drift
- 7-8: Full alignment on all cross-product fields surfaced in checklist C;
       documented divergences only
- 9-10: TW-2 vocabulary probes round-trip without silent drops or renames on
       ≥N-1 pairs; field-name governance gate documented

### 3. PROVENANCE HYGIENE
- 1-2: <25% of cross-peer directives in durable memory have provenance tags
- 3-4: 25-50% tagged
- 5-6: 51-80% tagged
- 7-8: ≥81% tagged uniformly; no untagged "Justin said X" entries in any peer
- 9-10: 100% tagging; probe manifest shows 0 silent-failure probes; at least
       one peer enforces structurally (direct-only or schema-checked)

### 4. DIRECTIVE PROPAGATION + RESOLUTION LATENCY
- 1-2: TW-4 propagation latency > 30 min OR conflict-resolution stalls uncounted
- 3-4: TW-4 latency 10-30 min; resolution latency >2 hr median
- 5-6: TW-4 latency 2-10 min; resolution latency 30-120 min median
- 7-8: TW-4 latency <2 min; resolution latency <30 min median
- 9-10: TW-4 latency <30s; resolution latency <10 min median; no silent misses

### 5. ESCALATION PROTOCOL ADHERENCE
- 1-2: No escalation model observable
- 3-4: Ad-hoc; ≥2 bypass events in evidence window
- 5-6: Documented; followed in >60% of observed cases
- 7-8: Followed in >85%; refusals cite grounds; escalation durable in peer memory
- 9-10: 100% adherence in window; explicit authority carve-outs respected
       (destructive/deploy/prod stay Justin-direct)

### 6. CONFLICT RESOLUTION QUALITY (synthesis emergence)
- 1-2: Disagreements stall or fork silently
- 3-4: Resolved via one concession; attribution unclear
- 5-6: Resolved with attribution; preserved provenance
- 7-8: ≥25% of observed disagreements produce joint positions preserved as artifacts
- 9-10: ≥50% produce positions measurably STRONGER than either starting stance
       (measurement: a non-participating assessor or auditor rates the joint
       position against both starting positions; "stronger" requires specific
       gain cited — removes a recurrence class, removes an invariant violation,
       etc. — not just "felt like consensus")

### 7. TRUST-BOUNDARY DISCIPLINE
- 1-2: No trust model; uniform blind trust or uniform no-persist
- 3-4: Uniform model enforced; peer autonomy low
- 5-6: Per-peer models exist but weakly enforced; laundering path exists
- 7-8: Pluralism supported; orchestrator respects each peer's model
- 9-10: 0 durable Justin-attributed rules lack provenance tags across all peers;
       ≥1 peer enforces structurally; orchestrator-relayed directives that
       disagree with direct Justin statements yield to direct

### 8. COMMITMENT SYMMETRY (bilateral durable agreements) — dttytevx
- 1-2: <25% of bilateral commitments recorded on either side
- 3-4: 25-50% recorded on at least one side
- 5-6: 51-80% recorded on at least one side; <50% symmetric
- 7-8: ≥80% recorded on ≥1 side; ≥50% symmetric
- 9-10: ≥95% recorded; ≥80% symmetric; asymmetric writes flagged as integration
       debt in checklist item H

### 9. END-TO-END PATH ATTESTATION — 0bz7aztr
- 1-2: No cross-peer evidence chaining
- 3-4: Per-peer chains exist; cross-peer flow produces disjoint chains
- 5-6: <50% of critical paths produce continuous chains
- 7-8: ≥50% of critical paths continuous; TW-3 passes on ≥N-1 pairs
- 9-10: ≥90% continuous; cross-product traceparent coverage ≥90%; TW-3 passes
       all applicable pairs

### 10. COLLECTIVE RESPONSIVENESS + HUB BALANCE
(Hub-weighted 0.8x per profile.json.)
- 1-2: <50% of enumerated peers respond; mesh effectively 2-peer
- 3-4: 51-70% respond; >80% of traffic hub-spoke
- 5-6: 71-90% respond; 60-80% hub-spoke
- 7-8: ≥91% respond with domain-specific contribution; 40-60% hub-spoke
- 9-10: 100% respond (or explicit non-participation recorded); <40% hub-spoke;
       every peer contributes domain signal no other could produce

## Scoring Instructions

For each dimension:
- Score (1-10) per rubric THRESHOLDS (not vibes)
- Cite specific probe ID or evidence section
- If baseline provided: HIGHER / LOWER / SAME. LOWER requires cited regression
  AND evidence that roster/profile/window did not change. Roster changes →
  apply roster-match rule in profile.json, do not call it regression.

## Then provide:
- **Overall assessment**: paragraph, facts only. Banned words: impressive,
  solid, strong, healthy, productive, good collaboration.
- **Top 3 integration risks**: cross-peer, falsifiable
- **Top 3 integration strengths**: cross-peer, evidence-backed
- **If this mesh had one week**: single most important integration action
- **Delta from baseline**: dimensions changed, cite cross-peer evidence
- **Hub weighting applied**: confirm 0.8x applied on dimension 10 for
  orchestrator evidence; confirm 1.0x on dimensions 3 and 5; note any
  dimension where you applied a non-default weight and why

## Baseline: {BASELINE}
## Profile: {PROFILE}
## Aggregated evidence: {EVIDENCE}
```

### Phase 4: Mechanical Synthesis (orchestrator; no interpretation)

**Step 1: Score matrix** — 10 dimensions × 10 assessors; Min/Max/Mean/StdDev/Baseline/Delta.

**Step 2: Calibration drift FLAG (no auto-override; visible to all peers).** For any dimension where mean < baseline without cited regression, flag "CALIBRATION DRIFT — pending auditor confirmation." Do NOT auto-override. The flag is written to `synthesis.md` AND surfaced in the published `audit.json` so all peers (not just the orchestrator) can see calibration signals in their own review — contributed by dttytevx. Auditor decides in Phase 5 whether to apply the override. Scoring stays as-is until auditor rules.

**Step 3: Roster-match check.** If participating peers differ from baseline roster, flag every dimension with "ROSTER-ADJUSTED" and compute delta on peer-intersection only; do not compute delta on the full dimension.

**Step 4: Variance flags.** StdDev > 1.5 → "UNCERTAIN."

**Step 5: Integration risk register.** Every cross-peer risk flagged by any assessor, with count + assessor IDs.

**Step 6: Hub-disclosure + participation table.**

```
Peer           | Role        | Self-ev items | Cross-refs | Probes resp | Escalations | Refusals | Durable rules | Silent failures
---------------|-------------|---------------|------------|-------------|-------------|----------|---------------|----------------
<orch-peer>    | ORCHESTRATOR|  9/9          | 4 (hub)    | 6/6         | 0           | 0        | 4             | 0
dttytevx       | participant |  9/9          | 4          | 6/6         | 1           | 0        | 3             | 0
crd4sdom       | participant |  9/9          | 3          | 6/6         | 0           | 0        | 2             | 0
12xnwqbb       | participant |  8/9          | 2          | 6/6         | 0           | 1        | 0 (DO model)  | 0
0bz7aztr       | participant |  7/9          | 1          | 4/6         | 0           | 0        | 2             | 2 (TW-1,TW-6)
```

Orchestrator row is always first, tagged ORCHESTRATOR. Assessors received this table; hub weighting applied deterministically.

**Step 6.5: Synthesis discipline rules (v1.1).**

- When TW-6 result conflicts with a peer's own checklist item I self-assertion, synthesis cites TW-6 as authoritative and flags the discrepancy as a posture drift risk (contributed by 0bz7aztr).
- Minimum viable round: if fewer than 8 of 10 assessors return a valid scored output, the round is `invalid — insufficient assessors` (sister rule to auditor VACANT; contributed by crd4sdom). Run artifacts are preserved but baseline pointer is not updated.

**Step 7: Write synthesis.md.**

### Phase 5: 11th Auditor — Integration Bias Audit (INDEPENDENT)

**5.1 Auditor selection: seeded-RNG, tamper-evident, no orchestrator discretion (v1.1; contributed by dttytevx, converging 12xnwqbb's recursive-risk note and crd4sdom's bootstrap-circularity note).**

The prior "highest trust-model discipline" heuristic was circular — that score is produced BY this review. Replaced with deterministic seeded-RNG selection:

1. **Eligibility filter:**
   - Must be non-orchestrator peer
   - Must NOT be in the top-K probe-participation count for this round (default K=1 for n≤5; K=2 for n≤8) — contributed by crd4sdom; prevents the peer most scrutinized by probes from also judging them
   - Must NOT have participation count = 0 (a peer that did not engage cannot audit)
2. **Seeded random selection:**
   - Seed = `sha256(profile_hash + run_id + participating_peer_ids_sorted)`
   - Among eligible peers sorted lexicographically by peer_id, select deterministically using seed modulo eligible count
   - Seed AND selection result recorded in `profile.json.auditor_selection` — tamper-evident
3. **Fallback order if selected peer declines:** next eligible peer by the same seeded ordering
4. **If ALL eligible peers decline:** `auditor_role: VACANT`, run does not promote to baseline

Orchestrator has NO discretion in selection. The seeded-RNG output is reproducible by any peer given the inputs, so post-hoc verification is possible.

**Independence scope clarification (Codex verification):** auditor selection is non-score-circular — it does not depend on any score produced BY this review. It does use current-round **participation data** (message counts, probe-pair membership), which is observable but not scoring-derived. The auditor cannot select themselves based on how they scored; that was the circularity being closed.

**Auditor COI additional exclusion** (contributed by crd4sdom): the selected auditor is additionally disqualified if they were a peer on either side of ≥50% of this round's probes. On disqualification, fall back to next-eligible per the seeded order.

**Round 1:** no prior-round data used; seeded-RNG works identically in round 1 and round N.

The auditor (once selected and accepting) `send_message`s back the audit artifact per the prompt below.

**Auditor attestation (tamper-evidence).** The auditor peer MUST return:

```json
{
  "audit_body": "<full audit markdown verbatim>",
  "audit_body_sha256": "<hash of audit_body>",
  "auditor_peer_id": "<non-orchestrator peer ID>",
  "auditor_session_cwd": "<e.g. /Users/justin/Projects/brainstormmsp>",
  "completed_at": "<ISO-8601>",
  "source_inputs": {
    "profile_hash": "<from profile.json hashes block>",
    "evidence_dir_hash": "<sha256 of concatenated evidence/*.md sorted by filename>",
    "manifest_hash": "<sha256 of probes/manifest.json>",
    "expected_hash": "<sha256 of probes/expected.json>",
    "synthesis_hash": "<sha256 of synthesis.md>"
  },
  "reply_msg_ids": [
    "<peer-bus message IDs the orchestrator used to pass inputs>"
  ]
}
```

Orchestrator writes this JSON to `audit.json` verbatim, and `audit_body` to `audit.md` verbatim. Any peer (or future auditor) can verify:

- `sha256(audit.md) == audit.json.audit_body_sha256` (artifact integrity)
- `source_inputs` hashes match the on-disk files at review time (no tampered inputs)
- `auditor_peer_id != orchestrator_peer_id` (independence)
- `auditor_session_cwd` is a non-orchestrator repo

If ANY of these verifications fail, the round is invalid. `auditor_peer_id` MUST be present; orchestrator self-spawn of the auditor is forbidden.

If no non-orchestrator peer accepts the auditor role, **the round is invalid** and `audit.md` is written with `auditor_role: VACANT` and scores are NOT promoted to baseline.

**5.2 Auditor prompt:**

```
You are the Integration Review Calibration & Bias Auditor, spawned from a
non-orchestrator peer session. You have THREE jobs.

## Inputs
- All 10 assessor outputs
- Orchestrator's synthesis
- Baseline (prior round's result.json)
- profile.json (pre-registered rules)
- probes/expected.json (reconciliation target; check payload hashes against canonical skill-file templates)
- probes/manifest.json (with silent-failure / tampered_probe / weakened_expectation flags)
- roster.json with response states

## Job 1: Calibration Audit
- Does each score's cited evidence match the rubric THRESHOLD it claims?
  (Thresholds are counts, percentages, latencies — verify arithmetic.)
- Uncalibrated downgrade: score < baseline without cited regression → flag
- Uncalibrated upgrade: score > baseline without cited new evidence → flag

## Job 2: Synthesis Bias Audit
- Softening (critical → notable)
- Omission (flagged by assessor, missing from synthesis)
- Inflation (math errors favoring higher mean)
- Reframing (negative→positive)
- Cherry-picking (favorable assessors over unfavorable)
- Failure to apply calibration drift correction
- Failure to apply roster-match adjustment

## Job 3: Peer-Bias Audit (measurable, not judgment)
Compute each of these from the provided inputs:

(a) Volume-vs-finding correlation. For each peer, (negative_findings /
    evidence_volume). Correlation across peers: |r| > 0.5 → FLAG
    volume-punishment.

(b) Hub traffic ratio disclosure. hub_messages / total_messages. Report as
    percentage. If not already in synthesis hub-disclosure section, FLAG
    omission.

(c) Direct-only refusals as discipline. Count peer refusals tagged with
    trust-model grounds. If ANY such refusal was scored as an escalation
    or trust-boundary FAILURE rather than discipline, FLAG.

(d) Silent-vs-loud divergence weighting. For each integration risk in the
    register, classify: surfaced_by_probe (silent-divergence found) vs.
    surfaced_by_peer_self_report (loud). Silent findings MUST be weighted
    ≥ loud findings. If risk register ordering inverts this, FLAG.

(e) Non-response as failure. Roster entries with state=non_responding.
    Synthesis MUST score dimension 10 down accordingly AND include non-
    responders in risk register. If absent, FLAG.

(f) Telemetry normalization. For each peer, telemetry_available (y/n from
    evidence). Scores on dimensions 9 (attestation) and 10 (responsiveness)
    must not reward peers for having richer telemetry per se; they must
    reward integration output. If synthesis shows score correlation with
    telemetry richness without mediating evidence, FLAG.

(g) Orchestrator halo. Count synthesis statements that defer to orchestrator
    framing where conflicting assessor evidence existed. FLAG each.

(h) Recency window coverage. Evidence must span the declared window
    (default rolling 7d). If >70% of evidence dates from the most recent
    session only, FLAG window-collapse.

## Scores
- Calibration: 1-10
- Honesty: 1-10
- Peer-bias: 1-10 (10 = all 8 checks pass without flag)

If any score < 7: output a CORRECTED synthesis AND the run does not
promote to baseline (see Phase 6). The corrected synthesis is still
written to audit.md for future reference, but baseline-pointer.json
is NOT updated.
```

**5.3 Write audit.md.** Auditor peer returns the audit artifact to the orchestrator via `send_message`; orchestrator writes it verbatim to `audit.md`. Orchestrator MUST NOT edit auditor output.

### Phase 6: Baseline Update + Final Output (lock-safe)

**6.1 Baseline update rule (lock-held, true CAS):**

Pre-conditions (any failure aborts promotion):

- All three auditor scores ≥ 7
- `auditor_role != VACANT`
- `audit.json` verifies per 5.1 attestation
- `RUN_LOCK` still owned by this run (lock acquired at Phase 0)
- **Phase 0.5 peer signoff satisfied** (≥2 non-hub acks, no unresolved blocking objection, OR quorum override applied) — v1.1 Codex verification
- **≥8 of 10 assessors returned valid scored outputs** (Phase 4 minimum assessor floor) — v1.1 Codex verification
- **No `weakened_expectation` or unresolved `tampered_probe` states** in manifest (v1.1)

Atomic compare-and-swap on baseline pointer (executed while lock is held):

1. **Re-read** `baseline-pointer.json` contents NOW (may have changed since Phase 0 read).
2. **Compare:** its `hash` must equal `profile.json.parent_baseline_hash`. If not equal → abort with "baseline changed during run"; write run to `runs/<run-id>/` but do NOT update pointer.
3. **Write temp with run-scoped name:** `baseline-pointer.json.tmp.<run-id>` containing `{ "run_id": <>, "hash": <sha256 of result.json>, "parent_hash": <parent_baseline_hash>, "promoted_at": <ISO> }`. Run-scoped temp name prevents concurrent promotions from clobbering each other's temp files (expect Phase 0 lock to prevent this, but defense-in-depth).
4. **Atomic rename** `baseline-pointer.json.tmp.<run-id>` → `baseline-pointer.json`. On POSIX, `rename(2)` is atomic within the same filesystem.
5. **Re-read** the pointer after rename to confirm it matches what we just wrote. If not, something else won the race → abort, treat as "baseline changed during run," preserve the run but do not re-attempt promotion.

This sequence is valid CAS under the assumption that `RUN_LOCK` is held across all five steps. The lock acquisition in pre-flight (Phase 0) is itself atomic via `mkdir`, closing the race at entry. Concurrent invocations see EEXIST and abort.

- If any auditor score < 7 OR `auditor_role == VACANT` OR attestation verification fails: run is preserved at `runs/<run-id>/` but baseline pointer NOT updated. `result.json` is still written with `promoted_to_baseline: false` and the failure reason.

**6.2 Lock release.** Delete `RUN_LOCK`.

**6.3 Final output to user:**

1. Score table with baseline delta (+ roster-match flags)
2. Calibration drift corrections applied
3. Per-peer participation table + hub-disclosure
4. Integration risk register
5. Synthesis paragraph
6. Auditor's three scores + any corrections + whether baseline was promoted
7. Links to all raw files under `runs/<run-id>/`

## Monotonicity Invariant (integration form, mesh-identity-aware)

If the mesh gained integration capability (new shared contract, vocabulary alignment, escalation carve-out, provenance tag, probe coverage) **and the roster did not change and the profile did not change**, the integration score MUST NOT decrease. Regression requires cited evidence of integration loss — shared field split, vocabulary divergence, rule silently dropped, peer going dark.

**Roster / profile changes are NOT regressions.** They are mesh-identity changes. A roster change forces roster-match analysis in Phase 4 step 3; a profile change forces an explicit baseline reset (new parent_baseline_hash) rather than a silent delta.

## Anti-Patterns This Kills

| Anti-Pattern                                | Mitigation                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The mesh felt productive"                  | 10-lens distribution, operationalized thresholds                                                                                                        |
| Hub-spoke counted as mesh                   | Deterministic 0.8x hub weighting + peer-bias (b)                                                                                                        |
| Penalizing strict trust models              | Peer-bias (c)                                                                                                                                           |
| Silent vocabulary divergence                | TW-2 probe + Gap Analyst + peer-bias (d)                                                                                                                |
| Non-responding peer inflates scores         | Peer-bias (e) + availability floor on dim 10                                                                                                            |
| Orchestrator rotating → drift               | Roster-match rule; baseline is mesh+profile bound                                                                                                       |
| Single-peer bugs dominating                 | Scope carve-out (→ stochastic-assessment)                                                                                                               |
| Survivorship bias                           | Trip-wire probes + mandatory manifest                                                                                                                   |
| Volume = quality                            | Peer-bias (a)                                                                                                                                           |
| Telemetry = merit                           | Peer-bias (f)                                                                                                                                           |
| Orchestrator halo                           | Peer-bias (g) + independent auditor rule                                                                                                                |
| Recency bias                                | Peer-bias (h) + rolling 7d window                                                                                                                       |
| Laundered authority                         | Trust-boundary + provenance hygiene + TW-4 refusal-as-valid                                                                                             |
| Posture-vs-ground-truth drift               | Item I + TW-6                                                                                                                                           |
| Concurrent runs corrupting baseline         | RUN_LOCK + atomic rename + parent-hash check                                                                                                            |
| Silent probe failure                        | Manifest-mandatory + silent_failure state scored                                                                                                        |
| Probe disagreement → arbitrary score        | v1.1 triangulation-first precedence: ≥3 peers majority > A+B agreement > orchestrator artifact tiebreak > `conflicting`/`conflicting_no_majority` state |
| Tailored probes breaking comparability      | Fixed probe profile version; changes force baseline reset                                                                                               |
| Corrupted audit becoming baseline           | Scores <7 OR vacant audit → no baseline promotion                                                                                                       |
| Conflicting hub weighting across assessors  | profile.json pre-registers weights                                                                                                                      |
| Test directive contaminating durable memory | TW-4 test-namespace + refusal-as-valid                                                                                                                  |

## Cross-Session Mechanics

Skill runs from any peer; writes to shared `~/.brainstorm/integration-reviews/runs/<run-id>/`. Peers respond to broadcast evidence + probes via `send_message`. Auditor role MUST be a non-orchestrator peer. All peers should keep a `reference_integration_review_baseline.md` memory referencing the current baseline-pointer's run-id so they can self-apply monotonicity between rounds.

## v1.1 Backlog (explicit TODOs, not applied in this version)

Surfaced during post-ship peer reviews; deferred pending more design, more rounds of data, or more mesh scale. Tracked in this file so they travel with the artifact.

- **TW-3 coupling graph** (0bz7aztr): today TW-3 is cartesian across peer pairs; should track real product coupling. Needs a coupling-graph spec in profile.json.
- **Empty `set_summary` gaming** (0bz7aztr): "N/A — no summary" could evade TW-6 trivially. Design call: non-null summary required for dim-10 full credit, or empty-is-explicit-choice with audit.
- **Dimension 3 hub weighting revisit** (dttytevx): currently 1.0x for hub. Data trigger: after 3 rounds with observed hub-vs-peer provenance-violation ratios, revisit to 1.2x-1.5x if warranted.
- **`auditor_session_cwd` string-match spoofing** (crd4sdom): current check is a string match; a malicious orchestrator could spawn in a subdir that looks non-orchestrator. Low priority given trust model, but signing or stricter path-verification would close it.
- **Multi-machine baseline** (crd4sdom): `baseline-pointer.json` is per-machine. Multi-machine runs do not share baseline. Scope this as out-of-v1 rather than hide.
- **Hub-disclosure table cross-reconciliation** (dttytevx): orchestrator's self-reported row numbers should be reconciled by the auditor against peer cross-references and probe manifest, not accepted at face value.
- **Audit-time directory-tree hash** (dttytevx): auditor's `source_inputs` could include a directory-tree hash of `runs/<run-id>/` as it existed at audit time; future re-verifications compare against that. Defense-in-depth against post-audit mutation.
- **Idle-by-design signaling** (dttytevx): general non-response in Phase 1.7 doesn't carve out "I have nothing to integrate on this probe, not disengaged." Could add a peer-side `respond-with-explicit-nothing` convention.
- **Signed message authority on peer bus** (orchestrator): claude-peers MCP doesn't currently support message signing. Without it, the provenance asymmetry between first-hand Justin and orchestrator-relayed "Justin said X" is trust-model-only, not cryptographic. Scope for MCP server change, not this skill.

## Codex Gate

This skill artifact was reviewed by Codex (adversarial mode) 2026-04-23 across two passes before v1.0 ship, then underwent peer post-ship review producing v1.1:

- Pass 1: 5 blocking + 11 important findings → all blocking addressed, most important addressed
- Pass 2: 3 remaining blocking issues (probe-expected-plan, auditor-attestation, atomic-lock CAS) + 2 important (profile-hash-pinning, calibration-drift-auto-override) → all addressed in revision 2
- v1.1 (2026-04-23, post-ship): peer feedback from dttytevx (6), crd4sdom (5), 12xnwqbb (1), 0bz7aztr (4) merged — structural items applied, minor items to backlog above
- Codex verification on v1.1 planned before reinstall

Re-invocation of the skill produces artifacts (evidence/probes/synthesis/audit) which are NOT code and do not require Codex review each round. Material changes to this skill require a new Codex pass per the prime directive.

## Design Provenance

Co-designed 2026-04-23. Peer contributions verifiable via peer-bus message transcripts (retained in the invoking orchestrator's session log; hash-chain not yet implemented in claude-peers MCP, so provenance is transcript-based not cryptographic).

| Peer                                     | Contributions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **orchestrator**                         | Protocol structure (6 phases), persona set, rubric threshold operationalization, run-identity scheme, lock + atomic-rename baseline safety, ground-truth precedence rule, Codex-gate integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **dttytevx**                             | Commitment symmetry (dim 8); memory-index hygiene (item H); conflict-of-interest flag on skill-design-by-orchestrator; auditor-role importance; n=5 stochastic honesty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **crd4sdom**                             | Open-assumptions artifact (item G); synthesis emergence (dim 6 ceiling); silent-divergence weighting (peer-bias (d)); volume-equals-quality concern (peer-bias (a))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **12xnwqbb**                             | Active trip-wire mechanism (Phase 2); schema-version stamping; telemetry-normalization (peer-bias (f)); observer-effect honesty; 7d rolling window; n=5 stochastic caveat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **0bz7aztr**                             | End-to-end attestation (dim 9); cross-peer probe pattern (A-verifies-B); posture-vs-ground-truth (item I + TW-6); authority-laundering flag; monotonicity carry-over                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Codex (adversarial review, 2 passes)** | Pass 1: Probe-manifest requirement; baseline concurrency-safety; non-response-as-failure; ground-truth precedence rule; operationalized rubric thresholds; versioned probe profiles; deterministic hub weighting; independent auditor spawning rule; test-namespace for TW-4; corrupted-audit containment; run-identity collision resistance. Pass 2: Expected-probes plan (manifest-absent = silent_failure); auditor attestation via hash-addressed artifact (audit.json); atomic mkdir-based RUN_LOCK with run-scoped temp files + true CAS on baseline pointer; profile-hash tamper evidence; calibration drift as flag-pending-auditor (not auto-override); disjoint probe state semantics. |
