/**
 * Contract compiler — walks `PLATFORM_ENDPOINTS` and dispatches each
 * registered generator. This is the brainstorm-side analogue of BR's
 * `scripts/contract-compile.ts`: one source of truth (the Zod
 * schemas) compiled to N output artifacts (markdown spec, JSON
 * Schema, runtime validator, language-specific bindings).
 *
 * The compiler does NOT write files itself; it returns a structured
 * `CompilerOutput` object. The CLI wrapper in
 * `scripts/compile-contract.ts` decides whether to write, print, or
 * snapshot-diff. Same separation BR uses (`compile()` returns IR,
 * generators return files, the CLI plumbs them).
 */

import { PLATFORM_ENDPOINTS, type EndpointDef } from "./schemas.js";
import {
  generateMarkdown,
  type EndpointSection,
} from "./generators/markdown.js";
import {
  generateJsonSchema,
  type JsonSchemaBundle,
} from "./generators/json-schema.js";
import {
  generateValidator,
  type EndpointCheckPlan,
} from "./generators/validator.js";
import { generatePydantic, type PydanticFile } from "./generators/pydantic.js";
import { generateGo, type GoFile } from "./generators/go.js";

export const CONTRACT_VERSION = "1.0.0";
export const CONTRACT_BASE_ID =
  "https://brainstorm.co/contract/v1/platform-contract.schema.json";

export interface CompilerOutput {
  endpoints: EndpointDef[];
  markdown: EndpointSection[];
  jsonSchema: JsonSchemaBundle;
  validator: EndpointCheckPlan[];
  pydantic: PydanticFile[];
  go: GoFile[];
}

export interface CompileOptions {
  /**
   * Override the accept-status set per endpoint. The validator
   * defaults to [200] but `platform-events` and `platform-tenants` are
   * tolerant of 401/403/409 because the verifier intentionally sends
   * a malformed signature/idempotency-key to test endpoint existence.
   */
  endpointAcceptStatuses?: Record<string, number[]>;
}

export function compileContract(opts: CompileOptions = {}): CompilerOutput {
  // Default accept-statuses match the prior hand-rolled
  // verifyProductContract behaviour so the rewire is a no-op for live
  // products.
  const accept: Record<string, number[]> = {
    health: [200],
    "god-mode-tools": [200],
    "god-mode-execute": [200, 400, 401, 403, 404, 429],
    "platform-events": [200, 401, 403],
    "platform-tenants": [200, 201, 400, 401, 403, 409],
    ...opts.endpointAcceptStatuses,
  };

  return {
    endpoints: PLATFORM_ENDPOINTS,
    markdown: generateMarkdown(PLATFORM_ENDPOINTS),
    jsonSchema: generateJsonSchema(PLATFORM_ENDPOINTS, {
      version: CONTRACT_VERSION,
      baseId: CONTRACT_BASE_ID,
    }),
    validator: generateValidator(PLATFORM_ENDPOINTS, accept),
    pydantic: generatePydantic(PLATFORM_ENDPOINTS),
    go: generateGo(PLATFORM_ENDPOINTS),
  };
}

export type {
  EndpointDef,
  EndpointSection,
  JsonSchemaBundle,
  EndpointCheckPlan,
  PydanticFile,
  GoFile,
};
