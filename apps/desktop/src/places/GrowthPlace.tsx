/**
 * Growth — what the organism has learned and become.
 *
 * The anatomy: memory (4 types, promote/quarantine), skills, and the self-heal
 * history read live off the organism bus (kairos.commit/heal events). Answers
 * "what has it become?" — the tended garden, not a dashboard of dead numbers.
 */
import { useMemo, useState } from "react";
import { MemoryView } from "../components/memory/MemoryView";
import { SkillsView } from "../components/skills/SkillsView";
import { useOrganism } from "../hooks/useOrganism";
import { organismEventLabel } from "../lib/organism";

type Tab = "memory" | "skills" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "history", label: "Self-heal history" },
];

export interface GrowthPlaceProps {
  activeSkills: string[];
  onActiveSkillsChange: (skills: string[]) => void;
}

export function GrowthPlace({
  activeSkills,
  onActiveSkillsChange,
}: GrowthPlaceProps) {
  const [tab, setTab] = useState<Tab>("memory");
  const { feed } = useOrganism();
  const healEvents = useMemo(
    () =>
      feed.filter(
        (e) => e.type === "kairos.commit" || e.type === "kairos.heal",
      ),
    [feed],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="shrink-0 flex items-center gap-1 px-3 py-2"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-2.5 py-1 rounded"
            style={{
              fontSize: "var(--text-xs)",
              background: tab === t.id ? "var(--ctp-surface0)" : "transparent",
              color: tab === t.id ? "var(--ctp-text)" : "var(--ctp-overlay1)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "memory" && <MemoryView />}
        {tab === "skills" && (
          <SkillsView
            activeSkills={activeSkills}
            onActiveSkillsChange={onActiveSkillsChange}
          />
        )}
        {tab === "history" && (
          <div className="h-full overflow-y-auto px-4 py-4">
            {healEvents.length === 0 ? (
              <div
                className="px-2 py-6 text-center"
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                No self-heal commits yet this session. KAIROS records each
                perceive → fix → verify → commit here.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {healEvents.map((e) => (
                  <div
                    key={e.seq}
                    className="animate-fade-in flex items-center gap-2 px-2 py-1.5 rounded"
                    style={{
                      background: "var(--ctp-base)",
                      fontSize: "var(--text-sm)",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "9999px",
                        background: "var(--organism)",
                      }}
                    />
                    <span
                      style={{ color: "var(--ctp-text)" }}
                      className="flex-1 truncate"
                    >
                      {organismEventLabel(e)}
                    </span>
                    <span
                      className="font-mono"
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ctp-overlay0)",
                      }}
                    >
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
