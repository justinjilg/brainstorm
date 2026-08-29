import { describe, expect, it } from "vitest";
import { sanitizeProvidersForIPC } from "../../ipc/handler.js";

describe("sanitizeProvidersForIPC", () => {
  it("removes key fields and redacts every custom header value", () => {
    const safe = sanitizeProvidersForIPC({
      lmstudio: {
        enabled: true,
        apiKeyEnv: "REMOTE_MODEL_TOKEN",
        headers: {
          Authorization: "Bearer top-secret",
          "X-API-Key": "another-secret",
          "X-Tenant": "customer-42",
        },
      },
    });

    expect(safe.lmstudio).toEqual({
      enabled: true,
      name: "lmstudio",
      headers: {
        Authorization: "[configured]",
        "X-API-Key": "[configured]",
        "X-Tenant": "[configured]",
      },
    });
    expect(JSON.stringify(safe)).not.toContain("top-secret");
    expect(JSON.stringify(safe)).not.toContain("REMOTE_MODEL_TOKEN");
    expect(JSON.stringify(safe)).not.toContain("customer-42");
  });
});
