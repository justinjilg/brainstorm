/**
 * Markdown Renderer — renders markdown with syntax highlighting.
 * Matches Claude Desktop's rendering quality.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useState, useCallback } from "react";

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
        pre: ({ children }) => <>{children}</>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--ctp-blue)] underline hover:text-[var(--ctp-sapphire)]"
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="text-xs border-collapse w-full">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-[var(--ctp-surface2)] bg-[var(--ctp-surface0)] px-2 py-1 text-left text-[var(--ctp-subtext1)] font-medium">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-[var(--ctp-surface2)] px-2 py-1 text-[var(--ctp-text)]">
            {children}
          </td>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[var(--ctp-mauve)] pl-3 my-2 text-[var(--ctp-subtext0)] italic">
            {children}
          </blockquote>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>
        ),
        h1: ({ children }) => (
          <h1 className="text-lg font-bold text-[var(--ctp-text)] mt-3 mb-1">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-base font-bold text-[var(--ctp-text)] mt-2 mb-1">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-bold text-[var(--ctp-text)] mt-2 mb-1">
            {children}
          </h3>
        ),
        p: ({ children }) => <p className="my-1">{children}</p>,
        hr: () => <hr className="border-[var(--ctp-surface1)] my-3" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CodeBlock({ className, children }: React.HTMLAttributes<HTMLElement>) {
  const match = /language-(\w+)/.exec(className ?? "");
  const language = match ? match[1] : undefined;
  const code = String(children).replace(/\n$/, "");
  const isInline = !className && !code.includes("\n");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  if (isInline) {
    return (
      <code className="px-1 py-0.5 rounded bg-[var(--ctp-surface1)] text-[var(--ctp-rosewater)] text-[0.85em] font-mono">
        {children}
      </code>
    );
  }

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden bg-[var(--ctp-mantle)] border border-[var(--ctp-surface0)]">
      <div className="flex items-center justify-between px-3 py-1 bg-[var(--ctp-crust)] border-b border-[var(--ctp-surface0)]">
        <span className="text-[10px] text-[var(--ctp-overlay0)] font-mono">
          {language ?? "text"}
        </span>
        <button
          onClick={handleCopy}
          className="text-[10px] text-[var(--ctp-overlay0)] hover:text-[var(--ctp-text)] transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language ?? "text"}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: "12px",
          background: "var(--ctp-mantle)",
          fontSize: "12px",
          lineHeight: "1.5",
        }}
        codeTagProps={{
          style: {
            fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
