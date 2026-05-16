/**
 * Agent identity persistence tests.
 *
 * Verifies the per-install agent_id management:
 *   - Generation matches BR's pattern (loadable via /v1/agent/bootstrap)
 *   - Persistence + reload round-trips
 *   - Corrupt-file recovery: regenerates rather than refuses
 *   - Invalid agent_id in file: regenerates
 *   - File perms set to 0600 where supported
 *   - Bootstrap client method shape (typed wrapper, payload validation)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOrCreateAgentIdentity,
  saveAgentIdentity,
  generateAgentId,
  type StoredAgentIdentity,
} from "../agent-identity.js";
import { isValidAgentId, BrainstormGateway } from "../client.js";

let tmpDir: string;
let agentFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "br-agent-id-test-"));
  agentFile = join(tmpDir, "agent.json");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Cleanup best-effort; tmpdir parent may have stale handles.
  }
});

describe("isValidAgentId", () => {
  it("accepts BR's documented pattern", () => {
    expect(isValidAgentId("brainstorm-cli-abc123def456789a")).toBe(true);
    expect(isValidAgentId("a1b")).toBe(true); // minimum-length boundary (3 chars)
    expect(isValidAgentId("a".repeat(64))).toBe(true); // upper bound
  });

  it("rejects illegal shapes", () => {
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("ab")).toBe(false); // too short (need ≥3)
    expect(isValidAgentId("a".repeat(65))).toBe(false); // too long
    expect(isValidAgentId("-leading-hyphen")).toBe(false);
    expect(isValidAgentId("trailing-hyphen-")).toBe(false);
    expect(isValidAgentId("UPPERCASE")).toBe(false);
    expect(isValidAgentId("under_score")).toBe(false);
    expect(isValidAgentId("dot.allowed")).toBe(false);
    expect(isValidAgentId("space inside")).toBe(false);
  });
});

describe("generateAgentId", () => {
  it("generates IDs matching the BR pattern", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateAgentId();
      expect(isValidAgentId(id), `iter ${i}: ${id}`).toBe(true);
      expect(id.startsWith("brainstorm-cli-")).toBe(true);
      // Suffix is 16 hex chars (8 bytes hex-encoded)
      expect(id).toMatch(/^brainstorm-cli-[a-f0-9]{16}$/);
    }
  });

  it("generates DIFFERENT IDs across calls (no PRNG collapse)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateAgentId());
    expect(ids.size).toBe(100);
  });
});

describe("loadOrCreateAgentIdentity", () => {
  it("creates a fresh identity when file is absent and persists it", () => {
    expect(existsSync(agentFile)).toBe(false);
    const identity = loadOrCreateAgentIdentity(agentFile);
    expect(isValidAgentId(identity.agentId)).toBe(true);
    expect(identity.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(agentFile)).toBe(true);

    // Second call returns the same identity (idempotent).
    const reloaded = loadOrCreateAgentIdentity(agentFile);
    expect(reloaded.agentId).toBe(identity.agentId);
    expect(reloaded.createdAt).toBe(identity.createdAt);
  });

  it("regenerates on corrupt JSON rather than throwing", () => {
    writeFileSync(agentFile, "{not valid json", "utf-8");
    const identity = loadOrCreateAgentIdentity(agentFile);
    expect(isValidAgentId(identity.agentId)).toBe(true);
    // The file should now be valid JSON.
    const parsed = JSON.parse(readFileSync(agentFile, "utf-8"));
    expect(parsed.agentId).toBe(identity.agentId);
  });

  it("regenerates when stored agentId fails BR's pattern", () => {
    const bad: StoredAgentIdentity = {
      agentId: "UPPERCASE-bad",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(agentFile, JSON.stringify(bad), "utf-8");
    const identity = loadOrCreateAgentIdentity(agentFile);
    expect(identity.agentId).not.toBe("UPPERCASE-bad");
    expect(isValidAgentId(identity.agentId)).toBe(true);
  });

  it("preserves an existing valid identity verbatim", () => {
    const original: StoredAgentIdentity = {
      agentId: "brainstorm-cli-aaaaaaaa11111111",
      createdAt: "2026-05-01T00:00:00.000Z",
      displayName: "test-agent",
      brProfileId: "abc-uuid-123",
    };
    saveAgentIdentity(original, agentFile);
    const loaded = loadOrCreateAgentIdentity(agentFile);
    expect(loaded).toEqual(original);
  });
});

describe("saveAgentIdentity", () => {
  it("sets 0600 perms on POSIX", () => {
    if (process.platform === "win32") return; // chmod is a no-op on win
    const identity: StoredAgentIdentity = {
      agentId: "brainstorm-cli-perms-test123",
      createdAt: new Date().toISOString(),
    };
    saveAgentIdentity(identity, agentFile);
    const mode = statSync(agentFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("BrainstormGateway.bootstrapAgent — payload validation", () => {
  it("rejects invalid agent_id before making a request", async () => {
    const gw = new BrainstormGateway({
      apiKey: "test",
      baseUrl: "https://example.invalid",
    });
    await expect(
      gw.bootstrapAgent({ agentId: "UPPERCASE-BAD" }),
    ).rejects.toThrow(/violates BR's pattern/);
    await expect(gw.bootstrapAgent({ agentId: "-leading" })).rejects.toThrow();
    await expect(gw.bootstrapAgent({ agentId: "ab" })).rejects.toThrow();
  });

  it("accepts a valid agent_id (payload validation passes; network call to fake host fails)", async () => {
    const gw = new BrainstormGateway({
      apiKey: "test",
      baseUrl: "https://example.invalid",
    });
    // The agent_id passes validation, so the call proceeds and we get
    // a network/dns error rather than the validation error.
    await expect(
      gw.bootstrapAgent({ agentId: "brainstorm-cli-validid123abcdef0" }),
    ).rejects.toThrow(); // any error is fine — just NOT the validation one
    await expect(
      gw.bootstrapAgent({ agentId: "brainstorm-cli-validid123abcdef0" }),
    ).rejects.not.toThrow(/violates BR's pattern/);
  });
});
