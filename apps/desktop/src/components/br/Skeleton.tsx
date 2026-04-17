/**
 * Skeleton placeholders — ported from BR's skeleton.ts. A skeleton sets a
 * spatial expectation for content that is about to arrive. Use in place
 * of "Loading X..." text while a hook is mid-fetch.
 */

import type { CSSProperties } from "react";

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const cls = ["skeleton", className].filter(Boolean).join(" ");
  return <div className={cls} style={style} />;
}

export function SkeletonStat(props: { width?: string; style?: CSSProperties }) {
  return (
    <Skeleton
      className="skeleton-stat"
      style={{ width: props.width, ...props.style }}
    />
  );
}

export function SkeletonText(props: { width?: string; style?: CSSProperties }) {
  return (
    <Skeleton
      className="skeleton-text"
      style={{ width: props.width, ...props.style }}
    />
  );
}

export function SkeletonChart(props: {
  height?: string;
  style?: CSSProperties;
}) {
  return (
    <Skeleton
      className="skeleton-chart"
      style={{ height: props.height, ...props.style }}
    />
  );
}

export function SkeletonRow(props: { style?: CSSProperties }) {
  return <Skeleton className="skeleton-row" style={props.style} />;
}

export function SkeletonRows({
  count,
  style,
}: {
  count: number;
  style?: CSSProperties;
}) {
  return (
    <div style={style}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

/** A full stats-row grid of N skeleton cards. */
export function SkeletonStatsRow({ count }: { count: number }) {
  return (
    <div className="stats-row">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat-card">
          <SkeletonText
            width="60px"
            style={{ height: "10px", marginBottom: 8 }}
          />
          <SkeletonStat />
        </div>
      ))}
    </div>
  );
}
