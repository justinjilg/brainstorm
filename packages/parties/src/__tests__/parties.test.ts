/**
 * Tests for Universal Parties Registry — schema validation, single-file
 * loading, directory aggregation, and the role-edge graph queries that
 * justify the registry's existence (per Round 2 amendment).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  partySchema,
  loadParty,
  loadAllParties,
  buildPartyIndex,
  findPartiesWithRoles,
  PARTIES_FOLDER,
} from "../index.js";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "parties-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("partySchema — validation", () => {
  test("minimal valid party parses", () => {
    const parsed = partySchema.parse({
      id: "party_acme",
      slug: "acme",
      display_name: "Acme Corp",
      type: "legal-entity",
    });
    expect(parsed.id).toBe("party_acme");
    expect(parsed.status).toBe("active"); // default
    expect(parsed.roles).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  test("id must match party_ pattern", () => {
    expect(() =>
      partySchema.parse({
        id: "wrong-prefix",
        slug: "x",
        display_name: "X",
        type: "legal-entity",
      }),
    ).toThrow();
  });

  test("slug must match kebab-case pattern", () => {
    expect(() =>
      partySchema.parse({
        id: "party_x",
        slug: "InvalidSlug",
        display_name: "X",
        type: "legal-entity",
      }),
    ).toThrow();
  });

  test("entity type enum is enforced", () => {
    expect(() =>
      partySchema.parse({
        id: "party_x",
        slug: "x",
        display_name: "X",
        type: "alien-form",
      }),
    ).toThrow();
  });

  test("multi-role party (the Round 2 motivating case)", () => {
    const parsed = partySchema.parse({
      id: "party_acme",
      slug: "acme",
      display_name: "Acme Corp",
      type: "legal-entity",
      jurisdictions: ["US-DE", "US-CA"],
      roles: [
        {
          type: "customer",
          folder_ref: "customers/accounts/acme",
          since: "2026-03-01",
        },
        {
          type: "investor",
          folder_ref: "governance/contracts/investor/acme-ventures",
          since: "2026-02-15",
          amount: 500_000,
          instrument: "SAFE",
        },
        {
          type: "design-partner",
          folder_ref: "customers/advocacy/beta-program/cohorts/2026-q1",
          since: "2026-01-01",
        },
      ],
    });
    expect(parsed.roles).toHaveLength(3);
    expect(parsed.roles[1]?.type).toBe("investor");
  });

  test("free-form fields on roles passthrough", () => {
    const parsed = partySchema.parse({
      id: "party_x",
      slug: "x",
      display_name: "X",
      type: "legal-entity",
      roles: [
        {
          type: "vendor",
          folder_ref: "operations/procurement/vendors/x",
          contract_value: 50_000,
          renews: "2027-01-01",
        },
      ],
    });
    expect((parsed.roles[0] as Record<string, unknown>).contract_value).toBe(
      50_000,
    );
  });

  test("status enum enforced; merged_into propagates", () => {
    const parsed = partySchema.parse({
      id: "party_oldname",
      slug: "oldname",
      display_name: "Old Name Inc",
      type: "legal-entity",
      status: "merged",
      merged_into: "party_newname",
    });
    expect(parsed.status).toBe("merged");
    expect(parsed.merged_into).toBe("party_newname");
  });
});

describe("loadParty — single file loading", () => {
  test("loads a valid file", () => {
    const path = join(testRoot, "party.toml");
    writeFileSync(
      path,
      `id = "party_acme"
slug = "acme"
display_name = "Acme Corp"
type = "legal-entity"

[[roles]]
type = "customer"
folder_ref = "customers/accounts/acme"
since = "2026-03-01"
`,
    );
    const result = loadParty(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.party.id).toBe("party_acme");
      expect(result.party.roles).toHaveLength(1);
    }
  });

  test("returns missing for absent path", () => {
    const result = loadParty(join(testRoot, "absent.toml"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("missing");
  });

  test("returns parse-error on malformed TOML", () => {
    const path = join(testRoot, "bad.toml");
    writeFileSync(path, "[broken\n");
    const result = loadParty(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("parse-error");
  });

  test("returns schema-error on invalid id", () => {
    const path = join(testRoot, "invalid.toml");
    writeFileSync(
      path,
      `id = "wrong"
slug = "x"
display_name = "X"
type = "legal-entity"
`,
    );
    const result = loadParty(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("schema-error");
      expect(result.message).toContain("id");
    }
  });

  test("never throws", () => {
    const path = join(testRoot, "garbage.toml");
    writeFileSync(path, "\x00\x01\x02 binary nonsense");
    expect(() => loadParty(path)).not.toThrow();
  });
});

describe("loadAllParties — directory aggregation", () => {
  test("returns empty when parties dir does not exist", () => {
    const result = loadAllParties(testRoot);
    expect(result.parties).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("loads all valid party files from governance/parties/", () => {
    const dir = join(testRoot, PARTIES_FOLDER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "acme.toml"),
      `id = "party_acme"
slug = "acme"
display_name = "Acme"
type = "legal-entity"
`,
    );
    writeFileSync(
      join(dir, "globex.toml"),
      `id = "party_globex"
slug = "globex"
display_name = "Globex"
type = "legal-entity"
`,
    );
    const result = loadAllParties(testRoot);
    expect(result.parties).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  test("lenient: bad files surface in errors but don't break the rest", () => {
    const dir = join(testRoot, PARTIES_FOLDER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "good.toml"),
      `id = "party_good"
slug = "good"
display_name = "Good"
type = "legal-entity"
`,
    );
    writeFileSync(join(dir, "bad.toml"), "[broken\n");
    const result = loadAllParties(testRoot);
    expect(result.parties).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toBe("parse-error");
  });

  test("ignores non-toml files", () => {
    const dir = join(testRoot, PARTIES_FOLDER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "real.toml"),
      `id = "party_real"
slug = "real"
display_name = "Real"
type = "legal-entity"
`,
    );
    writeFileSync(join(dir, "README.md"), "# Notes");
    const result = loadAllParties(testRoot);
    expect(result.parties).toHaveLength(1);
  });
});

describe("buildPartyIndex + findPartiesWithRoles", () => {
  test("indexes by id, slug, and role type", () => {
    const parties = [
      partySchema.parse({
        id: "party_acme",
        slug: "acme",
        display_name: "Acme",
        type: "legal-entity",
        roles: [{ type: "customer" }, { type: "investor" }],
      }),
      partySchema.parse({
        id: "party_globex",
        slug: "globex",
        display_name: "Globex",
        type: "legal-entity",
        roles: [{ type: "customer" }],
      }),
    ];
    const idx = buildPartyIndex(parties);

    expect(idx.byId.size).toBe(2);
    expect(idx.bySlug.get("acme")?.id).toBe("party_acme");
    expect(idx.byRoleType.get("customer")).toHaveLength(2);
    expect(idx.byRoleType.get("investor")).toHaveLength(1);
  });

  test("finds parties with two roles (the killer query)", () => {
    const parties = [
      partySchema.parse({
        id: "party_acme",
        slug: "acme",
        display_name: "Acme",
        type: "legal-entity",
        roles: [
          { type: "customer", status: "active" },
          { type: "investor", status: "active" },
        ],
      }),
      partySchema.parse({
        id: "party_globex",
        slug: "globex",
        display_name: "Globex",
        type: "legal-entity",
        roles: [{ type: "customer", status: "active" }],
      }),
      partySchema.parse({
        id: "party_inv",
        slug: "inv",
        display_name: "Investor Co",
        type: "legal-entity",
        roles: [{ type: "investor", status: "active" }],
      }),
    ];
    const idx = buildPartyIndex(parties);
    const both = findPartiesWithRoles(idx, "customer", "investor");
    expect(both).toHaveLength(1);
    expect(both[0]?.id).toBe("party_acme");
  });

  test("inactive roles are excluded from cross-role query", () => {
    const parties = [
      partySchema.parse({
        id: "party_x",
        slug: "x",
        display_name: "X",
        type: "legal-entity",
        roles: [
          { type: "customer", status: "active" },
          { type: "investor", status: "ended" },
        ],
      }),
    ];
    const idx = buildPartyIndex(parties);
    const both = findPartiesWithRoles(idx, "customer", "investor");
    expect(both).toHaveLength(0);
  });
});
