/**
 * Doctor → runbook routing (path-to-90 P8a).
 *
 * `storm doctor` is the operator's primary diagnostic. Pre-P8a, a failed
 * check printed a status + detail but did NOT point the operator at any
 * recovery runbook — even though three runbooks ship at
 * `docs/runbooks/{api-key-rotation,startup-health,vault-recovery}.md`.
 *
 * Operator persona's v14 one-week action: surface "→ see docs/runbooks/
 * <file>.md" so doctor failures route to the documented recovery path
 * without grepping.
 *
 * Extracted to its own module so the routing logic is testable without
 * importing the side-effecting CLI entry point at bin/brainstorm.ts.
 */

export interface DoctorCheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  /**
   * Optional runbook hint — when status is fail or warn, the doctor
   * printer surfaces a "→ see docs/runbooks/<file>.md" line so the
   * operator follows the chain without grepping. Path is relative to
   * repo root.
   */
  runbook?: string;
}

export interface DoctorSection {
  title: string;
  results: DoctorCheckResult[];
}

/**
 * Map common doctor-failure classes to the runbook that documents recovery.
 *
 * Heuristics (case-insensitive on the name + detail combined):
 *   - vault / lock / unlock / decrypt / argon2 / aes-gcm → vault-recovery.md
 *   - api key / token / unauthorized / 401 / 403 / invalid key / missing key
 *     / rotate → api-key-rotation.md
 *   - everything else at fail/warn → startup-health.md (generic
 *     "first run / connectivity" reference)
 *
 * Returns `undefined` for pass-level results.
 */
export function pickRunbook(
  status: DoctorCheckResult["status"],
  name: string,
  detail: string,
): string | undefined {
  if (status === "pass") return undefined;
  const haystack = `${name} ${detail}`.toLowerCase();
  if (/\b(vault|locked|unlock|decrypt|argon2|aes-?gcm)\b/.test(haystack)) {
    return "docs/runbooks/vault-recovery.md";
  }
  // Underscore is treated as a word char by \b, so we use it in the
  // separator class but a non-word lookaround on the start/end of the
  // alternation matches the typical env-var styles: BRAINSTORM_API_KEY,
  // OPENAI_API_KEY, api-key, api key, apikey, etc.
  if (
    /(?:^|[^a-z0-9])(api[\s_-]?key|token|unauthorized|401|403|invalid[\s_-]?key|missing[\s_-]?key|rotate)(?:[^a-z0-9]|$)/.test(
      haystack,
    )
  ) {
    return "docs/runbooks/api-key-rotation.md";
  }
  return "docs/runbooks/startup-health.md";
}

/**
 * Decorate a DoctorSection by adding `runbook` hints to any non-pass
 * results that don't already have one. Idempotent: results with an
 * explicit `runbook` set keep theirs.
 */
export function annotateDoctorRunbooks(section: DoctorSection): DoctorSection {
  return {
    title: section.title,
    results: section.results.map((r) => {
      if (r.status === "pass" || r.runbook) return r;
      return { ...r, runbook: pickRunbook(r.status, r.name, r.detail) };
    }),
  };
}
