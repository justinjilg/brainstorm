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
 * Why this trade-off:
 *   The TS validator only ever runs inside the brainstorm CLI process;
 *   nothing downstream needs the source as a string. Emitting it as
 *   source would force a build step (`tsx compile-contract.ts --write`
 *   then commit) for every spec change. Returning a function value
 *   means the spec change automatically reaches the validator on next
 *   process start — a soft form of hot-reload.
 *
 * The validator validates response shapes against the Zod schemas
 * registered with each endpoint, surfacing per-field issues that the
 * old hand-rolled `validate(body)` callbacks couldn't catch (they
 * only checked top-level field presence).
 */

import type { z } from "zod";
import type { EndpointDef } from "../schemas.js";

export interface EndpointCheckPlan {
  id: string;
  method: string;
  path: string;
  auth: "none" | "bearer";
  validateResponseBody: (body: unknown) => ValidationOutcome;
  validateRequestBody?: (body: unknown) => ValidationOutcome;
  /**
   * Acceptable response status codes. Defaults to [200]. Set to allow
   * "endpoint exists but our test payload was rejected" cases like
   * 401/403/409 on the platform-events and tenants endpoints where the
   * verifier intentionally sends a malformed signature.
   */
  acceptStatuses: number[];
}

export interface ValidationOutcome {
  ok: boolean;
  /** Concise message — first-line of the failing reason if !ok. */
  message: string;
  /** Per-field issues with dotted paths. */
  issues?: Array<{ path: string; message: string }>;
}

export function generateValidator(
  endpoints: EndpointDef[],
  endpointAcceptStatuses: Record<string, number[]> = {},
): EndpointCheckPlan[] {
  return endpoints.map((ep) => {
    const accept = endpointAcceptStatuses[ep.id] ?? [200];
    const responseValidators: Array<{ name: string; schema: z.ZodTypeAny }> = [
      { name: "primary", schema: ep.response },
      ...(ep.alternateResponses ?? []),
    ];

    return {
      id: ep.id,
      method: ep.method,
      path: ep.path,
      auth: ep.auth,
      acceptStatuses: accept,
      validateRequestBody: ep.request
        ? (body) => check(ep.request!, body)
        : undefined,
      validateResponseBody: (body) => {
        // Accept any of the registered response shapes — the contract
        // explicitly allows simulation + error variants on /execute.
        const attempts: ValidationOutcome[] = [];
        for (const r of responseValidators) {
          const outcome = check(r.schema, body);
          if (outcome.ok) return outcome;
          attempts.push({
            ...outcome,
            message: `${r.name}: ${outcome.message}`,
          });
        }
        // Concatenate per-shape failure summaries so the operator can
        // see why each variant was rejected.
        return {
          ok: false,
          message: attempts.map((a) => a.message).join("; "),
          issues: attempts.flatMap((a) => a.issues ?? []),
        };
      },
    };
  });
}

function check(schema: z.ZodTypeAny, body: unknown): ValidationOutcome {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, message: "ok" };
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
