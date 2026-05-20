export const DEFAULT_BR_BASE_URL = "https://api.brainstormrouter.com";
export const DEFAULT_BR_SITE_URL = "https://brainstormrouter.com";

// Public, rate-limited community key already used by the BR live contract
// ratchet. This is intentionally not a secret.
export const COMMUNITY_BR_KEY =
  "br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a";

export type BusinessHarnessAuthMode =
  | "api_key"
  | "keycloak"
  | "service_jwt"
  | "community_key"
  | "unknown";

export interface BusinessHarnessEnv {
  liveBrEnabled: boolean;
  liveWritesEnabled: boolean;
  recordEnabled: boolean;
  allowRawMemory: boolean;
  brBaseUrl: string;
  brSiteUrl: string;
  apiKey?: string;
  authMode: BusinessHarnessAuthMode;
  actorKind: "operator" | "agent" | "ci";
  sandboxTenantId?: string;
  activeGates: string[];
  warnings: string[];
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

export function loadBusinessHarnessEnv(
  source: NodeJS.ProcessEnv = process.env,
): BusinessHarnessEnv {
  const liveBrEnabled = truthy(source.RUN_LIVE_BR);
  const liveWritesEnabled = truthy(source.RUN_LIVE_BR_WRITES);
  const recordEnabled =
    truthy(source.RECORD_BR_LIVE_DISCOVERY) ||
    truthy(source.RECORD_BUSINESS_HARNESS_TRACE);
  const allowRawMemory = truthy(source.ALLOW_RAW_MEMORY_ARTIFACTS);
  const configuredKey = source.BRAINSTORM_API_KEY?.trim();
  const apiKey = liveBrEnabled
    ? (configuredKey ?? COMMUNITY_BR_KEY)
    : configuredKey;
  const sandboxTenantId = source.BRAINSTORM_SANDBOX_TENANT_ID?.trim();

  if (liveWritesEnabled && !sandboxTenantId) {
    throw new Error(
      "RUN_LIVE_BR_WRITES=1 requires BRAINSTORM_SANDBOX_TENANT_ID. Refusing to run live write-shaped probes.",
    );
  }

  let authMode: BusinessHarnessAuthMode = "unknown";
  if (apiKey === COMMUNITY_BR_KEY) authMode = "community_key";
  else if (apiKey?.startsWith("eyJ")) authMode = "service_jwt";
  else if (apiKey) authMode = "api_key";

  const activeGates = [];
  if (liveBrEnabled) activeGates.push("RUN_LIVE_BR");
  if (liveWritesEnabled) activeGates.push("RUN_LIVE_BR_WRITES");
  if (recordEnabled) activeGates.push("RECORD_BR_LIVE_DISCOVERY");
  if (allowRawMemory) activeGates.push("ALLOW_RAW_MEMORY_ARTIFACTS");

  const warnings = [];
  if (liveBrEnabled && !configuredKey) {
    warnings.push("BRAINSTORM_API_KEY not set; using public community BR key.");
  }
  if (allowRawMemory) {
    warnings.push(
      "ALLOW_RAW_MEMORY_ARTIFACTS is set; artifact writers must still redact snippets.",
    );
  }

  return {
    liveBrEnabled,
    liveWritesEnabled,
    recordEnabled,
    allowRawMemory,
    brBaseUrl: source.BRAINSTORM_BR_URL ?? DEFAULT_BR_BASE_URL,
    brSiteUrl: source.BRAINSTORM_BR_SITE_URL ?? DEFAULT_BR_SITE_URL,
    apiKey,
    authMode,
    actorKind: source.CI ? "ci" : "operator",
    sandboxTenantId,
    activeGates,
    warnings,
  };
}

export function describeBusinessHarnessEnv(env: BusinessHarnessEnv): string[] {
  return [
    `RUN_LIVE_BR=${env.liveBrEnabled ? "1" : "0"}`,
    `RUN_LIVE_BR_WRITES=${env.liveWritesEnabled ? "1" : "0"}`,
    `record=${env.recordEnabled ? "on" : "off"}`,
    `auth_mode=${env.authMode}`,
    `base_url=${env.brBaseUrl}`,
  ];
}
