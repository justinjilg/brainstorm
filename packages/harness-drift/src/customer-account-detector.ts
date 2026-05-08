import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";
import type { Drift, DriftDetector } from "./types.js";

/**
 * Customer-account intent ↔ runtime drift.
 *
 * Walks `customers/accounts/{slug}/` and compares declared intent fields
 * in `account.toml` against observed values in a co-located `runtime.toml`
 * (which a runtime sync job — Stripe poller, MSP poller, etc. — writes to
 * disk). When an actual runtime API is wired in a later phase, the
 * `runtime.toml` writer is replaced; this detector keeps working unchanged
 * because it reads from the same on-disk shape.
 *
 * Per Decision #9 revised: every drift this detector emits is
 * `field_class = "intent"` — the file declares what we want; the runtime
 * is the implementation. The UI surfaces "Runtime needs update", never
 * "Apply runtime to file."
 *
 * Fields compared today:
 *   - account.toml#mrr_intent       vs runtime.toml#mrr_observed
 *   - account.toml#status           vs runtime.toml#status_observed
 *   - account.toml#tier             vs runtime.toml#tier_observed
 *
 * Missing runtime.toml is NOT drift — it's "no observation yet." The UI
 * surfaces those rows distinctly so users can wire a runtime poller.
 */
export class CustomerAccountDriftDetector implements DriftDetector {
  readonly name = "customer-account-intent-runtime";
  readonly field_class = "intent" as const;

  constructor(
    private readonly harnessRoot: string,
    private readonly options: {
      now?: () => number;
    } = {},
  ) {}

  async detect(): Promise<Drift[]> {
    const drifts: Drift[] = [];
    const accountsDir = join(this.harnessRoot, "customers", "accounts");
    if (!existsSync(accountsDir)) return drifts;

    const slugs = listSlugs(accountsDir);
    const now = (this.options.now ?? (() => Date.now()))();

    for (const slug of slugs) {
      const accountPath = join(accountsDir, slug, "account.toml");
      const runtimePath = join(accountsDir, slug, "runtime.toml");
      if (!existsSync(accountPath)) continue;

      const intent = parseTomlSafe(accountPath);
      const observed = existsSync(runtimePath)
        ? parseTomlSafe(runtimePath)
        : null;

      if (!intent) continue;
      if (!observed) continue; // no runtime observation = no drift to detect

      for (const [intentField, observedField] of FIELD_PAIRS) {
        const intentValue = intent[intentField];
        const observedValue = observed[observedField];
        if (intentValue === undefined && observedValue === undefined) continue;
        if (deepEqual(intentValue, observedValue)) continue;

        drifts.push({
          id: `customer-account/${slug}/${intentField}`,
          field_class: "intent",
          relative_path: `customers/accounts/${slug}/account.toml`,
          field_path: intentField,
          intent_value: serialize(intentValue),
          observed_value: serialize(observedValue),
          detector_name: this.name,
          detected_at: now,
          severity: severityFor(intentField),
        });
      }
    }

    return drifts;
  }

  /**
   * List slugs that have an account.toml but no runtime.toml. The desktop
   * surfaces these as "wire a runtime poller" hints — they're not drifts,
   * they're a coverage gap.
   */
  unobservedAccounts(): string[] {
    const accountsDir = join(this.harnessRoot, "customers", "accounts");
    if (!existsSync(accountsDir)) return [];
    const slugs = listSlugs(accountsDir);
    return slugs.filter((slug) => {
      const acct = join(accountsDir, slug, "account.toml");
      const rt = join(accountsDir, slug, "runtime.toml");
      return existsSync(acct) && !existsSync(rt);
    });
  }
}

const FIELD_PAIRS: Array<[string, string]> = [
  ["mrr_intent", "mrr_observed"],
  ["status", "status_observed"],
  ["tier", "tier_observed"],
];

function severityFor(field: string): Drift["severity"] {
  if (field === "mrr_intent") return "high";
  if (field === "status") return "critical";
  return "medium";
}

function listSlugs(accountsDir: string): string[] {
  try {
    return readdirSync(accountsDir).filter((entry) => {
      try {
        return statSync(join(accountsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function parseTomlSafe(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return TOML.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function serialize(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
