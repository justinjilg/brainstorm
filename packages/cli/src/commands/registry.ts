/**
 * The single source of truth for the CLI's command modules.
 *
 * The entry file and every charter test build the program from THIS list, so a
 * new domain module can't pass one gate (e.g. the entry wires it) while missing
 * another (e.g. the parity/surface charters never see it). One list, one truth.
 */
import type { Command } from "commander";
import { registerSetupCommands } from "./cmd-setup.js";
import { registerOperatorCommands } from "./cmd-operator.js";
import { registerRouterCommands } from "./cmd-router.js";
import { registerAgentsCommands } from "./cmd-agents.js";
import { registerSessionCommands } from "./cmd-session.js";
import { registerInfraCommands } from "./cmd-infra.js";
import { registerOrchestrationCommands } from "./cmd-orchestration.js";
import { registerTasksCommands } from "./cmd-tasks.js";
import { registerMemoryCommands } from "./cmd-memory.js";
import { registerKnowledgeCommands } from "./cmd-knowledge.js";
import { registerCloudCommands } from "./cmd-cloud.js";
import { registerPlatformCommands } from "./cmd-platform.js";
import { registerBackendCommands } from "./cmd-backend.js";
import { registerChatCommands } from "./cmd-chat.js";

export const COMMAND_REGISTRARS: ReadonlyArray<(program: Command) => void> = [
  registerSetupCommands,
  registerOperatorCommands,
  registerRouterCommands,
  registerAgentsCommands,
  registerSessionCommands,
  registerInfraCommands,
  registerOrchestrationCommands,
  registerTasksCommands,
  registerMemoryCommands,
  registerKnowledgeCommands,
  registerCloudCommands,
  registerPlatformCommands,
  registerBackendCommands,
  registerChatCommands,
];

/** Register every command module onto `program`. */
export function registerAllCommands(program: Command): void {
  for (const register of COMMAND_REGISTRARS) register(program);
}
