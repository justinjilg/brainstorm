import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __test } from "../commands/evidence.js";

const { renderHuman, SECTIONS, fetchReport } = __test;

function passingReport() {
  const base = {
    lineage_did: "did:bvm:acme:researcher",
    generated_at: "2026-05-17T00:00:00Z",
  };
  const ok = (summary: string) => ({ ok: true, summary });
  return {
    ...base,
    chain: ok("12 envelopes, 0 sig failures, prev_hash intact"),
    lineage: ok("2 instances, 1 signed replacement event"),
    manifest: ok("autonomy=L2, 3 capabilities registered"),
    quota: ok("417 brokered, 0 rejected"),
    policy: ok("2 high-risk ChangeSets held pending_approval"),
    lifecycle: ok("boot→running→killed→replaced"),
    intent: ok("8 A2A invocations linked via traceparent"),
    replace: ok("DID continuity verified across instance replacement"),
  };
}

describe("brainstorm evidence verify — human render", () => {
  it("renders every section line in pass state", () => {
    const out = renderHuman(passingReport() as any);
    for (const s of SECTIONS) {
      expect(out).toContain(`[${s.label}]`);
    }
    expect(out).toMatch(/Overall:\s+✓ PASS/);
  });

  it("flags overall FAIL if any section is not ok", () => {
    const r = passingReport() as any;
    r.chain = { ok: false, summary: "1 hash mismatch at envelope 7" };
    const out = renderHuman(r);
    expect(out).toMatch(/Overall:.*FAIL/);
    expect(out).toMatch(/\[CHAIN\] ✗ 1 hash mismatch/);
  });

  it("handles missing sections gracefully", () => {
    const r = passingReport() as any;
    delete r.replace;
    const out = renderHuman(r);
    expect(out).toMatch(/\[REPLACE\].*missing section/);
    expect(out).toMatch(/Overall:.*FAIL/);
  });
});

describe("brainstorm evidence verify — fetchReport", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls /api/v1/evidence/lineage/<encoded did> with bearer auth", async () => {
    const captured: { url: string; auth: string } = { url: "", auth: "" };
    globalThis.fetch = (async (url: any, init: any) => {
      captured.url = String(url);
      captured.auth =
        (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(JSON.stringify(passingReport()), { status: 200 });
    }) as typeof globalThis.fetch;

    const { status, body } = await fetchReport(
      "https://vm.example",
      "tok",
      "did:bvm:acme:researcher",
    );
    expect(status).toBe(200);
    expect((body as any).lineage_did).toBe("did:bvm:acme:researcher");
    expect(captured.url).toBe(
      "https://vm.example/api/v1/evidence/lineage/did%3Abvm%3Aacme%3Aresearcher",
    );
    expect(captured.auth).toBe("Bearer tok");
  });

  it("surfaces a 404 with null body cleanly (no JSON parse throw)", async () => {
    globalThis.fetch = (async () =>
      new Response("lineage not found", {
        status: 404,
      })) as typeof globalThis.fetch;
    const { status, body } = await fetchReport(
      "https://vm.example",
      "tok",
      "did:bvm:acme:researcher",
    );
    expect(status).toBe(404);
    expect(body).toBeNull();
  });
});
