/**
 * API Endpoint Mapper — discovers API routes from code.
 *
 * Scans source files for route definitions across frameworks:
 * Express, Hono, Fastify, Flask, FastAPI, Django, Spring, Gin.
 *
 * Flywheel: endpoint map → agents know the API surface → better task
 * decomposition → better trajectories → smarter routing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

export interface APIEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  handler?: string;
}

export interface EndpointMap {
  endpoints: APIEndpoint[];
  frameworks: string[];
  totalRoutes: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
]);

const ROUTE_PATTERNS: Array<{
  framework: string;
  extensions: string[];
  patterns: Array<{
    regex: RegExp;
    methodGroup: number;
    pathGroup: number;
    handlerGroup?: number;
  }>;
}> = [
  {
    framework: "Express/Hono/Fastify",
    extensions: [".ts", ".js", ".mjs"],
    patterns: [
      {
        regex:
          /(?:app|router|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        methodGroup: 1,
        pathGroup: 2,
      },
    ],
  },
  {
    framework: "Next.js API Routes",
    extensions: [".ts", ".js"],
    patterns: [
      {
        regex:
          /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/g,
        methodGroup: 1,
        pathGroup: -1,
      },
    ],
  },
  {
    framework: "Flask/FastAPI",
    extensions: [".py"],
    patterns: [
      {
        regex:
          /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
        methodGroup: 1,
        pathGroup: 2,
      },
      {
        regex: /@(?:app|bp|blueprint)\.route\s*\(\s*['"]([^'"]+)['"]/g,
        methodGroup: -1,
        pathGroup: 1,
      },
    ],
  },
  {
    framework: "Django",
    extensions: [".py"],
    patterns: [
      {
        regex: /path\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\w.]+)/g,
        methodGroup: -1,
        pathGroup: 1,
        handlerGroup: 2,
      },
    ],
  },
  {
    framework: "Spring",
    extensions: [".java", ".kt"],
    patterns: [
      {
        regex:
          /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g,
        methodGroup: 1,
        pathGroup: 2,
      },
    ],
  },
  {
    framework: "Gin (Go)",
    extensions: [".go"],
    patterns: [
      {
        regex: /\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g,
        methodGroup: 1,
        pathGroup: 2,
      },
    ],
  },
];

export function mapEndpoints(projectPath: string): EndpointMap {
  const endpoints: APIEndpoint[] = [];
  const detectedFrameworks = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > 10) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else
        scanFile(
          full,
          extname(entry).toLowerCase(),
          projectPath,
          endpoints,
          detectedFrameworks,
        );
    }
  }

  walk(projectPath, 0);
  endpoints.sort((a, b) => a.path.localeCompare(b.path));

  return {
    endpoints,
    frameworks: Array.from(detectedFrameworks),
    totalRoutes: endpoints.length,
  };
}

function scanFile(
  filePath: string,
  ext: string,
  projectPath: string,
  endpoints: APIEndpoint[],
  detectedFrameworks: Set<string>,
): void {
  for (const def of ROUTE_PATTERNS) {
    if (!def.extensions.includes(ext)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
    const rel = relative(projectPath, filePath);

    for (const p of def.patterns) {
      p.regex.lastIndex = 0;
      let match;
      while ((match = p.regex.exec(content)) !== null) {
        const method =
          p.methodGroup === -1
            ? inferMethod(match[0])
            : (match[p.methodGroup] ?? "ANY").toUpperCase();
        let path =
          p.pathGroup === -1
            ? inferPathFromFile(rel)
            : (match[p.pathGroup] ?? "/");
        if (!path.startsWith("/")) path = "/" + path;

        // Line number
        let line = 1;
        for (let i = 0; i < match.index && i < content.length; i++) {
          if (content[i] === "\n") line++;
        }

        endpoints.push({
          method,
          path,
          file: rel,
          line,
          handler: p.handlerGroup ? match[p.handlerGroup] : undefined,
        });
        detectedFrameworks.add(def.framework);
      }
    }
  }
}

export function inferMethod(text: string): string {
  const l = text.toLowerCase();
  if (l.includes(".get") || l.includes("@get")) return "GET";
  if (l.includes(".post") || l.includes("@post")) return "POST";
  if (l.includes(".put") || l.includes("@put")) return "PUT";
  if (l.includes(".delete") || l.includes("@delete")) return "DELETE";
  if (l.includes(".patch") || l.includes("@patch")) return "PATCH";
  return "ANY";
}

export function inferPathFromFile(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const apiIdx = parts.indexOf("api");
  if (apiIdx >= 0) {
    const routeParts = parts.slice(apiIdx);
    if (routeParts[routeParts.length - 1]?.startsWith("route."))
      routeParts.pop();
    return "/" + routeParts.join("/");
  }
  return "/" + relPath.replace(/\.(ts|js|py|java|go|kt)$/, "");
}
