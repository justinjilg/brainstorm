import { Command } from "commander";

/**
 * `brainstorm status` — ecosystem-wide health view.
 *
 * Pulls /health from each known product (MSP, BR, GTM, VM, Shield) plus the
 * Edge surface where available. Concise human-readable output by default;
 * --json emits machine-parseable summary for scripting.
 *
 * Plan reference: P0/Wk1 #59 of radiant-petting-kitten rev 2 (Primitive 4).
 * The pre-existing `brainstorm router status` stays under its own subcommand
 * for backwards compat; this top-level command is the operator's single-pane
 * view of the unified ecosystem.
 */

interface ProductTarget {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  hasEdgeProtocol: boolean; // true for MSP + VM in the unified architecture
}

const PRODUCTS: ProductTarget[] = [
  {
    id: "msp",
    displayName: "brainstormMSP",
    baseUrl: process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai",
    apiKeyEnv: "BRAINSTORM_MSP_API_KEY",
    hasEdgeProtocol: true,
  },
  {
    id: "br",
    displayName: "BrainstormRouter",
    baseUrl:
      process.env.BRAINSTORM_BR_URL ?? "https://api.brainstormrouter.com",
    apiKeyEnv: "BRAINSTORM_API_KEY",
    hasEdgeProtocol: false,
  },
  {
    id: "gtm",
    displayName: "brainstorm-gtm",
    baseUrl: process.env.BRAINSTORM_GTM_URL ?? "https://catsfeet.com",
    apiKeyEnv: "BRAINSTORM_GTM_API_KEY",
    hasEdgeProtocol: false,
  },
  {
    id: "vm",
    displayName: "brainstormVM",
    baseUrl: process.env.BRAINSTORM_VM_URL ?? "https://app.brainstormvm.com",
    apiKeyEnv: "BRAINSTORM_VM_API_KEY",
    hasEdgeProtocol: true,
  },
  {
    id: "shield",
    displayName: "brainstorm-shield",
    baseUrl:
      process.env.BRAINSTORM_SHIELD_URL ?? "https://shield.brainstorm.co",
    apiKeyEnv: "BRAINSTORM_SHIELD_API_KEY",
    hasEdgeProtocol: false,
  },
];

interface ProductStatus {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  reachable: boolean;
  healthStatus: string | null; // "healthy" | "ok" | "degraded" | null when unreachable
  product: string | null; // self-reported product id from /health body
  version: string | null;
  toolCount: number | null;
  edgeProtocolImplemented: boolean | null; // null when not applicable
  latencyMs: number | null;
  error: string | null;
}

const HEALTH_TIMEOUT_MS = 8000;
const TOOLS_TIMEOUT_MS = 8000;

async function fetchProductStatus(p: ProductTarget): Promise<ProductStatus> {
  const apiKey = process.env[p.apiKeyEnv];
  const status: ProductStatus = {
    id: p.id,
    displayName: p.displayName,
    baseUrl: p.baseUrl,
    apiKeyConfigured: Boolean(apiKey),
    reachable: false,
    healthStatus: null,
    product: null,
    version: null,
    toolCount: null,
    edgeProtocolImplemented: p.hasEdgeProtocol ? false : null,
    latencyMs: null,
    error: null,
  };

  const start = Date.now();
  try {
    const healthRes = await fetch(`${p.baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    status.latencyMs = Date.now() - start;
    status.reachable = true;
    if (healthRes.ok) {
      try {
        const body = (await healthRes.json()) as Record<string, unknown>;
        status.healthStatus =
          (body.status as string) ?? (body.health as string) ?? "unknown";
        status.product = (body.product as string) ?? null;
        status.version = (body.version as string) ?? null;
      } catch {
        status.healthStatus = `http-${healthRes.status}`;
      }
    } else {
      status.healthStatus = `http-${healthRes.status}`;
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    return status;
  }

  if (apiKey) {
    try {
      const toolsRes = await fetch(`${p.baseUrl}/api/v1/god-mode/tools`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TOOLS_TIMEOUT_MS),
      });
      if (toolsRes.ok) {
        const data = (await toolsRes.json()) as { tools?: unknown[] };
        status.toolCount = Array.isArray(data.tools) ? data.tools.length : 0;
      }
    } catch {
      // Tools fetch failure is non-fatal — keep health status from above.
    }
  }

  if (p.hasEdgeProtocol) {
    // Cheap probe: does /api/v1/edge/heartbeat exist? Any non-404 means the
    // route is mounted (likely 400/401 for an empty request without auth).
    try {
      const probe = await fetch(`${p.baseUrl}/api/v1/edge/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      status.edgeProtocolImplemented = probe.status !== 404;
    } catch {
      status.edgeProtocolImplemented = false;
    }
  }

  return status;
}

