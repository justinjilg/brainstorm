#!/usr/bin/env tsx
/**
 * tui-snapshot — Autonomous TUI visual testing tool.
 *
 * Renders the Brainstorm TUI in a headless terminal emulator,
 * executes scripted keystrokes, and captures frames as plain text.
 *
 * This lets Claude Code (or CI) "see" the TUI output without a real terminal.
 *
 * Usage:
 *   npx tsx packages/cli/scripts/tui-snapshot.ts --scenario mode-switching
 *   npx tsx packages/cli/scripts/tui-snapshot.ts --scenario mode-switching --output snapshots/
 *
 * How it works:
 *   1. Spawns the built CLI binary in a PTY via node-pty
 *   2. Connects PTY output to @xterm/headless (virtual terminal emulator)
 *   3. Reads scenario file (keystrokes + delays + capture points)
 *   4. At each capture point, reads the virtual terminal's character buffer
 *   5. Outputs frames as plain text with optional color annotations
 */

import { spawn as ptySpawn } from "node-pty";
import { Terminal } from "@xterm/headless";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  width?: number;
  height?: number;
  command?: string;
  steps: ScenarioStep[];
}

type ScenarioStep =
  | { wait: number }
  | { capture: string }
  | { key: string }
  | { type: string };

// ── Color name lookup from xterm color index ───────────────────────────

const COLOR_NAMES: Record<number, string> = {
  0: "black",
  1: "red",
  2: "green",
  3: "yellow",
  4: "blue",
  5: "magenta",
  6: "cyan",
  7: "white",
  8: "bright-black",
  9: "bright-red",
  10: "bright-green",
  11: "bright-yellow",
  12: "bright-blue",
  13: "bright-magenta",
  14: "bright-cyan",
  15: "bright-white",
};

// ── Key name → escape sequence mapping ─────────────────────────────────

const KEY_MAP: Record<string, string> = {
  escape: "\u001B",
  enter: "\r",
  tab: "\t",
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  backspace: "\u007F",
  space: " ",
  "ctrl+d": "\u0004",
  "ctrl+c": "\u0003",
  "ctrl+l": "\u000C",
  "ctrl+k": "\u000B",
  "shift+tab": "\u001B[Z",
};

// ── Frame Capture ──────────────────────────────────────────────────────

function captureFrame(terminal: Terminal, includeColors = false): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];

  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) {
      lines.push("");
      continue;
    }

    let text = "";
    let colorAnnotations = "";

    for (let x = 0; x < terminal.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) {
        text += " ";
        continue;
      }

      const char = cell.getChars() || " ";
      text += char;

      if (includeColors && char.trim()) {
        const fg = cell.getFgColor();
        const bg = cell.getBgColor();
        const fgName = COLOR_NAMES[fg] ?? `#${fg}`;
        const bgName = bg === -1 ? "default" : (COLOR_NAMES[bg] ?? `#${bg}`);
        if (fg !== 7 || bg !== -1) {
          // Non-default colors
          colorAnnotations += `  [${x},${y}] '${char}' fg=${fgName} bg=${bgName}`;
          if (cell.isBold()) colorAnnotations += " BOLD";
          if (cell.isDim()) colorAnnotations += " DIM";
          colorAnnotations += "\n";
        }
      }
    }

    lines.push(text.trimEnd());

    if (includeColors && colorAnnotations) {
      lines.push(colorAnnotations.trimEnd());
    }
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

// ── Scenario Runner ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runScenario(
  scenarioPath: string,
  outputDir?: string,
): Promise<void> {
  const raw = readFileSync(scenarioPath, "utf-8");
  const scenario: Scenario = parseYaml(raw);

  const cols = scenario.width ?? 120;
  const rows = scenario.height ?? 40;

  console.log(`\n╔═══════════════════════════════════════════════╗`);
  console.log(`║  tui-snapshot: ${scenario.name}`);
  console.log(`║  Terminal: ${cols}×${rows}`);
  console.log(`╚═══════════════════════════════════════════════╝\n`);

  // Create the virtual terminal emulator
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });

  // Spawn the CLI in a real PTY
  const cliPath = resolve(import.meta.dirname ?? ".", "../dist/brainstorm.js");

  const command = scenario.command ?? `node ${cliPath} chat`;
  const [cmd, ...args] = command.split(" ");

  const pty = ptySpawn(cmd, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
      // Prevent interactive prompts during testing
      CI: "true",
      BRAINSTORM_TEST: "1",
    },
  });

  // Pipe PTY output to virtual terminal
  pty.onData((data) => {
    terminal.write(data);
  });

  const frames: Record<string, string> = {};

  try {
    for (const step of scenario.steps) {
      if ("wait" in step) {
        await sleep(step.wait);
      } else if ("capture" in step) {
        await sleep(100); // Brief settle time
        const frame = captureFrame(terminal, true);
        frames[step.capture] = frame;
        console.log(
          `── Frame: ${step.capture} ${"─".repeat(50 - step.capture.length)}`,
        );
        console.log(captureFrame(terminal, false));
        console.log("");
      } else if ("key" in step) {
        const keyData = KEY_MAP[step.key.toLowerCase()] ?? step.key;
        pty.write(keyData);
      } else if ("type" in step) {
        for (const char of step.type) {
          pty.write(char);
          await sleep(30); // Typing speed
        }
      }
    }
  } finally {
    pty.kill();
  }

  // Save frames to output directory if specified
  if (outputDir) {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    for (const [name, content] of Object.entries(frames)) {
      const filePath = join(outputDir, `${name}.txt`);
      writeFileSync(filePath, content, "utf-8");
      console.log(`  Saved: ${filePath}`);
    }
  }

  console.log(`\n✓ Captured ${Object.keys(frames).length} frames`);
}

// ── CLI ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const scenarioIdx = args.indexOf("--scenario");
const outputIdx = args.indexOf("--output");

if (scenarioIdx === -1 || !args[scenarioIdx + 1]) {
  console.error("Usage: tui-snapshot --scenario <name> [--output <dir>]");
  console.error("");
  console.error("Available scenarios:");
  const scenarioDir = resolve(import.meta.dirname ?? ".", "scenarios");
  if (existsSync(scenarioDir)) {
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(scenarioDir)) {
      if (f.endsWith(".yaml")) console.error(`  ${f.replace(".yaml", "")}`);
    }
  }
  process.exit(1);
}

const scenarioName = args[scenarioIdx + 1];
const scenarioDir = resolve(import.meta.dirname ?? ".", "scenarios");
const scenarioFile = join(scenarioDir, `${scenarioName}.yaml`);

if (!existsSync(scenarioFile)) {
  console.error(`Scenario not found: ${scenarioFile}`);
  process.exit(1);
}

const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

await runScenario(scenarioFile, outputDir);
process.exit(0);
