import React from "react";
import { Box, Text } from "ink";
import { Gauge } from "../viz/Gauge.js";
import { Sparkline } from "../viz/Sparkline.js";

interface DashboardModeProps {
  sessionCost: number;
  tokenCount: { input: number; output: number };
  modelCount: { local: number; cloud: number };
}

export function DashboardMode({
  sessionCost,
  tokenCount,
  modelCount,
}: DashboardModeProps) {
  const totalTokens = tokenCount.input + tokenCount.output;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Budget Section */}
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="blue">
          {" "}
          Budget
        </Text>
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Box flexDirection="column">
            <Text color="gray">Session</Text>
            <Text color="yellow" bold>
              ${sessionCost.toFixed(4)}
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text color="gray">Tokens</Text>
            <Text>
              {tokenCount.input.toLocaleString()}↑{" "}
              {tokenCount.output.toLocaleString()}↓
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text color="gray">Models</Text>
            <Text>
              {modelCount.local}L / {modelCount.cloud}C
            </Text>
          </Box>
        </Box>
        {totalTokens > 0 && (
          <Box marginTop={1}>
            <Sparkline
              data={[0, 0.2, 0.5, 0.3, 0.8, sessionCost].map((v) => v * 100)}
              color="yellow"
              width={20}
            />
          </Box>
        )}
      </Box>

      {/* Placeholder panels */}
      <Box marginTop={1} flexDirection="row" flexGrow={1}>
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="green">
            {" "}
            Routing Log
          </Text>
          <Text color="gray" dimColor>
            {" "}
            Recent routing decisions will appear here
          </Text>
          <Text color="gray" dimColor>
            {" "}
            as you interact with the assistant.
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          marginLeft={1}
          flexDirection="column"
        >
          <Text bold color="cyan">
            {" "}
            Tool Health
          </Text>
          <Text color="gray" dimColor>
            {" "}
            Tool success rates and status
          </Text>
          <Text color="gray" dimColor>
            {" "}
            will appear here during use.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
