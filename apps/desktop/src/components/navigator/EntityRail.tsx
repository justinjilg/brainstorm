/**
 * EntityRail — the five entity rows on the left edge of the Navigator.
 *
 * Replaces the flat `WORKSPACE_MODES` array. Selecting an entity changes
 * which workspace renders and which verb tabs are available.
 *
 * Collapsed mode shows just the entity glyphs; expanded mode shows label +
 * a contextual hint slot (currently unused — Phase 2 will surface
 * empty-state inline actions like "Open folder…" / "Create harness").
 */
import {
  ENTITIES,
  ENTITY_LABEL,
  ENTITY_GLYPH,
  type EntityKind,
} from "../../lib/workspace";

interface EntityRailProps {
  active: EntityKind;
  onSelect: (entity: EntityKind) => void;
  collapsed: boolean;
  /**
   * Optional per-entity hint rendered under the label when expanded.
   * Used to surface inline empty states ("Open folder", "Create harness").
   */
  hints?: Partial<Record<EntityKind, React.ReactNode>>;
}

export function EntityRail({
  active,
  onSelect,
  collapsed,
  hints,
}: EntityRailProps) {
  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center py-3 gap-2"
        style={{ width: 56 }}
      >
        {ENTITIES.map((entity) => (
          <button
            key={entity}
            onClick={() => onSelect(entity)}
            className="interactive w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              color:
                active === entity ? "var(--ctp-text)" : "var(--ctp-overlay0)",
              background:
                active === entity ? "var(--ctp-surface0)" : "transparent",
            }}
            title={ENTITY_LABEL[entity]}
          >
            {ENTITY_GLYPH[entity]}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-3">
      {ENTITIES.map((entity) => {
        const isActive = active === entity;
        return (
          <button
            key={entity}
            onClick={() => onSelect(entity)}
            className="interactive w-full text-left rounded-lg"
            style={{
              padding: "10px 12px",
              fontSize: "var(--text-sm)",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--ctp-text)" : "var(--ctp-subtext0)",
              background: isActive ? "var(--ctp-surface0)" : "transparent",
              border: `1px solid ${
                isActive ? "var(--ctp-blue)" : "transparent"
              }`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "var(--text-2xs)",
                  fontFamily: "var(--font-mono, monospace)",
                  borderRadius: 6,
                  background: "var(--ctp-mantle)",
                  color: "var(--ctp-overlay1)",
                }}
              >
                {ENTITY_GLYPH[entity]}
              </span>
              {ENTITY_LABEL[entity]}
            </div>
            {hints?.[entity] && (
              <div
                style={{
                  marginTop: 4,
                  marginLeft: 32,
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                {hints[entity]}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
