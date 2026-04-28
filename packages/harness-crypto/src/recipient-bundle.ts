import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";

/**
 * Recipient bundle schema for `.harness/recipients/{bundle-slug}.toml`.
 *
 * A bundle is a versioned list of age-format public keys that can decrypt a
 * class of harness content. Bundles are checked-in (public material), and
 * the active bundle for a given path glob is referenced by
 * `.harness/recipients/policy.toml`.
 *
 * Source-of-truth spec: ~/.claude/plans/snuggly-sleeping-hinton.md
 *   - `## Sensitive Data + GitHub Security + PQC` §4.2 (recipient bundle architecture)
 *   - Decision #11 revised (ratchet-as-transaction states; bundle membership ADR)
 */

// Each recipient is an age-format public key, optionally with metadata.
const recipientEntrySchema = z.object({
  // The age public key. Format: age1... (X25519) or age1pq1... (PQ-hybrid).
  public_key: z.string().regex(/^age1(pq1)?[a-z0-9]+$/, {
    message: "public_key must be an age-format key (age1... or age1pq1...)",
  }),
  // Reference to the human or agent owning this key
  owner: z.string().optional(),
  // Free-form description of what this identity does
  description: z.string().optional(),
  // ISO date the key was added to the bundle
  added_at: z.string().optional(),
  // Optional expiry — for time-bounded bundles (external counsel, M&A)
  expires_at: z.string().optional(),
  // Hardware-backed marker (YubiKey / TPM); informational
  hardware_backed: z.boolean().default(false),
});

export const recipientBundleSchema = z.object({
  // Stable id; never renamed
  id: z.string().regex(/^bundle_[a-z0-9_-]+$/, {
    message: "id must match /^bundle_[a-z0-9_-]+$/",
  }),
  // Human-readable bundle name
  name: z.string().min(1),
  // Bundle version — increments on every membership change
  version: z.number().int().nonnegative(),
  // Description of the bundle's purpose
  description: z.string().optional(),
  // Lifecycle
  status: z.enum(["active", "rotating", "archived"]).default("active"),
  // Timestamps
  created_at: z.string().optional(),
  rotated_at: z.string().optional(),
  // For time-bounded bundles (cross-org engagements per gap_2026-04-26-cross-org-recipient-bundles)
  scope: z.string().optional(),
  expires_at: z.string().optional(),
  audit_class: z
    .enum(["internal", "external", "regulator", "common-interest"])
    .default("internal"),
  // The recipients themselves
  recipients: z.array(recipientEntrySchema).min(1),
  // Linked governance decision (decision-cascade rule per Gap-Capture)
  governance_decision_ref: z.string().optional(),
});

export type RecipientBundle = z.infer<typeof recipientBundleSchema>;
export type RecipientEntry = z.infer<typeof recipientEntrySchema>;

/** Conventional location of recipient bundles inside a harness root. */
export const RECIPIENTS_FOLDER = ".harness/recipients";

export type LoadBundleResult =
  | { ok: true; bundle: RecipientBundle; path: string }
  | {
      ok: false;
      path: string;
      error: "missing" | "parse-error" | "schema-error";
      message: string;
    };

export function loadRecipientBundle(path: string): LoadBundleResult {
  if (!existsSync(path)) {
    return { ok: false, path, error: "missing", message: `No file at ${path}` };
  }

  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      path,
      error: "parse-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const result = recipientBundleSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      path,
      error: "schema-error",
      message: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  return { ok: true, bundle: result.data, path };
}

/**
 * Compute whether a recipient list is "PQ-hybrid clean" — every recipient
 * uses age1pq1 (post-quantum hybrid) keys. Required for `restricted` tier
 * per PQC §4.8 to defend against harvest-now-decrypt-later attacks.
 */
export function isPqHybridBundle(bundle: RecipientBundle): boolean {
  return bundle.recipients.every((r) => r.public_key.startsWith("age1pq1"));
}

/**
 * Compare two bundle versions and report the membership delta — used by
 * the ratchet command to render "what changes if I publish the new bundle".
 */
export interface BundleDelta {
  added: RecipientEntry[];
  removed: RecipientEntry[];
  unchanged: RecipientEntry[];
}

export function diffBundles(
  oldBundle: RecipientBundle,
  newBundle: RecipientBundle,
): BundleDelta {
  const oldKeys = new Set(oldBundle.recipients.map((r) => r.public_key));
  const newKeys = new Set(newBundle.recipients.map((r) => r.public_key));
  return {
    added: newBundle.recipients.filter((r) => !oldKeys.has(r.public_key)),
    removed: oldBundle.recipients.filter((r) => !newKeys.has(r.public_key)),
    unchanged: newBundle.recipients.filter((r) => oldKeys.has(r.public_key)),
  };
}

/** Build full path to a recipient bundle file in a harness. */
export function recipientBundlePath(
  harnessRoot: string,
  bundleSlug: string,
): string {
  return join(harnessRoot, RECIPIENTS_FOLDER, `${bundleSlug}.toml`);
}
