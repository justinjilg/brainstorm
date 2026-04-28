/**
 * business-schema tests — ensures the federation manifest parses real
 * `business.toml` content as specified in the spec's `## Federation Manifest
 * (Final Shape)` section.
 *
 * Coverage targets:
 *   - Round-trip: the spec's reference manifest example parses without error.
 *   - Required-field enforcement: missing identity.id / identity.name /
 *     identity.archetype fail-closed.
 *   - Forward-compat: unknown top-level keys pass via .passthrough().
 *   - Defaults: omitted optional sections fill from schema defaults.
 *   - Tier classification: access tiers (sensitive/confidential/restricted/
 *     externalized_only) parse correctly.
 *   - AI-loop budget: the LLM Substrate Continuity block parses.
 *   - ID format: identity.id must match /^biz_[a-z0-9_-]+$/.
 *   - Archetype enum: rejects unknown archetypes.
 */

import { describe, test, expect } from "vitest";
import {
  businessTomlSchema,
  archetypeSchema,
  BUSINESS_SCHEMA_VERSION,
  type BusinessToml,
} from "../business-schema.js";

// The spec's reference example, line 13407 in
// ~/.claude/plans/snuggly-sleeping-hinton.md
const SPEC_EXAMPLE = {
  identity: {
    id: "biz_brainstorm",
    name: "Brainstorm",
    archetype: "saas-platform",
    schema: "1.0",
  },
  identity_root: "identity/",
  products: [
    {
      slug: "brainstorm",
      code: ["~/Projects/brainstorm"],
      runtime: {
        deploy: "do-app:041a63b9",
        api: "https://api.brainstormrouter.com",
      },
    },
    {
      slug: "hawktalk",
      code: ["~/Projects/hawktalk"],
      runtime: { deploy: "do-app:..." },
    },
  ],
  runtimes: {
    msp: {
      endpoint: "https://brainstormmsp.do/...",
      tenant: "tenant-uuid",
    },
    gtm: { endpoint: "https://catsfeet.com/..." },
    billing: { provider: "stripe", account_id: "acct_..." },
    crm: { provider: "attio", workspace_id: "..." },
    support: { provider: "intercom", app_id: "..." },
    observability: { provider: "datadog", account: "..." },
  },
  external_systems: {
    dns: { provider: "cloudflare", zones: ["brainstorm.co"] },
    iac: { provider: "terraform", repo: "~/Projects/BrainstormOps" },
  },
  validation: {
    strict: ["identity/identity.toml", "business.toml"],
    lenient: ["customers/", "products/", "operations/"],
    advisory: ["**/*.md"],
  },
  access: {
    sensitive: [
      "team/compensation/**",
      "team/performance/feedback/**",
      "governance/contracts/employment/**",
      "operations/finance/**",
    ],
  },
};

describe("businessTomlSchema — round-trip from spec example", () => {
  test("the spec's reference manifest parses without error", () => {
    const parsed = businessTomlSchema.parse(SPEC_EXAMPLE);
    expect(parsed.identity.id).toBe("biz_brainstorm");
    expect(parsed.identity.archetype).toBe("saas-platform");
    expect(parsed.products).toHaveLength(2);
    expect(parsed.runtimes.msp).toEqual({
      endpoint: "https://brainstormmsp.do/...",
      tenant: "tenant-uuid",
    });
  });

  test("BUSINESS_SCHEMA_VERSION is the default schema field", () => {
    const minimal = {
      identity: {
        id: "biz_test",
        name: "Test",
        archetype: "saas-platform",
      },
    };
    const parsed = businessTomlSchema.parse(minimal);
    expect(parsed.identity.schema).toBe(BUSINESS_SCHEMA_VERSION);
  });
});

describe("businessTomlSchema — required fields", () => {
  test("missing identity.id fails", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { name: "X", archetype: "saas-platform" },
      }),
    ).toThrow();
  });

  test("missing identity.name fails", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "biz_x", archetype: "saas-platform" },
      }),
    ).toThrow();
  });

  test("missing identity.archetype fails", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "biz_x", name: "X" },
      }),
    ).toThrow();
  });
});

describe("businessTomlSchema — id and archetype validation", () => {
  test("identity.id must match biz_ pattern", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "wrong-prefix", name: "X", archetype: "saas-platform" },
      }),
    ).toThrow();

    expect(() =>
      businessTomlSchema.parse({
        identity: {
          id: "biz_INVALID-uppercase",
          name: "X",
          archetype: "saas-platform",
        },
      }),
    ).toThrow();
  });

  test("identity.archetype must be a known archetype", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: {
          id: "biz_x",
          name: "X",
          archetype: "frankenstein",
        },
      }),
    ).toThrow();
  });

  test("all v1 archetypes are accepted", () => {
    const archetypes = [
      "msp",
      "saas-platform",
      "agency",
      "marketplace",
      "ecommerce",
      "services",
    ] as const;
    for (const archetype of archetypes) {
      expect(() => archetypeSchema.parse(archetype)).not.toThrow();
    }
  });
});

