import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

const PHASE_LABELS: Record<string, string> = {
  classifying: "Analyzing task",
  routing: "Selecting model",
  connecting: "Connecting",
  streaming: "Generating",
};

interface ProgressIndicatorProps {
  /** Current thinking phase. */
  phase?: string;
  /** Active model name. */
  model?: string;
  /** Name of currently executing tool, if any. */
  activeTool?: string;
  /** Whether processing is active. */
  active: boolean;
}

export function ProgressIndicator({
  phase,
  model,
  activeTool,
  active,
}: ProgressIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const label = phase ? (PHASE_LABELS[phase] ?? phase) : "Processing";
  const timeStr = elapsed > 0 ? `${elapsed}s` : "";

  return (
    <Box paddingLeft={2}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text color="gray">
        {" "}
        {label}
        {model ? ` · ${model}` : ""}
        {activeTool ? ` · ${activeTool}` : ""}
        {timeStr ? ` (${timeStr})` : ""}
      </Text>
    </Box>
  );
}
