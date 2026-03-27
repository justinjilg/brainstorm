import React from "react";
import { Box, Text } from "ink";

interface GaugeProps {
  /** Value 0-100 */
  value: number;
  /** Width in characters */
  width?: number;
  /** Label shown before the gauge */
  label?: string;
  /** Show percentage after the gauge */
  showPercent?: boolean;
  /** Color function: returns Ink color string based on value */
  colorFn?: (value: number) => string;
}

const DEFAULT_COLOR = (v: number): string => {
  if (v >= 85) return "red";
  if (v >= 60) return "yellow";
  return "green";
};

export function Gauge({
  value,
  width = 16,
  label,
  showPercent = true,
  colorFn = DEFAULT_COLOR,
}: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = colorFn(clamped);

  return (
    <Box>
      {label && <Text color="gray">{label} </Text>}
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color="gray" dimColor>
        {"░".repeat(empty)}
      </Text>
      {showPercent && <Text color="gray"> {Math.round(clamped)}%</Text>}
    </Box>
  );
}
