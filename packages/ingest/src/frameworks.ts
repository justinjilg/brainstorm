/**
 * Framework & Build System Detection — identifies what the project uses.
 *
 * Checks for config files, package.json dependencies, and directory patterns
 * to determine frameworks, build tools, databases, and deployment targets.
 *
 * Flywheel: detected frameworks → routing profiles. "Express APIs route
 * debugging tasks to model X" learned from outcome data over time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrameworkDetection {
  /** Web frameworks detected. */
  frameworks: string[];
  /** Build tools / bundlers detected. */
  buildTools: string[];
  /** Package managers detected. */
  packageManagers: string[];
  /** Databases detected (from config, ORM, or migration files). */
  databases: string[];
  /** Deployment targets detected. */
  deployment: string[];
  /** Testing frameworks detected. */
  testing: string[];
  /** CI/CD systems detected. */
  ci: string[];
}

interface DetectionRule {
  name: string;
  category: keyof FrameworkDetection;
  files?: string[];
  dependencies?: string[];
  directories?: string[];
}

const RULES: DetectionRule[] = [
  // Web frameworks
  {
    name: "Next.js",
    category: "frameworks",
    files: ["next.config.js", "next.config.ts", "next.config.mjs"],
    dependencies: ["next"],
  },
  { name: "React", category: "frameworks", dependencies: ["react"] },
  {
    name: "Vue",
    category: "frameworks",
    dependencies: ["vue"],
    files: ["vue.config.js"],
  },
  {
    name: "Svelte",
    category: "frameworks",
    dependencies: ["svelte"],
    files: ["svelte.config.js"],
  },
  {
    name: "Angular",
    category: "frameworks",
    files: ["angular.json"],
    dependencies: ["@angular/core"],
  },
  { name: "Express", category: "frameworks", dependencies: ["express"] },
  { name: "Hono", category: "frameworks", dependencies: ["hono"] },
  { name: "Fastify", category: "frameworks", dependencies: ["fastify"] },
  { name: "NestJS", category: "frameworks", dependencies: ["@nestjs/core"] },
  {
    name: "Django",
    category: "frameworks",
    files: ["manage.py"],
    directories: ["django"],
  },
  { name: "Flask", category: "frameworks", dependencies: ["flask"] },
  { name: "FastAPI", category: "frameworks", dependencies: ["fastapi"] },
  {
    name: "Rails",
    category: "frameworks",
    files: ["Gemfile"],
    directories: ["app/controllers"],
  },
  {
    name: "Spring",
    category: "frameworks",
    files: ["pom.xml"],
    directories: ["src/main/java"],
  },
  {
    name: "Gin",
    category: "frameworks",
    dependencies: ["github.com/gin-gonic/gin"],
  },
  { name: "Actix", category: "frameworks", dependencies: ["actix-web"] },

  // Build tools
  { name: "Turborepo", category: "buildTools", files: ["turbo.json"] },
  {
    name: "Webpack",
    category: "buildTools",
    files: ["webpack.config.js", "webpack.config.ts"],
  },
  {
    name: "Vite",
    category: "buildTools",
    files: ["vite.config.js", "vite.config.ts"],
    dependencies: ["vite"],
  },
  {
    name: "tsup",
    category: "buildTools",
    files: ["tsup.config.ts"],
    dependencies: ["tsup"],
  },
  { name: "esbuild", category: "buildTools", dependencies: ["esbuild"] },
  {
    name: "Gradle",
    category: "buildTools",
    files: ["build.gradle", "build.gradle.kts"],
  },
  { name: "Maven", category: "buildTools", files: ["pom.xml"] },
  { name: "Cargo", category: "buildTools", files: ["Cargo.toml"] },
  { name: "Make", category: "buildTools", files: ["Makefile"] },
  { name: "CMake", category: "buildTools", files: ["CMakeLists.txt"] },

  // Package managers
  { name: "npm", category: "packageManagers", files: ["package-lock.json"] },
  { name: "pnpm", category: "packageManagers", files: ["pnpm-lock.yaml"] },
  { name: "yarn", category: "packageManagers", files: ["yarn.lock"] },
  { name: "bun", category: "packageManagers", files: ["bun.lockb"] },
  { name: "pip", category: "packageManagers", files: ["requirements.txt"] },
  { name: "poetry", category: "packageManagers", files: ["poetry.lock"] },
  { name: "uv", category: "packageManagers", files: ["uv.lock"] },
  { name: "cargo", category: "packageManagers", files: ["Cargo.lock"] },

  // Databases
  {
    name: "PostgreSQL",
    category: "databases",
    dependencies: ["pg", "postgres", "@neondatabase/serverless", "psycopg2"],
  },
  {
    name: "MySQL",
    category: "databases",
    dependencies: ["mysql2", "mysqlclient"],
  },
  {
    name: "SQLite",
    category: "databases",
    dependencies: ["better-sqlite3", "sqlite3"],
  },
  {
    name: "MongoDB",
    category: "databases",
    dependencies: ["mongoose", "mongodb"],
  },
  {
    name: "Redis",
    category: "databases",
    dependencies: ["redis", "ioredis", "@upstash/redis"],
  },
  { name: "Prisma", category: "databases", files: ["prisma/schema.prisma"] },
  { name: "Drizzle", category: "databases", dependencies: ["drizzle-orm"] },
  { name: "SQLAlchemy", category: "databases", dependencies: ["sqlalchemy"] },

  // Deployment
  {
    name: "Docker",
    category: "deployment",
    files: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"],
  },
  { name: "Vercel", category: "deployment", files: ["vercel.json", ".vercel"] },
  { name: "DigitalOcean", category: "deployment", files: [".do/app.yaml"] },
  { name: "Netlify", category: "deployment", files: ["netlify.toml"] },
  { name: "Fly.io", category: "deployment", files: ["fly.toml"] },
  {
    name: "Railway",
    category: "deployment",
    files: ["railway.json", "railway.toml"],
  },
  {
    name: "AWS",
    category: "deployment",
    files: ["serverless.yml", "template.yaml", "cdk.json"],
  },
  {
    name: "Terraform",
    category: "deployment",
    files: ["main.tf"],
    directories: ["terraform"],
  },
  {
    name: "Kubernetes",
    category: "deployment",
    files: ["k8s"],
    directories: ["k8s", "kubernetes"],
  },

  // Testing
  {
    name: "Vitest",
    category: "testing",
    files: ["vitest.config.ts", "vitest.config.js"],
    dependencies: ["vitest"],
  },
  {
    name: "Jest",
    category: "testing",
    files: ["jest.config.js", "jest.config.ts"],
    dependencies: ["jest"],
  },
  {
    name: "Playwright",
    category: "testing",
    dependencies: ["@playwright/test"],
  },
  { name: "Cypress", category: "testing", dependencies: ["cypress"] },
  { name: "pytest", category: "testing", files: ["pytest.ini", "conftest.py"] },

  // CI/CD
  {
    name: "GitHub Actions",
    category: "ci",
    directories: [".github/workflows"],
  },
  { name: "GitLab CI", category: "ci", files: [".gitlab-ci.yml"] },
  { name: "CircleCI", category: "ci", files: [".circleci/config.yml"] },
  { name: "Jenkins", category: "ci", files: ["Jenkinsfile"] },
];

