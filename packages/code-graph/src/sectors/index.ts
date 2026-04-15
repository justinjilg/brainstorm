// Agent assignment
export {
  assignAgentsToSectors,
  getAgentForFile,
  getAgentsByPriority,
  type SectorAgent,
} from "./agent-assigner.js";

// Model matching
export { profileForTier, type SectorTaskProfile } from "./model-matcher.js";

// Prompt building
export { buildSectorPrompt, generateSectorAgentMd } from "./prompt-builder.js";

// Persistent plans
export {
  loadSectorPlan,
  saveSectorPlan,
  loadAllSectorPlans,
  createInitialPlan,
  getNextObjective,
  completeObjective,
  initSectorPlansSchema,
  type SectorPlan,
  type PlanObjective,
} from "./plan.js";

// Daemon integration
export {
  selectNextSector,
  recordSectorTick,
  getSectorPlanSummary,
  type SectorTickContext,
} from "./sector-daemon.js";
