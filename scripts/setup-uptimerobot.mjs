#!/usr/bin/env node

/**
 * UptimeRobot Setup — imports monitors from monitoring-manifest.json
 *
 * Prerequisites:
 * 1. Sign up at https://uptimerobot.com (free: 50 monitors, 5-min intervals)
 * 2. Get API key from My Settings → API Settings → Main API Key
 * 3. Store: op item create --vault "Dev Keys" --category "API Credential" --title "UptimeRobot API Key" "credential=YOUR_KEY"
 * 4. Run: node scripts/setup-uptimerobot.mjs
 *
 * Or: UPTIMEROBOT_API_KEY=xxx node scripts/setup-uptimerobot.mjs
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MANIFEST_PATH = resolve(ROOT, "docs/internal/monitoring-manifest.json");

const dryRun = process.argv.includes("--dry-run");

// Resolve API key (env var first, then 1Password)
let apiKey = process.env.UPTIMEROBOT_API_KEY;
if (!apiKey) {
  try {
    apiKey = execFileSync("op", ["read", "op://Dev Keys/UptimeRobot API Key/credential"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    // Fall through
  }
}

if (!apiKey) {
  console.error(`Error: No UptimeRobot API key found.

Setup:
  1. Sign up at https://uptimerobot.com (free tier: 50 monitors)
  2. Go to My Settings → API Settings → Main API Key
  3. Store in 1Password:
     op item create --vault "Dev Keys" --category "API Credential" \\
       --title "UptimeRobot API Key" "credential=YOUR_KEY"
  4. Re-run this script
`);
  process.exit(1);
}

// Load manifest
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const monitors = manifest.monitors;

console.log(`UptimeRobot Monitor Setup`);
console.log(`${"=".repeat(40)}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "CREATE"}`);
console.log(`Monitors to create: ${monitors.length}\n`);

// Get existing monitors
async function getExisting() {
  const resp = await fetch("https://api.uptimerobot.com/v2/getMonitors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, format: "json" }),
  });
  const data = await resp.json();
  return data.monitors || [];
}

async function createMonitor(m) {
  const body = {
    api_key: apiKey,
    format: "json",
    friendly_name: m.name,
    url: m.url,
    type: 1, // HTTP(s)
    interval: m.interval,
    timeout: m.timeout || 30,
  };

  if (dryRun) {
    console.log(`  [would create] ${m.name} → ${m.url} (${m.interval}s)`);
    return true;
  }

  const resp = await fetch("https://api.uptimerobot.com/v2/newMonitor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();

  if (data.stat === "ok") {
    console.log(`  [created] ${m.name} → ${m.url}`);
    return true;
  } else {
    console.error(`  [error] ${m.name}: ${JSON.stringify(data.error)}`);
    return false;
  }
}

// Main
const existing = dryRun ? [] : await getExisting();
const existingUrls = new Set(existing.map((m) => m.url));

let created = 0;
let skipped = 0;

for (const monitor of monitors) {
  if (existingUrls.has(monitor.url)) {
    console.log(`  [skip] ${monitor.name} — already exists`);
    skipped++;
    continue;
  }

  const ok = await createMonitor(monitor);
  if (ok) created++;

  // UptimeRobot rate limit: 10 requests per minute on free tier
  if (!dryRun) await new Promise((r) => setTimeout(r, 7000));
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Created: ${created}`);
console.log(`Skipped: ${skipped}`);
if (dryRun) console.log(`\nRe-run without --dry-run to create monitors.`);
