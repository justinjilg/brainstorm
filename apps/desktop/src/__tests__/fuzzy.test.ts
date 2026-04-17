import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter } from "../lib/fuzzy";

describe("fuzzyScore", () => {
  it("returns null when a query character is unreachable", () => {
    expect(fuzzyScore("zzz", "Go to Config")).toBeNull();
  });

  it("matches camelCase + separator abbreviations that substring missed", () => {
    // These were all misses under the previous `.includes()` filter:
    expect(fuzzyScore("gocfg", "Go to Config")).not.toBeNull();
    expect(fuzzyScore("vmem", "View Memory")).not.toBeNull();
    expect(fuzzyScore("sto", "Switch to Opus")).not.toBeNull();
  });

  it("rewards first-character and word-boundary matches", () => {
    const start = fuzzyScore("g", "Go")!.score;
    const mid = fuzzyScore("g", "Aging")!.score;
    expect(start).toBeGreaterThan(mid);

    const boundary = fuzzyScore("tm", "To Memory")!.score;
    const interior = fuzzyScore("tm", "Arithmetic")!.score;
    expect(boundary).toBeGreaterThan(interior);
  });

  it("returns positions in label order for highlighting", () => {
    const r = fuzzyScore("got", "Go to Config")!;
    // Positions must be strictly increasing (they're consumed left-to-right)
    // and the characters at those positions must match the query in order.
    expect(r.positions.every((p, i) => i === 0 || p > r.positions[i - 1])).toBe(
      true,
    );
    const label = "go to config";
    expect(r.positions.map((i) => label[i]).join("")).toBe("got");
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { label: "Go to Config", category: "Navigation" },
    { label: "Go to Chat", category: "Navigation" },
    { label: "Switch to Opus", category: "Model" },
    { label: "View Memory", category: "Memory" },
  ];

  it("returns all items unfiltered on empty query", () => {
    expect(
      fuzzyFilter(
        items,
        "",
        (i) => i.label,
        (i) => i.category,
      ),
    ).toHaveLength(items.length);
  });

  it("orders by score — tighter matches first", () => {
    const result = fuzzyFilter(
      items,
      "gocfg",
      (i) => i.label,
      (i) => i.category,
    );
    // Go to Config matches all 5 chars; Go to Chat misses 'f' and 'g'.
    expect(result[0].item.label).toBe("Go to Config");
  });

  it("category is a fallback, not a prefix match for the primary label", () => {
    const result = fuzzyFilter(
      items,
      "memory",
      (i) => i.label,
      (i) => i.category,
    );
    // "View Memory" should come first, not whichever item happens to have
    // "Memory" in its category but not its label.
    expect(result[0].item.label).toBe("View Memory");
  });
});
