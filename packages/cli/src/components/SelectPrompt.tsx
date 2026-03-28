/**
 * SelectPrompt — Interactive selection UI for the terminal.
 *
 * Arrow keys navigate, Enter selects, Esc cancels.
 * Supports single-select and multi-select (Space to toggle).
 * Can show recommended options and descriptions.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
}

interface SelectPromptProps {
  /** Question to display above options */
  message: string;
  /** Available options */
  options: SelectOption[];
  /** Called when user selects an option (Enter) */
  onSelect: (value: string) => void;
  /** Called when user cancels (Esc) */
  onCancel?: () => void;
  /** Allow multiple selection with Space */
  multiSelect?: boolean;
  /** Called with selected values in multi-select mode */
  onMultiSelect?: (values: string[]) => void;
}

export function SelectPrompt({
  message,
  options,
  onSelect,
  onCancel,
  multiSelect = false,
  onMultiSelect,
}: SelectPromptProps) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setCursor((prev) => Math.min(prev + 1, options.length - 1));
    }
    if (key.upArrow || input === "k") {
      setCursor((prev) => Math.max(prev - 1, 0));
    }
    if (key.escape) {
      onCancel?.();
    }
    if (key.return) {
      if (multiSelect && onMultiSelect) {
        onMultiSelect(Array.from(selected));
      } else {
        onSelect(options[cursor].value);
      }
    }
    if (input === " " && multiSelect) {
      const val = options[cursor].value;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(val)) next.delete(val);
        else next.add(val);
        return next;
      });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ◆{" "}
        </Text>
        <Text bold>{message}</Text>
      </Box>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.has(opt.value);
        const indicator = multiSelect
          ? isSelected
            ? "◉"
            : "○"
          : isCursor
            ? "▸"
            : " ";
        const indicatorColor = multiSelect
          ? isSelected
            ? "green"
            : "gray"
          : isCursor
            ? "cyan"
            : "gray";

        return (
          <Box key={opt.value} flexDirection="column">
            <Box>
              <Text color={indicatorColor}>{indicator} </Text>
              <Text color={isCursor ? "white" : "gray"} bold={isCursor}>
                {opt.label}
              </Text>
              {opt.recommended && (
                <Text color="green" dimColor>
                  {" "}
                  (recommended)
                </Text>
              )}
            </Box>
            {opt.description && isCursor && (
              <Box paddingLeft={3}>
                <Text color="gray">{opt.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray">
          {multiSelect
            ? "↑↓ navigate │ Space toggle │ Enter confirm │ Esc cancel"
            : "↑↓ navigate │ Enter select │ Esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
