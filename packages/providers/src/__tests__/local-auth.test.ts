import { describe, it, expect } from "vitest";
import { buildAuthHeaders, resolveLocalAuth } from "../local/openai-compat.js";

describe("buildAuthHeaders", () => {
  it("returns undefined when there is no auth (localhost behaves as before)", () => {
    expect(buildAuthHeaders()).toBeUndefined();
    expect(buildAuthHeaders({})).toBeUndefined();
  });

  it("emits a bearer token from apiKey", () => {
    expect(buildAuthHeaders({ apiKey: "tok" })).toEqual({
      Authorization: "Bearer tok",
    });
  });

  it("merges static headers and the bearer token", () => {
    expect(
      buildAuthHeaders({ apiKey: "tok", headers: { "X-Team": "infra" } }),
    ).toEqual({ "X-Team": "infra", Authorization: "Bearer tok" });
  });

  it("replaces authorization case-insensitively when apiKey is configured", () => {
    expect(
      buildAuthHeaders({
        apiKey: "tok",
        headers: { authorization: "Basic stale", "X-Team": "infra" },
      }),
    ).toEqual({ "X-Team": "infra", Authorization: "Bearer tok" });
  });

  it("preserves static authorization when there is no apiKey", () => {
    expect(
      buildAuthHeaders({ headers: { authorization: "Basic configured" } }),
    ).toEqual({ authorization: "Basic configured" });
  });

  it("passes through static headers with no token", () => {
    expect(buildAuthHeaders({ headers: { "X-Team": "infra" } })).toEqual({
      "X-Team": "infra",
    });
  });
});

describe("resolveLocalAuth", () => {
  const resolver = (env: Record<string, string>) => (name: string) =>
    env[name] ?? null;

  it("returns undefined when the entry declares no auth", () => {
    expect(resolveLocalAuth({}, resolver({}))).toBeUndefined();
    expect(
      resolveLocalAuth({ apiKeyEnv: "MISSING" }, resolver({})),
    ).toBeUndefined();
  });

  it("resolves the token from the named env/vault key", () => {
    const auth = resolveLocalAuth(
      { apiKeyEnv: "JENKINS_TOKEN" },
      resolver({ JENKINS_TOKEN: "secret" }),
    );
    expect(auth).toEqual({ apiKey: "secret", headers: undefined });
    expect(buildAuthHeaders(auth)).toEqual({ Authorization: "Bearer secret" });
  });

  it("keeps static headers even when the token key is unset", () => {
    const auth = resolveLocalAuth(
      { apiKeyEnv: "MISSING", headers: { "X-Team": "infra" } },
      resolver({}),
    );
    expect(auth).toEqual({ apiKey: undefined, headers: { "X-Team": "infra" } });
  });
});
