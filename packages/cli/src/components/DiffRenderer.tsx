import React from "react";
import { Box, Text } from "ink";

interface DiffRendererProps {
  /** Unified diff string (with @@ hunks) or raw content to display with line numbers. */
  diff: string;
  /** Max lines to display before truncating. */
  maxLines?: number;
}

/**
 * Render a unified diff with colored +/- lines and line numbers.
 * If the input isn't a unified diff, displays with line numbers.
 */
export function DiffRenderer({ diff, maxLines = 30 }: DiffRendererProps) {
  const lines = diff.split("\n");
  const isUnifiedDiff = lines.some(
    (l) => l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++"),
  );

  if (isUnifiedDiff) {
    return <UnifiedDiff lines={lines} maxLines={maxLines} />;
  }

  return <NumberedContent lines={lines} maxLines={maxLines} />;
}

function UnifiedDiff({
  lines,
  maxLines,
}: {
  lines: string[];
  maxLines: number;
}) {
  const visible = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return (
            <Text key={i} color="gray" dimColor>
              {line}
            </Text>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <Text key={i} color="cyan" dimColor>
              {line}
            </Text>
          );
        }
        if (line.startsWith("+")) {
          return (
            <Text key={i} color="green">
              {line}
            </Text>
          );
        }
        if (line.startsWith("-")) {
          return (
            <Text key={i} color="red">
              {line}
            </Text>
          );
        }
        return (
          <Text key={i} color="gray">
            {" "}
            {line}
          </Text>
        );
      })}
      {truncated && (
        <Text color="gray" dimColor>
          ... {lines.length - maxLines} more lines
        </Text>
      )}
    </Box>
  );
}

function NumberedContent({
  lines,
  maxLines,
}: {
  lines: string[];
  maxLines: number;
}) {
  const visible = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;
  const padWidth = String(visible.length).length;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((line, i) => (
        <Text key={i}>
          <Text color="gray" dimColor>
            {String(i + 1).padStart(padWidth, " ")}
          </Text>
          <Text color="gray" dimColor>
            {" "}
            │{" "}
          </Text>
          <Text>{line}</Text>
        </Text>
      ))}
      {truncated && (
        <Text color="gray" dimColor>
          ... {lines.length - maxLines} more lines
        </Text>
      )}
    </Box>
  );
}
