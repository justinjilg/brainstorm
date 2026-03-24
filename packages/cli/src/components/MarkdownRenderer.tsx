import React, { useMemo } from 'react';
import { Text } from 'ink';

/**
 * Simple terminal markdown renderer.
 * Handles code blocks, headers, bold, italic, lists, and horizontal rules.
 * No external dependencies — uses ANSI escape codes directly.
 */
function renderTerminalMarkdown(input: string): string {
  let text = input;

  // Code blocks: ```lang\ncode\n``` → dim + indented
  text = text.replace(/```[\w]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const lines = code.trimEnd().split('\n');
    return '\n' + lines.map((l: string) => `  \x1b[2m${l}\x1b[22m`).join('\n') + '\n';
  });

  // Inline code: `code` → dim
  text = text.replace(/`([^`]+)`/g, '\x1b[2m$1\x1b[22m');

  // Headers: ## Header → bold
  text = text.replace(/^(#{1,4})\s+(.+)$/gm, (_match, _hashes: string, title: string) => {
    return `\x1b[1m${title}\x1b[22m`;
  });

  // Bold: **text** → bold
  text = text.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m');

  // Italic: *text* → italic
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '\x1b[3m$1\x1b[23m');

  // Unordered lists: - item or * item → bullet
  text = text.replace(/^[\s]*[-*]\s+/gm, '  • ');

  // Ordered lists: 1. item → numbered
  text = text.replace(/^[\s]*(\d+)\.\s+/gm, '  $1. ');

  // Horizontal rules: --- or *** → line
  text = text.replace(/^(-{3,}|\*{3,})$/gm, '─────────────────────────────────────');

  return text;
}

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const rendered = useMemo(() => renderTerminalMarkdown(content), [content]);
  return <Text>{rendered}</Text>;
}

/**
 * Render markdown to a plain string (for non-Ink contexts like `storm run`).
 */
export function renderMarkdownToString(content: string): string {
  return renderTerminalMarkdown(content);
}
