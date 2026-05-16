/**
 * Doctor → runbook routing (path-to-90 P8a).
 *
 * `storm doctor` is the operator's primary diagnostic. Pre-P8a, a failed
 * check printed a status + detail but did NOT point the operator at any
 * recovery runbook — even though three runbooks ship at
 * docs/runbooks/{api-key-rotation,startup-health,vault-recovery}.md.
 *
 * Operator persona's v14 one-week action: surface "→ see docs/runbooks/
 * <file>.md" so doctor failures route to the documented recovery path
 * without grepping.
 *
 * This file tests the routing logic (`annotateDoctorRunbooks`) in
 * isolation — without spinning up a full doctor run.
 */

import { describe, it, expect } from "vitest";
import { annotateDoctorRunbooks } from "../../logic/doctor-runbook.js";

describe("doctor → runbook routing (P8a)", () => {
  it("does NOT annotate pass results", () => {
    const annotated = annotateDoctorRunbooks({
      title: "Build",
      results: [
        {
          name: "workspace build",
          status: "pass",
          detail: "turbo run build completed successfully.",
        },
      ],
    });
    expect(annotated.results[0].runbook).toBeUndefined();
  });

  it("routes vault-shaped failures to vault-recovery.md", () => {
    const annotated = annotateDoctorRunbooks({
      title: "Vault",
      results: [
        {
          name: "BRAINSTORM_VAULT",
          status: "fail",
          detail:
            "Vault is locked; unlock with `storm vault unlock` before continuing.",
        },
        {
          name: "vault decrypt",
          status: "fail",
          detail: "Argon2id derivation failed — wrong password?",
        },
      ],
    });
    expect(annotated.results[0].runbook).toBe(
      "docs/runbooks/vault-recovery.md",
    );
    expect(annotated.results[1].runbook).toBe(
      "docs/runbooks/vault-recovery.md",
    );
  });

  it("routes API-key-shaped failures to api-key-rotation.md", () => {
    const annotated = annotateDoctorRunbooks({
      title: "Environment",
      results: [
        {
          name: "BRAINSTORM_API_KEY",
          status: "warn",
          detail: "Referenced in .env.example but not present in environment.",
        },
        {
          name: "OPENAI_API_KEY",
          status: "warn",
          detail: "Token missing — see api-key-rotation runbook",
        },
        {
          name: "anthropic-call",
          status: "fail",
          detail: "401 Unauthorized — invalid key",
        },
      ],
    });
    expect(annotated.results[0].runbook).toBe(
      "docs/runbooks/api-key-rotation.md",
    );
    expect(annotated.results[1].runbook).toBe(
      "docs/runbooks/api-key-rotation.md",
    );
    expect(annotated.results[2].runbook).toBe(
      "docs/runbooks/api-key-rotation.md",
    );
  });

  it("routes unknown failures to the generic startup-health.md", () => {
    const annotated = annotateDoctorRunbooks({
      title: "Models",
      results: [
        {
          name: "claude-opus-4-7",
          status: "warn",
          detail: "Reported as degraded.",
        },
        {
          name: "workspace build",
          status: "fail",
          detail: "turbo run build exited with code 1.",
        },
      ],
    });
    expect(annotated.results[0].runbook).toBe(
      "docs/runbooks/startup-health.md",
    );
    expect(annotated.results[1].runbook).toBe(
      "docs/runbooks/startup-health.md",
    );
  });

  it("preserves an explicit runbook annotation rather than overriding", () => {
    const annotated = annotateDoctorRunbooks({
      title: "Custom",
      results: [
        {
          name: "custom-check",
          status: "fail",
          detail: "Generic failure",
          runbook: "docs/runbooks/custom-recovery.md",
        },
      ],
    });
    expect(annotated.results[0].runbook).toBe(
      "docs/runbooks/custom-recovery.md",
    );
  });

  it("is case-insensitive on the routing keywords", () => {
    const annotated = annotateDoctorRunbooks({
      title: "Mixed-case",
      results: [
        { name: "VAULT-CHECK", status: "fail", detail: "LOCKED" },
        { name: "Token", status: "warn", detail: "Missing" },
      ],
    });
    expect(annotated.results[0].runbook).toBe(
      "docs/runbooks/vault-recovery.md",
    );
    expect(annotated.results[1].runbook).toBe(
      "docs/runbooks/api-key-rotation.md",
    );
  });

  it("idempotent: re-annotating a result keeps the same runbook", () => {
    const once = annotateDoctorRunbooks({
      title: "x",
      results: [{ name: "vault", status: "fail", detail: "locked" }],
    });
    const twice = annotateDoctorRunbooks(once);
    expect(twice.results[0].runbook).toBe(once.results[0].runbook);
  });
});
