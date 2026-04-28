import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import TOML from "@iarna/toml";
import { z } from "zod";

/**
 * Recipient-bundle ratchet — the operation that re-encrypts every file
 * matching a sensitive glob to a new bundle's recipient list.
 *
 * Per Decision #11 revised + PQC §4.6:
 *   - Ratchets are transaction objects with explicit states
 *   - Sentinel `.harness/ratchets/{ratchet-id}.toml` committed to git as
 *     the first commit of the ratchet PR
 *   - Emergency steal creates a *superseding* transaction; abandoned
 *     transaction is blocked from merging
 *   - recipient-set-coherence detector verifies all files in a bundle
 *     are encrypted to the same recipient set (the silent-partial-ratchet
 *     failure mode Round 1 Attack #1 surfaced)
 *
 * v1.5 status: this module ships the **state machine + sentinel** + the
 * **coherence detector**. Actual file re-encryption integration with the
 * `age` CLI is the v2 deliverable — it requires a tested ratchet runner
 * that walks the FS, decrypts each file with the current bundle, re-
 * encrypts to the new bundle, and atomically commits. That work depends
 * on having age installed locally and is properly a desktop-side concern.
 */

export type RatchetState =
  | "started"
  | "abandoned"
  | "stolen"
  | "completed"
  | "superseded";

const ratchetSentinelSchema = z.object({
  id: z.string().regex(/^ratchet_[a-z0-9_-]+$/),
  bundle_id: z.string().regex(/^bundle_[a-z0-9_-]+$/),
  state: z.enum(["started", "abandoned", "stolen", "completed", "superseded"]),
  started_by: z.string(),
  started_at: z.string(),
  machine_id: z.string(),
  expires_in_minutes: z.number().int().positive().default(120),
  /** Set when state = "stolen": id of the originating ratchet that was stolen. */
  stole_from: z.string().optional(),
  /** Set when state = "superseded": id of the ratchet that superseded this one. */
  superseded_by: z.string().optional(),
  /** Set when state = "completed" or "abandoned". */
  ended_at: z.string().optional(),
  /** Number of files this ratchet re-encrypted. */
  files_touched: z.number().int().nonnegative().optional(),
  /** Reference to the governance/decisions/ ADR that authorized the ratchet. */
  governance_decision_ref: z.string().optional(),
});

export type RatchetSentinel = z.infer<typeof ratchetSentinelSchema>;

/** Conventional location of ratchet sentinels inside a harness root. */
export const RATCHETS_FOLDER = ".harness/ratchets";

/** Build the path to a sentinel file. */
export function ratchetSentinelPath(
  harnessRoot: string,
  ratchetId: string,
): string {
  return join(harnessRoot, RATCHETS_FOLDER, `${ratchetId}.toml`);
}

// ── state machine ───────────────────────────────────────────

export const VALID_TRANSITIONS: Record<RatchetState, RatchetState[]> = {
  started: ["completed", "abandoned", "stolen"],
  abandoned: ["superseded"], // a stolen-replacement supersedes it
  stolen: [], // terminal
  completed: [], // terminal
  superseded: [], // terminal
};

