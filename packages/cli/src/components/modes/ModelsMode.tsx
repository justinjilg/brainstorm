import React from "react";
import { Box, Text } from "ink";
import { getProviderColor } from "../../theme.js";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  qualityTier: number;
  speedTier: number;
  pricing: { input: number; output: number };
  status: string;
}

interface ModelsModeProps {
  models: ModelInfo[];
}

const QUALITY_LABELS: Record<number, string> = {
  1: "★★★",
  2: "★★☆",
  3: "★☆☆",
  4: "☆☆☆",
  5: "☆☆☆",
};
const SPEED_LABELS: Record<number, string> = {
  1: "⚡⚡⚡",
  2: "⚡⚡",
  3: "⚡",
};

export function ModelsMode({ models }: ModelsModeProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
        flexGrow={1}
      >
        <Text bold color="yellow">
          {" "}
          Model Explorer
        </Text>
        <Box marginTop={1}>
          <Text color="gray">
            {"  "}
            {" Provider".padEnd(12)}
            {"Name".padEnd(22)}
            {"Quality".padEnd(10)}
            {"Speed".padEnd(10)}
            {"Cost (in/out)".padEnd(16)}
            {"Status"}
          </Text>
        </Box>
        <Text color="gray" dimColor>
          {"  " + "─".repeat(80)}
        </Text>
        {models.map((m) => (
          <Box key={m.id}>
            <Text>{"  "}</Text>
            <Text color={getProviderColor(m.provider)}>
              {m.provider.padEnd(12)}
            </Text>
            <Text bold>{m.name.padEnd(22)}</Text>
            <Text color="yellow">
              {(QUALITY_LABELS[m.qualityTier] ?? "?").padEnd(10)}
            </Text>
            <Text color="cyan">
              {(SPEED_LABELS[m.speedTier] ?? "?").padEnd(10)}
            </Text>
            <Text color="gray">
              {`$${m.pricing.input}/$${m.pricing.output}`.padEnd(16)}
            </Text>
            <Text color={m.status === "available" ? "green" : "red"}>
              {m.status === "available" ? "●" : "○"}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            {" "}
            {models.length} models │ Enter to select │ / to search
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
