/**
 * Markdown spec generator — emits per-endpoint sections that match the
 * structure of `docs/platform-contract-v1.md`.
 *
 * The generator does NOT yet emit the entire spec end-to-end (auth
 * section, naming conventions, domain registry, etc. are prose-heavy
 * and stay hand-maintained). It does emit the per-endpoint
 * request/response tables that historically drifted from the actual
 * validator — that's the lockstep payoff for Stage 2.
 *
 * Output: a `EndpointSection[]` array. Each section has a stable
 * anchor slug, so callers can splice them into the canonical doc or
 * persist them as a snapshot for the golden test.
 */

import { z } from "zod";
import type { EndpointDef } from "../schemas.js";

export interface EndpointSection {
  id: string;
  anchor: string;
  title: string;
  markdown: string;
}

export function generateMarkdown(endpoints: EndpointDef[]): EndpointSection[] {
  return endpoints.map((ep) => {
    const lines: string[] = [];
    lines.push(`### ${ep.method} ${ep.path}`);
    lines.push("");
    lines.push(`**Auth:** ${ep.auth === "bearer" ? "Bearer token" : "None"}`);
    lines.push("");
    lines.push(ep.summary);
    lines.push("");

    if (ep.request) {
      lines.push("**Request body:**");
      lines.push("");
      lines.push(...fieldTable(ep.request));
      lines.push("");
    }

    lines.push("**Response:**");
    lines.push("");
    lines.push(...fieldTable(ep.response));
    lines.push("");

    if (ep.alternateResponses?.length) {
      for (const alt of ep.alternateResponses) {
        lines.push(`**Alternate response (${alt.name}):**`);
        lines.push("");
        lines.push(...fieldTable(alt.schema));
        lines.push("");
      }
    }

    return {
      id: ep.id,
      anchor: `endpoint-${ep.id}`,
      title: ep.title,
      markdown: lines.join("\n").trimEnd() + "\n",
    };
  });
}

function fieldTable(schema: z.ZodTypeAny): string[] {
  const fields = describeFields(schema);
  if (fields.length === 0) {
    const summary = topLevelSummary(schema);
    return [`_${summary}_`];
  }
  const out: string[] = [];
  out.push("| Field | Type | Required | Description |");
  out.push("| ----- | ---- | -------- | ----------- |");
  for (const f of fields) {
    out.push(
      `| \`${f.name}\` | ${f.typeLabel} | ${f.required ? "Yes" : "No"} | ${escape(f.description)} |`,
    );
  }
  return out;
}

interface FieldDescription {
  name: string;
  typeLabel: string;
  required: boolean;
  description: string;
}

function describeFields(schema: z.ZodTypeAny): FieldDescription[] {
  // Unwrap describe/optional wrappers to find a ZodObject root.
  const unwrapped = unwrap(schema);
  if (!(unwrapped instanceof z.ZodObject)) return [];

  const shape = unwrapped.shape as Record<string, z.ZodTypeAny>;
  const fields: FieldDescription[] = [];
  for (const [name, fieldSchema] of Object.entries(shape)) {
    fields.push({
      name,
      typeLabel: typeLabel(fieldSchema),
      required: !isOptional(fieldSchema),
      description: fieldSchema.description ?? "",
    });
  }
  return fields;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = schema;
  // ZodOptional/ZodDefault/ZodEffects wrap an inner schema.
  // The defensive any-casts here are deliberate: the Zod type defs are
  // package-version-sensitive and this code runs at build time.
  for (let i = 0; i < 16; i++) {
    if (cur instanceof z.ZodOptional)
      cur = (cur as z.ZodOptional<z.ZodTypeAny>).unwrap();
    else if (cur instanceof z.ZodDefault)
      cur = (cur as z.ZodDefault<z.ZodTypeAny>)._def.innerType;
    else if (cur instanceof z.ZodEffects)
      cur = (cur as z.ZodEffects<z.ZodTypeAny>).innerType();
    else break;
  }
  return cur;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema.isOptional?.() === true
  );
}

function typeLabel(schema: z.ZodTypeAny): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodString) return "string";
  if (inner instanceof z.ZodNumber) return "number";
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodLiteral) {
    return `\`${JSON.stringify((inner as z.ZodLiteral<unknown>).value)}\``;
  }
  if (inner instanceof z.ZodEnum) {
    const values = (inner as z.ZodEnum<[string, ...string[]]>).options;
    return values.map((v) => `\`${v}\``).join(" \\| ");
  }
  if (inner instanceof z.ZodArray) {
    return `array<${typeLabel((inner as z.ZodArray<z.ZodTypeAny>).element)}>`;
  }
  if (inner instanceof z.ZodObject) return "object";
  if (inner instanceof z.ZodRecord) return "object<string, any>";
  if (inner instanceof z.ZodUnknown || inner instanceof z.ZodAny) return "any";
  return inner._def?.typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
}

function topLevelSummary(schema: z.ZodTypeAny): string {
  return schema.description ?? typeLabel(schema);
}

function escape(s: string): string {
  return s.replace(/\|/g, "\\|");
}