export function isValidTransition(
  from: RatchetState,
  to: RatchetState,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ── sentinel CRUD ───────────────────────────────────────────

export type LoadSentinelResult =
  | { ok: true; sentinel: RatchetSentinel; path: string }
  | { ok: false; path: string; error: string };

export function loadRatchetSentinel(path: string): LoadSentinelResult {
  if (!existsSync(path)) {
    return { ok: false, path, error: "missing" };
  }
  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      path,
      error: `parse: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const result = ratchetSentinelSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      path,
      error: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, sentinel: result.data, path };
}

export function writeRatchetSentinel(
  path: string,
  sentinel: RatchetSentinel,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Serialize via @iarna/toml for round-trip safety
  writeFileSync(
    path,
    TOML.stringify(sentinel as unknown as TOML.JsonMap),
    "utf-8",
  );
}

// ── ratchet manager ─────────────────────────────────────────

export interface StartRatchetOptions {
  harnessRoot: string;
  bundleId: string;
  startedBy: string;
  machineId: string;
  expiresInMinutes?: number;
  governanceDecisionRef?: string;
}

/**
 * Start a fresh ratchet. Throws if there's already an active (non-terminal,
 * non-expired) ratchet on the same bundle — that's the concurrency guard
 * Round 1 Attack #1 demanded.
 */
export function startRatchet(opts: StartRatchetOptions): RatchetSentinel {
  const active = findActiveRatchet(opts.harnessRoot, opts.bundleId);
  if (active) {
    throw new Error(
      `ratchet ${active.id} is already active on bundle ${opts.bundleId} (started by ${active.started_by} on ${active.started_at}); use --steal to override`,
    );
  }

  const id = `ratchet_${randomSlug()}`;
  const sentinel: RatchetSentinel = {
    id,
    bundle_id: opts.bundleId,
    state: "started",
    started_by: opts.startedBy,
    started_at: new Date().toISOString(),
    machine_id: opts.machineId,
    expires_in_minutes: opts.expiresInMinutes ?? 120,
    governance_decision_ref: opts.governanceDecisionRef,
  };
  writeRatchetSentinel(ratchetSentinelPath(opts.harnessRoot, id), sentinel);
  return sentinel;
}

/**
 * Mark a ratchet complete with a count of files touched. Idempotent in
 * the sense that re-completing an already-complete ratchet is a no-op
 * (returns the existing sentinel).
 */
export function completeRatchet(
  harnessRoot: string,
  ratchetId: string,
  filesTouched: number,
): RatchetSentinel {
  const path = ratchetSentinelPath(harnessRoot, ratchetId);
  const loaded = loadRatchetSentinel(path);
  if (!loaded.ok) {
    throw new Error(`completeRatchet: ${loaded.error}`);
  }
  const current = loaded.sentinel;
  if (current.state === "completed") return current;
  if (!isValidTransition(current.state, "completed")) {
    throw new Error(
      `completeRatchet: ratchet ${ratchetId} cannot transition ${current.state} → completed`,
    );
  }
  const updated: RatchetSentinel = {
    ...current,
    state: "completed",
    ended_at: new Date().toISOString(),
    files_touched: filesTouched,
  };
  writeRatchetSentinel(path, updated);
  return updated;
}

export function abandonRatchet(
  harnessRoot: string,
  ratchetId: string,
): RatchetSentinel {
  const path = ratchetSentinelPath(harnessRoot, ratchetId);
  const loaded = loadRatchetSentinel(path);
  if (!loaded.ok) throw new Error(`abandonRatchet: ${loaded.error}`);
  const current = loaded.sentinel;
  if (!isValidTransition(current.state, "abandoned")) {
    throw new Error(
      `abandonRatchet: ratchet ${ratchetId} cannot transition ${current.state} → abandoned`,
    );
  }
  const updated: RatchetSentinel = {
    ...current,
    state: "abandoned",
    ended_at: new Date().toISOString(),
  };
  writeRatchetSentinel(path, updated);
  return updated;
}

/**
 * Steal an active ratchet — creates a *superseding* transaction with a
 * new id that references the stolen one; the original becomes "abandoned"
 * → "superseded" (after merge). This is the emergency override.
 */
export interface StealRatchetResult {
  superseded: RatchetSentinel;
  replacement: RatchetSentinel;
}

export function stealRatchet(opts: {
  harnessRoot: string;
  victimRatchetId: string;
  newStartedBy: string;
  newMachineId: string;
  reason: string;
  governanceDecisionRef: string;
}): StealRatchetResult {
  const victimPath = ratchetSentinelPath(
    opts.harnessRoot,
    opts.victimRatchetId,
  );
  const victimLoaded = loadRatchetSentinel(victimPath);
  if (!victimLoaded.ok) throw new Error(`stealRatchet: ${victimLoaded.error}`);
  const victim = victimLoaded.sentinel;
  if (victim.state !== "started") {
    throw new Error(
      `stealRatchet: ratchet ${opts.victimRatchetId} is not in 'started' state (current: ${victim.state})`,
    );
  }

  const replacementId = `ratchet_${randomSlug()}`;
  const replacement: RatchetSentinel = {
    id: replacementId,
    bundle_id: victim.bundle_id,
    state: "started",
    started_by: opts.newStartedBy,
    started_at: new Date().toISOString(),
    machine_id: opts.newMachineId,
    expires_in_minutes: victim.expires_in_minutes,
    stole_from: victim.id,
    governance_decision_ref: opts.governanceDecisionRef,
  };

  // Mark the victim abandoned; record that the replacement supersedes it.
  // Note: we use 'abandoned' rather than direct 'superseded' so the chain
  // matches the state machine's allowed transitions. The replacement's
  // completion later fires the abandoned → superseded transition.
  const updatedVictim: RatchetSentinel = {
    ...victim,
    state: "abandoned",
    ended_at: new Date().toISOString(),
    superseded_by: replacementId,
  };

  writeRatchetSentinel(victimPath, updatedVictim);
  writeRatchetSentinel(
    ratchetSentinelPath(opts.harnessRoot, replacementId),
    replacement,
  );
  return { superseded: updatedVictim, replacement };
}

/**
 * Find an active ratchet on the given bundle (started + not expired),
 * if any. Used by `startRatchet` to enforce single-active-per-bundle.
 */
export function findActiveRatchet(
  harnessRoot: string,
  bundleId: string,
  now: number = Date.now(),
): RatchetSentinel | null {
  const ratchetsDir = join(harnessRoot, RATCHETS_FOLDER);
  if (!existsSync(ratchetsDir)) return null;
  // Read every sentinel; quick because the count is small (at most one
  // per concurrent ratchet operation).
  let files: string[];
  try {
    files = readdirSync(ratchetsDir);
  } catch {
    return null;
  }
  for (const name of files) {
    if (!name.endsWith(".toml")) continue;
    const loaded = loadRatchetSentinel(join(ratchetsDir, name));
    if (!loaded.ok) continue;
    const s = loaded.sentinel;
    if (s.bundle_id !== bundleId) continue;
    if (s.state !== "started") continue;
    const startedAt = Date.parse(s.started_at);
    const expiry = startedAt + s.expires_in_minutes * 60_000;
    if (expiry < now) continue; // expired — no longer active
    return s;
  }
  return null;
}

// ── coherence detector ─────────────────────────────────────

/**
 * Result of recipient-set-coherence verification: returns paths whose
 * encrypted-file recipient list disagrees with the bundle's stated
 * membership. This is the silent-partial-ratchet failure-mode detector
 * Round 1 Attack #1 demanded.
 *
 * v1.5 caveat: full implementation requires reading the age file header
 * (which is plaintext metadata) to extract the per-recipient stanzas.
 * That requires either parsing age's wire format or shelling to `age`
 * with a stub identity. For v1.5 we expose the *interface* (callers
 * pass file recipient sets they've extracted) and verify coherence
 * across them. The age-header reader is a v2 enhancement.
 */
export interface CoherenceCheckResult {
  bundle_id: string;
  expected_recipients: string[];
  /** Paths that match the bundle's recipient set exactly. */
  coherent: string[];
  /** Paths whose recipient set differs from the bundle's. */
  incoherent: Array<{
    path: string;
    has_recipients: string[];
    missing_from_file: string[];
    extra_in_file: string[];
  }>;
}

/** Compare each file's recipient list against the bundle's expected set. */
export function verifyRecipientSetCoherence(opts: {
  bundleId: string;
  expectedRecipients: string[];
  filesAndRecipients: Array<{ path: string; recipients: string[] }>;
}): CoherenceCheckResult {
  const expected = new Set(opts.expectedRecipients);
  const result: CoherenceCheckResult = {
    bundle_id: opts.bundleId,
    expected_recipients: opts.expectedRecipients,
    coherent: [],
    incoherent: [],
  };
  for (const file of opts.filesAndRecipients) {
    const has = new Set(file.recipients);
    const missing = opts.expectedRecipients.filter((r) => !has.has(r));
    const extra = file.recipients.filter((r) => !expected.has(r));
    if (missing.length === 0 && extra.length === 0) {
      result.coherent.push(file.path);
    } else {
      result.incoherent.push({
        path: file.path,
        has_recipients: file.recipients,
        missing_from_file: missing,
        extra_in_file: extra,
      });
    }
  }
  return result;
}

// ── helpers ─────────────────────────────────────────────────

function randomSlug(): string {
  // 16 chars of hex randomness — small enough for a sentinel filename,
  // large enough to avoid collisions. Avoids randomUUID() so the slug
  // matches the schema regex /^[a-z0-9_-]+$/.
  return randomBytes(8).toString("hex");
}
