import React from "react";
import { Box, Text } from "ink";
import { getRoleColor } from "../../theme.js";

interface ConfigModeProps {
  strategy: string;
  permissionMode: string;
  outputStyle: string;
  sandbox: string;
  role?: string;
  modelCount?: { local: number; cloud: number };
  turnCount?: number;
  sessionCost?: number;
}

function ConfigItem({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <Box>
      <Text color="gray"> {label.padEnd(18)}</Text>
      <Text color={color ?? "white"} bold>
        {value}
      </Text>
    </Box>
  );
}

export function ConfigMode({
  strategy,
  permissionMode,
  outputStyle,
  sandbox,
  role,
  modelCount,
  turnCount,
  sessionCost,
}: ConfigModeProps) {
  const modeColor =
    permissionMode === "auto"
      ? "green"
      : permissionMode === "plan"
        ? "cyan"
        : "yellow";

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="row" flexGrow={1}>
        {/* Left: Active Configuration */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexDirection="column"
          paddingX={1}
          width="50%"
        >
          <Text bold color="magenta">
            {" "}
            Active Configuration
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text color="green" bold>
                ●
              </Text>{" "}
              <Text bold>Routing</Text>
            </Text>
            <ConfigItem label="Strategy" value={strategy} />
            <ConfigItem
              label="Permission"
              value={permissionMode}
              color={modeColor}
            />
            <ConfigItem label="Output style" value={outputStyle} />
            {role && (
              <ConfigItem
                label="Active role"
                value={role}
                color={getRoleColor(role)}
              />
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text color="yellow" bold>
                ●
              </Text>{" "}
              <Text bold>Shell</Text>
            </Text>
            <ConfigItem
              label="Sandbox"
              value={sandbox}
              color={
                sandbox === "container"
                  ? "cyan"
                  : sandbox === "restricted"
                    ? "yellow"
                    : "gray"
              }
            />
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text color="blue" bold>
                ●
              </Text>{" "}
              <Text bold>Session</Text>
            </Text>
            {turnCount !== undefined && (
              <ConfigItem label="Turns" value={String(turnCount)} />
            )}
            {sessionCost !== undefined && (
              <ConfigItem
                label="Cost"
                value={`$${sessionCost.toFixed(4)}`}
                color="yellow"
              />
            )}
            {modelCount && (
              <ConfigItem
                label="Models"
                value={`${modelCount.local} local, ${modelCount.cloud} cloud`}
              />
            )}
          </Box>
        </Box>

        {/* Right: Quick Reference */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexDirection="column"
          paddingX={1}
          marginLeft={1}
          width="50%"
        >
          <Text bold color="cyan">
            {" "}
            Quick Reference
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text bold>Roles</Text>
            </Text>
            <Text color="gray"> /architect Deep thinking, read-only</Text>
            <Text color="gray"> /product-manager Requirements, scope</Text>
            <Text color="gray"> /sr-developer Quality implementation</Text>
            <Text color="gray"> /jr-developer Fast, cheap coding</Text>
            <Text color="gray"> /qa Testing, review</Text>
            <Text color="gray"> /default Reset to defaults</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text bold>Vault & Keys</Text>
            </Text>
            <Text color="gray"> /vault list Show stored keys</Text>
            <Text color="gray"> /vault add NAME Add a key</Text>
            <Text color="gray"> Resolver: vault → 1Password → env</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text bold>Workflows</Text>
            </Text>
            <Text color="gray"> storm workflow list</Text>
            <Text color="gray"> storm workflow run implement-feature</Text>
            <Text color="gray"> storm workflow run fix-bug</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text bold>Config File</Text>
            </Text>
            <Text color="gray"> ~/.brainstorm/config.toml</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
