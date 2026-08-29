/**
 * The legacy AppMode string union — the pre-reshape view names that ChatView and
 * CommandPalette still emit. AppShell's `useLegacyModeRouter` maps these onto the
 * new places/drawer, so these controls keep working without the deleted grid.
 * New code should navigate via PlaceId + the Settings drawer, not these strings.
 */
export type AppMode =
  | "chat"
  | "plan"
  | "trace"
  | "dashboard"
  | "models"
  | "memory"
  | "skills"
  | "workflows"
  | "security"
  | "config";
