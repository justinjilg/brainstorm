/**
 * Shortcut overlay — full-screen keyboard reference.
 * Shown when user presses ? in non-chat modes.
 */

import React from "react";
import { Box, Text, useInput } from "ink";

interface ShortcutOverlayProps {
  onDismiss: () => void;
}

export function ShortcutOverlay({ onDismiss }: ShortcutOverlayProps) {
  useInput(() => {
    onDismiss();
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">
        Keyboard Shortcuts
      </Text>
      <Text> </Text>

      <Text bold>Navigation</Text>
      <Text color="gray"> Esc Toggle between Chat and Dashboard</Text>
      <Text color="gray"> 1-4 Switch modes (in non-chat modes)</Text>
      <Text color="gray"> Tab Cycle modes (in non-chat modes)</Text>
      <Text color="gray"> Ctrl+D×2 Exit application</Text>
      <Text> </Text>

      <Text bold>Chat Mode</Text>
      <Text color="gray"> Enter Send message</Text>
      <Text color="gray"> \+Enter Multi-line (backslash continuation)</Text>
      <Text color="gray">
        {" "}
        Shift+Tab Cycle permission mode (auto/confirm/plan)
      </Text>
      <Text color="gray"> ↑↓ Input history</Text>
      <Text color="gray"> Shift+↑↓ Scroll message history</Text>
      <Text color="gray"> / Show command autocomplete</Text>
      <Text color="gray"> @file Include file in context</Text>
      <Text color="gray"> Esc Abort (while processing) / Dashboard (idle)</Text>
      <Text> </Text>

      <Text bold>Models Mode</Text>
      <Text color="gray"> ↑↓ / j/k Navigate model list</Text>
      <Text color="gray"> Enter Select model for session</Text>
      <Text> </Text>

      <Text bold>Dashboard Mode</Text>
      <Text color="gray"> r Refresh BrainstormRouter data</Text>
      <Text> </Text>

      <Text bold>Key Commands</Text>
      <Text color="gray"> /help Command reference</Text>
      <Text color="gray"> /role Switch roles (architect, sr-dev, qa)</Text>
      <Text color="gray"> /build Multi-model workflow wizard</Text>
      <Text color="gray"> /context Token breakdown</Text>
      <Text color="gray"> /insights Session intelligence</Text>
      <Text color="gray"> /undo Remove last turn</Text>
      <Text> </Text>

      <Text color="gray">Press any key to dismiss</Text>
    </Box>
  );
}
