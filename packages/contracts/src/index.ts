// @brainst0rm/contracts — behaviour for the contract layer + judge panels.
//
// Pure functions only in this stage: Zod validation, deterministic rendering,
// output validation, and the free/deterministic acceptance gates. No model
// calls; the panel dispatch (spawn) and router are injected by core at the call
// site in a later stage. The plain type shapes live in @brainst0rm/shared.

export {
  AgentContractSchema,
  createContract,
  renderContractPrompt,
  validateContractOutput,
  extractJsonBlock,
  type CreateContractInput,
  type RenderOptions,
  type ValidateOutputResult,
} from "./contract.js";

export {
  runAcceptanceGates,
  runAcceptanceGatesAsync,
  type GateReport,
  type GateResult,
  type GateDeps,
  type ContractResult,
  type AsyncGateDeps,
  type AsyncGateReport,
} from "./gates.js";

export {
  selectDiverseJudges,
  decidePanelOutcome,
  runJudgePanel,
  buildLensPrompt,
  scoreJudgeCapability,
  DEFAULT_PANELS,
  DEFAULT_JUDGE_CAPABILITY_FLOOR,
  type DiversitySelectionConfig,
  type DiverseJudgeSelection,
  type AchievedDiversity,
  type PanelSpawn,
  type PanelSpawnRequest,
  type PanelSpawnResult,
  type PanelDeps,
} from "./panel.js";

// Re-export the contract/panel types from shared for convenience.
export type {
  AgentContract,
  AcceptanceGate,
  PanelJudgeSpec,
  PanelConfig,
  QuorumSpec,
  Verdict,
  PanelDecision,
  ReviewFinding,
} from "@brainst0rm/shared";
