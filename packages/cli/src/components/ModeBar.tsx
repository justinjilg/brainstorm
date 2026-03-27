import React from "react";
import { Box, Text } from "ink";
import { MODE_LABELS, type TUIMode } from "../hooks/useMode.js";

interface ModeBarProps {
  activeMode: TUIMode;
  /** Condensed status info shown on the right */
  model?: string;
  cost?: number;
  role?: string;
}

export function ModeBar({ activeMode, model, cost, role }: ModeBarProps) {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box>
        {(
          Object.entries(MODE_LABELS) as [
            TUIMode,
            (typeof MODE_LABELS)[TUIMode],
          ][]
        ).map(([id, meta]) => {
          const isActive = id === activeMode;
          return (
            <Box key={id} marginRight={1}>
              <Text color="gray" dimColor={!isActive}>
                [
              </Text>
              <Text
                color={isActive ? meta.color : "gray"}
                bold={isActive}
                dimColor={!isActive}
              >
                {meta.key}
              </Text>
              <Text color="gray" dimColor={!isActive}>
                ]
              </Text>
              <Text
                color={isActive ? meta.color : "gray"}
                bold={isActive}
                dimColor={!isActive}
              >
                {" "}
                {meta.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        {role && (
          <>
            <Text color="magenta" bold>
              {role}
            </Text>
            <Text color="gray"> │ </Text>
          </>
        )}
        {model && (
          <>
            <Text color="green">{model}</Text>
            <Text color="gray"> │ </Text>
          </>
        )}
        <Text color={cost && cost > 0.01 ? "yellow" : "green"}>
          ${(cost ?? 0).toFixed(4)}
        </Text>
      </Box>
    </Box>
  );
}
