/**
 * Aider-style fuzzy edit cascade — edit-common applyEdit.
 *
 * Verifies each tier applies (or is rejected) as designed:
 *   T1 exact       — unique substring.
 *   T2 whitespace  — mis-indented old_string re-indents to the right spot.
 *   T3 ellipsis    — `...`-elided old_string replaces the whole span.
 *   T4 similarity  — a near-miss within threshold applies; below-threshold
 *                    and ambiguous matches are REJECTED (no wrong edit).
 * Plus: $-containing new_string survives every tier, and matchTier is
 * reported. The two existing edit suites must stay green independently.
 */

import { describe, it, expect } from "vitest";
import { applyEdit } from "../builtin/edit-common.js";

describe("applyEdit fuzzy cascade", () => {
  describe("T1 exact", () => {
    it("applies a unique substring and reports matchTier=exact", () => {
      const r = applyEdit("alpha beta gamma", "beta", "BETA");
      expect(r.applied).toBe(true);
      expect(r.content).toBe("alpha BETA gamma");
      expect(r.matchTier).toBe("exact");
    });

    it("rejects a non-unique exact match as ambiguous", () => {
      const r = applyEdit("x x x", "x", "y");
      expect(r.applied).toBe(false);
      expect(r.occurrences).toBe(3);
      expect(r.error).toContain("unique");
    });
  });

  describe("T2 whitespace / indent-flexible", () => {
    it("applies a mis-indented old_string at the file's real indent", () => {
      const content = [
        "function f() {",
        "  if (cond) {",
        "    doThing();",
        "    doOther();",
        "  }",
        "}",
      ].join("\n");
      // old_string is written with NO indentation (agent outdented it).
      const oldString = ["doThing();", "doOther();"].join("\n");
      const newString = ["doThing();", "doRenamed();"].join("\n");

      const r = applyEdit(content, oldString, newString);
      expect(r.applied).toBe(true);
      expect(r.matchTier).toBe("whitespace");
      // Replacement must land at the original 4-space indentation.
      expect(r.content).toBe(
        [
          "function f() {",
          "  if (cond) {",
          "    doThing();",
          "    doRenamed();",
          "  }",
          "}",
        ].join("\n"),
      );
    });

    it("re-indents a multi-level replacement by the matched delta", () => {
      const content = ["class C:", "    def m(self):", "        return 1"].join(
        "\n",
      );
      // old written at 0 indent, new adds a nested line at +4 relative.
      const oldString = ["def m(self):", "    return 1"].join("\n");
      const newString = ["def m(self):", "    return 2"].join("\n");
      const r = applyEdit(content, oldString, newString);
      expect(r.applied).toBe(true);
      expect(r.matchTier).toBe("whitespace");
      expect(r.content).toBe(
        ["class C:", "    def m(self):", "        return 2"].join("\n"),
      );
    });
  });

  describe("T3 ellipsis elision", () => {
    it("replaces the whole span between/around anchored chunks", () => {
      const content = [
        "header line",
        "BEGIN block",
        "  middle 1",
        "  middle 2",
        "  middle 3",
        "END block",
        "footer line",
      ].join("\n");
      const oldString = ["BEGIN block", "...", "END block"].join("\n");
      const newString = "REPLACED";
      const r = applyEdit(content, oldString, newString);
      expect(r.applied).toBe(true);
      expect(r.matchTier).toBe("ellipsis");
      expect(r.content).toBe(
        ["header line", "REPLACED", "footer line"].join("\n"),
      );
    });

    it("rejects an ellipsis chunk that is not unique", () => {
      const content = ["dup", "x", "dup", "y", "END"].join("\n");
      const oldString = ["dup", "...", "END"].join("\n");
      const r = applyEdit(content, oldString, "Z");
      // First chunk "dup" appears twice in the window -> reject.
      expect(r.applied).toBe(false);
    });

    it("does NOT match ellipsis chunks inside the middle of a line", () => {
      // Regression: raw indexOf would match "start"/"end" inside the
      // identifiers startX/endX and slice mid-token — a silent wrong edit.
      const content = ["const startX = 1;", "middle", "const endX = 2;"].join(
        "\n",
      );
      const r = applyEdit(
        content,
        ["start", "...", "end"].join("\n"),
        "REPLACED",
      );
      expect(r.applied).toBe(false);
      // Content must be untouched (no partial-token corruption).
      expect(r.content).toBeUndefined();
    });

    it("does NOT match ellipsis chunks that are substrings of a line", () => {
      const content = ["fooBEGIN();", "x();", "y();", "ENDbar();"].join("\n");
      const r = applyEdit(content, ["BEGIN", "...", "END"].join("\n"), "Z");
      expect(r.applied).toBe(false);
    });

    it("matches ellipsis chunks only as whole content lines", () => {
      const content = [
        "keep me",
        "BEGIN",
        "  a();",
        "  b();",
        "END",
        "keep me too",
      ].join("\n");
      const r = applyEdit(content, ["BEGIN", "...", "END"].join("\n"), "GONE");
      expect(r.applied).toBe(true);
      expect(r.matchTier).toBe("ellipsis");
      expect(r.content).toBe(["keep me", "GONE", "keep me too"].join("\n"));
    });
  });

  describe("T4 similarity fallback", () => {
    it("applies a near-miss whose best window clears the threshold", () => {
      const content = [
        "const config = {",
        "  retries: 3,",
        "  timeout: 1000,",
        "  backoff: 2,",
        "  jitter: true,",
        "  cache: false,",
        "  verbose: 0,",
        "};",
      ].join("\n");
      // One line differs (timeout value) of 8 -> 7/8 similarity = 0.875.
      const oldString = [
        "const config = {",
        "  retries: 3,",
        "  timeout: 9999,",
        "  backoff: 2,",
        "  jitter: true,",
        "  cache: false,",
        "  verbose: 0,",
        "};",
      ].join("\n");
      const newString = [
        "const config = {",
        "  retries: 5,",
        "  timeout: 2000,",
        "  backoff: 2,",
        "  jitter: true,",
        "  cache: false,",
        "  verbose: 0,",
        "};",
      ].join("\n");
      const r = applyEdit(content, oldString, newString);
      expect(r.applied).toBe(true);
      expect(r.matchTier).toBe("similarity");
      expect(r.content).toBe(newString);
    });

    it("REJECTS a below-threshold near-miss (no wrong edit)", () => {
      const content = [
        "alpha one",
        "bravo two",
        "charlie three",
        "delta four",
      ].join("\n");
      // Mostly different content — similarity well under 0.85.
      const oldString = [
        "wholly different",
        "unrelated text",
        "charlie three",
        "nothing alike",
      ].join("\n");
      const r = applyEdit(content, oldString, "X\nY\nZ\nW");
      expect(r.applied).toBe(false);
      expect(r.error).toBe("not found");
    });

    it("REJECTS an ambiguous match (two equally-good windows)", () => {
      // Two identical blocks; a mis-indented old_string matches both at
      // T2 (2 hits -> not unique) and ties at T4 -> ambiguous reject.
      const block = ["compute(a);", "compute(b);"];
      const content = [...block, "SEP", ...block].join("\n");
      const oldString = ["  compute(a);", "  compute(b);"].join("\n");
      const r = applyEdit(content, oldString, "X\nY");
      expect(r.applied).toBe(false);
      expect(r.error).toBe("not found");
    });

    it("applies a unique near-miss even when overlapping neighbor windows exist", () => {
      // Regression: the runner-up used for the margin check must be a
      // NON-overlapping window. In a file larger than old_string, the
      // best window's +/-1-line neighbors overlap it and share most of
      // its lines; comparing against one of them (rather than a distinct
      // region) would over-reject a genuinely unique near-miss.
      const block = [
        "const config = {",
        "  retries: 3,",
        "  timeout: 1000,",
        "  backoff: 2,",
        "  jitter: true,",
        "  cache: false,",
        "};",
      ];
      const content = ["zzz header", ...block, "zzz footer"].join("\n");
      // 6-of-7 lines identical to the single config region (timeout diff).
      const oldString = [
        "const config = {",
        "  retries: 3,",
        "  timeout: 9999,",
        "  backoff: 2,",
        "  jitter: true,",
        "  cache: false,",
        "};",
      ].join("\n");
      const newString = [
        "const config = {",
        "  retries: 5,",
        "  timeout: 2000,",
        "  backoff: 2,",
        "  jitter: true,",
        "  cache: false,",
        "};",
      ].join("\n");
      const r = applyEdit(content, oldString, newString);
      expect(r.applied).toBe(true);
      expect(r.matchTier).toBe("similarity");
      expect(r.content).toBe(
        ["zzz header", newString, "zzz footer"].join("\n"),
      );
    });
  });

  describe("$-preservation across tiers", () => {
    const dollarNew = "const p = /^\\$(\\d+)$/; // $& $1 ${VAR}";

    it("exact tier preserves $-sequences verbatim", () => {
      const r = applyEdit("PLACEHOLDER", "PLACEHOLDER", dollarNew);
      expect(r.matchTier).toBe("exact");
      expect(r.content).toBe(dollarNew);
    });

    it("whitespace tier preserves $-sequences verbatim", () => {
      // Multi-line indented block: old_string is outdented, so it is NOT
      // a contiguous substring -> forces T2 (not exact).
      const content = ["function f() {", "    a();", "    b();", "}"].join(
        "\n",
      );
      const oldString = ["a();", "b();"].join("\n");
      const newString = [dollarNew, "b();"].join("\n");
      const r = applyEdit(content, oldString, newString);
      expect(r.matchTier).toBe("whitespace");
      expect(r.content).toBe(
        ["function f() {", "    " + dollarNew, "    b();", "}"].join("\n"),
      );
    });

    it("ellipsis tier preserves $-sequences verbatim", () => {
      const content = ["START", "junk", "END"].join("\n");
      const oldString = ["START", "...", "END"].join("\n");
      const r = applyEdit(content, oldString, dollarNew);
      expect(r.matchTier).toBe("ellipsis");
      expect(r.content).toBe(dollarNew);
    });

    it("similarity tier preserves $-sequences verbatim", () => {
      const content = [
        "line one here",
        "line two here",
        "line three here",
        "line four typo",
        "line five here",
        "line six here",
        "line seven here",
        "line eight here",
      ].join("\n");
      const oldString = [
        "line one here",
        "line two here",
        "line three here",
        "line four here",
        "line five here",
        "line six here",
        "line seven here",
        "line eight here",
      ].join("\n");
      const newString = [dollarNew, "b", "c", "d", "e", "f", "g", "h"].join(
        "\n",
      );
      const r = applyEdit(content, oldString, newString);
      expect(r.matchTier).toBe("similarity");
      expect(r.content).toContain(dollarNew);
    });
  });
});
