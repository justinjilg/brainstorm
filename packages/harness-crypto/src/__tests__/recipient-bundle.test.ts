/**
 * Tests for recipient bundle parsing, PQ-hybrid detection, and diff —
 * the foundation for v1.5's age + sops integration.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  recipientBundleSchema,
  loadRecipientBundle,
  isPqHybridBundle,
  diffBundles,
  recipientBundlePath,
  RECIPIENTS_FOLDER,
  type RecipientBundle,
} from "../recipient-bundle.js";

// Use the schema's *input* type so optional/default fields don't have to
// be supplied in test fixtures.
type RecipientBundleInput = z.input<typeof recipientBundleSchema>;

const VALID_BUNDLE_TOML = `
id = "bundle_managers"
name = "Managers"
version = 7
status = "active"
audit_class = "internal"

[[recipients]]
public_key = "age1abcdefghijklmnopqrstuvwxyz0123456789"
owner = "team/humans/justin"
hardware_backed = true

[[recipients]]
public_key = "age1pq1qwertyuiopasdfghjklzxcvbnm0987654321"
owner = "team/humans/maria"
hardware_backed = false
`;

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "bundle-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const makeBundle = (
  overrides: Partial<RecipientBundleInput> = {},
): RecipientBundle =>
  recipientBundleSchema.parse({
    id: "bundle_test",
    name: "Test",
    version: 1,
    recipients: [{ public_key: "age1abcdefghij", owner: "team/humans/x" }],
    ...overrides,
  });

describe("recipientBundleSchema", () => {
  test("minimal valid bundle parses", () => {
    const parsed = makeBundle();
    expect(parsed.id).toBe("bundle_test");
    expect(parsed.status).toBe("active"); // default
    expect(parsed.audit_class).toBe("internal"); // default
    expect(parsed.recipients).toHaveLength(1);
  });

  test("id must match bundle_ pattern", () => {
    expect(() =>
      recipientBundleSchema.parse({
        id: "wrong",
        name: "X",
        version: 1,
        recipients: [{ public_key: "age1abc" }],
      }),
    ).toThrow();
  });

  test("public_key must be age format", () => {
    expect(() =>
      recipientBundleSchema.parse({
        id: "bundle_x",
        name: "X",
        version: 1,
        recipients: [{ public_key: "ssh-ed25519 AAAA..." }],
      }),
    ).toThrow();
  });

  test("recipients cannot be empty (zero recipients = no readers)", () => {
    expect(() =>
      recipientBundleSchema.parse({
        id: "bundle_x",
        name: "X",
        version: 1,
        recipients: [],
      }),
    ).toThrow();
  });

  test("scope and expires_at are accepted (cross-org bundles)", () => {
    const parsed = makeBundle({
      scope: "wilson-sonsini-acme-acquisition",
      expires_at: "2026-12-31",
      audit_class: "external",
    });
    expect(parsed.scope).toBe("wilson-sonsini-acme-acquisition");
    expect(parsed.expires_at).toBe("2026-12-31");
    expect(parsed.audit_class).toBe("external");
  });
});

describe("loadRecipientBundle", () => {
  test("loads a valid file", () => {
    const path = join(testRoot, "managers.toml");
    writeFileSync(path, VALID_BUNDLE_TOML);
    const result = loadRecipientBundle(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.id).toBe("bundle_managers");
      expect(result.bundle.recipients).toHaveLength(2);
    }
  });

  test("missing file returns error", () => {
    const result = loadRecipientBundle(join(testRoot, "absent.toml"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("missing");
  });

  test("malformed TOML returns parse-error", () => {
    const path = join(testRoot, "bad.toml");
    writeFileSync(path, "[broken\n");
    const result = loadRecipientBundle(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("parse-error");
  });

  test("schema-invalid returns schema-error", () => {
    const path = join(testRoot, "invalid.toml");
    writeFileSync(
      path,
      `id = "wrong"
name = "X"
version = 1
[[recipients]]
public_key = "age1abc"
`,
    );
    const result = loadRecipientBundle(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("schema-error");
  });
});

describe("isPqHybridBundle — required for restricted tier", () => {
  test("all-PQ bundle is hybrid-clean", () => {
    const bundle = makeBundle({
      recipients: [
        { public_key: "age1pq1one", hardware_backed: false },
        { public_key: "age1pq1two", hardware_backed: true },
      ],
    });
    expect(isPqHybridBundle(bundle)).toBe(true);
  });

  test("mixed bundle is NOT hybrid-clean", () => {
    const bundle = makeBundle({
      recipients: [
        { public_key: "age1classical", hardware_backed: false },
        { public_key: "age1pq1pqready", hardware_backed: false },
      ],
    });
    expect(isPqHybridBundle(bundle)).toBe(false);
  });

  test("classical-only bundle is NOT hybrid-clean", () => {
    const bundle = makeBundle();
    expect(isPqHybridBundle(bundle)).toBe(false);
  });
});

describe("diffBundles — the membership delta", () => {
  test("computes added/removed/unchanged sets", () => {
    const old_bundle = makeBundle({
      version: 1,
      recipients: [
        { public_key: "age1alpha", owner: "team/humans/a" },
        { public_key: "age1beta", owner: "team/humans/b" },
      ],
    });
    const new_bundle = makeBundle({
      version: 2,
      recipients: [
        { public_key: "age1beta", owner: "team/humans/b" },
        { public_key: "age1gamma", owner: "team/humans/c" },
      ],
    });
    const delta = diffBundles(old_bundle, new_bundle);
    expect(delta.added.map((r) => r.public_key)).toEqual(["age1gamma"]);
    expect(delta.removed.map((r) => r.public_key)).toEqual(["age1alpha"]);
    expect(delta.unchanged.map((r) => r.public_key)).toEqual(["age1beta"]);
  });

  test("identical bundles produce empty added/removed", () => {
    const a = makeBundle({ version: 1 });
    const b = makeBundle({ version: 1 });
    const delta = diffBundles(a, b);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.unchanged).toHaveLength(1);
  });
});

describe("recipientBundlePath", () => {
  test("composes the conventional path inside a harness root", () => {
    const path = recipientBundlePath("/home/user/Businesses/x", "managers");
    expect(path).toBe(
      `/home/user/Businesses/x/${RECIPIENTS_FOLDER}/managers.toml`,
    );
  });
});
