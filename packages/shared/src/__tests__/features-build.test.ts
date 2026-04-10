import { describe, it, expect } from "vitest";
import { getFeatureDefines, withFeatureDefines } from "../features-build.js";

describe("getFeatureDefines", () => {
  it("returns all feature flags for oss target as false", () => {
    const defines = getFeatureDefines("oss");
    expect(defines["__FEATURE_GATEWAY_INTELLIGENCE__"]).toBe("false");
    expect(defines["__FEATURE_TRAJECTORY_CAPTURE__"]).toBe("false");
    expect(defines["__FEATURE_SAAS_ANALYTICS__"]).toBe("false");
    expect(defines["__FEATURE_CLOUD_MEMORY__"]).toBe("false");
    expect(defines["__FEATURE_ADVANCED_ROUTING__"]).toBe("false");
    expect(defines["__FEATURE_AGENT_MARKETPLACE__"]).toBe("false");
  });

  it("returns all feature flags for saas target as true", () => {
    const defines = getFeatureDefines("saas");
    expect(defines["__FEATURE_GATEWAY_INTELLIGENCE__"]).toBe("true");
    expect(defines["__FEATURE_TRAJECTORY_CAPTURE__"]).toBe("true");
    expect(defines["__FEATURE_SAAS_ANALYTICS__"]).toBe("true");
    expect(defines["__FEATURE_CLOUD_MEMORY__"]).toBe("true");
    expect(defines["__FEATURE_ADVANCED_ROUTING__"]).toBe("true");
    expect(defines["__FEATURE_AGENT_MARKETPLACE__"]).toBe("true");
  });

  it("returns all feature flags for dev target as true", () => {
    const defines = getFeatureDefines("dev");
    expect(defines["__FEATURE_GATEWAY_INTELLIGENCE__"]).toBe("true");
    expect(defines["__FEATURE_TRAJECTORY_CAPTURE__"]).toBe("true");
    expect(defines["__FEATURE_SAAS_ANALYTICS__"]).toBe("true");
    expect(defines["__FEATURE_CLOUD_MEMORY__"]).toBe("true");
    expect(defines["__FEATURE_ADVANCED_ROUTING__"]).toBe("true");
    expect(defines["__FEATURE_AGENT_MARKETPLACE__"]).toBe("true");
  });

  it("returns string values for all entries", () => {
    const defines = getFeatureDefines("oss");
    for (const [key, value] of Object.entries(defines)) {
      expect(typeof value).toBe("string");
      expect(value === "true" || value === "false").toBe(true);
    }
  });

  it("returns exactly 6 feature flags for each target", () => {
    expect(Object.keys(getFeatureDefines("oss"))).toHaveLength(6);
    expect(Object.keys(getFeatureDefines("saas"))).toHaveLength(6);
    expect(Object.keys(getFeatureDefines("dev"))).toHaveLength(6);
  });
});

describe("withFeatureDefines", () => {
  it("merges feature defines with existing defines", () => {
    const existing = { "process.env.NODE_ENV": '"production"' };
    const result = withFeatureDefines("oss", existing);
    expect(result["process.env.NODE_ENV"]).toBe('"production"');
    expect(result["__FEATURE_GATEWAY_INTELLIGENCE__"]).toBe("false");
  });

  it("feature defines take precedence over existing defines with same key", () => {
    const existing = { __FEATURE_GATEWAY_INTELLIGENCE__: '"true"' };
    const result = withFeatureDefines("oss", existing);
    expect(result["__FEATURE_GATEWAY_INTELLIGENCE__"]).toBe("false");
  });

  it("works without existing defines", () => {
    const result = withFeatureDefines("saas");
    expect(Object.keys(result)).toHaveLength(6);
    expect(result["__FEATURE_SAAS_ANALYTICS__"]).toBe("true");
  });

  it("preserves all existing keys when merging", () => {
    const existing = {
      "process.env.API_URL": '"https://api.example.com"',
      "process.env.VERSION": '"1.0.0"',
    };
    const result = withFeatureDefines("dev", existing);
    expect(Object.keys(result)).toHaveLength(8);
    expect(result["process.env.API_URL"]).toBe('"https://api.example.com"');
    expect(result["process.env.VERSION"]).toBe('"1.0.0"');
  });
});
