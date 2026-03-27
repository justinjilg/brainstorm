import React from "react";
import { Text } from "ink";

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

interface SparklineProps {
  /** Array of numeric values to plot */
  data: number[];
  /** Color for the sparkline */
  color?: string;
  /** Width in characters (data is sampled to fit) */
  width?: number;
}

export function Sparkline({ data, color = "green", width }: SparklineProps) {
  if (data.length === 0)
    return (
      <Text color="gray" dimColor>
        ─
      </Text>
    );

  // Sample data to fit width if needed
  let values = data;
  if (width && data.length > width) {
    const step = data.length / width;
    values = Array.from(
      { length: width },
      (_, i) => data[Math.floor(i * step)],
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const bars = values.map((v) => {
    const idx = Math.round(((v - min) / range) * (BARS.length - 1));
    return BARS[idx];
  });

  return <Text color={color}>{bars.join("")}</Text>;
}
