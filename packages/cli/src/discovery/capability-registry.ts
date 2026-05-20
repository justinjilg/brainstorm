/**
 * Capability-registry product discovery.
 *
 * Plan ref: Brainstorm Platform v0.4 P3 M32, D11, FF-02.
 *
 * Pre-v0.4, the CLI hard-coded product base URLs via env vars
 * (BRAINSTORM_MSP_URL, BRAINSTORM_VM_URL, etc.). Drawback: if a product
 * went dark, the CLI still listed its tools (stale catalog); adding a
 * new product required redeploying the CLI binary or asking every user
 * to set a new env var.
 *
 * v0.4 fix: query the capability registry (VM CP `/api/v1/capabilities/list`)
 * to discover which products are currently online + their canonical URLs.
 *
 * Backward-compat (FF-02): env vars are still honored if set and emit a
 * deprecation warning. Sunset criterion: 30d after M32 ships; env-var
 * fallback removed in v0.5.
 *
 * Cache: 60s in-process (matches plan D5 client TTL pattern for tenant-svc).
 */

interface DiscoveredProduct {
  /** Stable product id: msp | vm | br | gtm | backup */
  id: string;
  /** Base URL for the product's HTTP API (godmode + capability endpoints). */
  baseUrl: string;
  /** online | degraded | offline (from the registry's heartbeat state). */
  status: "online" | "degraded" | "offline";
  /** Capability count surfaced by the registry. */
  capabilitiesCount: number;
  /** True when sourced from env-var fallback (FF-02 active). */
  fromEnvFallback: boolean;
}

interface RegistryListResponse {
  count: number;
  capabilities: Array<{
    agent_did: string;
    name: string;
    status: string;
  }>;
}

const REGISTRY_BASE =
  process.env.BRAINSTORM_REGISTRY_URL ?? "https://vm.brainstorm.co";
const CACHE_TTL_MS = 60_000;

let cache:
  | {
      products: DiscoveredProduct[];
      fetchedAt: number;
    }
  | undefined;

/**
 * The v0.4 product set. Product ids here are authoritative; the registry
 * tells us which are currently online + their counts.
 *
 * Default URLs are the production deploy targets — they're the fallback
 * when both the registry is unreachable AND no env override is set.
 */
const KNOWN_PRODUCTS: Record<
  string,
  { defaultBaseUrl: string; envVar: string }
> = {
  msp: {
    defaultBaseUrl: "https://brainstormmsp.ai",
    envVar: "BRAINSTORM_MSP_URL",
  },
  br: {
    defaultBaseUrl: "https://api.brainstormrouter.com",
    envVar: "BRAINSTORM_BR_URL",
  },
  gtm: { defaultBaseUrl: "https://catsfeet.com", envVar: "BRAINSTORM_GTM_URL" },
  vm: {
    defaultBaseUrl: "https://vm.brainstorm.co",
    envVar: "BRAINSTORM_VM_URL",
  },
  backup: {
    defaultBaseUrl: "https://backup.brainstorm.co",
    envVar: "BRAINSTORM_BACKUP_URL",
  },
};

/**
 * Discover the live product set via the capability registry. Returns
 * cached result if fresh; refreshes in the background if stale.
 *
 * Token is optional: the registry is readable by any authenticated user;
 * without a token the call returns the public subset (status counts only,
 * no per-tenant capabilities).
 */
export async function discoverProducts(opts?: {
  token?: string;
}): Promise<DiscoveredProduct[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.products;
  }

  const products = await fetchFromRegistry(opts?.token);
  cache = { products, fetchedAt: Date.now() };
  return products;
}

/**
 * Resolve a single product to its baseUrl. Honors env-var fallback
 * (with deprecation warning), then registry, then default.
 *
 * Plan ref: FF-02 — env-var fallback sunsets 30d after M32 ships.
 */
export async function resolveProductBaseUrl(
  productId: string,
): Promise<string> {
  const known = KNOWN_PRODUCTS[productId];
  if (!known) {
    throw new Error(`unknown product id: ${productId}`);
  }

  // FF-02: env override wins if set, emits deprecation warning.
  const envOverride = process.env[known.envVar];
  if (envOverride) {
    warnEnvDeprecation(known.envVar);
    return envOverride;
  }

  // Try registry.
  try {
    const products = await discoverProducts();
    const p = products.find((q) => q.id === productId);
    if (p && p.status !== "offline") {
      return p.baseUrl;
    }
  } catch {
    // Registry unreachable — fall through to default.
  }

  // Default URL (always the production deploy target).
  return known.defaultBaseUrl;
}

async function fetchFromRegistry(token?: string): Promise<DiscoveredProduct[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const url = `${REGISTRY_BASE}/api/v1/capabilities/list`;
  const resp = await fetch(url, { headers });

  if (!resp.ok) {
    throw new Error(`registry list ${resp.status}`);
  }

  const body = (await resp.json()) as RegistryListResponse;

  // Aggregate by product (derived from agent_did's product slot:
  // did:bvm:<tenant>:<product>:<short>).
  const byProduct = new Map<
    string,
    { count: number; allOffline: boolean; anyOnline: boolean }
  >();
  for (const cap of body.capabilities ?? []) {
    const product = parseProductFromDID(cap.agent_did);
    if (!product || !KNOWN_PRODUCTS[product]) continue;
    const entry = byProduct.get(product) ?? {
      count: 0,
      allOffline: true,
      anyOnline: false,
    };
    entry.count++;
    if (isCapabilityStatusInvokable(cap.status)) {
      entry.anyOnline = true;
      entry.allOffline = false;
    }
    byProduct.set(product, entry);
  }

  return Object.entries(KNOWN_PRODUCTS).map(([id, cfg]) => {
    const entry = byProduct.get(id);
    const status: "online" | "degraded" | "offline" = !entry
      ? "offline"
      : entry.allOffline
        ? "offline"
        : entry.anyOnline
          ? "online"
          : "degraded";
    return {
      id,
      baseUrl: cfg.defaultBaseUrl,
      status,
      capabilitiesCount: entry?.count ?? 0,
      fromEnvFallback: false,
    };
  });
}

export function parseProductFromDID(did: string): string | undefined {
  // did:bvm:<tenant>:<product>:<short>
  const parts = did.split(":");
  if (parts.length < 5 || parts[0] !== "did" || parts[1] !== "bvm") {
    return undefined;
  }
  return parts[3];
}

export function isCapabilityStatusInvokable(
  status: string | undefined,
): boolean {
  return status === "active";
}

const warnedEnvVars = new Set<string>();
function warnEnvDeprecation(envVar: string): void {
  if (warnedEnvVars.has(envVar)) return;
  warnedEnvVars.add(envVar);
  // stderr — doesn't interfere with stdout JSON output.
  process.stderr.write(
    `[deprecation] ${envVar} is honored for backwards compatibility but will be removed in v0.5. ` +
      `The CLI now discovers product URLs via the capability registry; unset this env var to use the registry value.\n`,
  );
}

/** Test hook — reset the cache between tests. Not for production use. */
export function _resetCacheForTests(): void {
  cache = undefined;
  warnedEnvVars.clear();
}
