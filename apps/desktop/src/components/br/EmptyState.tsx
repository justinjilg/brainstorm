/**
 * EmptyState — a bespoke empty placeholder for a view. Large centered
 * SVG mark + Fraunces heading + one-line description + optional CTA.
 *
 * Each caller should provide its own mark so the empty state actually
 * reads as "this view is specifically empty," not "something is missing."
 * Keep marks monochrome (bone-faint) so they telegraph _quietness_.
 */

import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: ReactNode;
  heading: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({
  icon,
  heading,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="empty-state-block">
      <div className="empty-state-icon" aria-hidden>
        {icon}
      </div>
      <div className="empty-state-heading">{heading}</div>
      {description ? (
        <div className="empty-state-desc">{description}</div>
      ) : null}
      {action ? (
        <button
          type="button"
          className="br-btn br-btn-primary"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
