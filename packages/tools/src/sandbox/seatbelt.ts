/**
 * macOS Seatbelt (sandbox-exec) confinement — kernel-enforced, per-call,
 * FAIL-CLOSED file-write sandboxing for subprocesses.
 *
 * Motivation: the KAIROS daemon corrupted the user's live repo three times
 * because isolation was by *convention* (an AsyncLocalStorage workspace that a
 * tool had to remember to honor) rather than *containment*. This wraps an argv
 * in an SBPL profile so the OS denies any file WRITE outside the granted roots
 * — a stray `git stash` in the wrong cwd is refused by the kernel, not merely
 * discouraged.
 *
 * Design (adapted from deepseek-ai/deepseek-harness, MIT, packages/sandbox/**):
 *  - policy is resolved PER CALL (not fixed on a provider);
 *  - `read-only` is the fail-safe default; write is opt-in;
 *  - a write-only fence: `(allow default)` then `(deny file-write*)` then allow
 *    specific subpaths — reads/network are out of scope here (pair with env
 *    scrubbing + the credential-dir read denies below);
 *  - writable roots are realpath-canonicalized because Seatbelt matches
 *    resolved paths (`/tmp` IS `/private/tmp` on darwin);
 *  - FAIL-CLOSED: if confinement is requested but the kernel won't enforce it,
 *    we refuse (`enforcement: "none"`, `res: null`) — never a silent fallback
 *    to an unconfined run.
 *
 * See docs/internal/seatbelt-sandbox-design-note.md.
 */
import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface SandboxPolicy {
  /** File-effect mode for this execution. */
  mode: SandboxMode;
  /** Absolute root a `workspace-write` execution may write under. */
  workspaceRoot: string;
}

/** Whether the kernel actually governed this execution. */
export type Enforcement = "full" | "none";

export interface ConfinedResult {
  enforcement: Enforcement;
  /** The spawn result, or null when confinement was required but unusable. */
  res: SpawnSyncReturns<Buffer> | null;
}

/** Absolute path — a rogue `sandbox-exec` earlier on PATH cannot be substituted. */
const SEATBELT_BIN = "/usr/bin/sandbox-exec";

/**
 * Resolve a path the way the kernel does (component-by-component, symlinks
 * followed) so a grant matches what Seatbelt compares against. A missing path
 * is returned as-spelled — it then matches nothing, the conservative outcome.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The canonical, deduped roots a policy may WRITE under (empty under read-only). */
export function writableRoots(policy: SandboxPolicy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [
    ...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath)),
  ];
}

/** Quote a path as an SBPL string literal. */
function sbpl(p: string): string {
  return `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Credential directories a confined process must never READ, even though the fence is write-only. */
function credentialReadDenies(): string[] {
  const home = process.env.HOME ?? "";
  if (!home) return [];
  return [
    `${home}/.brainstorm`,
    `${home}/.config/op`,
    `${home}/.aws`,
    `${home}/.ssh`,
  ].map((d) => `(deny file-read* (subpath ${sbpl(canonicalPath(d))}))`);
}

/**
 * Build the `sandbox-exec` args (`-p <SBPL>`) for one policy. The consumer
 * appends `"--", ...argv`. Only meaningful for confining modes; passing
 * `danger-full-access` is a caller error (there is nothing to confine).
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbpl("/dev/null")}))`,
    ...credentialReadDenies(),
  ];
  const roots = writableRoots(policy);
  if (roots.length > 0) {
    forms.push(
      `(allow file-write* ${roots.map((r) => `(subpath ${sbpl(r)})`).join(" ")})`,
    );
  }
  return ["-p", forms.join(" ")];
}

let usableCache: boolean | null = null;

/**
 * True iff the kernel accepts AND enforces a Seatbelt profile here: probe with
 * `sandbox-exec -p <read-only profile> -- true`. Exit 0 means enforced;
 * `sandbox_init` refusal or a missing binary (every non-darwin host) exits
 * non-zero → unusable. Cached for the process lifetime.
 */
export function seatbeltUsable(): boolean {
  if (usableCache !== null) return usableCache;
  if (process.platform !== "darwin") {
    usableCache = false;
    return false;
  }
  try {
    const probe = spawnSync(
      SEATBELT_BIN,
      [
        ...seatbeltProfileArgs({ mode: "read-only", workspaceRoot: "/" }),
        "--",
        "true",
      ],
      { stdio: "ignore", timeout: 5000 },
    );
    usableCache = probe.status === 0;
  } catch {
    usableCache = false;
  }
  return usableCache;
}

/** Test seam: reset the cached probe result. */
export function resetSeatbeltUsable(): void {
  usableCache = null;
}

/**
 * Run `argv` under Seatbelt confinement resolved from `policy`.
 *
 * FAIL-CLOSED: when the mode confines (`read-only`/`workspace-write`) but the
 * kernel won't enforce it, this returns `{ enforcement: "none", res: null }` —
 * it does NOT run the command. Callers that need an absolute boundary must
 * treat that as a denial. `danger-full-access` runs unconfined by definition.
 */
export function spawnConfined(
  argv: string[],
  policy: SandboxPolicy,
  opts: SpawnSyncOptions = {},
): ConfinedResult {
  if (argv.length === 0) throw new Error("spawnConfined: empty argv");
  if (policy.mode === "danger-full-access") {
    const res = spawnSync(
      argv[0],
      argv.slice(1),
      opts,
    ) as SpawnSyncReturns<Buffer>;
    return { enforcement: "full", res };
  }
  if (!seatbeltUsable()) {
    return { enforcement: "none", res: null };
  }
  const res = spawnSync(
    SEATBELT_BIN,
    [...seatbeltProfileArgs(policy), "--", ...argv],
    opts,
  ) as SpawnSyncReturns<Buffer>;
  return { enforcement: "full", res };
}
