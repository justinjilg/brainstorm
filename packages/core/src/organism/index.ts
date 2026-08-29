/**
 * The organism spine: a single live event stream + materialized snapshot that
 * every Brainstorm surface projects from, replacing three parallel dashboards.
 */
export {
  OrganismBus,
  getOrganismBus,
  setOrganismBus,
  resetOrganismBus,
  type OrganismBusOptions,
} from "./bus.js";
export { agentEventToOrganism, publishRouteDecision } from "./bridge.js";
