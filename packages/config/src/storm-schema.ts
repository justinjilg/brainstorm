import { z } from 'zod';

/**
 * Zod schema for STORM.md YAML frontmatter.
 *
 * All fields optional except `version: 1` — graceful degradation for
 * hand-written files. Invalid frontmatter returns null (warn, don't crash).
 */
export const stormFrontmatterSchema = z.object({
  version: z.literal(1),

  // Project identity
  name: z.string().optional(),
  type: z.enum(['monorepo', 'app', 'cli', 'library', 'api']).optional(),
  language: z.enum(['typescript', 'python', 'rust', 'go', 'java', 'multi']).optional(),
  framework: z.enum(['nextjs', 'hono', 'fastapi', 'express', 'none']).default('none'),
  runtime: z.enum(['node', 'deno', 'bun', 'python', 'go']).default('node'),
  deploy: z.enum(['vercel', 'do-app-platform', 'docker', 'aws', 'none']).default('none'),
  repo: z.string().optional(),

  // Routing hints — fed to the task classifier for better decisions
  routing: z.object({
    primary_tasks: z.array(z.string()).default([]),
    typical_complexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'expert']).default('moderate'),
    prefer_local: z.boolean().default(false),
    budget_tier: z.enum(['low', 'standard', 'premium']).default('standard'),
  }).default({}),

  // Provider configuration
  providers: z.object({
    cloud: z.enum(['brainstormrouter', 'direct', 'none']).default('brainstormrouter'),
    local: z.array(z.enum(['ollama', 'lmstudio', 'llamacpp'])).default([]),
  }).default({}),

  // Secrets strategy
  secrets: z.object({
    strategy: z.enum(['env-file', 'op-cli', 'sops', 'doppler', 'infisical', 'manual']).default('env-file'),
  }).default({}),

  // Commands and entry points — what I use every session
  entry_points: z.array(z.string()).default([]),
  test_command: z.string().optional(),
  build_command: z.string().optional(),
  dev_command: z.string().optional(),
});

export type StormFrontmatter = z.infer<typeof stormFrontmatterSchema>;
