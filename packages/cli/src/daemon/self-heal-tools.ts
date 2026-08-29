/**
 * Bulletproof isolation for the self-improvement daemon.
 *
 * After three incidents where the daemon's shell/git tools escaped an
 * AsyncLocalStorage-scoped worktree and mutated the user's MAIN repo, the model
 * gets NO raw git and NO shell at all. Its only way to persist work is a single
 * commit tool that is PIN-BOUND to the isolated clone's path — it runs
 * `git -C <clonePath>` with an explicit cwd and never consults getWorkspace(),
 * so it is immune to context leaks. The clone has its own `.git`, so even a
 * hypothetical stray git call cannot reach the user's repository.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  ToolRegistry,
  createDefaultToolRegistry,
  defineTool,
  spawnConfined,
  seatbeltUsable,
} from "@brainst0rm/tools";
import { z } from "zod";

// Raw process/git/network tools the autonomous daemon must NOT have — any of
// these could run `git` (or arbitrary commands) against whatever cwd it lands
// in. Stripped from the daemon's OWN registry (the shared chat registry keeps
// them).
const STRIPPED_TOOL_NAMES = [
  "shell",
  "process_spawn",
  "process_kill",
  "build_verify",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_branch",
  "git_stash",
  "gh_pr",
  "gh_issue",
  "gh_review",
  "gh_actions",
  "gh_release",
  "gh_search",
  "gh_security",
  "gh_repo",
  "begin_transaction",
  "commit_transaction",
  "rollback_transaction",
];

/**
 * A commit tool locked to `clonePath`. Verifies (typecheck) then commits, all
 * via `git -C clonePath` / a cwd-pinned build — never getWorkspace(). This is
 * the daemon's ONLY write-to-git capability.
 */
export function createSelfHealCommitTool(clonePath: string) {
  // Every subprocess the daemon spawns runs under macOS Seatbelt confinement,
  // scoped so it can only WRITE under the clone (+ temp). Belt-and-suspenders
  // with the explicit `git -C <clone>` / cwd pin and the clone's own .git: even
  // a misdirected write is denied by the kernel, not merely by convention.
  // On non-macOS, Seatbelt is unusable → the clone's own .git + explicit cwd is
  // the boundary (still cannot reach the user's repo via git).
  const run = (
    bin: string,
    args: string[],
    timeout: number,
  ): SpawnSyncReturns<Buffer> => {
    const opts = {
      cwd: clonePath,
      timeout,
      stdio: ["pipe", "pipe", "pipe"] as const,
    };
    // `/usr/bin/env` resolves the binary via PATH with NO shell (args stay
    // separate argv — a commit message can never inject a command).
    const argv = ["/usr/bin/env", bin, ...args];
    if (seatbeltUsable()) {
      const { res } = spawnConfined(
        argv,
        { mode: "workspace-write", workspaceRoot: clonePath },
        opts,
      );
      // res is non-null: seatbeltUsable() gated the confining path.
      return res as SpawnSyncReturns<Buffer>;
    }
    return spawnSync("/usr/bin/env", [bin, ...args], opts);
  };
  const git = (args: string[]): string => {
    const r = run("git", ["-C", clonePath, ...args], 20000);
    if (r.status !== 0) {
      throw new Error(
        `git ${args[0]} failed (${r.status ?? r.signal}): ${String(r.stderr ?? "").trim()}`,
      );
    }
    return r.stdout.toString();
  };

  return defineTool({
    name: "commit_self_heal",
    description:
      "Verify and commit your changes to the ISOLATED self-heal clone — the ONLY way to persist your work (you have no shell or raw git). It typechecks the clone first and commits only if the build is green; if it fails, it returns the errors so you can fix them. Never touches the user's main repo.",
    permission: "allow",
    inputSchema: z.object({
      message: z
        .string()
        .min(1)
        .describe("Commit message: what weakness you fixed and why."),
      skipVerify: z
        .boolean()
        .optional()
        .describe(
          "Only for non-code changes (docs). Normally leave false so the fix is typecheck-verified before it counts.",
        ),
    }),
    async execute({ message, skipVerify }) {
      // 1. Anything staged/changed?
      const dirty = git(["status", "--porcelain"]).trim();
      if (!dirty) return "Nothing to commit — no changes in the clone.";

      // 2. Verify (typecheck) unless explicitly skipped — pinned to the clone,
      //    run under the same confinement.
      if (!skipVerify) {
        const r = run("pnpm", ["-s", "exec", "tsc", "-b"], 240000);
        if (r.status !== 0) {
          const detail = `${r.stdout ?? ""}${r.stderr ?? ""}`
            .toString()
            .split("\n")
            .filter((l) => /error TS|error:/i.test(l))
            .slice(0, 12)
            .join("\n");
          return `VERIFY FAILED — not committing. Typecheck errors:\n${detail || "(typecheck failed; see logs)"}\nFix these, then call commit_self_heal again.`;
        }
      }

      // 3. Commit — explicit clone path, own .git, cannot reach main.
      git(["add", "-A"]);
      git(["commit", "-m", message]);
      const head = git(["rev-parse", "--short", "HEAD"]).trim();
      return `Committed ${head} to the isolated self-heal clone${skipVerify ? "" : " (typecheck green)"}. Main repo untouched.`;
    },
  });
}

/**
 * A daemon-scoped tool registry: the full default set MINUS every raw
 * git/shell/network tool, PLUS the clone-pinned commit tool. Built fresh so it
 * never mutates the shared chat registry.
 */
export function createDaemonRegistry(clonePath: string): ToolRegistry {
  const registry = createDefaultToolRegistry({ daemon: true });
  for (const name of STRIPPED_TOOL_NAMES) registry.unregister(name);
  registry.register(createSelfHealCommitTool(clonePath));
  return registry;
}
