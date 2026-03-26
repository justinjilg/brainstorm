import React, { useMemo } from "react";
import { Text } from "ink";

// Lazy-loaded for performance — only loaded on first render
let _markedRenderer: ((md: string) => string) | null = null;
let _loadFailed = false;

/**
 * Initialize marked-terminal renderer with syntax highlighting.
 * Lazy-loaded to avoid slowing CLI startup.
 */
async function getMarkedRenderer(): Promise<(md: string) => string> {
  if (_markedRenderer) return _markedRenderer;
  if (_loadFailed) return renderTerminalMarkdownFallback;

  try {
    const { Marked } = await import("marked");
    const { default: TerminalRenderer } = await import("marked-terminal");
    const { highlight } = await import("cli-highlight");

    const marked = new Marked();
    marked.use(
      TerminalRenderer({
        // Code block rendering with syntax highlighting
        code: (code: string, lang?: string) => {
          try {
            const highlighted = highlight(code, {
              language: lang || "auto",
              ignoreIllegals: true,
            });
            const lines = highlighted.split("\n");
            const numbered = lines.map((line: string, i: number) => {
              const num = String(i + 1).padStart(3, " ");
              return `\x1b[2m${num}\x1b[22m │ ${line}`;
            });
            const langLabel = lang ? `\x1b[2m ─── ${lang} ───\x1b[22m` : "";
            return `\n${langLabel}\n${numbered.join("\n")}\n`;
          } catch {
            // Fallback: dim code without highlighting
            const lines = code.split("\n");
            return (
              "\n" +
              lines.map((l: string) => `  \x1b[2m${l}\x1b[22m`).join("\n") +
              "\n"
            );
          }
        },
        // Table rendering with borders
        table: (header: string, body: string) => {
          return `\n${header}${body}\n`;
        },
        // Customize heading with bold + underline
        heading: (text: string, level: number) => {
          const prefix = level <= 2 ? "\x1b[1;4m" : "\x1b[1m";
          return `${prefix}${text}\x1b[22;24m\n`;
        },
        // Horizontal rule
        hr: () => "─".repeat(40) + "\n",
        // List items with bullets
        listitem: (text: string) => `  • ${text}\n`,
        // Links: show URL inline
        link: (href: string, _title: string, text: string) => {
          if (text === href) return `\x1b[4;34m${href}\x1b[24;39m`;
          return `${text} (\x1b[2m${href}\x1b[22m)`;
        },
        // Inline code
        codespan: (code: string) => `\x1b[2m\`${code}\`\x1b[22m`,
        // Bold
        strong: (text: string) => `\x1b[1m${text}\x1b[22m`,
        // Italic
        em: (text: string) => `\x1b[3m${text}\x1b[23m`,
      }),
    );

    _markedRenderer = (md: string) =>
      marked.parse(md, { async: false }) as string;
    return _markedRenderer;
  } catch {
    _loadFailed = true;
    return renderTerminalMarkdownFallback;
  }
}

// Eagerly initialize on module load (async, non-blocking)
getMarkedRenderer().catch(() => {});

/**
 * Fallback markdown renderer — pure ANSI, no dependencies.
 */
function renderTerminalMarkdownFallback(input: string): string {
  let text = input;

  // Code blocks with line numbers
  text = text.replace(
    /```([\w]*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const lines = code.trimEnd().split("\n");
      const langLabel = lang ? `\x1b[2m ─── ${lang} ───\x1b[22m\n` : "";
      const numbered = lines.map((l: string, i: number) => {
        const num = String(i + 1).padStart(3, " ");
        return `\x1b[2m${num}\x1b[22m │ \x1b[2m${l}\x1b[22m`;
      });
      return `\n${langLabel}${numbered.join("\n")}\n`;
    },
  );

  text = text.replace(/`([^`]+)`/g, "\x1b[2m`$1`\x1b[22m");
  text = text.replace(
    /^(#{1,4})\s+(.+)$/gm,
    (_match, hashes: string, title: string) => {
      return hashes.length <= 2
        ? `\x1b[1;4m${title}\x1b[22;24m`
        : `\x1b[1m${title}\x1b[22m`;
    },
  );
  text = text.replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m");
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "\x1b[3m$1\x1b[23m");
  text = text.replace(/^[\s]*[-*]\s+/gm, "  • ");
  text = text.replace(/^[\s]*(\d+)\.\s+/gm, "  $1. ");
  text = text.replace(/^(-{3,}|\*{3,})$/gm, "─".repeat(40));

  return text;
}

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const rendered = useMemo(() => {
    // Use the sync renderer if available, fallback otherwise
    if (_markedRenderer) return _markedRenderer(content);
    return renderTerminalMarkdownFallback(content);
  }, [content]);

  return <Text>{rendered}</Text>;
}

/**
 * Render markdown to a plain string (for non-Ink contexts like `storm run`).
 */
export function renderMarkdownToString(content: string): string {
  if (_markedRenderer) return _markedRenderer(content);
  return renderTerminalMarkdownFallback(content);
}
