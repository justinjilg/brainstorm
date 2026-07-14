/**
 * Shared edit logic used by file_edit, multi_edit, and batch_edit.
 * Centralizes the find-count-replace pattern to avoid duplication.
 *
 * applyEdit implements an Aider-style `replace_most_similar_chunk`
 * cascade: it tries a series of strategies in DECREASING precision and
 * applies the FIRST confident match. The guiding principle is that a
 * WRONG edit is worse than a REJECTED one — every tier either matches
 * unambiguously or declines, so we never silently corrupt a file.
 *
 *   T1 exact       — old_string is a unique substring (fastest path).
 *   T2 whitespace  — per-line trimmed match, unique; the replacement is
 *                    re-indented by the matched region's relative
 *                    leading whitespace ("relative leading whitespace").
 *   T3 ellipsis    — old_string contains bare `...` lines that elide a
 *                    span; each chunk is matched uniquely in order and
 *                    the whole span is replaced.
 *   T4 similarity  — a sliding-window line-similarity fallback that only
 *                    fires when the single best window clears a safety
 *                    threshold AND is unambiguously better than the rest.
 *
 * $-safety: the exact tier uses the FUNCTION form of String.replace
 * (`replace(old, () => new)`) so `$1`/`$&`/`${VAR}` in new_string are
 * never interpreted as regex backreferences. The other tiers build the
 * result by array splice / string slice, which is inherently literal.
 * See file-edit-dollar-preservation.test.ts.
 */

export type MatchTier = "exact" | "whitespace" | "ellipsis" | "similarity";

export interface EditResult {
  applied: boolean;
  content?: string;
  error?: string;
  occurrences?: number;
  /** Which cascade tier produced the match (observability). */
  matchTier?: MatchTier;
}

/** Similarity ratio a T4 window must clear to be applied at all. */
const SIMILARITY_THRESHOLD = 0.85;
/** Minimum gap between the best and runner-up window to be "unambiguous". */
const SIMILARITY_MARGIN = 0.05;

// ---------------------------------------------------------------------------
// whitespace helpers
// ---------------------------------------------------------------------------

