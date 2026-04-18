import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrainstormServer } from "../server";
import { ServerResponse, IncomingMessage } from "node:http";

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "mock-uuid"),
}));

vi.setSystemTime(new Date("2023-01-01T00:00:00.000Z"));

// Mock dependencies for BrainstormServer
const mockDependencies = {
  db: {} as any,
  config: {},
  registry: {} as any,
  router: {} as any,
  costTracker: {} as any,
  tools: {} as any,
  godmode: {} as any,
  memoryManager: {} as any,
  version: "test-version",
};

describe("BrainstormServer Utility Methods", () => {
  let server: BrainstormServer;

  beforeEach(() => {
    server = new BrainstormServer(mockDependencies, {
      cors: true,
      jwtSecret: "test-secret",
    });
  });

  describe("corsHeaders", () => {
    it("returns allowlist-reflected CORS headers for a matching origin", () => {
      // The old wildcard `Access-Control-Allow-Origin: *` was replaced
      // with an allowlist-reflection model (commit d36d967). Now the
      // test has to ship an Origin header and set allowedOrigins.
      const serverWithCors = new BrainstormServer(mockDependencies, {
        cors: true,
        allowedOrigins: ["http://localhost:1420"],
        jwtSecret: "test-secret",
      });
      const req = {
        headers: { origin: "http://localhost:1420" },
      } as unknown as import("node:http").IncomingMessage;
      const headers = (serverWithCors as any).corsHeaders(req);
      expect(headers).toEqual({
        "Access-Control-Allow-Origin": "http://localhost:1420",
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
    });

    it("returns empty headers when the origin isn't in the allowlist", () => {
      const server = new BrainstormServer(mockDependencies, {
        cors: true,
        allowedOrigins: ["http://localhost:1420"],
        jwtSecret: "test-secret",
      });
      const req = {
        headers: { origin: "http://evil.example" },
      } as unknown as import("node:http").IncomingMessage;
      expect((server as any).corsHeaders(req)).toEqual({});
    });
  });

  describe("errorResponse", () => {
    it("writes the correct status and JSON error message when CORS is disabled", () => {
      const serverWithoutCors = new BrainstormServer(mockDependencies, {
        cors: false,
        jwtSecret: "test-secret",
      });
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        setHeader: vi.fn(),
      } as unknown as ServerResponse;

      const message = "Something went wrong";
      const status = 400;
      const expectedPayload = {
        ok: false,
        error: message,
        request_id: "mock-uuid",
        timestamp: "2023-01-01T00:00:00.000Z",
      };

      (serverWithoutCors as any).errorResponse(mockRes, status, message);

      expect(mockRes.writeHead).toHaveBeenCalledWith(status, {
        "Content-Type": "application/json",
      });
      expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify(expectedPayload));
    });

    it("writes CORS headers when the response has an allowlisted origin attached", () => {
      // Post-d36d967 the server reads the request off a side-channel
      // (`res._brainstormReq`) so it can reflect the matching origin.
      // To exercise the CORS-enabled branch the test has to attach a
      // request with an origin the server's allowlist accepts.
      const serverWithCors = new BrainstormServer(mockDependencies, {
        cors: true,
        allowedOrigins: ["http://localhost:1420"],
        jwtSecret: "test-secret",
      });
      const fakeReq = {
        headers: { origin: "http://localhost:1420" },
      } as unknown as import("node:http").IncomingMessage;
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        setHeader: vi.fn(),
        _brainstormReq: fakeReq,
      } as unknown as ServerResponse;

      const message = "Unauthorized";
      const status = 401;
      (serverWithCors as any).errorResponse(mockRes, status, message);

      expect(mockRes.writeHead).toHaveBeenCalledWith(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "http://localhost:1420",
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
    });
  });

  describe("envelope", () => {
    it("wraps data in a standard envelope", () => {
      const data = { message: "Hello" };
      const enveloped = (server as any).envelope(data);
      expect(enveloped).toEqual({
        ok: true,
        data: { message: "Hello" },
        request_id: "mock-uuid",
        timestamp: "2023-01-01T00:00:00.000Z",
      });
    });
  });

  describe("safeInt", () => {
    it("returns the parsed integer for valid input", () => {
      expect((server as any).safeInt("123", 0)).toBe(123);
    });

    it("returns the fallback for invalid input", () => {
      expect((server as any).safeInt("abc", 0)).toBe(0);
    });

    it("returns the fallback for null input", () => {
      expect((server as any).safeInt(null, 5)).toBe(5);
    });

    it("returns the fallback for empty string input", () => {
      expect((server as any).safeInt("", 10)).toBe(10);
    });

    it("returns the value itself if it is already a valid number string", () => {
      expect((server as any).safeInt("42", 99)).toBe(42);
    });
  });
});
