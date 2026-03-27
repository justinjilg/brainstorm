import React from "react";
import { Box, Text } from "ink";
import type { TUIMode } from "../hooks/useMode.js";

interface KeyHintProps {
  mode: TUIMode;
  isProcessing?: boolean;
}

const HINTS: Record<TUIMode, string> = {
  chat: "Esc dashboard │ ↑↓ history │ Shift+↑↓ scroll │ Ctrl+D×2 exit",
  dashboard: "1-4 switch │ Tab cycle │ r refresh │ Esc chat │ Ctrl+D×2 exit",
  models: "1-4 switch │ ↑↓ navigate │ Enter select │ Esc chat",
  config: "1-4 switch │ Esc chat │ Ctrl+D×2 exit",
};

const PROCESSING_HINT = "Esc abort │ Shift+↑↓ scroll";

export function KeyHint({ mode, isProcessing }: KeyHintProps) {
  return (
    <Box paddingX={2}>
      <Text color="gray">{isProcessing ? PROCESSING_HINT : HINTS[mode]}</Text>
    </Box>
  );
}
