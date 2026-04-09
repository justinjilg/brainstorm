import { describe, it, expect } from "vitest";
import {
  BrainstormError,
  ConfigError,
  ProviderError,
  RoutingError,
  BudgetExceededError,
  ToolPermissionDenied,
} from "../errors.js";

describe("Error classes", () => {
  it("BrainstormError has message and code", () => {
    const err = new BrainstormError("test error", "TEST_CODE");
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_CODE");
    expect(err.name).toBe("BrainstormError");
    expect(err).toBeInstanceOf(Error);
  });

  it("ConfigError sets CONFIG_ERROR code", () => {
    const err = new ConfigError("bad config");
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.name).toBe("ConfigError");
    expect(err).toBeInstanceOf(BrainstormError);
  });

  it("ProviderError captures provider name", () => {
    const err = new ProviderError("API down", "openai");
    expect(err.provider).toBe("openai");
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.name).toBe("ProviderError");
  });

  it("RoutingError sets ROUTING_ERROR code", () => {
    const err = new RoutingError("no models available");
    expect(err.code).toBe("ROUTING_ERROR");
    expect(err).toBeInstanceOf(BrainstormError);
  });

  it("BudgetExceededError formats message with costs", () => {
    const err = new BudgetExceededError("daily", 5.5, 10);
    expect(err.message).toContain("daily");
    expect(err.message).toContain("5.5000");
    expect(err.message).toContain("10.00");
    expect(err.limit).toBe("daily");
    expect(err.used).toBe(5.5);
    expect(err.max).toBe(10);
    expect(err.code).toBe("BUDGET_EXCEEDED");
  });

  it("ToolPermissionDenied captures tool name", () => {
    const err = new ToolPermissionDenied("shell");
    expect(err.toolName).toBe("shell");
    expect(err.message).toContain("shell");
    expect(err.code).toBe("TOOL_PERMISSION_DENIED");
  });

  it("all errors have stack traces", () => {
    const errors = [
      new BrainstormError("a", "A"),
      new ConfigError("b"),
      new ProviderError("c", "p"),
      new RoutingError("d"),
      new BudgetExceededError("e", 1, 2),
      new ToolPermissionDenied("f"),
    ];
    for (const err of errors) {
      expect(err.stack).toBeDefined();
      expect(err.stack).toContain(err.name);
    }
  });
});
