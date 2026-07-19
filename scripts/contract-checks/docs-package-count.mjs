// docs-package-count gate.
//
// The package count is a generated fact and must come from the packages
// directory, not a hand-maintained number that silently drifts. Codex's
// iter-004 audit found the docs claimed 44 while the tree held 46. This gate
// greps the human docs (README.md, CLAUDE.md) for package-count claims and the
// packages badge, and fails if any diverges from the actual workspace count.
//
// Fix on failure: update the docs to the real count. The gate reports the
// exact lines to change.

import { readFileSync, globSync } from "node:fs";
import * as path from "node:path";

const DOCS = ["README.md", "CLAUDE.md"];

const CLAIM_PATTERNS = [
  /\bpackages-(\d+)-/g, // shields.io badge
  /\b(\d+)\s+TypeScript packages\b/g,
  /\bBuild all (\d+) packages\b/g,
  /monorepo with (\d+) TypeScript packages\b/g,
];

export async function check({ repoRoot }) {
  const actual = globSync("packages/*/package.json", { cwd: repoRoot }).length;
  const issues = [];

  for (const rel of DOCS) {
    let text;
    try {
      text = readFileSync(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pat of CLAIM_PATTERNS) {
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(lines[i])) !== null) {
          const claimed = Number(m[1]);
          if (claimed !== actual) {
            issues.push(
              `${rel}:${i + 1} claims ${claimed} packages; actual is ${actual}`,
            );
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      name: "docs-package-count",
      ok: false,
      kind: "drift",
      issues,
      note: `Update the doc(s) to ${actual}.`,
    };
  }
  return {
    name: "docs-package-count",
    ok: true,
    info: [`${actual} packages; all doc claims match`],
  };
}
