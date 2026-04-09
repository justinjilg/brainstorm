import { describe, it, expect } from "vitest";
import { BUILTIN_MCP_SERVERS } from "../builtin-servers.js";

describe("BUILTIN_MCP_SERVERS", () => {
  it("has at least 3 builtin servers", () => {
    expect(BUILTIN_MCP_SERVERS.length).toBeGreaterThanOrEqual(3);
  });

  it("all servers have required fields", () => {
    for (const server of BUILTIN_MCP_SERVERS) {
      expect(server.name).toBeDefined();
      expect(typeof server.name).toBe("string");
      expect(server.transport).toBeDefined();
      expect(["stdio", "sse", "http"]).toContain(server.transport);
      expect(server.npmPackage).toBeDefined();
      expect(server.description).toBeDefined();
      expect(typeof server.enabled).toBe("boolean");
    }
  });

  it("all server names are unique", () => {
    const names = BUILTIN_MCP_SERVERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("stdio servers have command and args", () => {
    const stdioServers = BUILTIN_MCP_SERVERS.filter(
      (s) => s.transport === "stdio",
    );
    for (const server of stdioServers) {
      expect(server.command).toBeDefined();
      expect(Array.isArray(server.args)).toBe(true);
    }
  });

  it("includes playwright and github servers", () => {
    const names = BUILTIN_MCP_SERVERS.map((s) => s.name);
    expect(names).toContain("playwright");
    expect(names).toContain("github");
  });

  it("npm packages are valid package names", () => {
    for (const server of BUILTIN_MCP_SERVERS) {
      // Either @scope/name or plain name
      expect(server.npmPackage).toMatch(/^(@[\w-]+\/)?[\w-]+$/);
    }
  });
});
