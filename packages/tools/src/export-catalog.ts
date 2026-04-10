#!/usr/bin/env tsx
/**
 * Tool Catalog Export — generates docs/tool-catalog.json
 *
 * Produces a machine-readable catalog of all brainstorm tools with:
 * - JSON Schema for each tool's inputSchema (via zod-to-json-schema)
 * - Operational metadata: permission, readonly, headlessSafe, category
 * - Protocol notes for multi-step tools
 * - Runtime discovery docs for MCP and God Mode tools
 * - Error contract specification
 *
 * Usage:
 *   npx tsx src/export-catalog.ts              # Write to docs/tool-catalog.json
 *   npx tsx src/export-catalog.ts --check      # Exit 1 if catalog is stale
 *   npx tsx src/export-catalog.ts --stdout      # Print to stdout
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createDefaultToolRegistry } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = resolve(__dirname, "../../../docs/tool-catalog.json");

// ── Category mapping ──────────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, string> = {
  file_read: "filesystem",
  file_write: "filesystem",
  file_edit: "filesystem",
  multi_edit: "filesystem",
  batch_edit: "filesystem",
  list_dir: "filesystem",
  glob: "filesystem",
  grep: "filesystem",
  shell: "shell",
  process_spawn: "shell",
  process_kill: "shell",
  build_verify: "shell",
  git_status: "git",
  git_diff: "git",
  git_log: "git",
  git_commit: "git",
  git_branch: "git",
  git_stash: "git",
  gh_pr: "github",
  gh_issue: "github",
  web_fetch: "web",
  web_search: "web",
  task_create: "tasks",
  task_update: "tasks",
  task_list: "tasks",
  undo_last_write: "agent",
  scratchpad_write: "agent",
  scratchpad_read: "agent",
  ask_user: "agent",
  set_routing_hint: "agent",
  cost_estimate: "agent",
  plan_preview: "planning",
  begin_transaction: "transactions",
  commit_transaction: "transactions",
  rollback_transaction: "transactions",
  br_status: "brainstorm_router",
  br_budget: "brainstorm_router",
  br_models: "brainstorm_router",
  br_memory_search: "brainstorm_router",
  br_memory_store: "brainstorm_router",
  br_leaderboard: "brainstorm_router",
  br_insights: "brainstorm_router",
  br_health: "brainstorm_router",
  tool_search: "discovery",
  daemon_sleep: "daemon",
};

// ── Headless safety ───────────────────────────────────────────────

const HEADLESS_UNSAFE = new Set([
  "ask_user", // Blocks waiting for UI event — deadlocks in brainstorm run
]);

// confirm-permission tools are headless-safe WITH --lfg flag
// They're marked headlessSafe: true because the automation flag resolves them

// ── Protocol notes for multi-step tools ───────────────────────────

const PROTOCOL_NOTES: Record<string, string> = {
  git_commit:
    "Requires --lfg or --unattended in non-interactive mode to bypass confirmation prompt.",
  begin_transaction:
    "Opens an atomic transaction. All file writes are staged. Must be followed by commit_transaction or rollback_transaction.",
  commit_transaction:
    "Applies all staged writes from begin_transaction atomically.",
  rollback_transaction:
    "Discards all staged writes from begin_transaction. No files are changed.",
  tool_search:
    "Discovers and loads deferred MCP/God Mode tools by keyword. Call this to find runtime-discovered tools not in the static catalog.",
  daemon_sleep:
    "Only available in daemon mode. Model calls this to control its own wake cycle.",
  ask_user:
    "Blocks waiting for UI event. Only works in interactive chat mode (brainstorm chat). Deadlocks in brainstorm run.",
  shell:
    "Supports foreground (default 120s timeout) and background mode (returns task ID). Use --lfg to auto-approve in non-interactive mode.",
  batch_edit:
    "Cross-file find-and-replace in one atomic operation. Validates all edits before applying any.",
  br_memory_store:
    "Stores a key-value pair in BrainstormRouter's memory. Requires active BR API key.",
  br_memory_search:
    "Searches BrainstormRouter's memory by semantic query. Requires active BR API key.",
};

// ── Build catalog ─────────────────────────────────────────────────

function buildCatalog(): Record<string, unknown> {
  const registry = createDefaultToolRegistry({ daemon: true });
  const allTools = registry.getAll();

  // Build category index
  const categories: Record<string, string[]> = {};
  for (const tool of allTools) {
    const cat = TOOL_CATEGORIES[tool.name] ?? "other";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(tool.name);
  }

  // Build per-tool entries
  const tools: Record<string, unknown> = {};
  for (const tool of allTools) {
    let inputSchema: unknown = {};
    try {
      inputSchema = zodToJsonSchema(tool.inputSchema, { target: "openApi3" });
      // Remove $schema wrapper that zod-to-json-schema adds
      if (
        typeof inputSchema === "object" &&
        inputSchema !== null &&
        "$schema" in inputSchema
      ) {
        delete (inputSchema as Record<string, unknown>)["$schema"];
      }
    } catch {
      inputSchema = { type: "object", properties: {} };
    }

    tools[tool.name] = {
      description: tool.description,
      category: TOOL_CATEGORIES[tool.name] ?? "other",
      permission: tool.permission,
      readonly: tool.readonly ?? false,
      headlessSafe: !HEADLESS_UNSAFE.has(tool.name),
      ...(PROTOCOL_NOTES[tool.name]
        ? { protocol: PROTOCOL_NOTES[tool.name] }
        : {}),
      inputSchema,
    };
  }

  return {
    $comment:
      "Machine-readable tool catalog for Brainstorm CLI. Generated by packages/tools/src/export-catalog.ts. Do not edit manually.",
    version: "0.13.0",
    generated: new Date().toISOString(),
    static: {
      toolCount: allTools.length,
      categories,
      tools,
    },
    runtime: {
      mcp: {
        description:
          "MCP tools are loaded from configured MCP servers at startup. Use tool_search to discover them.",
        discovery:
          'Call tool_search with a keyword to find and load deferred MCP tools. Example: tool_search({ query: "deploy" })',
        configLocation:
          "~/.brainstorm/mcp.json (global) or ./.brainstorm/mcp.json (project)",
      },
      godmode: {
        description:
          "God Mode tools are discovered from connected products (MSP, BR, GTM, VM, Shield) at startup via GET /api/v1/god-mode/tools.",
        discovery:
          "Products are configured in brainstorm.toml [godmode.connectors]. Each healthy product registers its tools automatically.",
        requires:
          "API key for the product set as environment variable or in vault",
        typicalCounts: {
          msp: 79,
          brainstorm_router: 10,
          gtm: 9,
          vm: 9,
          shield: 10,
        },
      },
    },
    errorContract: {
      success:
        "Tool returns a domain-specific object (e.g., { content, totalLines } for file_read)",
      failure:
        'Tool returns { error: string } (e.g., { error: "File not found: /path" })',
      detection:
        "Check for the presence of an 'error' key in the result object",
      note: "There is no unified { ok, data, error } wrapper. Each tool returns its own shape on success.",
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const stdoutMode = args.includes("--stdout");

const catalog = buildCatalog();
const json = JSON.stringify(catalog, null, 2) + "\n";

if (checkMode) {
  if (!existsSync(DOCS_PATH)) {
    console.error(
      "docs/tool-catalog.json does not exist. Run: npm run export-catalog",
    );
    process.exit(1);
  }
  const existing = readFileSync(DOCS_PATH, "utf-8");
  // Compare without generated timestamp
  const normalize = (s: string) =>
    s.replace(/"generated":\s*"[^"]+"/, '"generated": ""');
  const existingHash = createHash("sha256")
    .update(normalize(existing))
    .digest("hex");
  const newHash = createHash("sha256").update(normalize(json)).digest("hex");

  if (existingHash !== newHash) {
    console.error(
      "docs/tool-catalog.json is stale. Run: npm run export-catalog",
    );
    process.exit(1);
  }
  console.log("docs/tool-catalog.json is up to date.");
  process.exit(0);
}

if (stdoutMode) {
  process.stdout.write(json);
} else {
  writeFileSync(DOCS_PATH, json);
  const toolCount = Object.keys((catalog as any).static.tools).length;
  console.log(`Wrote docs/tool-catalog.json (${toolCount} tools)`);
}
