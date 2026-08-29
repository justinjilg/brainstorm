# Design Note: OS-level, per-call, fail-closed sandboxing (Seatbelt)

**Status:** proposal · **Date:** 2026-08-29 · **Owner:** Claude/Justin
**Prompted by:** three KAIROS daemon isolation escapes (see
`~/.claude/.../kairos-worktree-isolation-incident.md`).

## Why

The KAIROS self-improvement daemon corrupted the user's live repo **three times**
(node_modules symlink, `git stash` on main ×2). Root cause each time: we
isolated the agent's file/git effects **by convention** — an `AsyncLocalStorage`
workspace that path-based tools _choose_ to honor. The shell tool's `git` call
fell back to `process.cwd()` and hit the real repo. Convention is not a boundary.

We then moved to a separate **clone** + a **no-shell/no-raw-git daemon toolset**.
That closes the catastrophic git-escape, but it is a _capability_ fix (take the
gun away), not a _containment_ fix (the process still runs with full ambient
filesystem authority; a leaked `file_edit` or any future tool can still write
anywhere the backend user can).

DeepSeek's `deepseek-harness` (read firsthand from the cloned MIT source) does
this the right way: **kernel-enforced, per-call, fail-closed file confinement.**
Under it, our three incidents are not "unlikely" — they are **impossible**: a
stray write outside the workspace is denied by the OS, not by a hook the tool
had to remember to call. This note pulls their Seatbelt (macOS) profile builder
in and prescribes a Brainstorm adaptation.

## The pattern (verified in deepseek-harness source, MIT)

Five load-bearing decisions, all confirmed in
`packages/sandbox/sandbox/**` and `packages/sandbox/sandbox-local/**`:

1. **Per-call policy, not per-provider.** `SandboxPolicy` (`mode`,
   `workspaceRoot`, `sessionId`) is resolved _at the consumer boundary for each
   execution_ — "bash under `read-only` while a confined child agent needs its
   state dir writable" run at the same instant.
2. **`read-only` is the fail-safe default.** A deployment opts _into_ write.
3. **Fail-closed.** "Missing or unusable confinement **fails closed** rather
   than returning the original argv." Each backend _probes_ the kernel once
   (`sandbox-exec -p <profile> -- true`, exit 0 ⇒ enforced) and reports
   `full` | `partial`; callers needing an absolute boundary must refuse
   `partial`.
4. **A write-only fence.** The vocabulary governs _file writes_ only —
   `(allow default)` then `(deny file-write*)` then allow specific subpaths.
   Reads and network are out of scope (handled elsewhere: env scrubbing,
   path-deny rules for credential dirs).
5. **Canonical paths.** Writable roots are `realpathSync.native`-resolved,
   because Seatbelt matches _resolved_ paths — `/tmp` **is** `/private/tmp` on
   darwin, so an as-spelled grant matches nothing. One shared `writableRoots()`
   feeds both the Seatbelt grant and the in-process fs fence so they can't drift.

### Their Seatbelt profile builder (verbatim, for reference)

`packages/sandbox/sandbox-local/src/profiles.ts` and `../sandbox/src/roots.ts`:

```ts
// SBPL string literal quoting
function sbplString(path: string): string {
  return `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

// Build `sandbox-exec` args + the SBPL profile for one policy.
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = [
    "(version 1)",
    "(allow default)", // reads, network, exec allowed
    "(deny file-write*)", // ...but no writes
    `(allow file-write* (literal ${sbplString("/dev/null")}))`,
  ];
  const roots = writableRoots(policy); // [] under read-only
  if (roots.length > 0) {
    forms.push(
      `(allow file-write* ${roots.map((r) => `(subpath ${sbplString(r)})`).join(" ")})`,
    );
  }
  return ["-p", forms.join(" ")]; // consumer appends: '--', ...argv
}

// The mode's meaning as a canonical, deduped write allow-list.
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [
    ...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath)),
  ];
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // component-by-component, matches the kernel
    return path;
  } // missing path matches nothing — conservative
}
```

The runner then: `spawnSync('sandbox-exec', [...seatbeltProfileArgs(policy), '--', ...argv], …)`.

## Brainstorm adaptation

Add `packages/tools/src/sandbox/seatbelt.ts` — a self-contained, dependency-free
port. Then wire it into `shell` execution and the KAIROS daemon so **every**
subprocess the daemon (and eventually chat's shell) spawns is confined.

```ts
// packages/tools/src/sandbox/seatbelt.ts
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export interface SandboxPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
}
export type Enforcement = "full" | "partial" | "none";

const SEATBELT = "/usr/bin/sandbox-exec"; // absolute — no PATH substitution

export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}
function writableRoots(policy: SandboxPolicy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [
    ...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath)),
  ];
}
function sbpl(p: string): string {
  return `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbpl("/dev/null")}))`,
    // Brainstorm hardening: never let a confined process read our secrets even
    // though reads are otherwise allowed (env is also scrubbed separately).
    `(deny file-read* (subpath ${sbpl(canonicalPath(`${process.env.HOME}/.brainstorm`))}))`,
    `(deny file-read* (subpath ${sbpl(canonicalPath(`${process.env.HOME}/.config/op`))}))`,
  ];
  const roots = writableRoots(policy);
  if (roots.length) {
    forms.push(
      `(allow file-write* ${roots.map((r) => `(subpath ${sbpl(r)})`).join(" ")})`,
    );
  }
  return ["-p", forms.join(" ")];
}

