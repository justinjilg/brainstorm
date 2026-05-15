/**
 * Live BR contract test — drift ratchet (Path-to-90 P5).
 *
 * Hits api.brainstormrouter.com with the community key and asserts:
 *   1. The set of `x-br-*` headers in a live `/v1/chat/completions` response
 *      is a subset of CANONICAL_BR_HEADERS (no surprise drift).
 *   2. `/openapi.json` is reachable and returns ≥ 100 paths (BR contract size
 *      floor; deliberate-bump-only).
 *   3. `/v1/discovery` memory blocks match the canonical list the CLI uses
 *      for `br_memory_store` block-validation (catches the drift class
 *      that PR #302 fixed).
 *
 * This test is the CI ratchet against the failure mode 8 of 10 v14
 * assessment agents flagged ("BR envelope drop on hot path" + "no live
 * BR contract probes"). If it fails, BR added a header / changed a path /
 * renamed a memory block and our consumers need to update.
 *
 * Skipped unless `RUN_LIVE_BR=1`. CI workflow `.github/workflows/br-contract.yml`
 * sets the env var so the test runs on every PR + nightly cron. Local
 * runs are clean by default — `npm test` does NOT hit BR.
 */

import { describe, it, expect } from "vitest";
import { parseBrEnvelope, CANONICAL_BR_HEADERS } from "../cloud/br-envelope.js";

const LIVE_GATE = process.env.RUN_LIVE_BR === "1";

// Community key is INTENTIONALLY PUBLIC (see br-intelligence.ts:128 and
// docs/brainstormrouter-integration.md). Rate-limited to 10 RPM, budget
// capped at $5/month. Sufficient for one /chat/completions call per CI run.
const COMMUNITY_KEY =
  "br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a";

const BR_BASE = "https://api.brainstormrouter.com";

// Memory blocks the CLI hardcodes in br_memory_store
// (packages/tools/src/builtin/br-intelligence.ts:143).
// If BR changes this list, the test fails and the CLI's Zod enum must update.
const CLI_MEMORY_BLOCKS = ["human", "system", "project", "general"] as const;

describe.skipIf(!LIVE_GATE)("BR live contract ratchet (RUN_LIVE_BR=1)", () => {
  it("/v1/chat/completions response x-br-* headers are a subset of CANONICAL_BR_HEADERS", async () => {
    const res = await fetch(`${BR_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COMMUNITY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    // Drain body so the connection closes cleanly under CI runners.
    await res.text();
    expect(res.status, `BR returned ${res.status}`).toBeLessThan(500);

    const envelope = parseBrEnvelope(res.headers);
    // The drift detection signal: any x-br-* header BR emitted that our
    // canonical list doesn't recognise. Failing this test means BR
    // shipped a new header and our parser needs CANONICAL_BR_HEADERS
    // updated PLUS a typed field on BrEnvelope. Auto-fix by inspecting
    // the actual response headers, adding the new field, and bumping
    // the canonical list in the SAME PR.
    expect(
      envelope.unknownHeaders,
      "unexpected x-br-* headers from BR",
    ).toEqual([]);

    // Smoke check: at least the high-value identity/routing headers are
    // present. If they're missing, the BR envelope contract is broken
    // upstream and we shouldn't ratchet against an empty response.
    expect(envelope.build, "x-br-build should be present").toBeDefined();
    expect(
      envelope.routedModel,
      "x-br-routed-model should be present",
    ).toBeDefined();
    expect(envelope.envelope, "x-br-envelope should be present").toBeDefined();
  });

  it("/openapi.json is reachable with ≥100 documented paths", async () => {
    const res = await fetch(`${BR_BASE}/openapi.json`, {
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.ok, `openapi.json returned ${res.status}`).toBe(true);
    const spec = (await res.json()) as { paths?: Record<string, unknown> };
    const pathCount = Object.keys(spec.paths ?? {}).length;
    // Floor: 100 is well below the documented 144 (2026-05-15) but high
    // enough to catch a "BR contract collapsed to a few endpoints"
    // regression. Bump as the contract grows; don't shrink.
    expect(pathCount, "BR openapi.json path count").toBeGreaterThanOrEqual(100);
  });

  it("/v1/discovery memory blocks match the CLI's hardcoded enum", async () => {
    const res = await fetch(`${BR_BASE}/v1/discovery`, {
      headers: { Authorization: `Bearer ${COMMUNITY_KEY}` },
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.ok, `discovery returned ${res.status}`).toBe(true);
    const body = (await res.json()) as {
      capabilities?: { memory?: { blocks?: string[] } };
      memory?: { blocks?: string[] };
    };
    // BR currently nests memory under capabilities; older docs showed a
    // top-level shape. Tolerate both — if BR canonicalises one path we
    // can drop the fallback.
    const liveBlocks =
      body.capabilities?.memory?.blocks ?? body.memory?.blocks ?? [];
    // Set-equality check — order may vary but contents must match.
    // If this fails, the CLI's Zod enum in
    // packages/tools/src/builtin/br-intelligence.ts:143 must update,
    // and so must this test's CLI_MEMORY_BLOCKS sentinel.
    expect(
      [...liveBlocks].sort(),
      "BR /v1/discovery memory.blocks vs CLI hardcoded enum",
    ).toEqual([...CLI_MEMORY_BLOCKS].sort());
  });

  it("CANONICAL_BR_HEADERS hasn't drifted below the floor", () => {
    // Sanity floor: deliberate-bump-only. Tracks the schema version
    // captured 2026-05-15. Drops indicate someone deleted a canonical
    // header without updating the path-to-90 plan.
    expect(CANONICAL_BR_HEADERS.length).toBeGreaterThanOrEqual(33);
  });
});

// Self-document the skip path so a developer running `npm test` locally
// sees the gate condition rather than thinking the suite is empty.
describe("BR live contract ratchet — skip self-check", () => {
  it("documents the live-test gate", () => {
    if (!LIVE_GATE) {
      // eslint-disable-next-line no-console
      console.log(
        "[br-live-contract] skipped — set RUN_LIVE_BR=1 to run against api.brainstormrouter.com",
      );
    }
    expect(true).toBe(true);
  });
});
