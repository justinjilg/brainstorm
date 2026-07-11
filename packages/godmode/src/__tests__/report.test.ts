import { describe, it, expect } from "vitest";
import { renderChangeSetReport, escapeHtml } from "../report/html-report";
import {
  createEvidenceBundle,
  verifyEvidenceBundle,
} from "../report/evidence-bundle";
import type { AuditEntry } from "../audit";

const MASTER_SECRET = "test-master-secret-for-evidence";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    changesetId: "cs-001",
    connector: "github",
    action: "merge_pr",
    description: "Merge PR #42 into main",
    riskScore: 15,
    status: "executed",
    changesJson: JSON.stringify({ pr: 42, branch: "main" }),
    simulationJson: JSON.stringify({ ok: true, warnings: [] }),
    rollbackJson: JSON.stringify({ revert: "abc123" }),
    createdAt: 1_700_000_000_000,
    executedAt: 1_700_000_060_000,
    ...overrides,
  };
}

describe("renderChangeSetReport", () => {
  it("renders a self-contained HTML document", () => {
    const html = renderChangeSetReport([makeEntry()]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme");
    // No external resources
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<script");
  });

  it("applies risk severity classes by threshold", () => {
    expect(renderChangeSetReport([makeEntry({ riskScore: 10 })])).toContain(
      "risk-low",
    );
    expect(renderChangeSetReport([makeEntry({ riskScore: 50 })])).toContain(
      "risk-medium",
    );
    expect(renderChangeSetReport([makeEntry({ riskScore: 90 })])).toContain(
      "risk-high",
    );
    // Boundary: 30 => medium, 70 => high
    expect(renderChangeSetReport([makeEntry({ riskScore: 30 })])).toContain(
      "risk-medium",
    );
    expect(renderChangeSetReport([makeEntry({ riskScore: 70 })])).toContain(
      "risk-high",
    );
  });

  it("renders ISO timestamps and em-dash for null executedAt", () => {
    const html = renderChangeSetReport([
      makeEntry({ createdAt: 1_700_000_000_000, executedAt: null }),
    ]);
    expect(html).toContain(new Date(1_700_000_000_000).toISOString());
    expect(html).toContain("—");
  });

  it("pretty-prints valid JSON blocks", () => {
    const html = renderChangeSetReport([
      makeEntry({ changesJson: JSON.stringify({ a: 1, b: { c: 2 } }) }),
    ]);
    // Reindented with two-space nesting
    expect(html).toContain("&quot;a&quot;: 1");
  });

  it("escapes hostile strings in EVERY field", () => {
    const hostile = `<script>alert('xss')</script>" onerror="evil()" '`;
    const entry = makeEntry({
      changesetId: hostile,
      connector: hostile,
      action: hostile,
      description: hostile,
      status: hostile,
      changesJson: hostile,
      simulationJson: hostile,
      rollbackJson: hostile,
    });
    const html = renderChangeSetReport([entry], { title: hostile });

    // No raw executable markup survives
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain(`onerror="evil()"`);
    // The hostile content appears only in escaped form
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
  });

  it("renders malformed changesJson as escaped raw text", () => {
    const malformed = `{not valid json <script>alert(1)</script>`;
    const html = renderChangeSetReport([makeEntry({ changesJson: malformed })]);
    expect(html).toContain("malformed");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders a valid empty report for no entries", () => {
    const html = renderChangeSetReport([]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("No ChangeSet audit entries");
    expect(html).toContain("Entries: 0");
  });

  it("is deterministic for identical inputs and generatedAt", () => {
    const entries = [makeEntry()];
    const a = renderChangeSetReport(entries, { generatedAt: 123 });
    const b = renderChangeSetReport(entries, { generatedAt: 123 });
    expect(a).toBe(b);
  });
});

describe("escapeHtml", () => {
  it("escapes all five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("evidence bundle round-trip", () => {
  it("signs and verifies successfully", () => {
    const entries = [makeEntry()];
    const html = renderChangeSetReport(entries, { generatedAt: 555 });
    const bundle = createEvidenceBundle(entries, html, MASTER_SECRET, {
      generatedAt: 555,
    });

    expect(bundle.algorithm).toBe("hmac-sha256");
    expect(bundle.keyId).toBe("audit-evidence");
    expect(bundle.payload.reportSha256).toMatch(/^[0-9a-f]{64}$/);

    const result = verifyEvidenceBundle(bundle, html, MASTER_SECRET);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("uses the provided tenantId as keyId", () => {
    const entries = [makeEntry()];
    const html = renderChangeSetReport(entries);
    const bundle = createEvidenceBundle(entries, html, MASTER_SECRET, {
      tenantId: "acme-corp",
    });
    expect(bundle.keyId).toBe("acme-corp");
    expect(verifyEvidenceBundle(bundle, html, MASTER_SECRET).valid).toBe(true);
  });

  it("fails with report-hash-mismatch on a single-byte HTML tamper", () => {
    const entries = [makeEntry()];
    const html = renderChangeSetReport(entries);
    const bundle = createEvidenceBundle(entries, html, MASTER_SECRET);

    const tampered = html.replace("executed", "executeD");
    expect(tampered).not.toBe(html);

    const result = verifyEvidenceBundle(bundle, tampered, MASTER_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("report-hash-mismatch");
  });

  it("fails with signature-mismatch when a payload field is tampered", () => {
    const entries = [makeEntry()];
    const html = renderChangeSetReport(entries);
    const bundle = createEvidenceBundle(entries, html, MASTER_SECRET);

    // Tamper a payload field but keep reportSha256 consistent with the HTML.
    bundle.payload.entries[0].riskScore = 99;

    const result = verifyEvidenceBundle(bundle, html, MASTER_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature-mismatch");
  });

  it("fails with signature-mismatch under a different tenantId", () => {
    const entries = [makeEntry()];
    const html = renderChangeSetReport(entries);
    const bundle = createEvidenceBundle(entries, html, MASTER_SECRET, {
      tenantId: "tenant-a",
    });

    // Verifier trusts bundle.keyId; forge a different key by rewriting keyId.
    bundle.keyId = "tenant-b";
    const result = verifyEvidenceBundle(bundle, html, MASTER_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature-mismatch");
  });

  it("fails with signature-mismatch under a wrong master secret", () => {
    const entries = [makeEntry()];
    const html = renderChangeSetReport(entries);
    const bundle = createEvidenceBundle(entries, html, MASTER_SECRET);
    const result = verifyEvidenceBundle(bundle, html, "wrong-secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature-mismatch");
  });

  it("round-trips an empty entries report", () => {
    const html = renderChangeSetReport([]);
    const bundle = createEvidenceBundle([], html, MASTER_SECRET);
    expect(verifyEvidenceBundle(bundle, html, MASTER_SECRET).valid).toBe(true);
  });
});
