/**
 * Drift perception for the KAIROS daemon.
 *
 * The harness loop (desktop) writes drift observations — places where the
 * world model's intent disagrees with observed reality — into per-harness
 * SQLite files under ~/.brainstorm/harness-index/. Until now those rows only
 * reached a React panel. This helper is the notice→think joint: it sweeps
 * every harness index and returns unresolved drift as DriftNotice rows for
 * the daemon's tick message.
 *
 * Read-only by intent: opens each store, reads, closes. A corrupt or locked
 * harness db is skipped — a failing sense must never kill perception.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { HarnessIndexStore } from "@brainst0rm/harness-index";
import type { DriftNotice } from "@brainst0rm/core";

const HARNESS_INDEX_DIR = join(homedir(), ".brainstorm", "harness-index");

export function collectOpenDrifts(limit = 12): DriftNotice[] {
  let files: string[];
  try {
    files = readdirSync(HARNESS_INDEX_DIR).filter((f) => f.endsWith(".db"));
  } catch {
    return []; // no harnesses yet — nothing to sense
  }

  const notices: DriftNotice[] = [];
  for (const file of files) {
    if (notices.length >= limit) break;
    const harnessId = basename(file, ".db");
    let store: HarnessIndexStore | undefined;
    try {
      store = new HarnessIndexStore(join(HARNESS_INDEX_DIR, file));
      for (const d of store.unresolvedDrift()) {
        if (notices.length >= limit) break;
        notices.push({
          id: d.id,
          kind: d.detector_name,
          severity: d.severity ?? "info",
          summary: `${d.relative_path} · ${d.field_path}: intent=${d.intent_value ?? "?"} observed=${d.observed_value ?? "?"}`,
          source: harnessId,
        });
      }
    } catch {
      // Locked/corrupt harness db — skip this sense, keep the others.
    } finally {
      try {
        store?.close();
      } catch {
        // already closed or never opened
      }
    }
  }
  return notices;
}
