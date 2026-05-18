/**
 * `brainstorm evidence verify --lineage <did> [--format human|json]` —
 * v0.1 ratification surface defined in P5/Wk12 #73 of
 * radiant-petting-kitten rev 2 (Phase G of the end-to-end verification
 * sequence).
 *
 * Walks the evidence chain rooted at a HAI lineage_did and reports
 * (in either human or JSON form):
 *   - CHAIN     hash-link integrity + Dilithium signature verification
 *   - LINEAGE   identity continuity across instance replacements
 *   - MANIFEST  capabilities + autonomy registered for the lineage
 *   - QUOTA     LLM calls brokered + rejected at the per-agent BR key
 *   - POLICY    constitutional gate decisions on agent-initiated CS
 *   - LIFECYCLE boot → running → killed → replaced trail per instance
 *   - INTENT    A2A invocations linked by W3C traceparent
 *   - REPLACE   instance_did → instance_did transitions, each with
 *               a CP-signed replacement event
 *
 * Talks to brainstormVM CP `/api/v1/evidence/lineage/{lineage_did}`
 * which returns the precomputed report. This CLI surface formats it
 * for the operator; the verification math lives server-side because
 * the CP holds the canonical chain.
 */

import { Command } from "commander";

interface VerifyOptions {
  lineage?: string;
  format?: "human" | "json";
  vmUrl?: string;
  vmToken?: string;
}

interface SectionStatus {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

interface VerifyReport {
  lineage_did: string;
  generated_at: string;
  chain: SectionStatus;
  lineage: SectionStatus;
  manifest: SectionStatus;
  quota: SectionStatus;
  policy: SectionStatus;
  lifecycle: SectionStatus;
  intent: SectionStatus;
  replace: SectionStatus;
}

const SECTIONS: Array<{
  key: keyof VerifyReport;
  label: string;
}> = [
  { key: "chain", label: "CHAIN" },
  { key: "lineage", label: "LINEAGE" },
  { key: "manifest", label: "MANIFEST" },
  { key: "quota", label: "QUOTA" },
  { key: "policy", label: "POLICY" },
  { key: "lifecycle", label: "LIFECYCLE" },
  { key: "intent", label: "INTENT" },
  { key: "replace", label: "REPLACE" },
];

function isSectionStatus(v: unknown): v is SectionStatus {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SectionStatus).ok === "boolean" &&
    typeof (v as SectionStatus).summary === "string"
  );
}

export function renderHuman(report: VerifyReport): string {
  const overallOk = SECTIONS.every((s) =>
    isSectionStatus(report[s.key])
      ? (report[s.key] as SectionStatus).ok
      : false,
  );
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Evidence verify — ${report.lineage_did}`);
  lines.push(`  Generated:       ${report.generated_at}`);
  lines.push(
    `  Overall:         ${overallOk ? "✓ PASS" : "✗ FAIL — see sections below"}`,
  );
  lines.push("");
  for (const s of SECTIONS) {
    const v = report[s.key];
    if (!isSectionStatus(v)) {
      lines.push(`  [${s.label}] (missing section)`);
      continue;
    }
    const tick = v.ok ? "✓" : "✗";
    lines.push(`  [${s.label}] ${tick} ${v.summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function fetchReport(
  baseUrl: string,
  token: string,
  lineageDID: string,
): Promise<{ status: number; body: unknown }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/evidence/lineage/${encodeURIComponent(
    lineageDID,
  )}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* keep null */
  }
  return { status: res.status, body };
}

export function registerEvidenceCommand(program: Command): void {
  const cmd = program
    .command("evidence")
    .description("Evidence-chain operations");

  cmd
    .command("verify")
    .description("Verify a HAI lineage chain end-to-end (Phase G ratification)")
    .requiredOption("--lineage <did>", "lineage_did to verify")
    .option(
      "--format <fmt>",
      "Output format (human | json)",
      (v): "human" | "json" => {
        if (v !== "human" && v !== "json") {
          throw new Error(`unknown format ${v}: must be 'human' or 'json'`);
        }
        return v;
      },
      "human",
    )
    .option(
      "--vm-url <url>",
      "brainstormVM CP URL (default $BRAINSTORM_VM_URL)",
    )
    .option(
      "--vm-token <token>",
      "VM bearer token (default $BRAINSTORM_VM_API_KEY)",
    )
    .action(async (opts: VerifyOptions) => {
      const baseUrl =
        opts.vmUrl ??
        process.env.BRAINSTORM_VM_URL ??
        "https://vm.brainstorm.co";
      const token = opts.vmToken ?? process.env.BRAINSTORM_VM_API_KEY ?? "";
      if (!token) {
        console.error(
          "  Error: BRAINSTORM_VM_API_KEY not set (or pass --vm-token).",
        );
        process.exitCode = 2;
        return;
      }
      if (!opts.lineage || !opts.lineage.startsWith("did:bvm:")) {
        console.error(
          `  Error: --lineage must be a did:bvm:... lineage DID (got ${opts.lineage})`,
        );
        process.exitCode = 2;
        return;
      }

      try {
        const { status, body } = await fetchReport(
          baseUrl,
          token,
          opts.lineage,
        );
        if (status === 404) {
          console.error(
            `  ✗ lineage ${opts.lineage} not found on CP at ${baseUrl}`,
          );
          process.exitCode = 1;
          return;
        }
        if (status >= 400) {
          console.error(`  ✗ HTTP ${status} from CP — ${JSON.stringify(body)}`);
          process.exitCode = 1;
          return;
        }
        const report = body as VerifyReport;
        if (opts.format === "json") {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderHuman(report));
        }
        const overallOk = SECTIONS.every((s) =>
          isSectionStatus(report[s.key])
            ? (report[s.key] as SectionStatus).ok
            : false,
        );
        if (!overallOk) {
          process.exitCode = 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ evidence verify failed: ${msg}`);
        process.exitCode = 1;
      }
    });
}

// Exported for tests.
export const __test = {
  renderHuman,
  isSectionStatus,
  SECTIONS,
  fetchReport,
};
