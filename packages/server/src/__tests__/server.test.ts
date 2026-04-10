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
    it("returns correct CORS headers when CORS is enabled", () => {
      const serverWithCors = new BrainstormServer(mockDependencies, {
        cors: true,
        jwtSecret: "test-secret",
      });
      const headers = (serverWithCors as any).corsHeaders(); // Access private method
      expect(headers).toEqual({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
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

    it("writes the correct status and JSON error message with CORS enabled", () => {
      const mockRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        setHeader: vi.fn(),
      } as unknown as ServerResponse;

      const message = "Unauthorized";
      const status = 401;
      const expectedPayload = {
        ok: false,
        error: message,
        request_id: "mock-uuid",
        timestamp: "2023-01-01T00:00:00.000Z",
      };

      (server as any).errorResponse(mockRes, status, message);

      expect(mockRes.writeHead).toHaveBeenCalledWith(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify(expectedPayload));
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
