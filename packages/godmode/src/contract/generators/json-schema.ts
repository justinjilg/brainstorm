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
  definitions: Record<string, unknown>;
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
  const definitions: Record<string, unknown> = {};
  const endpointEntries: JsonSchemaBundle["endpoints"] = {};

  for (const ep of endpoints) {
    const entry: JsonSchemaBundle["endpoints"][string] = {
      method: ep.method,
      path: ep.path,
      auth: ep.auth,
      summary: ep.summary,
      response: lowerSchema(ep.response),
    };
    if (ep.request) {
      entry.request = lowerSchema(ep.request);
    }
    if (ep.alternateResponses) {
      entry.alternateResponses = Object.fromEntries(
        ep.alternateResponses.map((alt) => [alt.name, lowerSchema(alt.schema)]),
      );
    }
    endpointEntries[ep.id] = entry;
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: opts.baseId,
    title: "Brainstorm Platform Contract",
    version: opts.version,
    definitions,
    endpoints: endpointEntries,
  };
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
