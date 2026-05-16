// Plugin definition helpers
export {
  defineBrainstormPlugin,
  definePluginTool,
  definePluginHook,
  definePluginSkill,
  type ToolMetadata,
  type BrainstormToolDef,
} from "./define.js";

// Plugin loader
export {
  discoverPlugins,
  getGlobalPluginsDir,
  getProjectPluginsDir,
  type LoadedPlugin,
} from "./loader.js";

// Types
export type {
  BrainstormPlugin,
  PluginToolDef,
  PluginHookDef,
  PluginHookEvent,
  PluginSkillDef,
  PluginManifest,
} from "./types.js";
