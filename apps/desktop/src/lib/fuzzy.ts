/**
 * Small, dependency-free fuzzy scorer for the command palette.
 *
 * Replaces `label.toLowerCase().includes(query)` which couldn't find
 * "Go to Config" from "gocfg" or "View Memory" from "vmem". Every other
 * scorer we'd ship (fuse.js etc.) is 20 KB+ for functionality we don't
 * need — the palette has on the order of 30 commands.
 *
 * Score heuristic (higher is better):
 *   - match at start of label              +10
 *   - match at start of a word              +6
 *   - consecutive matches (run bonus)       +4 per run char after the first
 *   - match on category                     +2
 *   - camelCase / separator boundary match  +3
 *
 * Any query character that never matches → null (returned as -Infinity
 * internally so the caller can filter by `score != null`).
 */

export interface FuzzyMatch<T> {
  item: T;
  score: number;
  /** Indices in the searched string that matched the query. Useful for
   *  rendering highlights; emitted in label order. */
  positions: number[];
}

export function fuzzyScore(
  query: string,
  label: string,
  category = "",
): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const target = label.toLowerCase();
  const cat = category.toLowerCase();

  let cursor = 0;
  let score = 0;
  let runLength = 0;
  const positions: number[] = [];

  for (let i = 0; i < q.length; i++) {
    const qc = q[i];
    // First look inside the label starting from cursor.
    let idx = target.indexOf(qc, cursor);
    if (idx === -1) {
      // Fallback: allow the query char to match the category. We only credit
      // the +2 category bonus — no position, no run.
      if (cat.includes(qc)) {
        score += 2;
        runLength = 0;
        continue;
      }
      return null;
    }

    positions.push(idx);

    // Position-based bonuses.
    if (idx === 0) score += 10;
    else {
      const prev = target[idx - 1];
      if (prev === " " || prev === "-" || prev === "_" || prev === "/") {
        score += 6;
      } else if (
        // camelCase boundary: lowercase → uppercase in original label.
        label[idx - 1] &&
        label[idx - 1] === label[idx - 1].toLowerCase() &&
        label[idx] !== label[idx].toLowerCase()
      ) {
        score += 3;
      }
    }

    // Consecutive-run bonus.
    if (idx === cursor) {
      score += 4 * runLength;
      runLength++;
    } else {
      runLength = 1;
    }
    cursor = idx + 1;
  }

  // Penalise queries that match a long label sparsely — short labels feel
  // more relevant when they match at all.
  score -= Math.floor(label.length / 20);

  return { score, positions };
}

export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getLabel: (item: T) => string,
  getCategory: (item: T) => string = () => "",
): FuzzyMatch<T>[] {
  if (!query) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }
  const out: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const r = fuzzyScore(query, getLabel(item), getCategory(item));
    if (r) out.push({ item, score: r.score, positions: r.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
