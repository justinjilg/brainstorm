import React from "react";
import { Box, Text } from "ink";
import type { TUIMode } from "../hooks/useMode.js";

interface KeyHintProps {
  mode: TUIMode;
  isProcessing?: boolean;
}

const HINTS: Record<TUIMode, string> = {
  chat: "Ctrl+2 dashboard │ Ctrl+3 models │ Ctrl+4 config │ ↑↓ history │ Esc abort",
  dashboard: "1-4 switch │ Esc chat │ Tab cycle │ Ctrl+D exit",
  models: "1-4 switch │ j/k navigate │ Enter select │ Esc chat",
  config: "1-4 switch │ Esc chat │ Ctrl+D exit",
};

const PROCESSING_HINT = "Esc abort │ Shift+↑↓ scroll │ Ctrl+2 dashboard";

export function KeyHint({ mode, isProcessing }: KeyHintProps) {
  return (
    <Box paddingX={2}>
      <Text color="gray" dimColor>
        {isProcessing ? PROCESSING_HINT : HINTS[mode]}
      </Text>
    </Box>
  );
}
