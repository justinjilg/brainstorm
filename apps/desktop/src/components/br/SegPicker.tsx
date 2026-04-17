/**
 * SegPicker — a flat segmented-control for short option sets (e.g. time
 * ranges, density, pill filters). Matches BR's seg-picker styles exactly.
 *
 * Always show at least 2 options. The active item paints pearl-white on
 * ink so it pops against the surrounding card. The component is
 * controlled: parent owns the activeId.
 */

import type { ReactNode } from "react";

export interface SegPickerOption<T extends string = string> {
  id: T;
  label: ReactNode;
  tooltip?: string;
}

export interface SegPickerProps<T extends string = string> {
  options: SegPickerOption<T>[];
  activeId: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}

export function SegPicker<T extends string = string>({
  options,
  activeId,
  onChange,
  ariaLabel,
}: SegPickerProps<T>) {
  return (
    <div className="seg-picker" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = opt.id === activeId;
        const extra = opt.tooltip ? { "data-tooltip": opt.tooltip } : undefined;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`seg-picker-btn${active ? " is-active" : ""}`}
            onClick={() => onChange(opt.id)}
            {...extra}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
