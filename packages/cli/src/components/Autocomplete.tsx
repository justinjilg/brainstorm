/**
 * Autocomplete — dropdown suggestion list for slash commands and @file paths.
 *
 * Renders below the input box. Arrow keys navigate, Tab/Enter accepts,
 * Esc dismisses. Filters suggestions as user types.
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";

export interface AutocompleteItem {
  label: string;
  description?: string;
  prefix?: string;
}

interface AutocompleteProps {
  /** Current input text to match against */
  query: string;
  /** All possible suggestions */
  items: AutocompleteItem[];
  /** Called when user accepts a suggestion */
  onAccept: (label: string) => void;
  /** Called when user dismisses (Esc or type past suggestions) */
  onDismiss: () => void;
  /** Max items to show */
  maxVisible?: number;
}

export function Autocomplete({
  query,
  items,
  onAccept,
  onDismiss,
  maxVisible = 8,
}: AutocompleteProps) {
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return items
      .filter((item) => item.label.toLowerCase().includes(q))
      .slice(0, maxVisible);
  }, [query, items, maxVisible]);

  useInput((input, key) => {
    if (key.downArrow) {
      setCursor((prev) => Math.min(prev + 1, filtered.length - 1));
      return;
    }
    if (key.upArrow) {
      setCursor((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (key.tab || key.return) {
      if (filtered[cursor]) {
        onAccept(filtered[cursor].label);
      }
      return;
    }
    if (key.escape) {
      onDismiss();
      return;
    }
  });

  if (filtered.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={0}>
      {filtered.map((item, i) => {
        const isActive = i === cursor;
        return (
          <Box key={item.label}>
            <Text color={isActive ? "cyan" : "gray"}>
              {isActive ? "▸ " : "  "}
            </Text>
            <Text color={isActive ? "white" : "gray"} bold={isActive}>
              {item.prefix ?? ""}
              {item.label}
            </Text>
            {item.description && (
              <Text color="gray" dimColor={!isActive}>
                {" "}
                {item.description}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