describe("businessTomlSchema — forward compatibility", () => {
  test("unknown top-level keys are allowed (.passthrough)", () => {
    const withUnknown = {
      identity: {
        id: "biz_x",
        name: "X",
        archetype: "saas-platform",
      },
      unknown_v2_section: { foo: "bar" },
    };
    const parsed = businessTomlSchema.parse(withUnknown) as BusinessToml & {
      unknown_v2_section?: unknown;
    };
    expect(parsed.unknown_v2_section).toEqual({ foo: "bar" });
  });

  test("unknown product fields are allowed (.passthrough on products)", () => {
    const parsed = businessTomlSchema.parse({
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
      products: [
        {
          slug: "foo",
          code: [],
          runtime: {},
          v2_field: "future",
        },
      ],
    });
    expect((parsed.products[0] as Record<string, unknown>).v2_field).toBe(
      "future",
    );
  });
});

describe("businessTomlSchema — defaults", () => {
  test("omitted sections fill from defaults", () => {
    const minimal = {
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
    };
    const parsed = businessTomlSchema.parse(minimal);
    expect(parsed.identity_root).toBe("identity/");
    expect(parsed.products).toEqual([]);
    expect(parsed.runtimes).toEqual({});
    expect(parsed.external_systems).toEqual({});
    expect(parsed.validation.advisory).toEqual(["**/*.md"]);
    expect(parsed.access.sensitive).toEqual([]);
    expect(parsed.ai_loops.monthly_budget_usd).toBe(500);
    expect(parsed.ai_loops.detector_throttle_mode).toBe("skip");
  });

  test("identity.status defaults to active", () => {
    const parsed = businessTomlSchema.parse({
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
    });
    expect(parsed.identity.status).toBe("active");
  });
});

describe("businessTomlSchema — access tier classification", () => {
  test("all four tier globs parse", () => {
    const parsed = businessTomlSchema.parse({
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
      access: {
        sensitive: ["team/foo/**"],
        confidential: ["team/bar/**"],
        restricted: ["governance/contracts/employment/**"],
        externalized_only: ["team/compensation/**"],
      },
    });
    expect(parsed.access.sensitive).toHaveLength(1);
    expect(parsed.access.confidential).toHaveLength(1);
    expect(parsed.access.restricted).toHaveLength(1);
    expect(parsed.access.externalized_only).toHaveLength(1);
  });

  test("alerts.on_decrypt_restricted defaults to true", () => {
    const parsed = businessTomlSchema.parse({
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
      access: { restricted: ["x/**"] },
    });
    expect(parsed.access.alerts.on_decrypt_restricted).toBe(true);
  });
});

describe("businessTomlSchema — ai_loops budget", () => {
  test("custom budget overrides default", () => {
    const parsed = businessTomlSchema.parse({
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
      ai_loops: {
        monthly_budget_usd: 2000,
        detector_throttle_mode: "escalate",
        alert_threshold_pct: 0.9,
      },
    });
    expect(parsed.ai_loops.monthly_budget_usd).toBe(2000);
    expect(parsed.ai_loops.detector_throttle_mode).toBe("escalate");
    expect(parsed.ai_loops.alert_threshold_pct).toBe(0.9);
  });

  test("monthly_budget_usd rejects negative", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
        ai_loops: { monthly_budget_usd: -1 },
      }),
    ).toThrow();
  });

  test("alert_threshold_pct rejects out-of-range", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
        ai_loops: { alert_threshold_pct: 1.5 },
      }),
    ).toThrow();
  });
});

describe("businessTomlSchema — product pointer", () => {
  test("product slug must match pattern", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
        products: [{ slug: "Bad-Slug", code: [], runtime: {} }],
      }),
    ).toThrow();
  });

  test("product status enum is enforced when present", () => {
    expect(() =>
      businessTomlSchema.parse({
        identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
        products: [{ slug: "p1", code: [], runtime: {}, status: "exploding" }],
      }),
    ).toThrow();
  });

  test("product code array can be empty (e.g. for service-only products)", () => {
    const parsed = businessTomlSchema.parse({
      identity: { id: "biz_x", name: "X", archetype: "saas-platform" },
      products: [{ slug: "managed-service", code: [], runtime: {} }],
    });
    expect(parsed.products[0]?.code).toEqual([]);
  });
});
