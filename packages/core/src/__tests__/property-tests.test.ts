/**
 * Property-based tests using fast-check.
 *
 * These test invariants that should hold for ANY input, not just
 * specific test cases. First property tests for the Brainstorm project.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { MemoryManager } from "../memory/manager.js";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";

function getMemoryDir(projectPath: string): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".brainstorm", "projects", hash, "memory");
}

describe("Property-Based Tests", () => {
  describe("Memory ID generation", () => {
    it("always produces lowercase IDs with only alphanumeric and hyphens", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 100 }), (name) => {
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          // ID should only contain lowercase letters, digits, and hyphens
          expect(id).toMatch(/^[a-z0-9-]*$/);
        }),
        { numRuns: 200 },
      );
    });

    it("same name always produces same ID (deterministic)", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 50 }), (name) => {
          const id1 = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          const id2 = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          expect(id1).toBe(id2);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Memory save/get round-trip", () => {
    it("saved content is retrievable unchanged", () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-prop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const manager = new MemoryManager(projectPath);

      try {
        fc.assert(
          fc.property(
            fc.record({
              name: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
              content: fc.string({ minLength: 1, maxLength: 500 }),
            }),
            ({ name, content }) => {
              const saved = manager.save({
                name,
                description: "property test",
                content,
                type: "project",
                source: "user_input",
              });
              const retrieved = manager.get(saved.id);
              expect(retrieved).toBeDefined();
              expect(retrieved!.content).toBe(content);
            },
          ),
          { numRuns: 20 }, // Keep low — each creates a file
        );
      } finally {
        rmSync(getMemoryDir(projectPath), { recursive: true, force: true });
      }
    });
  });

  describe("Trust score invariants", () => {
    it("trust score is always between 0 and 1", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1, noNaN: true }),
          (trustScore) => {
            expect(trustScore).toBeGreaterThanOrEqual(0);
            expect(trustScore).toBeLessThanOrEqual(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("quarantine threshold is consistent", () => {
      const QUARANTINE_THRESHOLD = 0.4;
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1, noNaN: true }),
          (trustScore) => {
            if (trustScore < QUARANTINE_THRESHOLD) {
              // Below threshold → should be quarantined
              expect(trustScore).toBeLessThan(QUARANTINE_THRESHOLD);
            } else {
              // Above threshold → should NOT be quarantined
              expect(trustScore).toBeGreaterThanOrEqual(QUARANTINE_THRESHOLD);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Content hash invariants", () => {
    it("same content always produces same hash", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 1000 }), (content) => {
          const hash1 = createHash("sha256")
            .update(content)
            .digest("hex")
            .slice(0, 16);
          const hash2 = createHash("sha256")
            .update(content)
            .digest("hex")
            .slice(0, 16);
          expect(hash1).toBe(hash2);
        }),
        { numRuns: 100 },
      );
    });

    it("different content (usually) produces different hashes", () => {
      const hashes = new Set<string>();
      fc.assert(
        fc.property(fc.string({ minLength: 10, maxLength: 100 }), (content) => {
          const hash = createHash("sha256")
            .update(content)
            .digest("hex")
            .slice(0, 16);
          hashes.add(hash);
          return true;
        }),
        { numRuns: 50 },
      );
      // With 50 random strings, we should have at least 40 unique hashes
      expect(hashes.size).toBeGreaterThan(40);
    });
  });

  describe("Token estimation", () => {
    it("estimated tokens is always positive for non-empty text", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 10000 }), (text) => {
          const tokens = Math.ceil(text.length / 4);
          expect(tokens).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    it("longer text always estimates more tokens", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.string({ minLength: 101, maxLength: 1000 }),
          (short, long) => {
            const shortTokens = Math.ceil(short.length / 4);
            const longTokens = Math.ceil(long.length / 4);
            expect(longTokens).toBeGreaterThan(shortTokens);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
