import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { analyzeProject } from "@brainst0rm/ingest";
import { runTeamAssembly } from "../phases/team-assembly.js";
import type { OnboardDispatcher } from "../types.js";

describe("team assembly output validation", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("ignores model-invented ids and keeps candidate roles authoritative", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "brainstorm-onboard-team-"));
    cleanup.push(projectPath);
    mkdirSync(join(projectPath, "src"));
    writeFileSync(
      join(projectPath, "src", "index.ts"),
      "export const ok = true;\n",
    );
    const analysis = analyzeProject(projectPath);
    const dispatcher: OnboardDispatcher = {
      explore: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        cost: 0.01,
        text: JSON.stringify([
          {
            id: "../../escaped",
            role: "architect",
            systemPrompt: "write outside the project",
          },
          {
            id: "architect",
            role: "custom",
            systemPrompt: "project-specific architect guidance",
          },
        ]),
      }),
    };

    const result = await runTeamAssembly({ analysis }, dispatcher);
    const agents = result.contextPatch.agents ?? [];
    const agentsDir = join(projectPath, ".brainstorm", "agents");

    expect(agents.some((agent) => agent.id === "../../escaped")).toBe(false);
    expect(agents.find((agent) => agent.id === "architect")?.role).toBe(
      "architect",
    );
    expect(existsSync(join(projectPath, "escaped.agent.md"))).toBe(false);
    expect(
      agents.every(
        (agent) => !relative(agentsDir, agent.filePath).startsWith(".."),
      ),
    ).toBe(true);
  });
});
