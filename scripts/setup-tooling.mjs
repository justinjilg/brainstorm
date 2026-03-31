#!/usr/bin/env node

/**
 * Cross-Project Tooling Setup
 *
 * Propagates standard dev tooling configs to all ~/Projects repos:
 * - Dependabot (dependency updates)
 * - CodeQL (security scanning)
 * - EditorConfig (consistent formatting)
 *
 * Usage: node scripts/setup-tooling.mjs [--dry-run] [--project name]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = resolve(__dirname, "..", "..");

const dryRun = process.argv.includes("--dry-run");
const projectArg = process.argv.indexOf("--project");
const targetProject = projectArg !== -1 ? process.argv[projectArg + 1] : null;

// Detect project ecosystem
function detectEcosystem(projectPath) {
  const ecosystems = [];
  if (existsSync(join(projectPath, "package.json")) || existsSync(join(projectPath, "package-lock.json"))) {
    ecosystems.push("npm");
  }
  if (existsSync(join(projectPath, "requirements.txt")) || existsSync(join(projectPath, "pyproject.toml"))) {
    ecosystems.push("pip");
  }
  if (existsSync(join(projectPath, "go.mod"))) {
    ecosystems.push("gomod");
  }
  if (existsSync(join(projectPath, "Gemfile"))) {
    ecosystems.push("bundler");
  }
  if (existsSync(join(projectPath, ".github", "workflows"))) {
    ecosystems.push("github-actions");
  }
  if (existsSync(join(projectPath, "Dockerfile")) || existsSync(join(projectPath, "docker-compose.yml"))) {
    ecosystems.push("docker");
  }
  if (existsSync(join(projectPath, "terraform"))) {
    ecosystems.push("terraform");
  }
  return ecosystems;
}

// Detect languages for CodeQL
function detectLanguages(projectPath) {
  const languages = [];
  const ecosystems = detectEcosystem(projectPath);
  if (ecosystems.includes("npm")) languages.push("javascript-typescript");
  if (ecosystems.includes("pip")) languages.push("python");
  if (ecosystems.includes("gomod")) languages.push("go");
  return languages.length > 0 ? languages : ["javascript-typescript"];
}

// Generate Dependabot config
function generateDependabot(ecosystems, repoOwner) {
  const updates = [];

  const ecoMap = {
    npm: { "package-ecosystem": "npm", directory: "/", schedule: { interval: "weekly", day: "monday" } },
    pip: { "package-ecosystem": "pip", directory: "/", schedule: { interval: "weekly", day: "monday" } },
    gomod: { "package-ecosystem": "gomod", directory: "/", schedule: { interval: "weekly", day: "monday" } },
    docker: { "package-ecosystem": "docker", directory: "/", schedule: { interval: "weekly" } },
    terraform: { "package-ecosystem": "terraform", directory: "/terraform", schedule: { interval: "weekly" } },
    "github-actions": { "package-ecosystem": "github-actions", directory: "/", schedule: { interval: "weekly" } },
  };

  for (const eco of ecosystems) {
    if (ecoMap[eco]) {
      updates.push({
        ...ecoMap[eco],
        "open-pull-requests-limit": 10,
        labels: ["dependencies", "automated"],
      });
    }
  }

  return `# Dependabot — automated dependency updates\nversion: 2\n\nupdates:\n${updates
    .map((u) => {
      let yaml = `  - package-ecosystem: "${u["package-ecosystem"]}"\n`;
      yaml += `    directory: "${u.directory}"\n`;
      yaml += `    schedule:\n      interval: "${u.schedule.interval}"\n`;
      if (u.schedule.day) yaml += `      day: "${u.schedule.day}"\n`;
      yaml += `    open-pull-requests-limit: ${u["open-pull-requests-limit"]}\n`;
      yaml += `    labels:\n${u.labels.map((l) => `      - ${l}`).join("\n")}\n`;
      return yaml;
    })
    .join("\n")}`;
}

// Generate CodeQL workflow
function generateCodeQL(languages) {
  return `name: CodeQL Security Analysis

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 8 * * 0"

jobs:
  analyze:
    name: Analyze
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      packages: read
      actions: read
      contents: read

    strategy:
      fail-fast: false
      matrix:
        language: [${languages.map((l) => `"${l}"`).join(", ")}]

    steps:
      - uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: \${{ matrix.language }}
          queries: security-extended,security-and-quality

      - name: Autobuild
        uses: github/codeql-action/autobuild@v3

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: /language:\${{ matrix.language }}
`;
}

// Find all git repos
function findRepos() {
  const entries = readdirSync(PROJECTS_DIR);
  return entries
    .filter((entry) => {
      const fullPath = join(PROJECTS_DIR, entry);
      return (
        statSync(fullPath).isDirectory() &&
        existsSync(join(fullPath, ".git")) &&
        !entry.startsWith(".")
      );
    })
    .map((name) => ({ name, path: join(PROJECTS_DIR, name) }));
}

// Main
const repos = findRepos().filter((r) => !targetProject || r.name === targetProject);

console.log(`\nCross-Project Tooling Setup`);
console.log(`${"=".repeat(40)}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
console.log(`Repos: ${repos.length}\n`);

let totalCreated = 0;
let totalSkipped = 0;

for (const repo of repos) {
  const ecosystems = detectEcosystem(repo.path);
  const languages = detectLanguages(repo.path);

  console.log(`\n${repo.name} (${ecosystems.join(", ") || "unknown"})`);
  console.log(`  Languages: ${languages.join(", ")}`);

  const githubDir = join(repo.path, ".github");
  const workflowsDir = join(githubDir, "workflows");

  // Dependabot
  const depFile = join(githubDir, "dependabot.yml");
  if (existsSync(depFile)) {
    console.log(`  [skip] dependabot.yml already exists`);
    totalSkipped++;
  } else if (ecosystems.length > 0) {
    const content = generateDependabot(ecosystems, "justinpbarnett");
    if (!dryRun) {
      mkdirSync(githubDir, { recursive: true });
      writeFileSync(depFile, content);
    }
    console.log(`  [${dryRun ? "would create" : "created"}] dependabot.yml (${ecosystems.join(", ")})`);
    totalCreated++;
  }

  // CodeQL
  const codeqlFile = join(workflowsDir, "codeql.yml");
  if (existsSync(codeqlFile)) {
    console.log(`  [skip] codeql.yml already exists`);
    totalSkipped++;
  } else if (languages.length > 0) {
    const content = generateCodeQL(languages);
    if (!dryRun) {
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(codeqlFile, content);
    }
    console.log(`  [${dryRun ? "would create" : "created"}] codeql.yml (${languages.join(", ")})`);
    totalCreated++;
  }
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Created: ${totalCreated} files`);
console.log(`Skipped: ${totalSkipped} files (already exist)`);
if (dryRun) console.log(`\nRe-run without --dry-run to apply.`);
console.log();
