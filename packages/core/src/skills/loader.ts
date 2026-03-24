import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  source: 'project' | 'global' | 'claude-compat';
}

/**
 * Load skills from .brainstorm/skills/ directories.
 * Also loads Claude Code skills (.claude/commands/) for native compatibility.
 *
 * Skills are .md files with optional YAML frontmatter:
 * ---
 * description: "What this skill does"
 * ---
 * # Skill content (injected as prompt)
 */
export function loadSkills(projectPath: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  // 1. Project-level skills: .brainstorm/skills/
  const projectSkillsDir = join(projectPath, '.brainstorm', 'skills');
  skills.push(...loadSkillsFromDir(projectSkillsDir, 'project'));

  // 2. Global skills: ~/.brainstorm/skills/
  const globalSkillsDir = join(homedir(), '.brainstorm', 'skills');
  skills.push(...loadSkillsFromDir(globalSkillsDir, 'global'));

  // 3. Claude Code compatibility: .claude/commands/
  const claudeCommandsDir = join(projectPath, '.claude', 'commands');
  skills.push(...loadSkillsFromDir(claudeCommandsDir, 'claude-compat'));

  return skills;
}

function loadSkillsFromDir(dir: string, source: SkillDefinition['source']): SkillDefinition[] {
  if (!existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const name = basename(file, '.md');
      const { description, body } = parseFrontmatter(content);

      skills.push({
        name,
        description: description || `Skill: ${name}`,
        content: body,
        source,
      });
    } catch { /* skip unreadable files */ }
  }

  return skills;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns the description field and the body content.
 */
function parseFrontmatter(content: string): { description: string; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { description: '', body: content };

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Extract description from frontmatter (simple key: value parsing)
  const descMatch = frontmatter.match(/description:\s*"?([^"\n]+)"?/);
  const description = descMatch?.[1]?.trim() ?? '';

  return { description, body };
}

/**
 * Find a skill by name (for /command invocation).
 */
export function findSkill(skills: SkillDefinition[], name: string): SkillDefinition | undefined {
  return skills.find((s) => s.name === name);
}
