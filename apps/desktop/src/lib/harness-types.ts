import type { BusinessToml } from "@brainst0rm/config";

/**
 * The desktop's primary navigation root concept.
 *
 * Discriminated union: a desktop session is operating either inside a code
 * project (the existing flow), inside a business harness (the new flow per
 * the spec at ~/.claude/plans/snuggly-sleeping-hinton.md), or with no
 * active root yet.
 *
 * The discriminator is `kind`. Components that only care about path can
 * read `harnessRoot()`; components that need manifest-aware behavior
 * switch on `kind` and access the typed branches.
 */
export interface HarnessSessionVerify {
  /** Number of indexed entries whose (mtime/size/hash) match the FS. */
  clean: number;
  /** Indexed paths whose content changed since last index update. */
  stale: string[];
  /** Indexed paths whose underlying file no longer exists. */
  missing: string[];
  /** Files on disk that aren't yet indexed (set by directory walk; 0
   *  until the walker runs — v1.5 deliverable). */
  unindexedCount: number;
}

export type ActiveHarness =
  | { kind: "none" }
  | { kind: "code"; root: string }
  | {
      kind: "business";
      root: string;
      manifest: BusinessToml;
      /** Set after the index session opens; null while pending or on error. */
      sessionVerify: HarnessSessionVerify | null;
    };

/**
 * Result returned by `harness.openDialog` IPC route. Distinguishes:
 *   - cancel (user dismissed dialog)
 *   - business (folder contains business.toml; manifest valid)
 *   - code (folder is just a code project; no business.toml found by
 *     walking up)
 *   - error (folder contains business.toml but it failed to parse or
 *     validate)
 *
 * `code` allows the same dialog to handle both flows: opening a folder
 * that turns out to be a regular project just becomes the existing
 * code-project flow.
 */
export type OpenDialogResult =
  | { kind: "cancel" }
  | { kind: "business"; root: string; manifest: BusinessToml }
  | { kind: "code"; root: string }
  | {
      kind: "error";
      root: string;
      manifestPath: string;
      error: "parse-error" | "schema-error";
      message: string;
    };

export function isBusinessHarness(
  h: ActiveHarness,
): h is Extract<ActiveHarness, { kind: "business" }> {
  return h.kind === "business";
}

export function harnessRoot(h: ActiveHarness): string | null {
  return h.kind === "none" ? null : h.root;
}

export function harnessName(h: ActiveHarness): string | null {
  switch (h.kind) {
    case "none":
      return null;
    case "business":
      return h.manifest.identity.name;
    case "code":
      return h.root.split("/").filter(Boolean).pop() ?? h.root;
  }
}
