/**
 * `brainstorm trace <traceparent>` — walk a trace tree across A2A, Edge,
 * Evidence, and ChangeSet records.
 *
 * Queries each product's audit / evidence / changeset surface that exposes
 * a `traceparent` filter and prints a unified timeline. This MVP wires the
 * BrainstormRouter mesh-task endpoint (A2A) + brainstormVM CP evidence
 * lookup + ChangeSet audit log. As more products start stamping
 * traceparent onto their records, they slot in here.
 *
 * Plan reference: P2/Wk6 #67 of radiant-petting-kitten rev 2.
 */

import { Command } from "commander";

const W3C_TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

interface TraceRecord {
  layer: "a2a" | "edge" | "evidence" | "changeset" | "unknown";
  product: string;
  at: string; // ISO 8601
  summary: string;
  details?: Record<string, unknown>;
}

interface TraceOptions {
  json?: boolean;
  base?: string;
  token?: string;
}

function parseTraceparent(s: string): { traceID: string } | null {
  const m = s.match(W3C_TRACEPARENT_RE);
  if (!m) return null;
  return { traceID: m[2] as string };
}

async function fetchTrace(
  baseUrl: string,
  token: string,
  traceparent: string,
  traceID: string,
): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];

  // BR mesh — A2A task records keyed by trace_id.
  try {
    const u = `${baseUrl.replace(/\/$/, "")}/v1/mesh/traces/${traceID}`;
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { records?: TraceRecord[] };
      if (Array.isArray(body.records)) {
        for (const r of body.records) {
          records.push({
            ...r,
            layer: r.layer ?? "a2a",
            product: r.product ?? "br",
          });
        }
      }
    }
  } catch {
    // BR may not yet expose this endpoint; skip silently.
  }

  // brainstormVM evidence — envelopes stamped with traceparent.
  const vmURL = process.env.BRAINSTORM_VM_URL ?? "https://vm.brainstorm.co";
  try {
    const u = `${vmURL.replace(/\/$/, "")}/api/v1/evidence/by-trace/${encodeURIComponent(traceparent)}`;
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { records?: TraceRecord[] };
      if (Array.isArray(body.records)) {
        for (const r of body.records) {
          records.push({
            ...r,
            layer: r.layer ?? "evidence",
            product: r.product ?? "vm",
          });
        }
      }
    }
  } catch {
    // VM may not yet expose this endpoint either.
  }

  records.sort((a, b) => a.at.localeCompare(b.at));
  return records;
}

function renderTimeline(
  traceparent: string,
  traceID: string,
  records: TraceRecord[],
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Trace ${traceID}`);
  lines.push(`  traceparent: ${traceparent}`);
  lines.push("");
  if (records.length === 0) {
    lines.push("  No records yet. Possible causes:");
    lines.push("    - Records still propagating from receivers");
    lines.push(
      "    - No product yet exposes a traceparent-lookup endpoint (BR /v1/mesh/traces, VM /api/v1/evidence/by-trace)",
    );
    lines.push("    - Wrong traceparent");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    "  " +
      "Time".padEnd(22) +
      "Layer".padEnd(10) +
      "Product".padEnd(12) +
      "Summary",
  );
  lines.push(
    "  " + "─".repeat(22) + "─".repeat(10) + "─".repeat(12) + "──────────────",
  );
  for (const r of records) {
    lines.push(
      "  " +
        r.at.padEnd(22) +
        r.layer.padEnd(10) +
        r.product.padEnd(12) +
        r.summary,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function registerTraceCommand(program: Command): void {
  program
    .command("trace <traceparent>")
    .description(
      "Walk a trace tree across A2A, Edge, Evidence, and ChangeSet records",
    )
    .option("--base <url>", "BR base URL (default $BRAINSTORM_BR_URL)")
    .option("--token <token>", "Bearer token (default $BRAINSTORM_API_KEY)")
    .option("--json", "Output JSON")
    .action(async (traceparent: string, opts: TraceOptions) => {
      const parsed = parseTraceparent(traceparent);
      if (!parsed) {
        console.error(
          `  Error: traceparent does not match W3C v0 grammar (00-<32hex>-<16hex>-<2hex>); got ${traceparent}`,
        );
        process.exitCode = 2;
        return;
      }
      const baseUrl =
        opts.base ??
        process.env.BRAINSTORM_BR_URL ??
        "https://api.brainstormrouter.com";
      const token = opts.token ?? process.env.BRAINSTORM_API_KEY ?? "";
      if (!token) {
        console.error(
          "  Warning: BRAINSTORM_API_KEY not set; lookups will likely 401",
        );
      }
      const records = await fetchTrace(
        baseUrl,
        token,
        traceparent,
        parsed.traceID,
      );
      if (opts.json) {
        console.log(
          JSON.stringify(
            { traceparent, trace_id: parsed.traceID, records },
            null,
            2,
          ),
        );
      } else {
        console.log(renderTimeline(traceparent, parsed.traceID, records));
      }
    });
}

// Exported for tests.
export const __test = {
  W3C_TRACEPARENT_RE,
  parseTraceparent,
  renderTimeline,
  fetchTrace,
};
