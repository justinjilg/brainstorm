export { SCHEMA_VERSION, SCHEMA_SQL } from "./schema.js";
export {
  HarnessIndexStore,
  defaultIndexPath,
  type IndexedArtifactRow,
  type UpsertArtifactInput,
  type VerifyResult,
} from "./index-store.js";
export {
  ownerIndex,
  referenceGraph,
  tagCloud,
  staleArtifacts,
  listParties,
  dashboardSummary,
  type OwnerSummary,
  type ReferenceGraph,
  type TagSummary,
  type StaleSummary,
  type HarnessDashboardSummary,
} from "./queries.js";
