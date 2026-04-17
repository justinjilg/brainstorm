/**
 * BR component layer — React primitives that mirror the
 * @brainst0rm/router dashboard's Precision Monochrome idiom.
 *
 * Every surface in the desktop app should reach for these instead of
 * hand-rolled panels so the two products stay visually identical.
 */

export { DashCard } from "./DashCard.js";
export type { DashCardProps } from "./DashCard.js";

export { StatCard, StatsRow } from "./StatCard.js";
export type { StatAccent, StatCardProps, Trend } from "./StatCard.js";

export { PageHeader } from "./PageHeader.js";
export type { PageHeaderProps, PageTab } from "./PageHeader.js";

export { SegPicker } from "./SegPicker.js";
export type { SegPickerOption, SegPickerProps } from "./SegPicker.js";

export {
  Skeleton,
  SkeletonStat,
  SkeletonText,
  SkeletonChart,
  SkeletonRow,
  SkeletonRows,
  SkeletonStatsRow,
} from "./Skeleton.js";

export { EmptyState } from "./EmptyState.js";
export type { EmptyStateProps } from "./EmptyState.js";

export { initGlobalTooltip, useGlobalTooltip } from "./Tooltip.js";
