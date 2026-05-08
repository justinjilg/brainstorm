/**
 * Registry of starter templates for `brainstorm harness init --template`.
 *
 * Templates themselves live in archetype-specific packages so they can ship
 * + version independently of the CLI:
 *   - @brainst0rm/archetype-saas-platform
 *   - @brainst0rm/archetype-msp
 *
 * This file is the single point of registration.
 */

import { SAAS_PLATFORM_TEMPLATE } from "@brainst0rm/archetype-saas-platform";
import { MSP_TEMPLATE } from "@brainst0rm/archetype-msp";
import type { StarterTemplate } from "@brainst0rm/config";

export type { StarterTemplate, TemplateFile } from "@brainst0rm/config";

const ALL_TEMPLATES: Record<string, StarterTemplate> = {
  "saas-platform": SAAS_PLATFORM_TEMPLATE,
  msp: MSP_TEMPLATE,
};

export function getTemplate(slug: string): StarterTemplate | null {
  return ALL_TEMPLATES[slug] ?? null;
}

export function listTemplates(): Array<{
  slug: string;
  description: string;
}> {
  return Object.values(ALL_TEMPLATES).map((t) => ({
    slug: t.slug,
    description: t.description,
  }));
}
