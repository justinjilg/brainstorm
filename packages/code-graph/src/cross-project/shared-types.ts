/**
 * Shared Type Detection — finds types/interfaces/classes with the same
 * name across multiple projects.
 *
 * Shared types indicate tight coupling between projects. When one project
 * changes a shared type, the other project may break.
 */

export interface SharedType {
  name: string;
  kind: string;
  projects: Array<{
    project: string;
    file: string;
    exported: boolean;
  }>;
}

/**
 * Find types/classes/interfaces that appear in multiple project graphs.
 */
export function detectSharedTypes(
  projectGraphs: Array<{ project: string; db: any }>,
): SharedType[] {
  // Collect all exported class/interface names from each project
  const typesByName = new Map<string, SharedType>();

  for (const { project, db } of projectGraphs) {
    const types = db
      .prepare(
        `
      SELECT name, file, exported FROM classes WHERE exported = 1
    `,
      )
      .all() as Array<{ name: string; file: string; exported: number }>;

    // Also check for exported type-like functions (factory patterns)
    const interfaces = db
      .prepare(
        `
      SELECT DISTINCT name, file FROM nodes
      WHERE kind = 'class' AND name NOT LIKE '<%'
    `,
      )
      .all() as Array<{ name: string; file: string }>;

    const allTypes = [
      ...types.map((t) => ({
        name: t.name,
        file: t.file,
        exported: !!t.exported,
      })),
      ...interfaces.map((i) => ({
        name: i.name,
        file: i.file,
        exported: true,
      })),
    ];

    for (const type of allTypes) {
      const existing = typesByName.get(type.name);
      if (existing) {
        // Check it's not from the same project
        if (!existing.projects.some((p) => p.project === project)) {
          existing.projects.push({
            project,
            file: type.file,
            exported: type.exported,
          });
        }
      } else {
        typesByName.set(type.name, {
          name: type.name,
          kind: "class",
          projects: [
            {
              project,
              file: type.file,
              exported: type.exported,
            },
          ],
        });
      }
    }
  }

  // Only return types that appear in 2+ projects
  return Array.from(typesByName.values())
    .filter((t) => t.projects.length >= 2)
    .sort((a, b) => b.projects.length - a.projects.length);
}
