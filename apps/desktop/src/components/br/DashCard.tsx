/**
 * DashCard — shared shell for the BR-style "instrument panel" section.
 *
 * Every dashboard surface that wants a bordered section with a mono
 * eyebrow + editorial serif title lives inside one of these. Matches
 * the @brainst0rm/router dashCard helper one-for-one (eyebrow above
 * title, optional actions slot, body slot).
 */

import type { PropsWithChildren, ReactNode } from "react";

export interface DashCardProps {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  className?: string;
  /** Render a single empty-state-esque hint line instead of children. */
  note?: string;
}

export function DashCard({
  eyebrow,
  title,
  actions,
  className,
  note,
  children,
}: PropsWithChildren<DashCardProps>) {
  return (
    <section className={["dash-card", className].filter(Boolean).join(" ")}>
      <div className="dash-card-header">
        <div className="home-card-head">
          <div className="dash-card-eyebrow">{eyebrow}</div>
          <h3 className="dash-card-title">{title}</h3>
        </div>
        {actions ? <div className="dash-card-actions">{actions}</div> : null}
      </div>
      <div className="dash-card-body">
        {note ? <div className="dash-card-note">{note}</div> : children}
      </div>
    </section>
  );
}
