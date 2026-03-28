/**
 * Persona Registry — expert playbooks for each role.
 *
 * Import this module to register all built-in personas.
 * Each persona file self-registers via registerPersona().
 */

// Import to trigger registration
import "./architect.js";
import "./sr-developer.js";
import "./qa-engineer.js";
import "./product-manager.js";
import "./jr-developer.js";

// Re-export the API
export {
  composePersonaPrompt,
  getPersona,
  listPersonas,
  registerPersona,
  type Persona,
  type PersonaFramework,
  type ModelAdaptation,
} from "./base.js";
