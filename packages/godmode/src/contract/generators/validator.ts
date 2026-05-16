/**
 * Validator generator — produces a runtime contract verifier from the
 * canonical Zod schemas in `schemas.ts`.
 *
 * Unlike the markdown and JSON-schema generators, this one does NOT
 * emit source code. It returns a function value that the existing
 * `verifyProductContract` entrypoint in `manifest.ts` consumes. The
 * "compiled" artifact is the function itself — same lockstep
 * principle, just with the boundary at runtime instead of build time.
 *
 * Response-shape selection (the bit the Stage-2 review fixed):
 *   For endpoints that declare alternateResponses, the validator
 *   discriminates by structural signal BEFORE validating against a
 *   variant. The /execute endpoint specifically uses `success: true`
 *   vs `success: false` and the presence of `simulation` to pick the
 *   intended response shape. The prior "any of the variants passes"
 *   loop allowed a server that returned a generic 404 envelope (with
 *   `success: false, error: {...}`) to be reported as a healthy
 *   endpoint — exactly the silent-pass risk the reviewers caught.
 */

import { z } from "zod";
import type { EndpointDef } from "../schemas.js";

export interface EndpointCheckPlan {
  id: string;
  method: string;
  path: string;
  auth: "none" | "bearer";
  validateResponseBody: (body: unknown, status: number) => ValidationOutcome;
  validateRequestBody?: (body: unknown) => ValidationOutcome;
  acceptStatuses: number[];
}

/**
 * Discriminated outcome. `ok=true` carries no payload; `ok=false`
 * always carries at least one issue. The prior optional-`issues`
 * shape forced every caller to optional-chain `.issues?.length`,
 * which the type-design reviewer flagged as the wrong default.
 */
export type ValidationOutcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      issues: Array<{ path: string; message: string }>;
    };

const OK: ValidationOutcome = { ok: true };

export function generateValidator(
  endpoints: EndpointDef[],
  endpointAcceptStatuses: Record<string, number[]> = {},
): EndpointCheckPlan[] {
  return endpoints.map((ep) => {
    const accept = endpointAcceptStatuses[ep.id] ?? [200];
    return {
      id: ep.id,
      method: ep.method,
      path: ep.path,
      auth: ep.auth,
      acceptStatuses: accept,
      validateRequestBody: ep.request
        ? (body) => check(ep.request as z.ZodTypeAny, body)
        : undefined,
      validateResponseBody: (body, status) =>
        validateResponse(ep, body, status),
    };
  });
}

function validateResponse(
  ep: EndpointDef,
  body: unknown,
  status: number,
): ValidationOutcome {
  const variants = [
    { name: "primary", schema: ep.response },
    ...(ep.alternateResponses ?? []),
  ];

  // Step 1: structural discrimination. If we can pick a single variant
  // from the body shape (or from the HTTP status), validate only against
  // that one — the failure message is then actionable instead of
  // "three variants all failed for different reasons".
  const picked = pickVariant(variants, body, status);
  if (picked) {
    const outcome = check(picked.schema, body);
    if (outcome.ok) return outcome;
    return prefixOutcome(picked.name, outcome);
  }

  // Step 2: no discriminator matched. The body is not in any
  // recognisable shape; surface that explicitly instead of dumping
  // every variant's complaint.
  if (variants.length === 1) {
    return prefixOutcome("primary", check(variants[0].schema, body));
  }
  return {
    ok: false,
    message: `response did not match any registered shape (tried ${variants.map((v) => v.name).join(", ")})`,
    issues: [
      {
        path: "<root>",
        message:
          "unrecognised response — no discriminator field (success / simulation) matched",
      },
    ],
  };
}

function pickVariant(
  variants: Array<{ name: string; schema: z.ZodTypeAny }>,
  body: unknown,
  _status: number,
): { name: string; schema: z.ZodTypeAny } | undefined {
  if (variants.length === 1) return variants[0];
  if (!isPlainObject(body)) return undefined;
  const b = body as Record<string, unknown>;

  // /execute: discriminator is `success` literal + presence of
  // `simulation`. The schemas use `z.literal(true)` / `z.literal(false)`
  // so we can read them directly off the body without running parse.
  if ("success" in b) {
    if (b.success === false) {
      const errorVariant = variants.find((v) => v.name === "error");
      if (errorVariant) return errorVariant;
    }
    if (b.success === true) {
      if ("simulation" in b) {
        const sim = variants.find((v) => v.name === "simulation");
        if (sim) return sim;
      }
      // primary success response
      return variants.find((v) => v.name === "primary");
    }
  }

  return undefined;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function check(schema: z.ZodTypeAny, body: unknown): ValidationOutcome {
  const result = schema.safeParse(body);
  if (result.success) return OK;
  const issues = result.error.issues.map((i) => ({
    path: i.path.join(".") || "<root>",
    message: i.message,
  }));
  return {
    ok: false,
    message: issues[0]
      ? `${issues[0].path}: ${issues[0].message}`
      : "schema mismatch",
    issues,
  };
}

function prefixOutcome(
  variantName: string,
  outcome: ValidationOutcome,
): ValidationOutcome {
  if (outcome.ok) return outcome;
  return {
    ok: false,
    message: `${variantName}: ${outcome.message}`,
    issues: outcome.issues,
  };
}
