/**
 * Vivarium charter guardrails — the anti-re-clutter enforcement for the
 * flagship desktop (Phase 4 of the UX reimagining).
 *
 * These are the tests that keep the reshape from silently regressing back into
 * the old sprawl:
 *   1. The flagship has exactly four places — a fifth would need this test
 *      changed deliberately (the whole point of deleting the 5×5 grid).
 *   2. The live-state hooks are bus-driven, not polled — no `setInterval` may
 *      reappear in the KAIROS/health/organism hooks (useServerData is the one
 *      documented, deferred exception until its dashboards are demolished).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLACES } from "../src/places/registry";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

describe("Vivarium charter", () => {
  it("has exactly four places (the grid is gone, and stays gone)", () => {
    expect(PLACES.length).toBe(4);
    expect(PLACES.map((p) => p.id).sort()).toEqual([
      "council",
      "growth",
      "pulse",
      "talk",
    ]);
  });

  it("opens on the calm home (Talk), never on Pulse", async () => {
    const { DEFAULT_PLACE } = await import("../src/places/registry");
    expect(DEFAULT_PLACE).toBe("talk");
    // Pulse is a drawer, not a canvas place.
    expect(PLACES.find((p) => p.id === "pulse")?.presentation).toBe("drawer");
  });

  it("keeps every data hook free of polling (no setInterval anywhere in hooks/)", () => {
    // The whole point of the spine: surfaces project a live stream, they don't
    // poll. This guards ALL hooks — not just the bus ones — so a `setInterval`
    // can't quietly reappear under any name.
    const hooksDir = join(src, "hooks");
    for (const f of readdirSync(hooksDir)) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      const text = readFileSync(join(hooksDir, f), "utf-8");
      expect(
        text,
        `hooks/${f} must not poll — project the organism bus instead`,
      ).not.toMatch(/setInterval/);
    }
  });

  it("does not reach God Mode / business-harness admin from the flagship shell", () => {
    // The engine room (God Mode, MSP/business harness) is demoted out of the
    // flagship's identity: the shell, places, and entry must not import the
    // business/* or GodModeWidget surfaces. They stay repo-resident, reachable
    // only behind a capability toggle — never wired into the calm home.
    const shellFiles = [
      "App.tsx",
      "components/shell/AppShell.tsx",
      "components/shell/Rail.tsx",
      "components/shell/PulseFeed.tsx",
      "components/shell/SettingsDrawer.tsx",
      "places/TalkPlace.tsx",
      "places/CouncilPlace.tsx",
      "places/GrowthPlace.tsx",
    ];
    for (const rel of shellFiles) {
      const text = readFileSync(join(src, rel), "utf-8");
      expect(
        text,
        `${rel} must not import God Mode / business admin`,
      ).not.toMatch(/components\/business|GodModeWidget/);
    }
  });
});
