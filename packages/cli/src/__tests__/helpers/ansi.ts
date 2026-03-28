/**
 * ANSI escape code helpers for asserting on rendered terminal frames.
 */

import stripAnsi from "strip-ansi";

/**
 * Remove all ANSI escape codes from a string.
 */
export function plain(frame: string): string {
  return stripAnsi(frame);
}

// Multiple ANSI SGR code variants per color.
// Ink/chalk may produce different escape sequences depending on color level.
const FG_CODES: Record<string, string[]> = {
  black: ["\u001b[30m"],
  red: ["\u001b[31m", "\u001b[91m"],
  green: ["\u001b[32m", "\u001b[92m"],
  yellow: ["\u001b[33m", "\u001b[93m"],
  blue: ["\u001b[34m", "\u001b[94m"],
  magenta: ["\u001b[35m", "\u001b[95m"],
  cyan: ["\u001b[36m", "\u001b[96m"],
  white: ["\u001b[37m", "\u001b[97m"],
  gray: ["\u001b[90m", "\u001b[2m"],
};

/**
 * Check if a frame contains text rendered in a specific color.
 * Checks all known ANSI code variants for the color.
 */
export function hasColor(frame: string, text: string, color: string): boolean {
  const codes = FG_CODES[color];
  if (!codes)
    throw new Error(
      `Unknown color: ${color}. Known: ${Object.keys(FG_CODES).join(", ")}`,
    );
  const lines = frame.split("\n");
  for (const line of lines) {
    if (line.includes(text)) {
      for (const code of codes) {
        if (line.includes(code)) return true;
      }
    }
  }
  return false;
}

/**
 * Check if a frame contains bold text.
 */
export function hasBold(frame: string, text: string): boolean {
  const boldCode = "\u001b[1m";
  const lines = frame.split("\n");
  for (const line of lines) {
    if (line.includes(text) && line.includes(boldCode)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a frame contains dimmed text.
 */
export function hasDim(frame: string, text: string): boolean {
  const dimCode = "\u001b[2m";
  const lines = frame.split("\n");
  for (const line of lines) {
    if (line.includes(text) && line.includes(dimCode)) {
      return true;
    }
  }
  return false;
}

/**
 * Get plain text content of a frame (strip ANSI, trim whitespace).
 */
export function getTextContent(frame: string): string {
  return plain(frame).replace(/\s+/g, " ").trim();
}

/**
 * Check if a specific text appears in the frame (ignoring ANSI codes).
 */
export function containsText(frame: string, text: string): boolean {
  return plain(frame).includes(text);
}