/** True iff the kernel actually accepts+enforces a profile (probe with `true`). */
export function seatbeltUsable(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync(
    SEATBELT,
    [
      ...seatbeltProfileArgs({ mode: "read-only", workspaceRoot: "/" }),
      "--",
      "true",
    ],
    { stdio: "ignore", timeout: 5000 },
  );
  return probe.status === 0;
}

/**
 * Run argv under Seatbelt confinement. FAIL-CLOSED: if confinement is requested
 * (mode !== danger-full-access) but unusable, we DO NOT run — we return an
 * enforcement:"none" result the caller must treat as a denial, never a fallback.
 */
export function spawnConfined(
  argv: string[],
  policy: SandboxPolicy,
  opts: SpawnSyncOptions = {},
) {
  if (policy.mode === "danger-full-access") {
    return {
      enforcement: "full" as Enforcement,
      res: spawnSync(argv[0], argv.slice(1), opts),
    };
  }
  if (!seatbeltUsable()) {
    return { enforcement: "none" as Enforcement, res: null }; // caller refuses
  }
  const res = spawnSync(
    SEATBELT,
    [...seatbeltProfileArgs(policy), "--", ...argv],
    opts,
  );
  return { enforcement: "full" as Enforcement, res };
}
```

### Wiring

- **KAIROS daemon (immediate win).** Resolve one `SandboxPolicy` per tick:
  `{ mode: "workspace-write", workspaceRoot: <clonePath> }`. Route the daemon's
  subprocess spawns (verify/typecheck, any future shell) through `spawnConfined`.
  A `git stash` that lands in the wrong cwd is now **denied by the kernel**, not
  merely discouraged — the clone stops being load-bearing for safety and becomes
  merely convenient.
- **`shell` tool.** Replace the raw `execFile`/`spawn` with `spawnConfined`
  using the tool's resolved policy (default `read-only`; `workspace-write` scoped
  to `getWorkspace()`). Pair with the existing env-scrub (`buildChildEnv`) —
  Seatbelt fences _writes_, env-scrub fences _secret reads via env_, and the
  `file-read*` deny rules above fence _secret reads via disk_.
- **Escalation-as-UX (later).** Mirror DeepSeek's ladder: a denial returns a
  marker the model recognizes (`[sandbox: file access denied under <mode> mode]`)
  and, where the deployment allows, an approval-gated retry at a strictly-wider
  mode with a required `justification`. Keeps autonomy on a leash without
  hard-blocking legitimate work.

## Caveats / honesty

- **macOS-only.** `sandbox-exec` (Seatbelt) is what Brainstorm needs on the
  user's Macs. Linux parity needs Bubblewrap → Landlock (DeepSeek ships both);
  that is a follow-up, not this note. Report `enforcement:"none"` and **refuse**
  confined work on unsupported hosts rather than silently running unconfined.
- **`sandbox-exec` is "deprecated" by Apple** but remains fully functional and
  is what Chrome, Codex CLI, and now DeepSeek use. Acceptable; revisit if a
  future macOS removes it.
- **Write-only fence.** It does not restrict _network_ or _process_ visibility.
  For an autonomous agent that reads untrusted files (prompt-injection surface),
  layer: env scrub + the `file-read*` deny rules for credential dirs + (future)
  a network-deny SBPL clause for the daemon.
- **Not a VM.** Same-kernel confinement. For truly hostile code, the capability
  seam is replaced by a microVM/container — out of scope here.

## Migration order

1. Land `seatbelt.ts` + tests (probe returns true on darwin; a write outside
   `workspaceRoot` is denied; `/dev/null` write allowed; `.brainstorm` read
   denied).
2. Route the KAIROS daemon's spawns through it (biggest safety payoff; the
   daemon is the proven hazard).
3. Route the `shell` tool through it behind a config flag; default on for macOS.
4. Add the escalation marker + approval retry.
5. (Later) Linux bwrap/Landlock backend to reach parity.

## Verified on this machine (2026-08-29, macOS, `/usr/bin/sandbox-exec`)

The profile in this note was run live, not just reasoned about:

| Test                                                    | Profile                                     | Result                                    |
| ------------------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| Write outside workspace (`> /tmp/…`) under `read-only`  | `(deny file-write*)`                        | **`Operation not permitted` — DENIED** ✅ |
| Write to `/dev/null`                                    | `(allow file-write* (literal "/dev/null"))` | allowed ✅                                |
| Write under a granted `(subpath …)` (`workspace-write`) | grant present                               | allowed ✅                                |
| Read `/etc/hosts` under `read-only`                     | write-only fence                            | allowed (as designed) ✅                  |

The KAIROS `git stash`-on-main escape would have hit row 1: **kernel-denied**,
regardless of any AsyncLocalStorage leak.

## Attribution

Pattern and the reference `seatbeltProfileArgs`/`writableRoots`/`canonicalPath`
snippet are from `deepseek-ai/deepseek-harness` (MIT),
`packages/sandbox/**`, read 2026-08-29. The Brainstorm port above is adapted
(absolute `sandbox-exec`, credential-dir read-deny, fail-closed `enforcement`
signalling) and is our own code.
