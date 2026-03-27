import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getProviderColor } from "../../theme.js";
import { Gauge } from "../viz/Gauge.js";

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
  onSelectModel?: (modelId: string) => void;
}

const QUALITY_BARS: Record<number, { label: string; value: number }> = {
  1: { label: "Excellent", value: 100 },
  2: { label: "Good", value: 66 },
  3: { label: "Basic", value: 33 },
};

const SPEED_BARS: Record<number, { label: string; value: number }> = {
  1: { label: "Fast", value: 100 },
  2: { label: "Medium", value: 66 },
  3: { label: "Slow", value: 33 },
};

export function ModelsMode({ models, onSelectModel }: ModelsModeProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, models.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    if (key.return && onSelectModel && models[selectedIdx]) {
      onSelectModel(models[selectedIdx].id);
    }
  });

  const selected = models[selectedIdx];

  return (
    <Box flexDirection="row" flexGrow={1} paddingX={1}>
      {/* Left: Model list */}
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
        width="60%"
      >
        <Text bold color="yellow">
          {" "}
          Model Explorer
        </Text>
        <Box marginTop={1} flexDirection="column">
          {models.map((m, i) => {
            const isSelected = i === selectedIdx;
            const provColor = getProviderColor(m.provider);
            return (
              <Box key={m.id}>
                <Text color={isSelected ? "white" : "gray"}>
                  {isSelected ? " ▸ " : "   "}
                </Text>
                <Text color={m.status === "available" ? "green" : "red"}>
                  {m.status === "available" ? "● " : "○ "}
                </Text>
                <Text color={provColor} bold={isSelected}>
                  {m.name.padEnd(24)}
                </Text>
                <Text color="gray">
                  ${m.pricing.input}/${m.pricing.output}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            {models.length} models │ j/k navigate │ Enter select
          </Text>
        </Box>
      </Box>

      {/* Right: Selected model detail */}
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
        marginLeft={1}
        width="40%"
      >
        {selected ? (
          <>
            <Text bold color={getProviderColor(selected.provider)}>
              {" "}
              {selected.name}
            </Text>
            <Text color="gray" dimColor>
              {" "}
              {selected.id}
            </Text>

            <Box marginTop={1} flexDirection="column">
              <Text color="gray">Provider</Text>
              <Text color={getProviderColor(selected.provider)} bold>
                {" "}
                {selected.provider}
              </Text>

              <Box marginTop={1}>
                <Text color="gray">Quality </Text>
                <Gauge
                  value={QUALITY_BARS[selected.qualityTier]?.value ?? 50}
                  width={8}
                  showPercent={false}
                  colorFn={() => "yellow"}
                />
                <Text color="gray">
                  {" "}
                  {QUALITY_BARS[selected.qualityTier]?.label ?? "?"}
                </Text>
              </Box>

              <Box>
                <Text color="gray">Speed </Text>
                <Gauge
                  value={SPEED_BARS[selected.speedTier]?.value ?? 50}
                  width={8}
                  showPercent={false}
                  colorFn={() => "cyan"}
                />
                <Text color="gray">
                  {" "}
                  {SPEED_BARS[selected.speedTier]?.label ?? "?"}
                </Text>
              </Box>

              <Box marginTop={1} flexDirection="column">
                <Text color="gray">Pricing (per 1M tokens)</Text>
                <Text>
                  {" "}
                  Input: <Text color="yellow">${selected.pricing.input}</Text>
                </Text>
                <Text>
                  {" "}
                  Output: <Text color="yellow">${selected.pricing.output}</Text>
                </Text>
              </Box>

              <Box marginTop={1}>
                <Text color="gray">Status: </Text>
                <Text
                  color={selected.status === "available" ? "green" : "red"}
                  bold
                >
                  {selected.status}
                </Text>
              </Box>
            </Box>
          </>
        ) : (
          <Text color="gray" dimColor>
            No model selected
          </Text>
        )}
      </Box>
    </Box>
  );
}
