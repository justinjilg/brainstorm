/**
 * Tests for sensitive-glob enforcement — the v1 lint that ships in
 * `brainstorm harness lint --strict` and the pre-commit hook (per PQC §6.3).
 */

import { describe, test, expect } from "vitest";
import {
  hasEncryptedSuffix,
  isEnvelopeCompanion,
  matchesSensitiveGlob,
  validateSensitivePaths,
  isSensitivePath,
  logicalPath,
  encryptedPath,
} from "../sensitive-glob.js";

describe("hasEncryptedSuffix", () => {
  test.each([
    ["customers/acme/contract.md.age", true],
    ["governance/parties/acme.sops.toml", true],
    ["operations/finance/budgets/2026.sops.yaml", true],
    ["team/policy.md", false],
    ["governance/parties/acme.toml", false],
    ["something.txt", false],
  ])("%s → %s", (path, expected) => {
    expect(hasEncryptedSuffix(path)).toBe(expected);
  });

  test("envelope companions are NOT considered encrypted (they're plaintext metadata)", () => {
    expect(hasEncryptedSuffix("team/feedback/jane.md.age.envelope.toml")).toBe(
      false,
    );
  });
});

describe("isEnvelopeCompanion", () => {
  test("recognizes envelope companion suffix", () => {
    expect(
      isEnvelopeCompanion("operations/finance/runway.md.age.envelope.toml"),
    ).toBe(true);
  });

  test("non-envelope files return false", () => {
    expect(isEnvelopeCompanion("operations/finance/runway.md")).toBe(false);
    expect(isEnvelopeCompanion("operations/finance/runway.md.age")).toBe(false);
  });
});

describe("matchesSensitiveGlob", () => {
  const globs = [
    "team/compensation/**",
    "team/performance/feedback/**",
    "governance/contracts/employment/**",
    "operations/finance/**",
  ];

  test.each([
    ["team/compensation/bands.toml", true],
    ["team/compensation/jane.sops.toml", true],
    ["team/performance/feedback/jane.md.age", true],
    ["governance/contracts/employment/jane.md.age", true],
    ["operations/finance/runway/2026-04.toml", true],
    ["customers/accounts/acme/account.toml", false],
    ["team/policies/code-of-conduct.md", false],
    ["operations/it/tooling.toml", false],
  ])("%s vs sensitive globs → %s", (path, expected) => {
    expect(matchesSensitiveGlob(path, globs)).toBe(expected);
  });
});

describe("validateSensitivePaths — the CI-grade lint", () => {
  const globs = [
    "team/compensation/**",
    "team/performance/feedback/**",
    "governance/contracts/employment/**",
  ];

  test("plaintext under sensitive glob is a violation", () => {
    const violations = validateSensitivePaths(
      ["team/compensation/jane.toml", "team/compensation/bands.sops.toml"],
      globs,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      path: "team/compensation/jane.toml",
      reason: "plaintext-under-sensitive",
      matched_glob: "team/compensation/**",
    });
  });

  test("envelope companions don't trigger violations", () => {
    const violations = validateSensitivePaths(
      [
        "team/performance/feedback/jane.md.age",
        "team/performance/feedback/jane.md.age.envelope.toml",
      ],
      globs,
    );
    expect(violations).toEqual([]);
  });

  test("non-sensitive paths are not validated", () => {
    const violations = validateSensitivePaths(
      ["customers/accounts/acme/account.toml", "products/peer10/product.toml"],
      globs,
    );
    expect(violations).toEqual([]);
  });

  test("a clean run produces no violations", () => {
    const violations = validateSensitivePaths(
      [
        "team/compensation/bands.sops.toml",
        "team/performance/feedback/jane.md.age",
        "governance/contracts/employment/jane.md.age",
        "governance/contracts/employment/jane.md.age.envelope.toml",
      ],
      globs,
    );
    expect(violations).toEqual([]);
  });

  test("the Anthropic-leak failure mode (plaintext slipping past) is caught", () => {
    // Simulates: someone adds a new sensitive folder, forgets to encrypt
    const violations = validateSensitivePaths(
      [
        "team/performance/feedback/intern-program.md", // forgot .age
        "team/compensation/2027-bands.toml", // forgot .sops.toml
      ],
      globs,
    );
    expect(violations).toHaveLength(2);
    expect(
      violations.every((v) => v.reason === "plaintext-under-sensitive"),
    ).toBe(true);
  });
});

describe("logicalPath / encryptedPath — round-trip helpers", () => {
  test("strip encrypted suffix to get logical path", () => {
    expect(logicalPath("customers/acme/contract.md.age")).toBe(
      "customers/acme/contract.md",
    );
    expect(logicalPath("governance/parties/acme.sops.toml")).toBe(
      "governance/parties/acme.toml",
    );
  });

  test("non-encrypted paths return unchanged", () => {
    expect(logicalPath("customers/accounts/acme/account.toml")).toBe(
      "customers/accounts/acme/account.toml",
    );
  });

  test("encryptedPath picks the right suffix per file type", () => {
    expect(encryptedPath("team/feedback/jane.md")).toBe(
      "team/feedback/jane.md.age",
    );
    expect(encryptedPath("governance/parties/acme.toml")).toBe(
      "governance/parties/acme.sops.toml",
    );
    expect(encryptedPath("config/secrets.yaml")).toBe(
      "config/secrets.sops.yaml",
    );
    expect(encryptedPath("config/secrets.json")).toBe(
      "config/secrets.sops.json",
    );
  });
});

describe("isSensitivePath", () => {
  const globs = ["team/compensation/**", "operations/finance/**"];

  test("returns true for matching path", () => {
    expect(isSensitivePath("team/compensation/jane.toml", globs)).toBe(true);
  });

  test("returns false for non-matching path", () => {
    expect(isSensitivePath("team/policy.md", globs)).toBe(false);
  });
});
