#!/usr/bin/env node
/**
 * Bounded Brainstorm ↔ BrainstormRouter route contract map.
 *
 * This is intentionally NOT a full BrainstormRouter route inventory. It maps
 * only the BR/product routes the business harness currently touches, then
 * checks those against code, docs, BR OpenAPI, BR capability metadata, BR RBAC,
 * and BR SDK resources where applicable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BR_ROOT =
  process.env.BRAINSTORMROUTER_REPO ??
  path.resolve(REPO_ROOT, "..", "brainstormrouter");

const JSON_OUT = path.join(
  REPO_ROOT,
  "artifacts/br-business-contract-map.json",
);
const MD_OUT = path.join(
  REPO_ROOT,
  "docs/internal/br-business-harness-contract-matrix.md",
);

const ROUTES = [
  {
    id: "br.health",
    target: "br",
    method: "GET",
    path: "/health",
    purpose: "Unauthenticated BR liveness and connectivity check.",
    contract: "br-openapi",
    codeRefs: [
      ["packages/tools/src/builtin/br-intelligence.ts", "`${BR_BASE}/health`"],
      ["packages/gateway/src/client.ts", '"/health"'],
    ],
    docRefs: [
      ["docs/brainstormrouter-integration.md", "`/health`"],
      ["docs/runbooks/br-degraded.md", "/health"],
    ],
  },
  {
    id: "br.openapi",
    target: "br",
    method: "GET",
    path: "/openapi.json",
    purpose: "Machine-readable BR endpoint contract.",
    contract: "br-static-asset",
    codeRefs: [
      [
        "packages/providers/src/__tests__/br-live-contract.live.test.ts",
        "/openapi.json",
      ],
    ],
    docRefs: [
      ["docs/brainstormrouter-integration.md", "openapi.json"],
      ["docs/internal/br-business-harness-e2e-autopsy-plan.md", "openapi.json"],
    ],
  },
  {
    id: "br.attestation",
    target: "br",
    method: "GET",
    path: "/attestation",
    purpose: "Signed image and transparency-log attestation.",
    contract: "br-openapi",
    codeRefs: [],
    docRefs: [
      ["docs/brainstormrouter-integration.md", "/attestation"],
      ["docs/assessment-evidence-v15.md", "/attestation"],
    ],
  },
  {
    id: "br.discovery",
    target: "br",
    method: "GET",
    path: "/v1/discovery",
    purpose: "BR self-describing capability and memory-block discovery.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/providers/src/__tests__/br-live-contract.live.test.ts",
        "/v1/discovery",
      ],
      ["packages/gateway/src/client.ts", '"/v1/discovery"'],
    ],
    docRefs: [
      ["docs/brainstormrouter-integration.md", "/v1/discovery"],
      ["docs/path-to-90-plan-2026-05-15.md", "/v1/discovery"],
    ],
  },
  {
    id: "br.self",
    target: "br",
    method: "GET",
    path: "/v1/self",
    purpose:
      "Agent self-awareness, identity, budget, provider health, suggestions.",
    contract: "br-openapi",
    codeRefs: [
      ["packages/tools/src/builtin/br-intelligence.ts", 'brFetch("/v1/self")'],
      ["packages/gateway/src/client.ts", '"/v1/self"'],
    ],
    docRefs: [
      ["docs/runbooks/br-degraded.md", "/v1/self"],
      ["docs/br-capability-audit.md", "/v1/self"],
    ],
  },
  {
    id: "br.chat_completions",
    target: "br",
    method: "POST",
    path: "/v1/chat/completions",
    purpose: "OpenAI-compatible model routing through BR.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/providers/src/cloud/brainstorm-saas.ts",
        'BR_BASE_URL = "https://api.brainstormrouter.com/v1"',
      ],
      [
        "packages/providers/src/__tests__/br-live-contract.live.test.ts",
        "/v1/chat/completions",
      ],
    ],
    docRefs: [
      ["docs/brainstormrouter-integration.md", "/v1/chat/completions"],
      ["docs/runbooks/audit-chain-broken.md", "/v1/chat/completions"],
    ],
  },
  {
    id: "br.budget_status",
    target: "br",
    method: "GET",
    path: "/v1/budget/status",
    purpose: "Current tenant/key budget state.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/tools/src/builtin/br-intelligence.ts",
        'brFetch("/v1/budget/status")',
      ],
    ],
    docRefs: [
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/budget/status",
      ],
      ["docs/br-capability-audit.md", "/v1/budget/status"],
    ],
  },
  {
    id: "br.budget_forecast",
    target: "br",
    method: "GET",
    path: "/v1/budget/forecast",
    purpose: "Spend forecast and anomaly summary.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/tools/src/builtin/br-intelligence.ts",
        'brFetch("/v1/budget/forecast")',
      ],
    ],
    docRefs: [
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/budget/forecast",
      ],
    ],
  },
  {
    id: "br.intelligence_rankings",
    target: "br",
    method: "GET",
    path: "/v1/intelligence/rankings",
    purpose: "Production model ranking and leaderboard signal.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/tools/src/builtin/br-intelligence.ts",
        "/v1/intelligence/rankings",
      ],
      ["docs/internal/br-api-spec.md", "/v1/intelligence/rankings"],
    ],
    docRefs: [
      ["docs/internal/br-api-spec.md", "/v1/intelligence/rankings"],
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/intelligence/rankings",
      ],
    ],
  },
  {
    id: "br.insights_optimize",
    target: "br",
    method: "GET",
    path: "/v1/insights/optimize",
    purpose: "Cost optimization recommendations.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/tools/src/builtin/br-intelligence.ts",
        'brFetch("/v1/insights/optimize")',
      ],
    ],
    docRefs: [
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/insights/optimize",
      ],
    ],
  },
  {
    id: "br.models",
    target: "br",
    method: "GET",
    path: "/v1/models",
    purpose: "List available routed models.",
    contract: "br-openapi",
    codeRefs: [
      [
        "packages/tools/src/builtin/br-intelligence.ts",
        'brFetch("/v1/models")',
      ],
      ["packages/gateway/src/client.ts", '"/v1/models"'],
    ],
    docRefs: [
      ["docs/brainstormrouter-integration.md", "/v1/models"],
      ["docs/br-capability-audit.md", "/v1/models"],
    ],
  },
  {
    id: "br.memory_query",
    target: "br",
    method: "POST",
    path: "/v1/memory/query",
    purpose: "Search BR persistent memory without writing.",
    contract: "br-openapi",
    codeRefs: [
      ["packages/tools/src/builtin/br-intelligence.ts", "/v1/memory/query"],
      ["packages/gateway/src/client.ts", "/v1/memory/query"],
    ],
    docRefs: [
      ["docs/internal/br-api-spec.md", "/v1/memory/query"],
      ["docs/br-capability-audit.md", "/v1/memory/query"],
    ],
  },
  {
    id: "br.memory_store",
    target: "br",
    method: "POST",
    path: "/v1/memory/store",
    purpose:
      "Store BR persistent memory. Must remain confirmation-gated in the harness.",
    contract: "br-openapi",
    codeRefs: [
      ["packages/tools/src/builtin/br-intelligence.ts", "/v1/memory/store"],
    ],
    docRefs: [
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/memory/store",
      ],
    ],
  },
  {
    id: "a2a.invoke_did",
    target: "br",
    method: "POST",
    path: "/v1/mesh/invoke-did/{target_did}",
    purpose: "Invoke a DID-addressed product/agent capability through BR.",
    contract: "br-openapi",
    codeRefs: [
      ["packages/cli/src/commands/a2a.ts", "/v1/mesh/invoke-did/"],
      ["packages/cli/src/__tests__/a2a.test.ts", "/v1/mesh/invoke-did/"],
    ],
    docRefs: [
      ["docs/a2a-protocol-v01.md", "/v1/mesh/invoke-did/{target_did}"],
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/mesh/invoke-did/{target_did}",
      ],
    ],
  },
  {
    id: "a2a.hostname_invoke",
    target: "br",
    method: "POST",
    path: "/v1/mesh/invoke/{hostname}",
    purpose: "BR mTLS hostname route. The DID CLI must not use this path.",
    contract: "br-openapi",
    negativeCodeRefs: [
      [
        "packages/cli/src/commands/a2a.ts",
        "/v1/mesh/invoke/${encodeURIComponent",
      ],
      ["packages/cli/src/commands/a2a.ts", "/v1/mesh/invoke/"],
    ],
    docRefs: [
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/v1/mesh/invoke/{hostname}",
      ],
    ],
  },
  {
    id: "a2a.status_url",
    target: "br",
    method: "GET",
    path: "/v1/mesh/task/{task_id}",
    purpose: "Async A2A status URL returned by BR on 202 responses.",
    contract: "response-driven",
    codeRefs: [["packages/cli/src/commands/a2a.ts", "status_url"]],
    docRefs: [["docs/a2a-protocol-v01.md", "/v1/mesh/task/<task_id>"]],
  },
  {
    id: "vm.capability_list",
    target: "vm",
    method: "GET",
    path: "/api/v1/capabilities/list",
    purpose: "Current capability registry source for `brainstorm a2a list`.",
    contract: "vm-capability-registry",
    codeRefs: [
      ["packages/cli/src/commands/a2a.ts", "/api/v1/capabilities/list"],
      [
        "packages/cli/src/discovery/capability-registry.ts",
        "/api/v1/capabilities/list",
      ],
    ],
    docRefs: [
      [
        "docs/internal/br-business-harness-e2e-autopsy-plan.md",
        "/api/v1/capabilities/list",
      ],
    ],
  },
  {
    id: "platform.health",
    target: "product",
    method: "GET",
    path: "/health",
    purpose: "Platform Contract v1 product health.",
    contract: "platform-contract-v1",
    codeRefs: [
      ["packages/godmode/src/product-connector.ts", 'apiFetch("/health")'],
      ["packages/cli/src/commands/status.ts", "/health"],
    ],
    docRefs: [
      ["docs/platform-contract-v1.md", "GET /health"],
      ["docs/getting-started.md", "GET  /health"],
    ],
  },
  {
    id: "platform.godmode_tools",
    target: "product",
    method: "GET",
    path: "/api/v1/god-mode/tools",
    purpose: "Discover product actuator tools.",
    contract: "platform-contract-v1",
    codeRefs: [
      [
        "packages/godmode/src/product-connector.ts",
        'apiFetch("/api/v1/god-mode/tools")',
      ],
      ["packages/cli/src/commands/status.ts", "/api/v1/god-mode/tools"],
    ],
    docRefs: [
      ["docs/platform-contract-v1.md", "GET /api/v1/god-mode/tools"],
      ["docs/getting-started.md", "GET  /api/v1/god-mode/tools"],
    ],
  },
  {
    id: "platform.godmode_execute",
    target: "product",
    method: "POST",
    path: "/api/v1/god-mode/execute",
    purpose: "Execute or simulate product actuator tools.",
    contract: "platform-contract-v1",
    codeRefs: [
      [
        "packages/godmode/src/product-connector.ts",
        'apiFetch("/api/v1/god-mode/execute"',
      ],
      ["packages/msp-executor/src/msp-executor.ts", "/api/v1/god-mode/execute"],
    ],
    docRefs: [
      ["docs/platform-contract-v1.md", "POST /api/v1/god-mode/execute"],
      ["docs/getting-started.md", "POST /api/v1/god-mode/execute"],
    ],
  },
];

const LEGACY_DOC_MENTIONS = [
  {
    doc: "docs/brainstormrouter-integration.md",
    stale: "/v1/agent/status",
    replacement: "/v1/self",
  },
  {
    doc: "docs/brainstormrouter-integration.md",
    stale: "/v1/agent/memory",
    replacement: "/v1/memory/query and /v1/memory/store",
  },
  {
    doc: "docs/brainstormrouter-integration.md",
    stale: "/v1/intelligence/leaderboard",
    replacement: "/v1/intelligence/rankings",
  },
  {
    doc: "docs/brainstormrouter-integration.md",
    stale: "/v1/intelligence/insights",
    replacement: "/v1/insights/optimize",
  },
  {
    doc: "docs/brainstormrouter-integration.md",
    stale: "/v1/health",
    replacement: "/health",
  },
];

function readMaybe(absPath) {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

function relRead(relPath, root = REPO_ROOT) {
  return readMaybe(path.join(root, relPath));
}

function walkFiles(root, predicate) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, predicate));
    else if (predicate(abs)) out.push(abs);
  }
  return out;
}

function normalizePathForConcrete(pathPattern) {
  return pathPattern.replaceAll(/\{[^}]+\}/g, "example");
}

function openApiPaths(brRoot) {
  const yaml = readMaybe(path.join(brRoot, "docs/openapi.yaml"));
  const paths = new Set();
  for (const match of yaml.matchAll(/^  (\/[^:\n]+):\s*$/gm)) {
    paths.add(match[1]);
  }
  return paths;
}

function brCapabilityRoutes(brRoot) {
  const files = walkFiles(path.join(brRoot, "src/api/capabilities"), (abs) =>
    abs.endsWith(".ts"),
  );
  const routes = new Map();
  const re =
    /protocols:\s*\{\s*rest:\s*\{\s*method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)"/g;
  for (const abs of files) {
    const text = readMaybe(abs);
    for (const match of text.matchAll(re)) {
      const key = `${match[1]} ${match[2]}`;
      const rel = path.relative(brRoot, abs);
      const arr = routes.get(key) ?? [];
      arr.push(rel);
      routes.set(key, arr);
    }
  }
  return routes;
}

function brRbacEntries(brRoot) {
  const text = readMaybe(path.join(brRoot, "src/api/middleware/rbac.ts"));
  const entries = [];
  const re =
    /\{\s*method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)",\s*permission:\s*"([^"]+)"/g;
  for (const match of text.matchAll(re)) {
    entries.push({ method: match[1], path: match[2], permission: match[3] });
  }
  return entries;
}

function brSdkPaths(brRoot) {
  const files = walkFiles(path.join(brRoot, "packages/sdk-ts/src"), (abs) =>
    abs.endsWith(".ts"),
  );
  const paths = new Map();
  const re = /this\._(get|post|put|delete|patch)\(`?([^"`]+)["`]/g;
  for (const abs of files) {
    const text = readMaybe(abs);
    for (const match of text.matchAll(re)) {
      const method = match[1].toUpperCase();
      const route = match[2];
      if (!route.startsWith("/")) continue;
      const key = `${method} ${route}`;
      const arr = paths.get(key) ?? [];
      arr.push(path.relative(brRoot, abs));
      paths.set(key, arr);
    }
  }
  return paths;
}

function rbacMatch(entries, method, pathPattern, capabilityHasRoute) {
  const concrete = normalizePathForConcrete(pathPattern);
  const exact = entries.find(
    (e) => e.method === method && e.path === pathPattern,
  );
  if (exact)
    return { found: true, via: "rbac-exact", permission: exact.permission };
  const prefix = entries.find(
    (e) =>
      e.method === method &&
      e.path.endsWith("/") &&
      concrete.startsWith(e.path),
  );
  if (prefix) {
    return { found: true, via: "rbac-prefix", permission: prefix.permission };
  }
  if (capabilityHasRoute) {
    return {
      found: true,
      via: "capability-fallback",
      permission: "capability",
    };
  }
  return { found: false, via: "none", permission: null };
}

function sourceRefs(refs, root = REPO_ROOT) {
  return (refs ?? []).map(([file, needle]) => {
    const text = relRead(file, root);
    return {
      file,
      needle,
      present: text.includes(needle),
    };
  });
}

function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function analyze() {
  const brRepoDetected = fs.existsSync(BR_ROOT);
  const openapi = openApiPaths(BR_ROOT);
  const capabilities = brCapabilityRoutes(BR_ROOT);
  const rbac = brRbacEntries(BR_ROOT);
  const sdk = brSdkPaths(BR_ROOT);

  const routes = ROUTES.map((route) => {
    const key = routeKey(route);
    const openApiPresent = openapi.has(route.path);
    const capabilityFiles = capabilities.get(key) ?? [];
    const sdkFiles = sdk.get(key) ?? [];
    const code = sourceRefs(route.codeRefs);
    const docs = sourceRefs(route.docRefs);
    const negativeCode = sourceRefs(route.negativeCodeRefs);
    const capabilityPresent = capabilityFiles.length > 0;
    const rbacResult = rbacMatch(
      rbac,
      route.method,
      route.path,
      capabilityPresent,
    );

    const issues = [];
    const warnings = [];

    for (const ref of code) {
      if (!ref.present) {
        issues.push(`code reference missing: ${ref.file} :: ${ref.needle}`);
      }
    }
    for (const ref of docs) {
      if (!ref.present) {
        warnings.push(`doc reference missing: ${ref.file} :: ${ref.needle}`);
      }
    }
    for (const ref of negativeCode) {
      if (ref.present) {
        issues.push(
          `forbidden code reference present: ${ref.file} :: ${ref.needle}`,
        );
      }
    }

    if (route.contract === "br-openapi") {
      if (!brRepoDetected) {
        warnings.push(
          `BR repo not detected at ${BR_ROOT}; OpenAPI check skipped`,
        );
      } else if (!openApiPresent) {
        issues.push(`BR OpenAPI missing ${route.path}`);
      }
      if (
        brRepoDetected &&
        !capabilityPresent &&
        route.path !== "/openapi.json"
      ) {
        warnings.push(`BR capability metadata did not expose ${key}`);
      }
      if (
        brRepoDetected &&
        !rbacResult.found &&
        !["/health", "/attestation"].includes(route.path)
      ) {
        warnings.push(`BR RBAC/capability permission not found for ${key}`);
      }
    }

    if (route.id === "a2a.invoke_did" && brRepoDetected && !rbacResult.found) {
      issues.push(`BR permission resolution missing for ${key}`);
    }

    return {
      ...route,
      key,
      evidence: {
        code,
        docs,
        negativeCode,
        br_openapi: route.contract === "br-openapi" ? openApiPresent : null,
        br_capability_files: capabilityFiles,
        br_rbac: rbacResult,
        br_sdk_files: sdkFiles,
      },
      status: issues.length === 0 ? "ok" : "fail",
      issues,
      warnings,
    };
  });

  const legacyDocMentions = LEGACY_DOC_MENTIONS.map((entry) => {
    const present = relRead(entry.doc).includes(entry.stale);
    return { ...entry, present };
  });

  const issues = routes.flatMap((r) =>
    r.issues.map((issue) => `${r.id}: ${issue}`),
  );
  const warnings = [
    ...routes.flatMap((r) =>
      r.warnings.map((warning) => `${r.id}: ${warning}`),
    ),
    ...legacyDocMentions
      .filter((entry) => entry.present)
      .map(
        (entry) =>
          `${entry.doc} mentions stale ${entry.stale}; current replacement is ${entry.replacement}`,
      ),
  ];

  return {
    schema_version: 1,
    scope:
      "bounded to Brainstorm routes currently touching BR/product actuator contracts",
    repo_root: REPO_ROOT,
    br_repo_root: BR_ROOT,
    br_repo_detected: brRepoDetected,
    ok: issues.length === 0,
    counts: {
      routes: routes.length,
      failures: routes.filter((r) => r.status === "fail").length,
      warnings: warnings.length,
      br_openapi_paths_seen: openapi.size,
      br_capability_routes_seen: capabilities.size,
      br_rbac_entries_seen: rbac.length,
      br_sdk_paths_seen: sdk.size,
    },
    routes,
    legacy_doc_mentions: legacyDocMentions,
    issues,
    warnings,
  };
}

function yes(value) {
  if (value === null) return "n/a";
  if (Array.isArray(value)) return value.length > 0 ? "yes" : "no";
  return value ? "yes" : "no";
}

function refsYes(refs) {
  if (refs.length === 0) return "n/a";
  return yes(refs.every((ref) => ref.present));
}

function mdEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdown(map) {
  const lines = [];
  lines.push("# BR Business Harness Contract Matrix");
  lines.push("");
  lines.push("Status: generated by `npm run br:contract-map`.");
  lines.push("");
  lines.push(
    "Scope is intentionally bounded to the BR and product actuator routes this harness currently touches. It is not a full BrainstormRouter route inventory.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Routes tracked: ${map.counts.routes}`);
  lines.push(`- Failures: ${map.counts.failures}`);
  lines.push(`- Warnings: ${map.counts.warnings}`);
  lines.push(`- BR repo detected: ${map.br_repo_detected ? "yes" : "no"}`);
  lines.push(`- BR OpenAPI paths seen: ${map.counts.br_openapi_paths_seen}`);
  lines.push(
    `- BR capability routes seen: ${map.counts.br_capability_routes_seen}`,
  );
  lines.push(`- BR RBAC entries seen: ${map.counts.br_rbac_entries_seen}`);
  lines.push("");

  if (map.issues.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const issue of map.issues) lines.push(`- ${issue}`);
    lines.push("");
  }

  if (map.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of map.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push("## Route Matrix");
  lines.push("");
  lines.push(
    "| Status | ID | Target | Method | Path | Code | Docs | BR OpenAPI | BR Capability | Permission | SDK | Purpose |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of map.routes) {
    lines.push(
      [
        r.status === "ok" ? "ok" : "fail",
        r.id,
        r.target,
        r.method,
        r.path,
        refsYes(r.evidence.code),
        refsYes(r.evidence.docs),
        yes(r.evidence.br_openapi),
        yes(r.evidence.br_capability_files),
        r.evidence.br_rbac.found
          ? `${r.evidence.br_rbac.via}:${r.evidence.br_rbac.permission}`
          : "no",
        yes(r.evidence.br_sdk_files),
        r.purpose,
      ]
        .map(mdEscape)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  lines.push("");

  lines.push("## Legacy Doc Mentions");
  lines.push("");
  lines.push("| Present | Doc | Stale | Replacement |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of map.legacy_doc_mentions) {
    lines.push(
      `| ${entry.present ? "yes" : "no"} | ${mdEscape(entry.doc)} | ${mdEscape(entry.stale)} | ${mdEscape(entry.replacement)} |`,
    );
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- `a2a.invoke_did` is the load-bearing route for `brainstorm a2a invoke <did> <capability>`.",
  );
  lines.push(
    "- `a2a.hostname_invoke` is tracked as a negative guard: the DID CLI must not send encoded DIDs to that hostname route.",
  );
  lines.push(
    "- `a2a.status_url` is response-driven; it may not appear as a standalone BR OpenAPI path until async task polling is formalized.",
  );
  lines.push(
    "- Structural preflight gate #17 (`br-contract-map`) runs this map in `npm run contract-check`.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function formatOutput(text, parser) {
  try {
    const prettier = await import("prettier");
    return await prettier.format(text, { parser });
  } catch {
    return text;
  }
}

function writeIfChanged(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readMaybe(file);
  if (existing !== content) fs.writeFileSync(file, content);
}

async function main() {
  const check = process.argv.includes("--check");
  const json = process.argv.includes("--json");
  const map = analyze();
  const jsonText = await formatOutput(stableJson(map), "json");
  const mdText = await formatOutput(renderMarkdown(map), "markdown");

  if (json) process.stdout.write(jsonText);

  if (check) {
    const stale = [];
    if (readMaybe(JSON_OUT) !== jsonText)
      stale.push(path.relative(REPO_ROOT, JSON_OUT));
    if (readMaybe(MD_OUT) !== mdText)
      stale.push(path.relative(REPO_ROOT, MD_OUT));
    if (stale.length > 0) {
      process.stderr.write(
        `BR contract map outputs are stale: ${stale.join(", ")}. Run npm run br:contract-map.\n`,
      );
      process.exit(1);
    }
  } else {
    writeIfChanged(JSON_OUT, jsonText);
    writeIfChanged(MD_OUT, mdText);
  }

  if (!map.ok) {
    process.stderr.write(
      `BR business contract map found ${map.issues.length} failure(s).\n`,
    );
    for (const issue of map.issues) process.stderr.write(`  - ${issue}\n`);
    process.exit(1);
  }

  if (!json) {
    process.stdout.write(
      `BR business contract map ok: ${map.counts.routes} routes, ${map.counts.warnings} warning(s).\n`,
    );
    process.stdout.write(`  JSON: ${path.relative(REPO_ROOT, JSON_OUT)}\n`);
    process.stdout.write(`  Matrix: ${path.relative(REPO_ROOT, MD_OUT)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(
    `BR business contract map crashed: ${
      err instanceof Error ? err.stack : String(err)
    }\n`,
  );
  process.exit(2);
});
