import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { createLogger } from "@brainst0rm/shared";
import { partySchema, type Party } from "./schema.js";

const log = createLogger("parties");

/** Conventional location of party files inside a harness root. */
export const PARTIES_FOLDER = "governance/parties";

export type LoadPartyResult =
  | { ok: true; path: string; party: Party }
  | {
      ok: false;
      path: string;
      error: "missing" | "parse-error" | "schema-error";
      message: string;
    };

/**
 * Load a single party file from an absolute path. Non-throwing; the caller
 * checks `ok`. The contract mirrors `loadBusinessHarness` in the config
 * package so callers can compose them uniformly.
 */
export function loadParty(path: string): LoadPartyResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      error: "missing",
      message: `No file at ${path}`,
    };
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

  const result = partySchema.safeParse(raw);
  if (!result.success) {
    log.warn(
      { path, issues: result.error.issues },
      "party file failed schema validation",
    );
    return {
      ok: false,
      path,
      error: "schema-error",
      message: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  return { ok: true, path, party: result.data };
}

/**
 * Load all party files in `{harnessRoot}/governance/parties/`. Returns valid
 * parties + a list of files that failed to parse for diagnostics. Lenient
 * parsing per the spec's Validation Tiers convention — one bad party file
 * must not break the rest of the registry.
 */
export interface LoadAllPartiesResult {
  parties: Party[];
  errors: Array<{ path: string; error: string; message: string }>;
}

export function loadAllParties(harnessRoot: string): LoadAllPartiesResult {
  const partiesDir = join(harnessRoot, PARTIES_FOLDER);
  const result: LoadAllPartiesResult = { parties: [], errors: [] };

  if (!existsSync(partiesDir)) return result;

  let files: string[];
  try {
    files = readdirSync(partiesDir);
  } catch (e) {
    log.warn(
      { partiesDir, err: e instanceof Error ? e.message : String(e) },
      "could not read parties directory",
    );
    return result;
  }

  for (const filename of files) {
    if (!filename.endsWith(".toml")) continue;
    const path = join(partiesDir, filename);
    const loaded = loadParty(path);
    if (loaded.ok) {
      result.parties.push(loaded.party);
    } else {
      result.errors.push({
        path,
        error: loaded.error,
        message: loaded.message,
      });
    }
  }

  return result;
}

/**
 * Build an in-memory party index for fast lookup by id and slug. Used by
 * AI traversal and the desktop's party-resolution UI.
 */
export interface PartyIndex {
  byId: Map<string, Party>;
  bySlug: Map<string, Party>;
  byRoleType: Map<string, Party[]>;
}

export function buildPartyIndex(parties: Party[]): PartyIndex {
  const byId = new Map<string, Party>();
  const bySlug = new Map<string, Party>();
  const byRoleType = new Map<string, Party[]>();

  for (const party of parties) {
    byId.set(party.id, party);
    bySlug.set(party.slug, party);
    for (const role of party.roles) {
      const list = byRoleType.get(role.type) ?? [];
      list.push(party);
      byRoleType.set(role.type, list);
    }
  }

  return { byId, bySlug, byRoleType };
}

/**
 * Find every party with both of two role types — useful for "customers
 * who are also investors" or "vendors who are also competitors" queries.
 */
export function findPartiesWithRoles(
  index: PartyIndex,
  roleA: string,
  roleB: string,
): Party[] {
  const candidates = index.byRoleType.get(roleA) ?? [];
  return candidates.filter((p) =>
    p.roles.some((r) => r.type === roleB && r.status === "active"),
  );
}