function leadingWhitespace(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Smallest leading-whitespace length across non-blank lines (0 if none). */
function minCommonLeading(lines: string[]): number {
  const lens = lines
    .filter((l) => !isBlank(l))
    .map((l) => leadingWhitespace(l).length);
  if (lens.length === 0) return 0;
  return Math.min(...lens);
}

function firstNonBlankIndent(lines: string[]): string {
  for (const l of lines) {
    if (!isBlank(l)) return leadingWhitespace(l);
  }
  return "";
}

/**
 * Aider `match_but_for_leading_whitespace`: if every window line matches
 * its part line ignoring leading whitespace, AND they are all offset by
 * the SAME leading-whitespace prefix, return that prefix. Otherwise null.
 */
function matchButForLeadingWhitespace(
  windowLines: string[],
  partLines: string[],
): string | null {
  const n = windowLines.length;
  for (let i = 0; i < n; i++) {
    if (
      windowLines[i].replace(/^[ \t]+/, "") !==
      partLines[i].replace(/^[ \t]+/, "")
    ) {
      return null;
    }
  }
  const adds = new Set<string>();
  for (let i = 0; i < n; i++) {
    if (isBlank(windowLines[i])) continue;
    const w = windowLines[i];
    const p = partLines[i];
    if (w.length < p.length) return null; // part more-indented than window
    const add = w.slice(0, w.length - p.length);
    if (add + p !== w) return null; // prefix wouldn't reconstruct the line
    adds.add(add);
  }
  if (adds.size !== 1) return null;
  return [...adds][0];
}

// ---------------------------------------------------------------------------
// T2 — whitespace / indent-flexible
// ---------------------------------------------------------------------------

function tryWhitespaceFlexible(
  content: string,
  oldString: string,
  newString: string,
): EditResult | null {
  const contentLines = content.split("\n");
  let partLines = oldString.split("\n");
  let replaceLines = newString.split("\n");

  // Outdent both part and replacement by their common leading whitespace
  // so a uniformly over-indented old_string can still match.
  const num = Math.min(
    minCommonLeading(partLines),
    minCommonLeading(replaceLines),
  );
  if (num > 0) {
    partLines = partLines.map((l) => (isBlank(l) ? l : l.slice(num)));
    replaceLines = replaceLines.map((l) => (isBlank(l) ? l : l.slice(num)));
  }

  const len = partLines.length;
  if (len === 0 || len > contentLines.length) return null;

  const matches: Array<{ i: number; add: string }> = [];
  for (let i = 0; i + len <= contentLines.length; i++) {
    const add = matchButForLeadingWhitespace(
      contentLines.slice(i, i + len),
      partLines,
    );
    if (add !== null) matches.push({ i, add });
  }

  // Require a UNIQUE trimmed match — ambiguity is a rejection, not a guess.
  if (matches.length !== 1) return null;

  const { i, add } = matches[0];
  const reindented = replaceLines.map((l) => (isBlank(l) ? l : add + l));
  const resultLines = [
    ...contentLines.slice(0, i),
    ...reindented,
    ...contentLines.slice(i + len),
  ];
  return {
    applied: true,
    content: resultLines.join("\n"),
    matchTier: "whitespace",
  };
}

// ---------------------------------------------------------------------------
// T3 — ellipsis elision
// ---------------------------------------------------------------------------

/**
 * Find every LINE-ANCHORED occurrence of `chunkLines` (a contiguous run of
 * whole content lines, exact match) within contentLines starting at `from`.
 * Line-anchoring is critical: a raw substring indexOf would let a chunk
 * match inside the middle of a longer line/identifier, so the replaced span
 * slices through surrounding code — a silent WRONG edit. Aider matches whole
 * lines, and so do we.
 */
function findLineChunk(
  contentLines: string[],
  chunkLines: string[],
  from: number,
): number[] {
  const len = chunkLines.length;
  const hits: number[] = [];
  if (len === 0) return hits;
  for (let i = from; i + len <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < len; j++) {
      if (contentLines[i + j] !== chunkLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

function tryEllipsis(
  content: string,
  oldString: string,
  newString: string,
): EditResult | null {
  const oldLines = oldString.split("\n");
  const hasDots = oldLines.some((l) => l.trim() === "...");
  if (!hasDots) return null;

  // Split old_string into chunks (arrays of lines) separated by bare `...`.
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const l of oldLines) {
    if (l.trim() === "...") {
      chunks.push(cur);
      cur = [];
    } else {
      cur.push(l);
    }
  }
  chunks.push(cur);

  const nonEmpty = chunks.filter((c) => c.some((line) => line.trim() !== ""));
  if (nonEmpty.length === 0) return null;

  const contentLines = content.split("\n");

  // Match each chunk in order as a contiguous run of WHOLE content lines,
  // UNIQUELY within the remaining (line) window.
  let cursor = 0; // line index
  let spanStartLine = -1;
  let spanEndLine = -1; // exclusive
  for (const chunk of nonEmpty) {
    const hits = findLineChunk(contentLines, chunk, cursor);
    if (hits.length !== 1) return null; // 0 = not found, >1 = ambiguous
    const at = hits[0];
    if (spanStartLine === -1) spanStartLine = at;
    spanEndLine = at + chunk.length;
    cursor = at + chunk.length;
  }
  if (spanStartLine === -1 || spanEndLine === -1) return null;

  // Line splice / join is inherently $-literal.
  const resultLines = [
    ...contentLines.slice(0, spanStartLine),
    ...newString.split("\n"),
    ...contentLines.slice(spanEndLine),
  ];
  return {
    applied: true,
    content: resultLines.join("\n"),
    matchTier: "ellipsis",
  };
}

// ---------------------------------------------------------------------------
// T4 — similarity fallback (SequenceMatcher-style, no deps)
// ---------------------------------------------------------------------------

/**
 * A small SequenceMatcher-style ratio over LINES (trimmed): 2*LCS/(n+m).
 * Trimming means pure-indentation differences don't penalize the score —
 * T2 already handles indentation exactly; T4 catches content near-misses.
 */
function lineSimilarity(aLines: string[], bLines: string[]): number {
  const a = aLines.map((l) => l.trim());
  const b = bLines.map((l) => l.trim());
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  // LCS length via rolling 1-D DP.
  const dp = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const lcs = dp[m];
  return (2 * lcs) / (n + m);
}

/** Shift new_string lines by the (window - old) leading-whitespace delta. */
function reindentLines(
  lines: string[],
  winIndent: string,
  oldIndent: string,
): string[] {
  const delta = winIndent.length - oldIndent.length;
  if (delta === 0) return lines;
  if (delta > 0) {
    const extra = winIndent.slice(oldIndent.length);
    return lines.map((l) => (isBlank(l) ? l : extra + l));
  }
  const remove = -delta;
  return lines.map((l) => {
    if (isBlank(l)) return l;
    const lead = leadingWhitespace(l).length;
    return l.slice(Math.min(remove, lead));
  });
}

function trySimilarity(
  content: string,
  oldString: string,
  newString: string,
): EditResult | null {
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");
  const len = oldLines.length;
  if (len === 0 || len > contentLines.length) return null;

  const ratios: Array<{ i: number; r: number }> = [];
  for (let i = 0; i + len <= contentLines.length; i++) {
    ratios.push({
      i,
      r: lineSimilarity(contentLines.slice(i, i + len), oldLines),
    });
  }
  if (ratios.length === 0) return null;

  ratios.sort((x, y) => y.r - x.r);
  const best = ratios[0];
  if (best.r < SIMILARITY_THRESHOLD) return null; // below safety threshold

  // Unambiguously best: the runner-up must be a clear margin behind. The
  // runner-up is the highest-scoring window that does NOT overlap the best
  // one — an adjacent +/-1-line neighbor shares most of its lines and would
  // spuriously tie, over-rejecting a genuinely unique near-miss. Windows
  // overlap when their start indices are closer than `len` lines apart.
  // ratios is sorted descending, so the first non-overlapping entry is the
  // highest-scoring distinct region.
  for (const cand of ratios) {
    if (Math.abs(cand.i - best.i) < len) continue; // overlaps best window
    if (best.r - cand.r < SIMILARITY_MARGIN) return null; // ambiguous
    break;
  }

  const window = contentLines.slice(best.i, best.i + len);
  const replaceLines = reindentLines(
    newString.split("\n"),
    firstNonBlankIndent(window),
    firstNonBlankIndent(oldLines),
  );
  const resultLines = [
    ...contentLines.slice(0, best.i),
    ...replaceLines,
    ...contentLines.slice(best.i + len),
  ];
  return {
    applied: true,
    content: resultLines.join("\n"),
    matchTier: "similarity",
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Apply a single string replacement to content using the fuzzy cascade.
 * Returns the updated content if a confident match was found, or an error
 * message if not. Never applies a low-confidence match.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
): EditResult {
  if (oldString.length === 0) {
    return { applied: false, error: "empty old_string" };
  }

  const occurrences = content.split(oldString).length - 1;

  // T1 — exact unique match (fastest path, function-form $-safe replace).
  if (occurrences === 1) {
    return {
      applied: true,
      content: content.replace(oldString, () => newString),
      matchTier: "exact",
    };
  }
  if (occurrences > 1) {
    // Truly ambiguous — a wrong pick is worse than a rejection.
    return {
      applied: false,
      error: `${occurrences} occurrences (must be unique)`,
      occurrences,
    };
  }

  // occurrences === 0 → fuzzy cascade, decreasing precision.
  return (
    tryWhitespaceFlexible(content, oldString, newString) ??
    tryEllipsis(content, oldString, newString) ??
    trySimilarity(content, oldString, newString) ?? {
      applied: false,
      error: "not found",
    }
  );
}

/**
 * Apply multiple edits to content sequentially.
 * Returns the final content and per-edit results.
 */
export function applyEdits(
  content: string,
  edits: Array<{ old_string: string; new_string: string }>,
): {
  content: string;
  results: Array<{
    old: string;
    applied: boolean;
    reason?: string;
    matchTier?: MatchTier;
  }>;
  appliedCount: number;
} {
  let current = content;
  const results: Array<{
    old: string;
    applied: boolean;
    reason?: string;
    matchTier?: MatchTier;
  }> = [];
  let appliedCount = 0;

  for (const edit of edits) {
    const result = applyEdit(current, edit.old_string, edit.new_string);
    if (result.applied && result.content !== undefined) {
      current = result.content;
      results.push({
        old: edit.old_string.slice(0, 40),
        applied: true,
        matchTier: result.matchTier,
      });
      appliedCount++;
    } else {
      results.push({
        old: edit.old_string.slice(0, 40),
        applied: false,
        reason: result.error,
      });
    }
  }

  return { content: current, results, appliedCount };
}
