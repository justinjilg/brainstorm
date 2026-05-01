/**
 * Workspace navigation types.
 *
 * The desktop's top-level navigation is a hybrid of two axes:
 *
 *   entity (the subject)     ×     verb (the action)
 *   ─────────────────────         ─────────────────────
 *   conversation                    talk      (chat scoped to entity)
 *   project                         plan
 *   business                        inspect
 *   platform                        operate
 *   self                            configure
 *
 * Some entities legitimately omit certain verbs (no "talk to platform").
 * `VERBS_BY_ENTITY` is the single source of truth for which verb tabs are
 * available per entity.
 *
 * See `~/.claude/plans/declarative-marinating-badger.md` for the full
 * matrix and the rationale.
 */

export type EntityKind =
  | "conversation"
  | "project"
  | "business"
  | "platform"
  | "self";

export type VerbKind = "talk" | "plan" | "inspect" | "operate" | "configure";

export interface WorkspaceSelection {
  entity: EntityKind;
  verb: VerbKind;
}

export const ENTITIES: ReadonlyArray<EntityKind> = [
  "conversation",
  "project",
  "business",
  "platform",
  "self",
];

export const ENTITY_LABEL: Record<EntityKind, string> = {
  conversation: "Conversation",
  project: "Project",
  business: "Business",
  platform: "Platform",
  self: "Self",
};

export const ENTITY_GLYPH: Record<EntityKind, string> = {
  conversation: "C",
  project: "P",
  business: "B",
  platform: "○",
  self: "S",
};

export const VERB_LABEL: Record<VerbKind, string> = {
  talk: "Talk",
  plan: "Plan",
  inspect: "Inspect",
  operate: "Operate",
  configure: "Configure",
};

/**
 * Per-entity verb availability. Entities that omit a verb have it
 * intentionally absent — see plan rationale ("better than inventing
 * meta-chat for Platform / Self"). The order of each array is the order
 * in which tabs render.
 */
export const VERBS_BY_ENTITY: Record<EntityKind, ReadonlyArray<VerbKind>> = {
  conversation: ["talk", "inspect", "operate", "configure"],
  project: ["talk", "plan", "inspect", "operate", "configure"],
  business: ["talk", "plan", "inspect", "operate", "configure"],
  platform: ["plan", "inspect", "operate", "configure"],
  self: ["plan", "inspect", "operate", "configure"],
};

/**
 * Returns the first available verb for an entity. Used when switching
 * entities to pick a default verb that exists for the new entity.
 */
export function defaultVerbFor(entity: EntityKind): VerbKind {
  return VERBS_BY_ENTITY[entity][0];
}

/**
 * Returns true if `verb` is a legal selection for `entity`. Useful to
 * guard against stale (entity, verb) pairs after entity changes — falls
 * back to `defaultVerbFor(entity)` when false.
 */
export function isVerbAvailable(entity: EntityKind, verb: VerbKind): boolean {
  return VERBS_BY_ENTITY[entity].includes(verb);
}

const SELECTION_STORAGE_KEY = "brainstorm.desktop.workspaceSelection";

export function loadSelection(): WorkspaceSelection | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceSelection>;
    if (
      parsed.entity &&
      ENTITIES.includes(parsed.entity as EntityKind) &&
      parsed.verb &&
      isVerbAvailable(parsed.entity as EntityKind, parsed.verb as VerbKind)
    ) {
      return {
        entity: parsed.entity as EntityKind,
        verb: parsed.verb as VerbKind,
      };
    }
  } catch {
    // Corrupted localStorage entry — ignore and fall back to defaults.
  }
  return null;
}

export function saveSelection(selection: WorkspaceSelection): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Quota exceeded or storage disabled — non-fatal.
  }
}
