/**
 * Tests for capability-registry product discovery (v0.4 M32).
 *
 * These tests stub the global fetch and process.env to drive the
 * resolver through its precedence rules:
 *   1. env override (FF-02) — wins, warns once per env var
 *   2. registry — used when env not set
 *   3. default URL — fallback when registry is unreachable
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  _resetCacheForTests,
  discoverProducts,
  resolveProductBaseUrl,
} from "../discovery/capability-registry.js";

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  _resetCacheForTests();
  // Strip BRAINSTORM_*_URL env vars between tests.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BRAINSTORM_") && k.endsWith("_URL")) {
      delete process.env[k];
    }
  }
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  process.env = { ...ORIG_ENV };
});

function mockRegistryResponse(body: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function mockRegistryError() {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

describe("discoverProducts", () => {
  test("aggregates capability counts by product from DIDs", async () => {
    mockRegistryResponse({
      count: 5,
      capabilities: [
        { agent_did: "did:bvm:t1:msp:abc", name: "x", status: "active" },
        { agent_did: "did:bvm:t1:msp:abc", name: "y", status: "active" },
        { agent_did: "did:bvm:t1:vm:def", name: "z", status: "active" },
        { agent_did: "did:bvm:t1:br:ghi", name: "w", status: "offline" },
        { agent_did: "did:bvm:t1:gtm:jkl", name: "v", status: "active" },
      ],
    });

    const products = await discoverProducts();
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));

    expect(byId.msp.status).toBe("online");
    expect(byId.msp.capabilitiesCount).toBe(2);
    expect(byId.vm.status).toBe("online");
    expect(byId.vm.capabilitiesCount).toBe(1);
    expect(byId.br.status).toBe("offline"); // only offline cap → offline
    expect(byId.gtm.status).toBe("online");
    expect(byId.backup.status).toBe("offline"); // no caps → offline
  });

  test("skips DIDs that don't parse as did:bvm:<tenant>:<product>:<short>", async () => {
    mockRegistryResponse({
      count: 2,
      capabilities: [
        { agent_did: "garbage", name: "x", status: "active" },
        { agent_did: "did:bvm:t1:msp:abc", name: "y", status: "active" },
      ],
    });

    const products = await discoverProducts();
    const msp = products.find((p) => p.id === "msp")!;
    expect(msp.capabilitiesCount).toBe(1);
  });

  test("ignores unknown product slots (forward compat)", async () => {
    mockRegistryResponse({
      count: 1,
      capabilities: [
        { agent_did: "did:bvm:t1:weird:abc", name: "x", status: "active" },
      ],
    });

    const products = await discoverProducts();
    expect(products.find((p) => p.id === "weird")).toBeUndefined();
  });
});

describe("resolveProductBaseUrl", () => {
  test("env override wins + emits deprecation warning to stderr", async () => {
    process.env.BRAINSTORM_MSP_URL = "https://msp-override.example.com";
    let stderr = "";
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;

    try {
      const url = await resolveProductBaseUrl("msp");
      expect(url).toBe("https://msp-override.example.com");
      expect(stderr).toContain("[deprecation]");
      expect(stderr).toContain("BRAINSTORM_MSP_URL");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("registry value used when no env override and registry reachable", async () => {
    mockRegistryResponse({
      count: 1,
      capabilities: [
        { agent_did: "did:bvm:t1:msp:abc", name: "x", status: "active" },
      ],
    });
    const url = await resolveProductBaseUrl("msp");
    expect(url).toBe("https://brainstormmsp.ai");
  });

  test("default URL when registry unreachable AND no env override", async () => {
    mockRegistryError();
    const url = await resolveProductBaseUrl("vm");
    expect(url).toBe("https://vm.brainstorm.co");
  });

  test("unknown product id throws", async () => {
    await expect(resolveProductBaseUrl("nope")).rejects.toThrow(
      "unknown product id",
    );
  });

  test("deprecation warning emitted only once per env var", async () => {
    process.env.BRAINSTORM_MSP_URL = "https://msp-override.example.com";
    let stderrWrites = 0;
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      if (
        typeof chunk === "string" &&
        chunk.includes("[deprecation]") &&
        chunk.includes("BRAINSTORM_MSP_URL")
      ) {
        stderrWrites++;
      }
      return true;
    }) as typeof process.stderr.write;
    try {
      await resolveProductBaseUrl("msp");
      await resolveProductBaseUrl("msp");
      await resolveProductBaseUrl("msp");
      expect(stderrWrites).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
  });
});
