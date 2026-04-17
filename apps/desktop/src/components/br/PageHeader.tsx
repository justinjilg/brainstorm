/**
 * PageHeader — Fraunces title + description + optional actions + optional tabs.
 *
 * Every top-level view should lead with one of these so the page has a
 * single self-describing stanza. Tabs are mono-uppercase pill under the
 * title and call onTabChange when the active id flips.
 */

import type { ReactNode } from "react";

export interface PageTab {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  tabs?: PageTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
}

export function PageHeader({
  title,
  description,
  actions,
  tabs,
  activeTab,
  onTabChange,
}: PageHeaderProps) {
  const Row = actions ? "div" : null;
  const titleBlock = (
    <div>
      <h2 className="page-title">{title}</h2>
      {description ? <p className="page-description">{description}</p> : null}
    </div>
  );

  return (
    <div className="page-header">
      {Row ? (
        <div className="page-header-row">
          {titleBlock}
          <div className="page-header-actions">{actions}</div>
        </div>
      ) : (
        titleBlock
      )}
      {tabs && tabs.length > 0 ? (
        <div className="page-header-tabs" role="tablist">
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? "page-tab active" : "page-tab"}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.icon ? (
                  <span className="page-tab-icon" aria-hidden>
                    {tab.icon}
                  </span>
                ) : null}
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
