/**
 * VerbTabs — horizontal tabs at the top of the active workspace showing
 * which verbs are available for the current entity. Verbs absent from
 * `VERBS_BY_ENTITY[entity]` (e.g., Talk for Platform) are simply not
 * rendered — uneven verb-rows across entities is a deliberate design
 * choice over inventing meta-chat surfaces.
 */
import {
  VERB_LABEL,
  VERBS_BY_ENTITY,
  type EntityKind,
  type VerbKind,
} from "../../lib/workspace";

interface VerbTabsProps {
  entity: EntityKind;
  activeVerb: VerbKind;
  onSelect: (verb: VerbKind) => void;
}

export function VerbTabs({ entity, activeVerb, onSelect }: VerbTabsProps) {
  const verbs = VERBS_BY_ENTITY[entity];
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--ctp-mantle)",
        flexShrink: 0,
      }}
    >
      {verbs.map((verb) => {
        const isActive = verb === activeVerb;
        return (
          <button
            key={verb}
            onClick={() => onSelect(verb)}
            className="interactive"
            style={{
              padding: "10px 18px",
              fontSize: "var(--text-xs)",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--ctp-text)" : "var(--ctp-overlay1)",
              background: isActive ? "var(--ctp-base)" : "transparent",
              border: "none",
              borderBottom: `2px solid ${
                isActive ? "var(--ctp-blue)" : "transparent"
              }`,
              cursor: "pointer",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {VERB_LABEL[verb]}
          </button>
        );
      })}
    </div>
  );
}
