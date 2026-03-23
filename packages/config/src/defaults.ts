import { brainstormConfigSchema, type BrainstormConfig } from './schema.js';

export const DEFAULT_CONFIG: BrainstormConfig = brainstormConfigSchema.parse({});
