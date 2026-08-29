/**
 * Rail — the flagship's whole navigation, replacing the entity rail + verb tabs.
 *
 * A slim column: the canvas places (Talk / Council / Growth), the breathing
 * RailHeart that opens the Pulse feed, and a Settings gear. That's it — four
 * places and a drawer, calm and legible, versus the former 5×5 grid. The
 * anti-clutter guardrail lives in places/registry.ts (`PLACES.length === 4`).
 */
import { CANVAS_PLACES, type PlaceId } from "../../places/registry";
import { RailHeart } from "./RailHeart";

export interface RailProps {
  active: PlaceId;
  onSelect: (id: PlaceId) => void;
  onOpenPulse: () => void;
  onOpenSettings: () => void;
  pulseActive: boolean;
  pulseHasUnseen: boolean;
}

export function Rail({
  active,
  onSelect,
  onOpenPulse,
  onOpenSettings,
  pulseActive,
  pulseHasUnseen,
}: RailProps) {
  return (
    <nav
      data-testid="rail"
      className="shrink-0 flex flex-col items-stretch"
      style={{
        width: 68,
        background: "var(--ctp-mantle)",
        borderRight: "1px solid var(--border-subtle)",
      }}
    >
      <div className="flex flex-col gap-0.5 pt-2">
        {CANVAS_PLACES.map((p) => {
          const isActive = active === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              title={`${p.label} — ${p.blurb}  (⌘${p.hotkey})`}
              data-testid={`place-${p.id}`}
              aria-current={isActive ? "page" : undefined}
              className="relative flex flex-col items-center gap-1 py-2.5 outline-none"
              style={{
                background: isActive ? "var(--ctp-surface0)" : "transparent",
                borderLeft: isActive
                  ? "2px solid var(--ctp-text)"
                  : "2px solid transparent",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-lg)",
                  color: isActive ? "var(--ctp-text)" : "var(--ctp-overlay1)",
                  lineHeight: 1,
                }}
              >
                {p.glyph}
              </span>
              <span
                className="uppercase tracking-[0.08em]"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: isActive
                    ? "var(--ctp-subtext1)"
                    : "var(--ctp-overlay0)",
                }}
              >
                {p.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* The organism lives at the edge — always glowing, one click to open. */}
      <div className="mt-auto flex flex-col items-stretch pb-2">
        <RailHeart
          onOpen={onOpenPulse}
          hasUnseen={pulseHasUnseen}
          active={pulseActive}
        />
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings — models, keys, budget, autonomy (⌘,)"
          data-testid="rail-settings"
          className="flex flex-col items-center gap-1 py-2.5 outline-none opacity-70 hover:opacity-100"
        >
          <span
            style={{
              fontSize: "var(--text-base)",
              color: "var(--ctp-overlay1)",
            }}
          >
            ⋯
          </span>
        </button>
      </div>
    </nav>
  );
}
