/**
 * JSON Schema generator — emits Draft 7 schemas for every endpoint
 * request/response, intended as the universal interchange artifact
 * that third-party product implementers can consume regardless of
 * language.
 *
 * Output structure:
 *   {
 *     "$id": "https://brainstorm.co/contract/v1.json",
 *     "definitions": {
 *       "HealthResponse": { ... },
 *       "ToolDefinition": { ... },
 *       ...
 *     },
 *     "endpoints": {
 *       "health": { "response": { "$ref": "#/definitions/HealthResponse" } },
 *       ...
 *     }
 *   }
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { EndpointDef } from "../schemas.js";

export interface JsonSchemaBundle {
  $schema: string;
  $id: string;
  title: string;
  version: string;
  endpoints: Record<
    string,
    {
      method: string;
      path: string;
      auth: string;
      summary: string;
      request?: unknown;
      response: unknown;
      alternateResponses?: Record<string, unknown>;
    }
  >;
}

export function generateJsonSchema(
  endpoints: EndpointDef[],
  opts: { version: string; baseId: string },
): JsonSchemaBundle {
  const endpointEntries: JsonSchemaBundle["endpoints"] = {};

  for (const ep of endpoints) {
    const entry: JsonSchemaBundle["endpoints"][string] = {
      method: ep.method,
      path: ep.path,
      auth: ep.auth,
      summary: ep.summary,
      response: lowerWithContext(ep.id, "response", ep.response),
    };
    if (ep.request) {
      entry.request = lowerWithContext(ep.id, "request", ep.request);
    }
    if (ep.alternateResponses) {
      const altRecord: Record<string, unknown> = {};
      for (const alt of ep.alternateResponses) {
        if (altRecord[alt.name] !== undefined) {
          throw new Error(
            `json-schema generator: duplicate alternateResponse name "${alt.name}" on endpoint "${ep.id}".`,
          );
        }
        altRecord[alt.name] = lowerWithContext(
          ep.id,
          `alternateResponses.${alt.name}`,
          alt.schema,
        );
      }
      entry.alternateResponses = altRecord;
    }
    endpointEntries[ep.id] = entry;
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: opts.baseId,
    title: "Brainstorm Platform Contract",
    version: opts.version,
    endpoints: endpointEntries,
  };
}

function lowerWithContext(
  endpointId: string,
  field: string,
  schema: unknown,
): unknown {
  try {
    return lowerSchema(schema);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `json-schema generation failed for ${endpointId}.${field}: ${msg}`,
    );
  }
}

function lowerSchema(schema: unknown): unknown {
  // zod-to-json-schema accepts ZodType<any, any, any>; cast at the
  // boundary. The compiler validates inputs by virtue of EndpointDef.
  const raw = zodToJsonSchema(schema as never, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  // strip the $schema wrapper it adds — the bundle declares it once at
  // the top level.
  if (raw && typeof raw === "object" && "$schema" in raw) {
    const { $schema: _, ...rest } = raw as Record<string, unknown>;
    return rest;
  }
  return raw;
}
