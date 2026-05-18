import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __test } from "../commands/trace.js";

const { W3C_TRACEPARENT_RE, parseTraceparent, renderTimeline, fetchTrace } =
  __test;

describe("brainstorm trace — W3C parsing + timeline render", () => {
  it("rejects malformed traceparent (wrong section lengths)", () => {
    expect(parseTraceparent("00-abc-def-01")).toBeNull();
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    // 31-hex trace_id (one short)
    expect(
      parseTraceparent(
        "00-0123456789abcdef0123456789abcde-0123456789abcdef-01",
      ),
    ).toBeNull();
  });

  it("accepts valid W3C v0 traceparent + extracts trace_id", () => {
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const parsed = parseTraceparent(tp);
    expect(parsed).not.toBeNull();
    expect(parsed!.traceID).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("rejects forbidden W3C identifiers (version=ff, all-zero trace_id, all-zero span_id)", () => {
    // Version ff is reserved per W3C §3.2.2.2.
    expect(
      parseTraceparent(
        "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      ),
    ).toBeNull();
    // All-zero trace_id is invalid per W3C §3.2.2.3.
    expect(
      parseTraceparent(
        "00-00000000000000000000000000000000-b7ad6b7169203331-01",
      ),
    ).toBeNull();
    // All-zero span_id is invalid per W3C §3.2.2.4.
    expect(
      parseTraceparent(
        "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
      ),
    ).toBeNull();
  });

  it("W3C_TRACEPARENT_RE is anchored — won't match a substring", () => {
    const inner = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    expect(W3C_TRACEPARENT_RE.test(`prefix-${inner}`)).toBe(false);
    expect(W3C_TRACEPARENT_RE.test(`${inner}-tail`)).toBe(false);
    expect(W3C_TRACEPARENT_RE.test(inner)).toBe(true);
  });

  it("renderTimeline produces guidance when no records found", () => {
    const out = renderTimeline(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      "0af7651916cd43dd8448eb211c80319c",
      [],
    );
    expect(out).toMatch(/No records yet/);
    expect(out).toMatch(/0af7651916cd43dd8448eb211c80319c/);
  });

  it("renderTimeline emits one row per record + sorted by time", () => {
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const out = renderTimeline(tp, "0af7651916cd43dd8448eb211c80319c", [
      {
        layer: "a2a",
        product: "br",
        at: "2026-05-17T00:00:01Z",
        summary: "mesh invoke",
      },
      {
        layer: "evidence",
        product: "vm",
        at: "2026-05-17T00:00:02Z",
        summary: "envelope sealed",
      },
    ]);
    expect(out).toMatch(/mesh invoke/);
    expect(out).toMatch(/envelope sealed/);
    expect(out.indexOf("mesh invoke")).toBeLessThan(
      out.indexOf("envelope sealed"),
    );
  });
});

describe("brainstorm trace — fetchTrace merges BR + VM sources", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("collects records from BR and VM and sorts chronologically", async () => {
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const traceID = "0af7651916cd43dd8448eb211c80319c";

    globalThis.fetch = (async (url: any) => {
      const s = String(url);
      if (s.includes("/v1/mesh/traces/")) {
        return new Response(
          JSON.stringify({
            records: [
              {
                layer: "a2a",
                product: "br",
                at: "2026-05-17T00:00:02Z",
                summary: "broker accept",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (s.includes("/api/v1/evidence/by-trace/")) {
        return new Response(
          JSON.stringify({
            records: [
              {
                layer: "evidence",
                product: "vm",
                at: "2026-05-17T00:00:01Z",
                summary: "envelope sealed",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const records = await fetchTrace(
      "https://br.example",
      { brToken: "br-tok", vmToken: "vm-tok", vmURL: "https://vm.example" },
      tp,
      traceID,
    );
    expect(records.map((r) => r.summary)).toEqual([
      "envelope sealed",
      "broker accept",
    ]);
  });

  it("sends the BR token to BR and the VM token to VM (per-product keys)", async () => {
    const captured: { url: string; auth: string }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      captured.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>)?.Authorization ?? "",
      });
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }) as typeof globalThis.fetch;

    await fetchTrace(
      "https://br.example",
      {
        brToken: "br-secret",
        vmToken: "vm-secret",
        vmURL: "https://vm.example",
      },
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      "0af7651916cd43dd8448eb211c80319c",
    );

    const brCall = captured.find((c) => c.url.includes("br.example"));
    const vmCall = captured.find((c) => c.url.includes("vm.example"));
    expect(brCall?.auth).toBe("Bearer br-secret");
    expect(vmCall?.auth).toBe("Bearer vm-secret");
  });

  it("returns empty list silently when both endpoints fail", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;

    const records = await fetchTrace(
      "https://br.example",
      { brToken: "br-tok", vmToken: "vm-tok", vmURL: "https://vm.example" },
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      "0af7651916cd43dd8448eb211c80319c",
    );
    expect(records).toEqual([]);
  });
});
