# Stochastic Assessment Audit v10 — 2026-04-18

Auditor role: Calibration & Bias Auditor for v10. Cross-checks
arithmetic, monotonicity, and synthesis faithfulness against the 10
raw agent outputs. v9 baseline overall 5.76; v10 reports 5.96.

## Job 1 — Arithmetic Audit

Reproduced all ten per-dimension sums from the synthesis score matrix:

| Dim    |   Sum |   /10 | Reported | OK                      |
| ------ | ----: | ----: | -------: | ----------------------- |
| Code   | 75.65 | 7.565 |     7.57 | PASS (half-up rounding) |
| Wiring | 68.80 | 6.880 |     6.88 | PASS                    |
| Test   | 66.20 | 6.620 |     6.62 | PASS                    |
| Prod   | 47.75 | 4.775 |     4.78 | PASS                    |
| Ops    | 57.63 | 5.763 |     5.76 | PASS                    |
| Sec    | 66.88 | 6.688 |     6.69 | PASS                    |
| Doc    | 56.75 | 5.675 |     5.68 | PASS                    |
| Fail   | 66.35 | 6.635 |     6.64 | PASS                    |
| Scale  | 39.98 | 3.998 |     4.00 | PASS                    |
| Ship   | 49.98 | 4.998 |     5.00 | PASS                    |

Overall: 59.60 / 10 = 5.960 → 5.96 reported. Matches. Rounding rule is
consistent (half-away-from-zero at the second decimal). No inflation.

σ values not recomputed (not in scope); Security 0.42 is plausible
given the 5.93 → 7.60 spread over N=10.

**Arithmetic result: clean.**

## Job 2 — Monotonicity Audit

Every v10 dimension mean is ≥ v9 mean. Per-agent minima:

- Sec min = 5.93 (Chaos Monkey) = v9 baseline exactly. No regression —
  persona held the line on an out-of-scope dimension.
- Ops min = 5.58 (Chaos Monkey) = v9 baseline. No regression.
- All other per-agent minima ≥ v9 means on their dimensions.

No agent dipped below v9 on any dimension. Monotonicity invariant
held. Synthesis's "no dimension regressed" claim is correct.

**Monotonicity result: clean.**

## Job 3 — Bias Audit & Specific Attacker Claim

### Attacker's Risk #3 — ground truth check

Claim (paraphrased from the raw Attacker output): "`restricted` blocks
dangerous command patterns but still executes on the host with
`process.env` unchanged (line 86 short-circuits scrubbing when level
is `"none"`, and the container path is the only one that scrubs via
`buildChildEnv(currentSandboxLevel)` where level is truthy)."

Actual code at `packages/tools/src/builtin/shell.ts:85-95`:

```ts
export function buildChildEnv(level: SandboxLevel): NodeJS.ProcessEnv {
  if (level === "none") return process.env;
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (SCRUBBED_ENV_NAMES.has(name)) continue;
    if (SCRUBBED_ENV_PATTERN.test(name) && !SCRUBBED_ENV_ALLOWLIST.has(name))
      continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}
```

Line 86 short-circuits **only** when `level === "none"`. For
`"restricted"` (and any other non-`"none"` value), control falls
through to the scrub loop. Both host-spawn sites (`shell.ts:374`,
`shell.ts:485`) call `buildChildEnv(currentSandboxLevel)`, and the
module default at line 106 is `"restricted"`. Tests at
`shell-sandbox.test.ts:176-227` explicitly assert scrubbing under
`"restricted"` — OP_SERVICE_ACCOUNT_TOKEN, provider keys,
pattern-matched unknowns, GITHUB_TOKEN allowlist, and the `"none"`
pass-through.

**Attacker Risk #3 is factually wrong.** The Attacker mis-reads the
control flow: they treat the `"none"` short-circuit as if it were the
scrub body, and they claim the container path is the only scrubber
when in fact the host path is the primary scrubber. The read-write
bind-mount concern attached to the same risk is independently valid,
but the env-inheritance sub-claim is not.

### Did the synthesis flag this contradiction?

**No.** The synthesis simultaneously (a) credits A2 (`buildChildEnv`
scrubs OP_SERVICE_ACCOUNT_TOKEN et al.) as a closed finding and
attributes most of the +0.76 Security gain to it, and (b) carries the
Attacker's 7.60 forward into the Sec mean (66.88) while that same
Attacker is asserting, in writing, that `restricted` doesn't scrub on
the host. Those two agent statements cannot both be true.

This is not score-moving: removing the Attacker's 7.60 drops Sec from
6.69 to 6.54, still +0.61 over v9. But the synthesis is structurally
obliged to either correct the Attacker or discount their Sec score,
and it did neither.

**Bias finding:** faithfulness gap. Not softening, not omission, not
reframing — a missed internal contradiction between the agent pool
and the code.

### Other bias checks

- **Softening:** none found. Risk-register entries quote agents
  sharply ("CI ratchet not wired into `.github/workflows/*.yml`",
  "`buildChildEnv` scrub doesn't catch user-added unusual secret
  names", "Docker `--user=1000:1000` vs host UID mismatch").
- **Omission:** Sr Engineer's UID-mismatch nit and the Attacker's
  GITHUB_TOKEN-exfil note both made the register at 1/10. Chaos
  Monkey's "2/3 chaos-corruption scenarios still open" is the
  headline Most-Flagged Risk. No drops detected.
- **Inflation:** arithmetic already verified clean.
- **Reframing:** "structurally bounded, no telemetry stream" on
  Prod 4.78 is accurate, not spin.
- **Cherry-pick:** Operator's 6.08 high and Chaos Monkey's 5.80 low
  both preserved in the agent table and narrated in Methodology Notes.

## Scores

- **Calibration: 9/10.** Math clean, monotonicity clean, σ plausible.
  One-point deduction: an agent (Attacker) made a factually false
  claim about the code within the scoring round and was not
  recalibrated.
- **Honesty: 7/10.** Synthesis is mostly faithful but failed to flag
  the Attacker's internal contradiction against the A2 closure it
  simultaneously credited. Transparency gap a Calibration & Bias
  Auditor is expected to note.

Both ≥ 7. **No corrected synthesis required.**

## Single-line amendment recommended for the synthesis

Append to Calibration Drift Corrections: "Attacker Risk #3 mis-reads
`buildChildEnv` — line 86 short-circuits only on `"none"`;
`"restricted"` does scrub on the host path (test
`shell-sandbox.test.ts:176-227` asserts this). A2-closed credit stands;
the Attacker's contradicting sub-claim does not. No score adjustment;
contradiction logged."

---

Files referenced:

- `/Users/justin/Projects/brainstorm/packages/tools/src/builtin/shell.ts` (lines 85-95, 106, 374, 485)
- `/Users/justin/Projects/brainstorm/packages/tools/src/__tests__/shell-sandbox.test.ts` (lines 176-227)
- `/Users/justin/Projects/brainstorm/docs/assessment-evidence.md`
- `/Users/justin/Projects/brainstorm/docs/assessment-synthesis.md`
