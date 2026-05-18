/**
 * Docs field-level drift gate.
 *
 * Extends Stage-2's `docs-drift.mjs` (which only checks that every
 * endpoint's `METHOD /path` appears in the prose spec) to ALSO assert
 * every Zod-schema field name appears in the corresponding section's
 * field tables. Catches the drift mode where a field gets added to
 * `schemas.ts` but nobody updates `docs/platform-contract-v1.md`.
 *
 * Direction enforced:
 *   - Zod field ⊂ doc field set (schema-additive drift catches drift)
 *
 * Direction not enforced (informational only):
 *   - Doc field ⊂ Zod field set (the doc may legitimately mention
 *     fields removed from the schema, with deprecation context).
 *
 * Field-extraction heuristics:
 *   - The doc's section for an endpoint runs from the `METHOD /path`
 *     line until the next `##` heading.
 *   - Inside, look for markdown table rows. Field name is the first
 *     cell; we strip backticks and quotes.
 *   - Skip header rows (where the first cell is "Field" or
 *     "----").
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

function topLevelFieldNames(schema) {
  // Unwrap optional/default/effects wrappers to find a ZodObject.
  let s = schema;
  for (let i = 0; i < 8; i++) {
    if (s instanceof z.ZodOptional) s = s.unwrap();
    else if (s instanceof z.ZodDefault) s = s._def.innerType;
    else if (s instanceof z.ZodEffects) s = s.innerType();
    else break;
  }
  if (!(s instanceof z.ZodObject)) return [];
  return Object.keys(s.shape);
}

function locateSection(doc, method, p) {
  // Find the `METHOD /path` token, then walk forward until the next
  // top-level `##` heading. Returns the substring covering this
  // endpoint's content.
  const pair = `${method} ${p}`;
  const idx = doc.indexOf(pair);
  if (idx === -1) return null;
  // Look backwards for the previous heading start to anchor the
  // section properly.
  const sectionStart = doc.lastIndexOf("\n## ", idx);
  const start = sectionStart === -1 ? Math.max(0, idx - 200) : sectionStart;
  // Find the next `\n## ` after the pair to bound the section.
  const nextHead = doc.indexOf("\n## ", idx);
  const end = nextHead === -1 ? doc.length : nextHead;
  return doc.slice(start, end);
}

function extractDocFieldNames(section) {
  // Pull field names from BOTH markdown tables AND JSON-shaped code
  // blocks. The prose spec mixes both styles — some endpoints have
  // formal field tables, others show example response JSON. Either
  // counts as "documented."
  const fields = new Set();

  // 1. Markdown table rows: any `| <field> | ... |` line.
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    const first = cells.find((c) => c.length > 0);
    if (!first) continue;
    if (/^[-:]+$/.test(first)) continue;
    if (/^Field$/i.test(first)) continue;
    const cleaned = first.replace(/[`"']/g, "").trim();
    if (/^[a-z_][a-z0-9_]*$/i.test(cleaned)) {
      fields.add(cleaned);
    }
  }

  // 2. JSON-shaped code-block keys: `"name":` patterns. The doc's
  // example bodies surface field names this way; they're effectively
  // documentation even without a tabular structure.
  for (const m of section.matchAll(/"([a-z_][a-z0-9_]*)"\s*:/g)) {
    fields.add(m[1]);
  }

  return fields;
}

export async function check({ repoRoot }) {
  const issues = [];

  const distEntry = path.join(repoRoot, "packages/godmode/dist/index.js");
  if (!existsSync(distEntry)) {
    return {
      name: "docs-field-drift",
      ok: false,
      issues: [
        `@brainst0rm/godmode dist missing — run \`npx turbo run build --filter=@brainst0rm/godmode\` first.`,
      ],
    };
  }

  const docPath = path.join(repoRoot, "docs/platform-contract-v1.md");
  if (!existsSync(docPath)) {
    return {
      name: "docs-field-drift",
      ok: false,
      issues: [
        `docs/platform-contract-v1.md not found.`,
      ],
    };
  }
  const docText = readFileSync(docPath, "utf8");

  const { PLATFORM_ENDPOINTS } = await import(distEntry);

  let checked = 0;
  for (const ep of PLATFORM_ENDPOINTS) {
    const zodFields = topLevelFieldNames(ep.response);
    if (zodFields.length === 0) continue; // not an object-shaped response

    const section = locateSection(docText, ep.method, ep.path);
    if (!section) {
      // docs-drift.mjs already catches missing (method, path) — skip
      // here to avoid duplicate issues.
      continue;
    }

    const docFields = extractDocFieldNames(section);
    checked++;

    for (const f of zodFields) {
      if (!docFields.has(f)) {
        issues.push(
          `${ep.id} (${ep.method} ${ep.path}): Zod schema has field "${f}" but no markdown table in docs/platform-contract-v1.md references it. ` +
            `Add a row to the endpoint's response table or remove the field from the schema.`,
        );
      }
    }
  }

  return {
    name: "docs-field-drift",
    ok: issues.length === 0,
    issues,
    note: `${checked} endpoints' field tables checked`,
  };
}
