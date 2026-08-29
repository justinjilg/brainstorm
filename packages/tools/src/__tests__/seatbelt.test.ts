import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  seatbeltProfileArgs,
  writableRoots,
  canonicalPath,
  seatbeltUsable,
  spawnConfined,
} from "../sandbox/seatbelt.js";

// Pure-logic tests run everywhere; enforcement tests run only where the kernel
// actually governs the profile (macOS with a working sandbox-exec).
const enforced = seatbeltUsable();

describe("seatbelt profile builder (pure)", () => {
  it("read-only grants no writable roots", () => {
    expect(writableRoots({ mode: "read-only", workspaceRoot: "/ws" })).toEqual(
      [],
    );
  });

  it("read-only profile denies writes and allows /dev/null only", () => {
    const args = seatbeltProfileArgs({
      mode: "read-only",
      workspaceRoot: "/ws",
    });
    expect(args[0]).toBe("-p");
    const sbpl = args[1];
    expect(sbpl).toContain("(deny file-write*)");
    expect(sbpl).toContain('(allow file-write* (literal "/dev/null"))');
    // no subpath write grant under read-only
    expect(sbpl).not.toContain("(allow file-write* (subpath");
  });

  it("workspace-write grants the (canonical) workspace root as a subpath", () => {
    const ws = canonicalPath(tmpdir());
    const sbpl = seatbeltProfileArgs({
      mode: "workspace-write",
      workspaceRoot: ws,
    })[1];
    expect(sbpl).toContain(`(subpath "${ws}")`);
  });

  it("credential dirs are read-denied even though the fence is write-only", () => {
    const sbpl = seatbeltProfileArgs({
      mode: "read-only",
      workspaceRoot: "/ws",
    })[1];
    expect(sbpl).toContain("(deny file-read*");
    expect(sbpl).toContain(".brainstorm");
  });

  it("SBPL string quoting escapes quotes and backslashes", () => {
    const sbpl = seatbeltProfileArgs({
      mode: "workspace-write",
      workspaceRoot: '/weird/pa"th\\x',
    })[1];
    // the raw quote/backslash must be escaped inside the literal
    expect(sbpl).toContain('pa\\"th\\\\x');
  });
});

describe.skipIf(!enforced)("seatbelt enforcement (kernel, macOS)", () => {
  const ws = mkdtempSync(join(tmpdir(), "seatbelt-ws-"));
  // A target under HOME (NOT a granted root in any mode — not the workspace,
  // not /tmp, not os.tmpdir()). The write must be denied and never created.
  const outsideTarget = join(
    homedir(),
    `.brainstorm-seatbelt-outside-${process.pid}`,
  );
  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideTarget, { force: true });
  });

  it("read-only DENIES a write outside the workspace", () => {
    const { enforcement, res } = spawnConfined(
      ["/bin/sh", "-c", `echo hi > ${outsideTarget}`],
      { mode: "read-only", workspaceRoot: ws },
    );
    expect(enforcement).toBe("full");
    expect(res?.status).not.toBe(0); // kernel refused the write
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it("workspace-write ALLOWS a write inside the workspace", () => {
    const target = join(canonicalPath(ws), "ok.txt");
    const { res } = spawnConfined(["/bin/sh", "-c", `echo hi > ${target}`], {
      mode: "workspace-write",
      workspaceRoot: ws,
    });
    expect(res?.status).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("workspace-write still DENIES a write outside the workspace", () => {
    const { res } = spawnConfined(
      ["/bin/sh", "-c", `echo hi > ${outsideTarget}`],
      { mode: "workspace-write", workspaceRoot: ws },
    );
    expect(res?.status).not.toBe(0);
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it("reads are still allowed (write-only fence)", () => {
    const src = join(ws, "readable");
    writeFileSync(src, "data");
    const { res } = spawnConfined(["/bin/sh", "-c", `cat ${src} > /dev/null`], {
      mode: "read-only",
      workspaceRoot: ws,
    });
    expect(res?.status).toBe(0);
  });
});

describe.skipIf(enforced)("seatbelt fail-closed on unsupported hosts", () => {
  it("refuses (enforcement:none, res:null) rather than running unconfined", () => {
    const { enforcement, res } = spawnConfined(["/bin/sh", "-c", "true"], {
      mode: "read-only",
      workspaceRoot: "/tmp",
    });
    expect(enforcement).toBe("none");
    expect(res).toBeNull();
  });
});