/**
 * Detect frameworks, build tools, databases, and infrastructure.
 * Pure filesystem checks — no LLM, no network.
 */
export function detectFrameworks(projectPath: string): FrameworkDetection {
  const result: FrameworkDetection = {
    frameworks: [],
    buildTools: [],
    packageManagers: [],
    databases: [],
    deployment: [],
    testing: [],
    ci: [],
  };

  // Load package.json dependencies for dependency-based detection
  const deps = loadDependencies(projectPath);

  for (const rule of RULES) {
    let matched = false;

    // Check files
    if (rule.files) {
      matched = rule.files.some((f) => existsSync(join(projectPath, f)));
    }

    // Check directories
    if (!matched && rule.directories) {
      matched = rule.directories.some((d) => existsSync(join(projectPath, d)));
    }

    // Check dependencies
    if (!matched && rule.dependencies) {
      matched = rule.dependencies.some((d) => deps.has(d));
    }

    if (matched) {
      result[rule.category].push(rule.name);
    }
  }

  return result;
}

/** Load all dependency names from package.json, Cargo.toml, go.mod, requirements.txt. */
function loadDependencies(projectPath: string): Set<string> {
  const deps = new Set<string>();

  // package.json
  try {
    const pkg = JSON.parse(
      readFileSync(join(projectPath, "package.json"), "utf-8"),
    );
    for (const d of Object.keys(pkg.dependencies ?? {})) deps.add(d);
    for (const d of Object.keys(pkg.devDependencies ?? {})) deps.add(d);
  } catch {
    /* no package.json */
  }

  // requirements.txt
  try {
    const reqs = readFileSync(join(projectPath, "requirements.txt"), "utf-8");
    for (const line of reqs.split("\n")) {
      const name = line
        .trim()
        .split(/[=<>!~\[]/)[0]
        .trim();
      if (name && !name.startsWith("#")) deps.add(name.toLowerCase());
    }
  } catch {
    /* no requirements.txt */
  }

  // pyproject.toml (basic parsing)
  try {
    const pyproject = readFileSync(
      join(projectPath, "pyproject.toml"),
      "utf-8",
    );
    const depMatch = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depMatch) {
      for (const m of depMatch[1].matchAll(/"([^"]+)"/g)) {
        const name = m[1].split(/[=<>!~\[]/)[0].trim();
        if (name) deps.add(name.toLowerCase());
      }
    }
  } catch {
    /* no pyproject.toml */
  }

  // Cargo.toml (basic parsing)
  try {
    const cargo = readFileSync(join(projectPath, "Cargo.toml"), "utf-8");
    for (const m of cargo.matchAll(
      /^\[dependencies\.([^\]]+)\]|^([a-z][\w-]*)\s*=/gm,
    )) {
      const name = m[1] ?? m[2];
      if (name) deps.add(name);
    }
  } catch {
    /* no Cargo.toml */
  }

  // go.mod (basic parsing)
  try {
    const gomod = readFileSync(join(projectPath, "go.mod"), "utf-8");
    for (const m of gomod.matchAll(/\t([^\s]+)\s/g)) {
      if (m[1]) deps.add(m[1]);
    }
  } catch {
    /* no go.mod */
  }

  return deps;
}