function formatStatusBadge(s: ProductStatus): string {
  if (!s.reachable) return "✗ unreachable";
  if (s.healthStatus === "healthy" || s.healthStatus === "ok") return "✓ ok";
  if (s.healthStatus?.startsWith("http-")) return `△ ${s.healthStatus}`;
  return `△ ${s.healthStatus ?? "unknown"}`;
}

function renderTable(statuses: ProductStatus[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  Brainstorm Ecosystem Status");
  lines.push("");
  lines.push(
    "  " +
      "Product".padEnd(18) +
      "Status".padEnd(20) +
      "Latency".padEnd(10) +
      "Tools".padEnd(8) +
      "Edge",
  );
  lines.push(
    "  " +
      "─".repeat(18) +
      "─".repeat(20) +
      "─".repeat(10) +
      "─".repeat(8) +
      "────",
  );
  for (const s of statuses) {
    const tools =
      s.toolCount === null
        ? s.apiKeyConfigured
          ? "?"
          : "(no key)"
        : String(s.toolCount);
    const edge =
      s.edgeProtocolImplemented === null
        ? "n/a"
        : s.edgeProtocolImplemented
          ? "yes"
          : "no";
    const latency = s.latencyMs === null ? "—" : `${s.latencyMs}ms`;
    lines.push(
      "  " +
        s.displayName.padEnd(18) +
        formatStatusBadge(s).padEnd(20) +
        latency.padEnd(10) +
        tools.padEnd(8) +
        edge,
    );
  }
  lines.push("");
  // Print configuration hints for any unreachable / unconfigured products.
  const issues = statuses.filter((s) => !s.reachable || !s.apiKeyConfigured);
  if (issues.length > 0) {
    lines.push("  Notes:");
    for (const s of issues) {
      if (!s.apiKeyConfigured) {
        lines.push(
          `    ${s.displayName}: set ${envHintFor(s.id)} to query tools`,
        );
      }
      if (!s.reachable && s.error) {
        lines.push(`    ${s.displayName}: ${s.error}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function envHintFor(productId: string): string {
  const map: Record<string, string> = {
    msp: "BRAINSTORM_MSP_API_KEY",
    br: "BRAINSTORM_API_KEY",
    gtm: "BRAINSTORM_GTM_API_KEY",
    vm: "BRAINSTORM_VM_API_KEY",
    shield: "BRAINSTORM_SHIELD_API_KEY",
  };
  return map[productId] ?? "BRAINSTORM_*_API_KEY";
}

/**
 * Register the top-level `status` command on the given Commander program.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show ecosystem-wide health across all known products")
    .option("--json", "Output as JSON")
    .option("--product <id>", "Limit to one product id (msp|br|gtm|vm|shield)")
    .action(async (opts: { json?: boolean; product?: string }) => {
      const targets = opts.product
        ? PRODUCTS.filter((p) => p.id === opts.product)
        : PRODUCTS;
      if (targets.length === 0) {
        console.error(
          `  Unknown --product ${opts.product}. Known: ${PRODUCTS.map((p) => p.id).join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }
      const results = await Promise.all(targets.map(fetchProductStatus));
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      console.log(renderTable(results));
    });
}

// Exported for testing.
export const __test = { fetchProductStatus, formatStatusBadge, PRODUCTS };
