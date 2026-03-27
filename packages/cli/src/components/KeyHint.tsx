import React from "react";
import { Box, Text } from "ink";
import type { TUIMode } from "../hooks/useMode.js";

interface KeyHintProps {
  mode: TUIMode;
  isProcessing?: boolean;
}

const HINTS: Record<TUIMode, string> = {
  chat: "Tab mode │ ↑↓ history │ Shift+↑↓ scroll │ Esc abort │ Ctrl+D exit",
  dashboard: "Tab mode │ r refresh │ ? help │ Ctrl+D exit",
  models: "Tab mode │ j/k navigate │ Enter select │ / search │ Ctrl+D exit",
  config: "Tab mode │ j/k navigate │ Enter edit │ s save │ Ctrl+D exit",
};

const PROCESSING_HINT = "Esc abort │ Shift+↑↓ scroll │ Tab mode";

export function KeyHint({ mode, isProcessing }: KeyHintProps) {
  return (
    <Box paddingX={2}>
      <Text color="gray" dimColor>
        {isProcessing ? PROCESSING_HINT : HINTS[mode]}
      </Text>
    </Box>
  );
}
