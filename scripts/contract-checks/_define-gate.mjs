/**
 * Gate factory — the single import every gate uses.
 *
 * Stage-3 had each gate manually return `{ name, ok, issues[], note? }`.
 * The Stage-3 review found three failure modes that came from this
 * being a duck-typed shape:
 *
 *   1. A gate returning `{ ok: true }` with no `issues` array
 *      crashes the orchestrator's `r.issues.length` access in JSON
 *      mode.
 *   2. A gate returning `{ ok: false, issues: [] }` violates the
 *      ok↔issues coupling — the human report shows FAIL with no
 *      bullets, leaving operators guessing.
 *   3. "Failed because of drift" and "failed because the gate's
 *      infrastructure broke (dist missing, syntax error in the gate
 *      module)" collapsed to the same shape. Operators chased
 *      phantom contract failures.
 *
 * `defineGate({ name, check })` validates the returned shape at the
 * boundary and adds a structural `kind` field so reports can
 * distinguish infrastructure problems from real drift.
 */

/**
 * @typedef {{ name: string, ok: true, info?: string[], note?: string }} GatePass
 * @typedef {{
 *   name: string,
 *   ok: false,
 *   kind: "drift" | "infra",
 *   issues: string[],
 *   note?: string,
 * }} GateFail
 * @typedef {GatePass | GateFail} CheckResult
 *
 * @typedef {{ repoRoot: string, verbose?: boolean }} CheckContext
 */

/**
 * Validate a gate's returned result. Throws on any structural
 * violation — the orchestrator wraps gate invocations in try/catch
 * and surfaces the throw as an infra failure (so the gate's bug
 * doesn't get reported as a drift finding).
 *
 * @param {string} expectedName
 * @param {unknown} result
 * @returns {CheckResult}
 */
function validateResult(expectedName, result) {
  if (!result || typeof result !== "object") {
    throw new Error(
      `gate "${expectedName}" returned ${typeof result}, expected an object.`,
    );
  }
  const r = /** @type {Record<string, unknown>} */ (result);
  if (r.name !== expectedName) {
    throw new Error(
      `gate "${expectedName}" returned name="${r.name}". The name field must match the gate's declared name.`,
    );
  }
  if (typeof r.ok !== "boolean") {
    throw new Error(`gate "${expectedName}" returned non-boolean ok.`);
  }
  if (r.ok === false) {
    if (!Array.isArray(r.issues) || r.issues.length === 0) {
      throw new Error(
        `gate "${expectedName}" returned ok=false but no issues. ok=false MUST carry at least one issue.`,
      );
    }
    if (r.kind !== undefined && r.kind !== "drift" && r.kind !== "infra") {
      throw new Error(
        `gate "${expectedName}" returned kind="${r.kind}". Allowed: "drift" or "infra".`,
      );
    }
  } else {
    if (r.issues !== undefined) {
      throw new Error(
        `gate "${expectedName}" returned ok=true with an issues field. ok=true must use the info field for non-fatal notes.`,
      );
    }
  }
  return /** @type {CheckResult} */ (result);
}

/**
 * Declare a contract gate. The factory wraps the body with shape
 * validation and infra-failure tagging — every gate uses this so
 * the orchestrator never sees a malformed CheckResult.
 *
 * @param {{ name: string, check: (ctx: CheckContext) => Promise<CheckResult> }} def
 */
export function defineGate(def) {
  return {
    name: def.name,
    async run(ctx) {
      try {
        const result = await def.check(ctx);
        return validateResult(def.name, result);
      } catch (err) {
        // The gate threw OR returned a malformed result. Either way
        // this is an infra failure, not a drift finding.
        const stack =
          err instanceof Error
            ? err.stack?.split("\n").slice(0, 4).join("\n") ?? err.message
            : String(err);
        return /** @type {CheckResult} */ ({
          name: def.name,
          ok: false,
          kind: "infra",
          issues: [
            `gate threw or returned malformed result: ${err instanceof Error ? err.message : String(err)}`,
            stack,
          ],
        });
      }
    },
  };
}

/**
 * Helper: build a successful CheckResult. Use this instead of object
 * literals so the shape stays consistent.
 *
 * @param {string} name
 * @param {{ info?: string[], note?: string }} [opts]
 * @returns {CheckResult}
 */
export function gatePass(name, opts = {}) {
  const r = { name, ok: /** @type {const} */ (true) };
  if (opts.info && opts.info.length > 0) r.info = opts.info;
  if (opts.note) r.note = opts.note;
  return r;
}

/**
 * Helper: build a failed CheckResult. The `kind` argument forces the
 * gate author to decide whether this is real drift (the contract is
 * broken) or infrastructure (the gate couldn't run — dist missing,
 * tsx not on PATH, etc.). Operators reading CI output need to be
 * able to tell those apart.
 *
 * @param {string} name
 * @param {"drift" | "infra"} kind
 * @param {string[]} issues
 * @param {{ note?: string }} [opts]
 * @returns {CheckResult}
 */
export function gateFail(name, kind, issues, opts = {}) {
  if (!issues || issues.length === 0) {
    throw new Error(
      `gateFail("${name}", ...) called with no issues. Callers MUST supply at least one.`,
    );
  }
  /** @type {GateFail} */
  const r = { name, ok: false, kind, issues };
  if (opts.note) r.note = opts.note;
  return r;
}
